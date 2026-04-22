require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
    Client, GatewayIntentBits, Collection, REST, Routes,
    EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, Events
} = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// ==========================================
// 1. Supabase 연결
// ==========================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
    realtime: {
        params: { eventsPerSecond: 10 },
        timeout: 30000
    }
});

// ==========================================
// 2. 디스코드 클라이언트 생성
// ==========================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// ==========================================
// 3. 명령어 로드
// ==========================================
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
const commandsForRegister = [];

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    client.commands.set(command.data.name, command);
    commandsForRegister.push(command.data.toJSON());
}

// ==========================================
// 4. 전역 상수
// ==========================================
const voiceSessions = new Map();
const AUCTION_CHANNEL_ID = '1494514674547298448';
const COMMAND_NOTICE_CHANNEL_ID = '1494509385391673436';
const GUILD_ID = process.env.DISCORD_GUILD_ID;

const getSafeBaseApiUrl = () => {
    const rawUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
    const cleanUrl = rawUrl.endsWith('/') ? rawUrl.slice(0, -1) : rawUrl;
    return `${cleanUrl}/api/pokemon`;
};

// ==========================================
// 5. 봇 준비 완료
// [수정 8] clientReady → Events.ClientReady (discord.js v14 공식 권장)
// ==========================================
client.once(Events.ClientReady, async () => {
    console.log(`✅ 로그인 성공! 봇 이름: ${client.user.tag}`);

    // 슬래시 명령어 등록
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commandsForRegister });
        console.log('✅ 슬래시 명령어 등록 완료!');
    } catch (error) {
        console.error('명령어 등록 에러:', error);
    }

    // ==========================================
    // [재부팅 동기화] 기존 음성 접속자 복구
    // ==========================================
    let activeUserCount = 0;
    const nowSync = Date.now();
    client.guilds.cache.forEach(guild => {
        guild.voiceStates.cache.forEach(voiceState => {
            if (!voiceState.member?.user.bot && voiceState.channelId) {
                voiceSessions.set(voiceState.member.id, { joinedAt: nowSync, accumulated: 0 });
                activeUserCount++;
            }
        });
    });
    console.log(`🔄 [재부팅 동기화] 기존 음성 접속자 ${activeUserCount}명의 파밍 타이머를 가동합니다!`);

    // ==========================================
    // 📡 Realtime — 장착 + 경매 등록 감지
    // ==========================================
    const dbChannel = supabase.channel('pokemon-system-channel-v3');

    // [장착 감지] 에픽 이상 포켓몬 장착 시 디스코드 역할 자동 지급
    // [수정 7] GUILD_ID 없으면 리스너 자체를 등록하지 않음 (의도 명확화)
    if (GUILD_ID) {
        dbChannel.on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'user_inventory', filter: 'status=eq.equipped' },
            async (payload) => {
                try {
                    const { user_id, pokemon_id } = payload.new;
                    const { data: player } = await supabase.from('players').select('discord_id').eq('id', user_id).single();
                    const { data: pokeDict } = await supabase.from('pokemon_dict').select('name_ko, rarity').eq('id', pokemon_id).single();

                    if (!player || !pokeDict) return;
                    const guild = client.guilds.cache.get(GUILD_ID);
                    if (!guild) return;
                    const member = await guild.members.fetch(player.discord_id).catch(() => null);
                    if (!member) return;

                    const pokemonName = pokeDict.name_ko;
                    const rarity = pokeDict.rarity || '일반';
                    const targetRarities = ['에픽', '전설', '환상', '히든'];

                    if (targetRarities.includes(rarity)) {
                        const roleToAdd = guild.roles.cache.find(role => role.name === pokemonName);
                        if (roleToAdd) await member.roles.add(roleToAdd).catch(console.error);

                        if (rarity === '에픽' || rarity === '전설') {
                            const groupRoleName = `${rarity}포켓몬`;
                            const groupRole = guild.roles.cache.find(role => role.name === groupRoleName);
                            if (groupRole) await member.roles.add(groupRole).catch(console.error);
                        }
                    }
                } catch (error) {
                    console.error('🚨 웹 장착 감지 에러:', error);
                }
            }
        );
    }

    // [경매 등록 감지] 새 매물 등록 시 경매 채널 알림
    dbChannel.on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'auctions' },
        async (payload) => {
            try {
                const auction = payload.new;
                const channel = client.channels.cache.get(AUCTION_CHANNEL_ID);
                if (!channel) return;

                const { data: seller } = await supabase.from('players').select('discord_id').eq('id', auction.seller_id).single();
                if (!seller) return;

                let itemName = auction.item_name;
                let rarity = '아이템';
                let thumb = null;

                if (auction.sell_type === 'pokemon') {
                    const { data: inv } = await supabase
                        .from('user_inventory')
                        .select('pokemon:pokemon_dict(name_ko, rarity, official_art_url, sprite_url)')
                        .eq('id', auction.inventory_item_id)
                        .single();
                    if (inv && inv.pokemon) {
                        const pokeData = Array.isArray(inv.pokemon) ? inv.pokemon[0] : inv.pokemon;
                        itemName = pokeData.name_ko;
                        rarity = pokeData.rarity || '일반';
                        thumb = pokeData.official_art_url || pokeData.sprite_url;
                    }
                }

                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle('🛒 경매장 새 매물 등록!')
                    .setDescription(
                        `<@${seller.discord_id}>님이 새로운 매물을 등록했습니다!\n\n` +
                        `**[${rarity}] ${itemName}**\n` +
                        `💰 시작가: **${auction.start_price.toLocaleString()} P**\n` +
                        `⏳ 마감: <t:${Math.floor(new Date(auction.end_at).getTime() / 1000)}:R>`
                    )
                    .setTimestamp();

                if (thumb) embed.setThumbnail(thumb);
                await channel.send({ content: `📢 **새로운 경매 매물 등록**`, embeds: [embed] });
            } catch (error) {
                console.error('🚨 경매 등록 알림 에러:', error);
            }
        }
    );

    dbChannel.subscribe((status) => {
        console.log(`📡 [디버그] 장착/경매 웹소켓 상태: ${status}`);
        if (status === 'TIMED_OUT') {
            console.error('🚨 [장애] 장착/경매 웹소켓 TIMED_OUT — 네트워크 점검 필요');
        }
    });

    // ==========================================
    // 🌟 MVP 결제 감지 — 폴링 방식
    // [수정 4] 봇 재시작 시 DB에서 마지막 처리 시간 복구
    //          마지막 created_at + 1ms로 갱신 (중복/누락 동시 방지)
    // ==========================================
    let lastMvpCheckTime = new Date().toISOString();
    try {
        const { data: lastTx } = await supabase
            .from('mvp_transactions')
            .select('created_at')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        if (lastTx) {
            // 마지막 처리 건의 created_at + 1ms → 중복 발송 + 누락 동시 방지
            const lastTime = new Date(lastTx.created_at);
            lastTime.setMilliseconds(lastTime.getMilliseconds() + 1);
            lastMvpCheckTime = lastTime.toISOString();
            console.log(`⏱️ [디버그] MVP 감지 기준 시간 DB 복구 완료: ${lastMvpCheckTime}`);
        } else {
            console.log(`⏱️ [디버그] MVP 트랜잭션 없음. 현재 시각 기준으로 시작합니다.`);
        }
    } catch (e) {
        console.error('🚨 MVP 기준 시간 초기화 에러:', e);
    }

    setInterval(async () => {
        try {
            const { data: newTxs, error } = await supabase
                .from('mvp_transactions')
                .select('*')
                .gt('created_at', lastMvpCheckTime)
                .order('created_at', { ascending: true });

            if (error || !newTxs || newTxs.length === 0) return;

            for (const tx of newTxs) {
                console.log(`🔔 [디버그] MVP 결제 감지 (Polling): ${tx.id}`);

                const { data: player } = await supabase
                    .from('players')
                    .select('discord_id, mvp_expires_at')
                    .eq('id', tx.user_id)
                    .single();

                if (!player || !player.discord_id) {
                    console.log(`🚨 [디버그] 유저(${tx.user_id}) 디스코드 ID 없음`);
                    continue;
                }

                const user = await client.users.fetch(player.discord_id).catch(() => null);
                const expDateStr = new Date(player.mvp_expires_at).toLocaleString('ko-KR', {
                    year: 'numeric', month: 'long', day: 'numeric',
                    hour: '2-digit', minute: '2-digit'
                });

                const embed = new EmbedBuilder()
                    .setColor(0xFFD700)
                    .setTitle(`👑 MVP ${tx.package_days}일권 혜택 적용 완료!`)
                    .setDescription(
                        `MVP 혜택이 성공적으로 적용되었습니다!\n\n` +
                        `🎁 **지급된 보너스:** +${tx.bonus_points.toLocaleString()} P\n` +
                        `⏳ **혜택 만료 일시:** ${expDateStr}\n\n` +
                        `후원해 주셔서 감사합니다!`
                    );

                const noticeChannel = client.channels.cache.get(COMMAND_NOTICE_CHANNEL_ID);

                if (user) {
                    try {
                        await user.send({ embeds: [embed] });
                        console.log(`✅ [디버그] DM 발송 성공: ${player.discord_id}`);
                    } catch (err) {
                        console.error(`🚨 [디버그] DM 차단 — 공지 채널 대체 발송`);
                        if (noticeChannel) {
                            await noticeChannel.send({
                                content: `📢 <@${player.discord_id}>님, DM이 차단되어 이곳에 알립니다! MVP 혜택이 정상 적용되었습니다.`,
                                embeds: [embed]
                            });
                        }
                    }
                } else {
                    console.error(`🚨 [디버그] 유저 미발견: ${player.discord_id}`);
                    if (noticeChannel) {
                        await noticeChannel.send({
                            content: `📢 <@${player.discord_id}>님, 디스코드 프로필을 찾을 수 없어 이곳에 알립니다! MVP 혜택이 정상 적용되었습니다.`,
                            embeds: [embed]
                        });
                    }
                }
            }

            // [수정 4] 루프 완료 후 마지막 건 created_at + 1ms 갱신
            const lastCreatedAt = new Date(newTxs[newTxs.length - 1].created_at);
            lastCreatedAt.setMilliseconds(lastCreatedAt.getMilliseconds() + 1);
            lastMvpCheckTime = lastCreatedAt.toISOString();

        } catch (error) {
            console.error('🚨 MVP 폴링 에러:', error);
        }
    }, 15000);

    // ==========================================
    // ⏰ 경매 마감 체크 (60초 주기)
    // [수정 3] 봇 재시작 시 최근 30분 마감 경매 선로드 (중복 알림 방지)
    // [수정 5] a.pokemon null 크래시 방지 (옵셔널 체이닝)
    // ==========================================
    const announcedAuctions = new Set();

    try {
        const { data: recentClosed } = await supabase
            .from('auctions')
            .select('id')
            .lt('end_at', new Date().toISOString())
            .gt('end_at', new Date(Date.now() - 30 * 60 * 1000).toISOString());

        recentClosed?.forEach(a => announcedAuctions.add(a.id));
        console.log(`🛡️ [재시작 보호] 최근 마감 경매 ${recentClosed?.length ?? 0}건 중복 방지 등록 완료`);
    } catch (e) {
        console.error('🚨 경매 중복 방지 초기화 에러:', e);
    }

    setInterval(async () => {
        try {
            const baseApiUrl = getSafeBaseApiUrl();
            const res = await fetch(`${baseApiUrl}/auction`);
            if (!res.ok) return;

            const data = await res.json();
            if (!data.success) return;

            const auctions = data.data || [];
            const now = Date.now();

            for (const a of auctions) {
                const endAt = new Date(a.end_at).getTime();
                if (endAt > now) continue;
                if (announcedAuctions.has(a.id)) continue;
                if (now - endAt > 30 * 60 * 1000) continue;

                announcedAuctions.add(a.id);

                const channel = client.channels.cache.get(AUCTION_CHANNEL_ID);
                if (!channel) continue;

                if (a.highest_bidder_id) {
                    const { data: winner } = await supabase
                        .from('players')
                        .select('discord_id')
                        .eq('id', a.highest_bidder_id)
                        .single();

                    const winnerMention = winner ? `<@${winner.discord_id}>` : '익명의 소환사';
                    // [수정 5] 옵셔널 체이닝으로 null 크래시 방지
                    const itemName = a.sell_type === 'item'
                        ? a.item_name
                        : (a.pokemon?.name_ko ?? '알 수 없는 포켓몬');
                    const rarity = a.sell_type === 'item'
                        ? '아이템'
                        : (a.pokemon?.rarity ?? '일반');

                    const embed = new EmbedBuilder()
                        .setColor(0xFFD700)
                        .setTitle('🎉 경매 낙찰 완료!')
                        .setDescription(
                            `축하합니다! ${winnerMention} 님이 치열한 경쟁 끝에\n` +
                            `[ ${rarity} ] **${itemName}** 매물을 **${a.current_bid.toLocaleString()} P**에 최종 낙찰받았습니다!`
                        )
                        .setFooter({ text: '경매장 수령함에서 매물을 획득하세요!' });

                    if (a.pokemon?.official_art_url || a.pokemon?.sprite_url) {
                        embed.setThumbnail(a.pokemon.official_art_url || a.pokemon.sprite_url);
                    }
                    await channel.send({ content: `📢 **경매 마감 알림**`, embeds: [embed] });
                }
            }
        } catch (error) {
            console.error('경매 체크 에러:', error);
        }
    }, 60 * 1000);

    // ==========================================
    // ⏰ MVP 만료 스케줄러 (1시간 주기)
    // [수정 6] Tier 2 만료 체크를 is_mvp와 분리
    //          premium_tier_expires_at이 있는 유저를 별도 조회
    // ==========================================
    setInterval(async () => {
        try {
            const now = new Date();

            // MVP 전체 유저 (is_mvp: true)
            const { data: mvpPlayers } = await supabase
                .from('players')
                .select('id, discord_id, mvp_expires_at, premium_tier_expires_at')
                .eq('is_mvp', true);

            // [수정 6] Tier 2 만료 알림 — is_mvp와 무관하게 별도 조회
            const { data: tier2Players } = await supabase
                .from('players')
                .select('id, discord_id, premium_tier_expires_at')
                .eq('is_mvp', false)
                .not('premium_tier_expires_at', 'is', null);

            // is_mvp: true 유저 + is_mvp: false인데 Tier 2 잔존 유저 통합
            const allPlayers = [
                ...(mvpPlayers || []),
                ...(tier2Players || [])
            ];

            for (const player of allPlayers) {
                if (!player.discord_id) continue;
                const user = await client.users.fetch(player.discord_id).catch(() => null);

                // --- Tier 2 만료 체크 ---
                if (player.premium_tier_expires_at) {
                    const premExp = new Date(player.premium_tier_expires_at);
                    const premDiffMs = premExp.getTime() - now.getTime();
                    const premDiffHours = premDiffMs / (1000 * 60 * 60);

                    // A. Tier 2 만료 24시간 전 알림
                    if (premDiffHours <= 24 && premDiffHours > 23) {
                        if (user) {
                            const embed = new EmbedBuilder()
                                .setColor(0xFFA000)
                                .setTitle('💎 최고 티어 혜택 만료 24시간 전')
                                .setDescription(
                                    '소환사님의 최고 티어(Tier 2) 혜택이 **약 24시간 후 만료**됩니다.\n' +
                                    '이후에는 일반 MVP 혜택(Tier 1)으로 전환되어 포인트 지급량이 소폭 감소합니다.'
                                );
                            user.send({ embeds: [embed] }).catch(() => {});
                        }
                    }
                    // B. Tier 2 단독 만료 처리 (1시간 제한 없음)
                    else if (premDiffMs <= 0) {
                        await supabase
                            .from('players')
                            .update({ premium_tier_expires_at: null })
                            .eq('id', player.id);

                        if (user) {
                            const embed = new EmbedBuilder()
                                .setColor(0x03A9F4)
                                .setTitle('💎 최고 티어 혜택 만료 안내')
                                .setDescription(
                                    '최고 티어(Tier 2) 기간이 종료되었습니다.\n' +
                                    '이제 소환사님은 **일반 MVP 혜택(Tier 1)​**으로 전환됩니다.\n\n' +
                                    '(음성방: 8P ➔ 7P / 내전 승리: 30P ➔ 20P, 패배: 25P ➔ 15P)'
                                );
                            user.send({ embeds: [embed] }).catch(() => {});
                        }
                    }
                }

                // --- 전체 MVP 만료 체크 (is_mvp: true 유저만) ---
                if (player.mvp_expires_at) {
                    const mvpExp = new Date(player.mvp_expires_at);
                    const mvpDiffMs = mvpExp.getTime() - now.getTime();
                    const mvpDiffHours = mvpDiffMs / (1000 * 60 * 60);

                    // A. MVP 만료 24시간 전 알림
                    if (mvpDiffHours <= 24 && mvpDiffHours > 23) {
                        if (user) {
                            const embed = new EmbedBuilder()
                                .setColor(0xFF5722)
                                .setTitle('⚠️ MVP 혜택 만료 24시간 전')
                                .setDescription(
                                    '소환사님의 MVP 혜택이 **약 24시간 후 만료**됩니다.\n' +
                                    '혜택 유지를 원하시면 연장을 고려해 보세요!'
                                );
                            user.send({ embeds: [embed] }).catch(() => {});
                        }
                    }
                    // B. MVP 전체 만료 — 일반 등급 전환
                    else if (mvpDiffMs <= 0) {
                        await supabase
                            .from('players')
                            .update({
                                is_mvp: false,
                                mvp_expires_at: null,
                                premium_tier_expires_at: null
                            })
                            .eq('id', player.id);

                        if (user) {
                            const embed = new EmbedBuilder()
                                .setColor(0x808080)
                                .setTitle('💔 MVP 혜택 만료 안내')
                                .setDescription(
                                    '아쉽게도 MVP 혜택 기간이 모두 종료되어 일반 등급으로 전환되었습니다.\n' +
                                    '그동안의 후원에 다시 한번 감사드립니다!'
                                );
                            user.send({ embeds: [embed] }).catch(() => {});
                        }
                    }
                }
            }
        } catch (error) {
            console.error('MVP 스케줄러 에러:', error);
        }
    }, 60 * 60 * 1000);
});

// ==========================================
// 🎙️ 음성 파밍 — 입/퇴장 이벤트
// ==========================================
client.on('voiceStateUpdate', async (oldState, newState) => {
    if (newState.member?.user.bot) return;
    const discordId = newState.member.id;
    const now = Date.now();

    if (!oldState.channelId && newState.channelId) {
        // 입장
        if (!voiceSessions.has(discordId)) {
            voiceSessions.set(discordId, { joinedAt: now, accumulated: 0 });
        } else {
            voiceSessions.get(discordId).joinedAt = now;
        }
    } else if (oldState.channelId && !newState.channelId) {
        // 퇴장
        const session = voiceSessions.get(discordId);
        if (session && session.joinedAt) {
            session.accumulated += (now - session.joinedAt);
            session.joinedAt = null;
        }
    }
});

// 음성 파밍 포인트 지급 (1분 주기 체크, 10분 누적 시 지급)
// [수정 1] while 루프로 10분 2배 이상 누적 시 잔량 소멸 버그 수정
// [수정 2] 보상 지급 실패 시 타이머 차감 안 함
// [수정 3] GUILD_ID로 정확한 서버 지정 (first() 멀티서버 위험 제거)
setInterval(async () => {
    const now = Date.now();
    const REWARD_INTERVAL = 10 * 60 * 1000;

    for (const [discordId, session] of voiceSessions.entries()) {
        // [수정 3] client.guilds.cache.first() → GUILD_ID로 정확히 지정
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) continue;
        const member = await guild.members.fetch(discordId).catch(() => null);
        if (!member) continue;

        let currentTotal = session.accumulated;
        if (member.voice.channelId && session.joinedAt) {
            currentTotal += (now - session.joinedAt);
        }

        // [수정 1] while 루프 — 10분 2배 이상 누적 시 모두 처리
        while (currentTotal >= REWARD_INTERVAL) {
            try {
                const { data: player } = await supabase
                    .from('players')
                    .select('id, points, premium_tier_expires_at, mvp_expires_at')
                    .eq('discord_id', discordId)
                    .single();

                if (player) {
                    let amount = 5;
                    const nowTime = new Date();
                    const premiumExp = player.premium_tier_expires_at ? new Date(player.premium_tier_expires_at) : null;
                    const mvpExp = player.mvp_expires_at ? new Date(player.mvp_expires_at) : null;

                    if (premiumExp && premiumExp > nowTime) {
                        amount = 8; // Tier 2
                    } else if (mvpExp && mvpExp > nowTime) {
                        amount = 7; // 일반 MVP
                    }

                    const newPoints = (player.points || 0) + amount;
                    await supabase.from('players').update({ points: newPoints }).eq('id', player.id);
                    await supabase.from('point_logs').insert({
                        user_id: player.id,
                        amount: amount,
                        reason: `음성 채널 유지 보상 (10분, +${amount}P)`
                    });

                    // [수정 2] 지급 성공 시에만 타이머 차감
                    currentTotal -= REWARD_INTERVAL;
                } else {
                    // 유저 정보 없으면 루프 탈출 (무한 루프 방지)
                    break;
                }
            } catch (e) {
                console.error('보상 지급 에러:', e);
                // [수정 2] 지급 실패 시 타이머 차감 안 하고 루프 탈출
                break;
            }
        }

        // 최종 누적량 저장
        session.accumulated = currentTotal;
        if (member.voice.channelId) {
            session.joinedAt = now;
        }
    }
}, 60 * 1000);

// ==========================================
// 🤖 상호작용 처리 (명령어 / 버튼 / 모달)
// ==========================================
client.on('interactionCreate', async interaction => {
    const baseApiUrl = getSafeBaseApiUrl();

    // 슬래시 명령어
    if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);
        if (command) await command.execute(interaction, supabase);
    }
    // 자동완성
    else if (interaction.isAutocomplete()) {
        const command = client.commands.get(interaction.commandName);
        if (command) await command.autocomplete(interaction, supabase);
    }
    // 버튼
    else if (interaction.isButton()) {
        // 경매 취소
        if (interaction.customId.startsWith('cancel_')) {
            const auctionId = interaction.customId.replace('cancel_', '');
            try {
                const res = await fetch(`${baseApiUrl}/auction/cancel`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ auction_id: auctionId, user_id: interaction.user.id })
                });
                const data = await res.json().catch(() => ({ success: false, message: '서버 응답 파싱 실패' }));

                if (data.success) {
                    await interaction.update({
                        embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('판매 취소됨').setDescription('매물이 보관함으로 반환되었습니다.')],
                        components: []
                    });
                } else {
                    await interaction.reply({ content: `❌ 취소 실패: ${data.message}`, ephemeral: true });
                }
            } catch (e) { console.error(e); }
        }
        // 경매 입찰 모달 열기
        else if (interaction.customId.startsWith('bid_')) {
            const withoutPrefix = interaction.customId.replace('bid_', '');
            const lastUnderscore = withoutPrefix.lastIndexOf('_');
            const auctionId = withoutPrefix.slice(0, lastUnderscore);
            const minBid = withoutPrefix.slice(lastUnderscore + 1);
            const modal = new ModalBuilder().setCustomId(`modal_bid_${auctionId}`).setTitle('경매 입찰');
            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('bid_amount')
                        .setLabel(`입찰 금액 (최소 ${minBid}P)`)
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                )
            );
            await interaction.showModal(modal);
        }

        // 포켓몬 관련 버튼 (산책 / 진화 / 보관함)
        const commandMap = { 'walk_pet': '산책', 'evolve_pet': '진화', 'open_inventory': '보관함' };
        const targetCmd = commandMap[interaction.customId];
        if (targetCmd) {
            if (interaction.message.interaction && interaction.message.interaction.user.id !== interaction.user.id) {
                return interaction.reply({ content: '❌ 남의 정보 창에서는 버튼을 누를 수 없습니다.', ephemeral: true });
            }
            const cmd = client.commands.get(targetCmd);
            if (cmd) await cmd.execute(interaction, supabase);
        }
    }
    // 모달 제출
    else if (interaction.isModalSubmit()) {
        // 경매 등록 모달
        if (interaction.customId.startsWith('modal_register_')) {
            await interaction.deferReply({ ephemeral: true });
            const selectedValue = interaction.customId.replace('modal_register_', '');
            const firstUnderscore = selectedValue.indexOf('_');
            const type = selectedValue.slice(0, firstUnderscore);
            const targetId = selectedValue.slice(firstUnderscore + 1);

            const startPrice = parseInt(interaction.fields.getTextInputValue('start_price'));
            const durationHours = parseInt(interaction.fields.getTextInputValue('duration_hours'));

            if (!['6', '12', '24'].includes(String(durationHours))) {
                return interaction.editReply('❌ 진행 시간은 6, 12, 24 중 하나여야 합니다.');
            }
            if (isNaN(startPrice) || startPrice <= 0) {
                return interaction.editReply('❌ 시작 가격을 올바르게 입력해주세요.');
            }

            try {
                const res = await fetch(`${baseApiUrl}/auction`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        seller_id: interaction.user.id,
                        sell_type: type,
                        inventory_item_id: type === 'pokemon' ? targetId : null,
                        item_name: type === 'item' ? targetId : null,
                        quantity: 1,
                        start_price: startPrice,
                        duration_hours: durationHours
                    })
                });
                const data = await res.json().catch(() => ({ success: false, message: `통신 상태 오류 (${res.status})` }));

                if (data.success) {
                    await interaction.editReply('✅ 경매 등록이 완료되었습니다!');
                } else {
                    await interaction.editReply(`❌ 등록 실패: ${data.message}`);
                }
            } catch (e) {
                console.error('등록 에러:', e);
                interaction.editReply('❌ 시스템 내부 오류가 발생했습니다.');
            }
        }
        // 입찰 모달
        else if (interaction.customId.startsWith('modal_bid_')) {
            await interaction.deferReply({ ephemeral: true });
            const auctionId = interaction.customId.replace('modal_bid_', '');
            const bidAmount = parseInt(interaction.fields.getTextInputValue('bid_amount'));
            try {
                const res = await fetch(`${baseApiUrl}/auction/bid`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ auction_id: auctionId, bidder_id: interaction.user.id, bid_amount: bidAmount })
                });
                const data = await res.json().catch(() => ({ success: false, message: '서버 응답 파싱 실패' }));

                if (data.success) {
                    await interaction.editReply(`🎉 입찰 성공! 최고 입찰자가 되었습니다.`);
                } else {
                    await interaction.editReply(`❌ 입찰 실패: ${data.message}`);
                }
            } catch (e) {
                interaction.editReply('❌ 통신 에러가 발생했습니다.');
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);