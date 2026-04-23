require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
    Client, GatewayIntentBits, Collection, REST, Routes,
    EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, Events
} = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// ==========================================
// 1. Supabase 연결 (🌟 Realtime 옵션 완전 제거 - 100% Polling 기반)
// ==========================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false }
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
// 4. 채널 ID 설정
// ==========================================
const AUCTION_CHANNEL_ID     = '1494514674547298448';       // 경매 등록/낙찰 알림
const MVP_NOTICE_CHANNEL_ID  = '1496664479998677133';       // MVP 결제 완료 알림
const MVP_EXPIRE_CHANNEL_ID  = '1496664479998677133';       // MVP 만료 알림

const GUILD_ID = process.env.DISCORD_GUILD_ID;

const getSafeBaseApiUrl = () => {
    const rawUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
    const cleanUrl = rawUrl.endsWith('/') ? rawUrl.slice(0, -1) : rawUrl;
    return `${cleanUrl}/api/pokemon`;
};

const voiceSessions = new Map();

// ==========================================
// 5. 봇 준비 완료
// ==========================================
client.once(Events.ClientReady, async () => {
    console.log(`✅ 로그인 성공! 봇 이름: ${client.user.tag}`);

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commandsForRegister });
        console.log('✅ 슬래시 명령어 등록 완료!');
    } catch (error) {
        console.error('명령어 등록 에러:', error);
    }

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
    console.log(`🔄 [재부팅 동기화] 기존 음성 접속자 ${activeUserCount}명의 파밍 타이머 가동!`);

    // ==========================================
    // 🌟 [신규] 경매장 새 매물 감지 (Polling 방식)
    // ==========================================
    let lastAuctionCheckTime = new Date().toISOString();
    try {
        const { data: lastAuction } = await supabase
            .from('auctions')
            .select('created_at')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        if (lastAuction) {
            const lastTime = new Date(lastAuction.created_at);
            lastTime.setMilliseconds(lastTime.getMilliseconds() + 1);
            lastAuctionCheckTime = lastTime.toISOString();
            console.log(`⏱️ [디버그] 경매 감지 기준 시간 복구 완료: ${lastAuctionCheckTime}`);
        }
    } catch (e) {
        console.error('🚨 경매 기준 시간 초기화 에러:', e);
    }

    setInterval(async () => {
        try {
            const { data: newAuctions, error } = await supabase
                .from('auctions')
                .select('*')
                .gt('created_at', lastAuctionCheckTime)
                .order('created_at', { ascending: true });

            if (error || !newAuctions || newAuctions.length === 0) return;

            const channel = client.channels.cache.get(AUCTION_CHANNEL_ID);

            for (const auction of newAuctions) {
                console.log(`🛒 [디버그] 새 경매 감지 (Polling): ${auction.id}`);
                
                if (!channel) continue;

                const { data: seller } = await supabase.from('players').select('discord_id').eq('id', auction.seller_id).single();
                if (!seller) continue;

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

                const lastCreatedAt = new Date(auction.created_at);
                lastCreatedAt.setMilliseconds(lastCreatedAt.getMilliseconds() + 1);
                lastAuctionCheckTime = lastCreatedAt.toISOString();
            }
        } catch (error) {
            console.error('🚨 경매 폴링 에러:', error);
        }
    }, 15000); // 15초마다 새 매물 확인

    // ==========================================
    // 🌟 MVP 결제 감지 (Polling 방식)
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
            const lastTime = new Date(lastTx.created_at);
            lastTime.setMilliseconds(lastTime.getMilliseconds() + 1);
            lastMvpCheckTime = lastTime.toISOString();
            console.log(`⏱️ [디버그] MVP 감지 기준 시간 복구 완료: ${lastMvpCheckTime}`);
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

            const noticeChannel = client.channels.cache.get(MVP_NOTICE_CHANNEL_ID);

            for (const tx of newTxs) {
                console.log(`🔔 [디버그] MVP 결제 감지 (Polling): ${tx.id}`);

                const { data: player } = await supabase
                    .from('players')
                    .select('discord_id, mvp_expires_at')
                    .eq('id', tx.user_id)
                    .single();

                if (!player || !player.discord_id) continue;

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

                if (noticeChannel) {
                    await noticeChannel.send({
                        content: `📢 <@${player.discord_id}>님, MVP 혜택이 정상 적용되었습니다!`,
                        embeds: [embed]
                    });
                }

                const lastCreatedAt = new Date(tx.created_at);
                lastCreatedAt.setMilliseconds(lastCreatedAt.getMilliseconds() + 1);
                lastMvpCheckTime = lastCreatedAt.toISOString();
            }
        } catch (error) {
            console.error('🚨 MVP 폴링 에러:', error);
        }
    }, 15000); // 15초마다 MVP 결제 확인

    // ==========================================
    // ⏰ 경매 마감 체크 (60초 주기)
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
    // ==========================================
    setInterval(async () => {
        try {
            const now = new Date();
            const expireChannel = client.channels.cache.get(MVP_EXPIRE_CHANNEL_ID);

            const { data: mvpPlayers } = await supabase
                .from('players')
                .select('id, discord_id, mvp_expires_at, premium_tier_expires_at')
                .eq('is_mvp', true);

            const { data: tier2Players } = await supabase
                .from('players')
                .select('id, discord_id, premium_tier_expires_at')
                .eq('is_mvp', false)
                .not('premium_tier_expires_at', 'is', null);

            const allPlayers = [...(mvpPlayers || []), ...(tier2Players || [])];

            for (const player of allPlayers) {
                if (!player.discord_id) continue;

                // --- Tier 2 만료 체크 ---
                if (player.premium_tier_expires_at) {
                    const premExp = new Date(player.premium_tier_expires_at);
                    const premDiffMs = premExp.getTime() - now.getTime();
                    const premDiffHours = premDiffMs / (1000 * 60 * 60);

                    if (premDiffHours <= 24 && premDiffHours > 23) {
                        if (expireChannel) {
                            const embed = new EmbedBuilder()
                                .setColor(0xFFA000)
                                .setTitle('💎 최고 티어 혜택 만료 24시간 전')
                                .setDescription('최고 티어(Tier 2) 혜택이 **약 24시간 후 만료**됩니다.\n이후에는 일반 MVP 혜택(Tier 1)으로 전환되어 포인트 지급량이 소폭 감소합니다.');
                            await expireChannel.send({ content: `⚠️ <@${player.discord_id}>님`, embeds: [embed] });
                        }
                    } else if (premDiffMs <= 0) {
                        await supabase.from('players').update({ premium_tier_expires_at: null }).eq('id', player.id);
                        if (expireChannel) {
                            const embed = new EmbedBuilder()
                                .setColor(0x03A9F4)
                                .setTitle('💎 최고 티어 혜택 만료 안내')
                                .setDescription('최고 티어(Tier 2) 기간이 종료되었습니다.\n이제 **일반 MVP 혜택(Tier 1)​**으로 전환됩니다.\n\n(음성방: 8P ➔ 7P / 내전 승리: 30P ➔ 20P, 패배: 25P ➔ 15P)');
                            await expireChannel.send({ content: `📢 <@${player.discord_id}>님`, embeds: [embed] });
                        }
                    }
                }

                // --- 전체 MVP 만료 체크 ---
                if (player.mvp_expires_at) {
                    const mvpExp = new Date(player.mvp_expires_at);
                    const mvpDiffMs = mvpExp.getTime() - now.getTime();
                    const mvpDiffHours = mvpDiffMs / (1000 * 60 * 60);

                    if (mvpDiffHours <= 24 && mvpDiffHours > 23) {
                        if (expireChannel) {
                            const embed = new EmbedBuilder()
                                .setColor(0xFF5722)
                                .setTitle('⚠️ MVP 혜택 만료 24시간 전')
                                .setDescription('MVP 혜택이 **약 24시간 후 만료**됩니다.\n혜택 유지를 원하시면 연장을 고려해 보세요!');
                            await expireChannel.send({ content: `⚠️ <@${player.discord_id}>님`, embeds: [embed] });
                        }
                    } else if (mvpDiffMs <= 0) {
                        await supabase.from('players').update({ is_mvp: false, mvp_expires_at: null, premium_tier_expires_at: null }).eq('id', player.id);
                        if (expireChannel) {
                            const embed = new EmbedBuilder()
                                .setColor(0x808080)
                                .setTitle('💔 MVP 혜택 만료 안내')
                                .setDescription('MVP 혜택 기간이 모두 종료되어 일반 등급으로 전환되었습니다.\n그동안의 후원에 다시 한번 감사드립니다!');
                            await expireChannel.send({ content: `📢 <@${player.discord_id}>님`, embeds: [embed] });
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
        if (!voiceSessions.has(discordId)) {
            voiceSessions.set(discordId, { joinedAt: now, accumulated: 0 });
        } else {
            voiceSessions.get(discordId).joinedAt = now;
        }
    } else if (oldState.channelId && !newState.channelId) {
        const session = voiceSessions.get(discordId);
        if (session && session.joinedAt) {
            session.accumulated += (now - session.joinedAt);
            session.joinedAt = null;
        }
    }
});

// 음성 파밍 포인트 지급 (1분 주기 체크)
setInterval(async () => {
    const now = Date.now();
    const REWARD_INTERVAL = 10 * 60 * 1000;

    for (const [discordId, session] of voiceSessions.entries()) {
const guild = GUILD_ID ? client.guilds.cache.get(GUILD_ID) : client.guilds.cache.first();        if (!guild) continue;
        const member = await guild.members.fetch(discordId).catch(() => null);
        if (!member) continue;

        let currentTotal = session.accumulated;
        if (member.voice.channelId && session.joinedAt) {
            currentTotal += (now - session.joinedAt);
        }

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
                        amount = 8;
                    } else if (mvpExp && mvpExp > nowTime) {
                        amount = 7;
                    }

                    const newPoints = (player.points || 0) + amount;
                    await supabase.from('players').update({ points: newPoints }).eq('id', player.id);
                    await supabase.from('point_logs').insert({
                        user_id: player.id,
                        amount: amount,
                        reason: `음성 채널 유지 보상 (10분, +${amount}P)`
                    });

                    currentTotal -= REWARD_INTERVAL;
                } else {
                    break;
                }
            } catch (e) {
                console.error('보상 지급 에러:', e);
                break;
            }
        }

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

    if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);
        if (command) await command.execute(interaction, supabase);
    }
    else if (interaction.isAutocomplete()) {
        const command = client.commands.get(interaction.commandName);
        if (command) await command.autocomplete(interaction, supabase);
    }
    else if (interaction.isButton()) {
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
    else if (interaction.isModalSubmit()) {
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