require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { 
    Client, GatewayIntentBits, Collection, REST, Routes, 
    EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder 
} = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// 1. Supabase 연결
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// 2. 디스코드 클라이언트 생성 (음성 상태 감지 권한 포함)
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates 
    ]
});

// 3. 명령어 로드
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

// 🎙️ 전역 음성 세션 메모리 장부
const voiceSessions = new Map();

// 봇 준비 완료 이벤트
client.once('ready', async () => {
    console.log(`✅ 로그인 성공! 봇 이름: ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commandsForRegister });
        console.log('✅ 슬래시 명령어 등록 완료!');
    } catch (error) { console.error('명령어 등록 에러:', error); }

    // =========================================================
    // 🔍 [재부팅 동기화] 현재 접속 중인 유저 타이머 일괄 가동!
    // =========================================================
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

    // =========================================================
    // ⏰ [자동 알림] 1분마다 경매 마감 체크
    // =========================================================
    const AUCTION_CHANNEL_ID = '1494514674547298448'; 
    const announcedAuctions = new Set();

    setInterval(async () => {
        try {
            const baseApiUrl = process.env.NEXT_PUBLIC_SITE_URL ? `${process.env.NEXT_PUBLIC_SITE_URL}/api/pokemon` : 'http://localhost:3000/api';
            const res = await fetch(`${baseApiUrl}/auction`);
            const data = await res.json();
            if (!data.success) return;

            const auctions = data.data || [];
            const now = Date.now();

            for (const a of auctions) {
                const endAt = new Date(a.end_at).getTime();
                if (endAt <= now && !announcedAuctions.has(a.id)) {
                    announcedAuctions.add(a.id);
                    if (now - endAt > 5 * 60 * 1000) continue; // 5분 지난 옛날 건 패스

                    const channel = client.channels.cache.get(AUCTION_CHANNEL_ID);
                    if (!channel) continue;

                    // 낙찰자가 있을 때만 방송
                    if (a.highest_bidder_id) {
                        const { data: winner } = await supabase.from('players').select('discord_id').eq('id', a.highest_bidder_id).single();
                        const winnerMention = winner ? `<@${winner.discord_id}>` : '익명의 소환사';
                        const itemName = a.sell_type === 'item' ? a.item_name : a.pokemon.name_ko;
                        const rarity = a.sell_type === 'item' ? '아이템' : (a.pokemon.rarity || '일반');

                        const embed = new EmbedBuilder()
                            .setColor(0xFFD700)
                            .setTitle('🎉 경매 낙찰 완료!')
                            .setDescription(`축하합니다! ${winnerMention} 님이 치열한 경쟁 끝에\n[ ${rarity} ] **${itemName}** 매물을 **${a.current_bid.toLocaleString()} P**에 최종 낙찰받았습니다!`)
                            .setFooter({ text: '경매장 수령함에서 매물을 획득하세요!' });

                        if (a.pokemon && (a.pokemon.official_art_url || a.pokemon.sprite_url)) {
                            embed.setThumbnail(a.pokemon.official_art_url || a.pokemon.sprite_url);
                        }
                        await channel.send({ content: `📢 **경매 마감 알림**`, embeds: [embed] });
                    }
                }
            }
        } catch (error) { console.error('경매 체크 에러:', error); }
    }, 60 * 1000);
});

// =====================================================================
// 🎙️ [음성 파밍] 누적 시간 시스템 (10분당 5P + 로그 기록)
// =====================================================================
client.on('voiceStateUpdate', async (oldState, newState) => {
    if (newState.member?.user.bot) return;
    const discordId = newState.member.id;
    const now = Date.now();

    // 1. 입장 (또는 채널 이동 시작)
    if (!oldState.channelId && newState.channelId) {
        if (!voiceSessions.has(discordId)) {
            voiceSessions.set(discordId, { joinedAt: now, accumulated: 0 });
        } else {
            const session = voiceSessions.get(discordId);
            session.joinedAt = now;
        }
        console.log(`🎙️ [음성 입장/재개] ${discordId}`);
    }
    // 2. 완전 퇴장
    else if (oldState.channelId && !newState.channelId) {
        const session = voiceSessions.get(discordId);
        if (session && session.joinedAt) {
            session.accumulated += (now - session.joinedAt);
            session.joinedAt = null;
            console.log(`🔇 [음성 퇴장] ${discordId} | 누적: ${Math.floor(session.accumulated / 1000)}초`);
        }
    }
});

// ⏰ 1분마다 누적 시간 검사 및 포인트 지급
setInterval(async () => {
    const now = Date.now();
    const REWARD_INTERVAL = 10 * 60 * 1000; // 10분

    for (const [discordId, session] of voiceSessions.entries()) {
        const guild = client.guilds.cache.first();
        if (!guild) continue;
        const member = await guild.members.fetch(discordId).catch(() => null);
        if (!member) continue;

        let currentTotal = session.accumulated;
        if (member.voice.channelId && session.joinedAt) {
            currentTotal += (now - session.joinedAt);
        }

        // 10분 돌파 시 보상 지급
        if (currentTotal >= REWARD_INTERVAL) {
            try {
                const { data: player } = await supabase.from('players').select('id, points').eq('discord_id', discordId).single();
                if (player) {
                    const amount = 5;
                    const newPoints = (player.points || 0) + amount;
                    
                    // DB 포인트 업데이트
                    await supabase.from('players').update({ points: newPoints }).eq('id', player.id);
                    
                    // 🌟 포인트 로그 기록
                    await supabase.from('point_logs').insert({
                        user_id: player.id,
                        amount: amount,
                        reason: '음성 채널 유지 보상 (10분)'
                    });

                    console.log(`💰 [보상 지급] ${discordId} | +${amount}P | 로그 기록 완료`);
                }
            } catch (e) { console.error('보상 지급 중 에러:', e); }

            // 세션 시간 차감 및 기준점 갱신
            if (member.voice.channelId) {
                session.joinedAt = now;
                session.accumulated = currentTotal - REWARD_INTERVAL;
            } else {
                session.accumulated -= REWARD_INTERVAL;
            }
        }
    }
}, 60 * 1000);

// =====================================================================
// 🤖 상호작용 (명령어, 버튼, 모달) 처리
// =====================================================================
client.on('interactionCreate', async interaction => {
    const baseApiUrl = process.env.NEXT_PUBLIC_SITE_URL ? `${process.env.NEXT_PUBLIC_SITE_URL}/api` : 'http://localhost:3000/api';

    // 1️⃣ 슬래시 명령어
    if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);
        if (command) await command.execute(interaction, supabase);
    } 
    // 2️⃣ 자동완성
    else if (interaction.isAutocomplete()) {
        const command = client.commands.get(interaction.commandName);
        if (command) await command.autocomplete(interaction, supabase);
    }
    // 3️⃣ 버튼
    else if (interaction.isButton()) {
        // 경매 취소
        if (interaction.customId.startsWith('cancel_')) {
            const auctionId = interaction.customId.split('_')[1];
            const { data: player } = await supabase.from('players').select('id').eq('discord_id', interaction.user.id).single();
            if(!player) return;
            const res = await fetch(`${baseApiUrl}/auction/cancel`, { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ auction_id: auctionId, user_id: player.id }) 
            });
            const data = await res.json();
            if(data.success) await interaction.update({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('판매 취소됨').setDescription('매물이 보관함으로 반환되었습니다.')], components: [] });
        }
        // 입찰 모달 띄우기
        else if (interaction.customId.startsWith('bid_')) {
            const [_, auctionId, minBid] = interaction.customId.split('_');
            const modal = new ModalBuilder().setCustomId(`modal_bid_${auctionId}`).setTitle('경매 입찰');
            modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bid_amount').setLabel(`입찰 금액 (최소 ${minBid}P)`).setStyle(TextInputStyle.Short).setRequired(true)));
            await interaction.showModal(modal);
        }
        
        // 🌟 [어뷰징 방지 추가] 내정보 버튼 연동
        const commandMap = { 'walk_pet': '산책', 'evolve_pet': '진화', 'open_inventory': '보관함' };
        const targetCmd = commandMap[interaction.customId];
        
        if (targetCmd) {
            // 버튼을 누른 사람이 이 메시지를 생성한 주인인지 검사
            if (interaction.message.interaction && interaction.message.interaction.user.id !== interaction.user.id) {
                return interaction.reply({ 
                    content: '❌ 남의 정보 창에서는 버튼을 누를 수 없습니다. 직접 `/내정보`를 입력해 주세요!', 
                    ephemeral: true 
                });
            }

            const cmd = client.commands.get(targetCmd);
            if (cmd) await cmd.execute(interaction, supabase);
        }
    } 
    // 4️⃣ 모달 폼 제출
    else if (interaction.isModalSubmit()) {
        // 경매 등록 처리
        if (interaction.customId.startsWith('modal_register_')) {
            await interaction.deferReply({ ephemeral: true });
            const selectedValue = interaction.customId.replace('modal_register_', '');
            const [type, ...rest] = selectedValue.split('_');
            const targetId = rest.join('_');
            const startPrice = parseInt(interaction.fields.getTextInputValue('start_price'));
            const durationHours = parseInt(interaction.fields.getTextInputValue('duration_hours'));

            try {
                const { data: player } = await supabase.from('players').select('id').eq('discord_id', interaction.user.id).single();
                if (!player) return;

                const response = await fetch(`${baseApiUrl}/auction`, { 
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/json' }, 
                    body: JSON.stringify({ seller_id: player.id, sell_type: type, inventory_item_id: type === 'pokemon' ? targetId : null, item_name: type === 'item' ? targetId : null, quantity: 1, start_price: startPrice, duration_hours: durationHours }) 
                });
                const data = await response.json();
                if (data.success) {
                    await interaction.editReply('✅ 경매 등록이 완료되었습니다!');
                    await interaction.channel.send(`📢 **${interaction.member?.displayName || interaction.user.username}** 님이 경매장에 새로운 매물을 등록했습니다!`);
                }
            } catch (e) { console.error(e); }
        }
        // 입찰 처리
        else if (interaction.customId.startsWith('modal_bid_')) {
            await interaction.deferReply({ ephemeral: true });
            const auctionId = interaction.customId.split('_')[2];
            const bidAmount = parseInt(interaction.fields.getTextInputValue('bid_amount'));
            const { data: player } = await supabase.from('players').select('id').eq('discord_id', interaction.user.id).single();
            const res = await fetch(`${baseApiUrl}/auction/bid`, { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ auction_id: auctionId, bidder_id: player.id, bid_amount: bidAmount }) 
            });
            const data = await res.json();
            if (data.success) await interaction.editReply(`🎉 입찰 성공! 최고 입찰자가 되었습니다.`);
            else await interaction.editReply(`❌ 실패: ${data.message}`);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);