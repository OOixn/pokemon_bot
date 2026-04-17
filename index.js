require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { 
    Client, GatewayIntentBits, Collection, REST, Routes, 
    EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder 
} = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// 1. Supabase (데이터베이스) 연결
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// 2. 디스코드 클라이언트(봇) 생성 및 권한 설정
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates // 🌟 음성 채널 출입 감지 권한
    ]
});

// 3. 명령어 폴더 안의 파일들 불러오기
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

client.once('ready', async () => {
    console.log(`✅ 로그인 성공! 봇 이름: ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('🔄 슬래시 명령어 등록 중...');
        await rest.put(Routes.applicationCommands(client.user.id), { body: commandsForRegister });
        console.log('✅ 슬래시 명령어 등록 완료!');
    } catch (error) { console.error('명령어 등록 에러:', error); }

    // =========================================================
    // ⏰ [자동 알림] 1분마다 경매 마감을 체크해서 채널에 방송합니다!
    // =========================================================
    
    // 🌟 [필수 설정] 알림을 띄울 디스코드 채널의 ID를 입력하세요!
    // (디스코드에서 해당 채팅 채널 우클릭 -> ID 복사)
    const AUCTION_CHANNEL_ID = '1494514674547298448'; 
    
    const announcedAuctions = new Set(); // 중복 알림을 막기 위한 메모리 장부

    setInterval(async () => {
        try {
            const baseApiUrl = process.env.NEXT_PUBLIC_SITE_URL ? `${process.env.NEXT_PUBLIC_SITE_URL}/api` : 'http://localhost:3000/api';
            const res = await fetch(`${baseApiUrl}/auction`);
            const data = await res.json();
            
            if (!data.success) return;

            const auctions = data.data || [];
            const now = Date.now();

            for (const a of auctions) {
                const endAt = new Date(a.end_at).getTime();

                // 1. 마감 시간이 지났고, 아직 알림을 안 보낸 매물인지 확인
                if (endAt <= now && !announcedAuctions.has(a.id)) {
                    announcedAuctions.add(a.id); // 장부에 기록해서 두 번 안 울리게 함

                    // 2. 봇이 꺼져있을 때 종료된 옛날 매물이 재부팅 시 도배되는 것을 방지 (최근 5분 이내 종료건만 알림)
                    if (now - endAt > 5 * 60 * 1000) continue;

                    const channel = client.channels.cache.get(AUCTION_CHANNEL_ID);
                    if (!channel) continue;

                    // 3. 누군가 입찰해서 '낙찰'된 경우만 방송! (유찰된 건 조용히 넘어감)
                    if (a.highest_bidder_id) {
                        
                        // 낙찰자의 디스코드 ID를 가져와서 멘션(@) 처리
                        const { data: winner } = await supabase.from('players').select('discord_id').eq('id', a.highest_bidder_id).single();
                        const winnerMention = winner ? `<@${winner.discord_id}>` : '익명의 소환사';

                        const itemName = a.sell_type === 'item' ? a.item_name : a.pokemon.name_ko;
                        const rarity = a.sell_type === 'item' ? '아이템' : (a.pokemon.rarity || '일반');

                        const embed = new EmbedBuilder()
                            .setColor(0xFFD700)
                            .setTitle('🎉 경매 낙찰 완료!')
                            .setDescription(`축하합니다! ${winnerMention} 님이 치열한 경쟁 끝에\n\`[ ${rarity} ]\` **${itemName}** 매물을 **${a.current_bid.toLocaleString()} P**에 최종 낙찰받았습니다!`)
                            .setFooter({ text: '경매장 수령함에서 매물을 획득하세요!' });

                        if (a.pokemon && (a.pokemon.official_art_url || a.pokemon.sprite_url)) {
                            embed.setThumbnail(a.pokemon.official_art_url || a.pokemon.sprite_url);
                        }

                        // 채널에 확성기 발사!
                        await channel.send({ content: `📢 **경매 마감 알림**`, embeds: [embed] });
                    }
                }
            }
        } catch (error) {
            console.error('경매 마감 체크 타이머 에러:', error);
        }
    }, 60 * 1000); // 60초(1분)마다 실행
});

// =====================================================================
// 💰 [활동 보상] 공통 포인트 지급 함수
// =====================================================================
const pointQueues = new Map(); 

async function awardPoints(discordId, amount, reason) {
    if (!pointQueues.has(discordId)) {
        pointQueues.set(discordId, Promise.resolve());
    }

    const queue = pointQueues.get(discordId).then(async () => {
        try {
            const { data: player } = await supabase.from('players').select('id, points').eq('discord_id', discordId).single();
            if (!player) return;

            const newPoints = (player.points || 0) + amount;
            await supabase.from('players').update({ points: newPoints }).eq('id', player.id);
            
            console.log(`[포인트 획득] ${discordId}님 | +${amount}P (${reason}) | 현재: ${newPoints}P`);
        } catch (error) {
            console.error('포인트 지급 에러:', error);
        }
    });

    pointQueues.set(discordId, queue);
    return queue;
}

// 🎙️ [음성 파밍] 10분당 3P 지급
const voiceIntervals = new Map();
client.on('voiceStateUpdate', (oldState, newState) => {
    if (newState.member.user.bot) return;

    const discordId = newState.member.id;

    if (!oldState.channelId && newState.channelId) {
        const interval = setInterval(async () => {
            await awardPoints(discordId, 5, '음성 채널 10분 유지');
        }, 10 * 60 * 1000); 

        voiceIntervals.set(discordId, interval);
        console.log(`🎙️ [음성 입장] ${discordId}님의 포인트 타이머 가동 시작`);
    }
    else if (oldState.channelId && !newState.channelId) {
        const interval = voiceIntervals.get(discordId);
        if (interval) {
            clearInterval(interval);
            voiceIntervals.delete(discordId);
            console.log(`🔇 [음성 퇴장] ${discordId}님의 포인트 타이머 정지`);
        }
    }
});

// =====================================================================
// 🤖 상호작용(명령어, 버튼, 모달) 통제 로직 (초경량화 라우터)
// =====================================================================
client.on('interactionCreate', async interaction => {
    // API URL 기준 설정
    const baseApiUrl = process.env.NEXT_PUBLIC_SITE_URL ? `${process.env.NEXT_PUBLIC_SITE_URL}/api` : 'http://localhost:3000/api';

    // 1️⃣ 슬래시 명령어
    if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);
        if (!command) return;
        try { await command.execute(interaction, supabase); } 
        catch (error) { console.error(error); }
    } 
    // 2️⃣ 자동완성
    else if (interaction.isAutocomplete()) {
        const command = client.commands.get(interaction.commandName);
        if (!command) return;
        try { await command.autocomplete(interaction, supabase); } 
        catch (error) { console.error(error); }
    }
    // 3️⃣ 🌟 버튼 클릭
    else if (interaction.isButton()) {
        
        // ⚖️ [경매 시스템 - 취소]
        if (interaction.customId.startsWith('cancel_')) {
            const auctionId = interaction.customId.split('_')[1];
            try {
                const { data: player } = await supabase.from('players').select('id').eq('discord_id', interaction.user.id).single();
                if(!player) return;
                const res = await fetch(`${baseApiUrl}/auction/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auction_id: auctionId, user_id: player.id }) });
                const data = await res.json();
                if(data.success) await interaction.update({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('판매 취소됨').setDescription('매물을 취소하고 보관함으로 반환했습니다.')], components: [] });
                else await interaction.reply({ content: `취소 실패: ${data.message}`, ephemeral: true });
            } catch (e) { await interaction.reply({ content: '에러가 발생했습니다.', ephemeral: true }); }
        }
        // ⚖️ [경매 시스템 - 입찰 폼 띄우기]
        else if (interaction.customId.startsWith('bid_')) {
            const [_, auctionId, minBid] = interaction.customId.split('_');
            const modal = new ModalBuilder().setCustomId(`modal_bid_${auctionId}`).setTitle('경매 입찰');
            modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bid_amount').setLabel(`입찰 금액 (최소 ${minBid}P 이상)`).setStyle(TextInputStyle.Short).setRequired(true)));
            await interaction.showModal(modal);
        }
        
        // 🚀 [핵심 라우팅] /내정보 창에서 버튼을 눌렀을 때 해당 파일(명령어)로 즉시 토스!
        const commandMap = {
            'walk_pet': '산책',
            'evolve_pet': '진화',
            'open_inventory': '보관함'
        };

        const targetCommandName = commandMap[interaction.customId];
        
        if (targetCommandName) {
            const targetCommand = client.commands.get(targetCommandName);
            if (targetCommand) {
                await targetCommand.execute(interaction, supabase);
            } else {
                await interaction.reply({ content: `❌ \`/${targetCommandName}\` 명령어를 찾을 수 없습니다. 봇을 재부팅해 보세요.`, ephemeral: true });
            }
        }
    } 
    // 4️⃣ 모달 폼 제출 (경매 등록 및 입찰 처리)
    else if (interaction.isModalSubmit()) {
        
        // 🌟 [핵심 로직] 경매 매물 등록 처리 및 채널 방송
        if (interaction.customId.startsWith('modal_register_')) {
            // 본인에게만 진행 상황이 보이도록 설정
            await interaction.deferReply({ ephemeral: true });
            
            const userName = interaction.member?.displayName || interaction.user.username; // 서버 닉네임 가져오기
            
            // 이름에 '_'가 들어갈 수 있으므로 안전하게 분리
            const selectedValue = interaction.customId.replace('modal_register_', '');
            const [type, ...rest] = selectedValue.split('_'); 
            const targetId = rest.join('_'); 

            const startPrice = parseInt(interaction.fields.getTextInputValue('start_price'));
            const durationHours = parseInt(interaction.fields.getTextInputValue('duration_hours'));

            try {
                const { data: player } = await supabase.from('players').select('id').eq('discord_id', interaction.user.id).single();
                if (!player) return interaction.editReply('❌ 연동된 계정 정보가 없습니다.');
                
                // 1. 등록 전에 방송에 사용할 등급과 이름 조회
                let broadcastName = '';
                let rarityText = '';
                let thumbnailImg = null;

                if (type === 'pokemon') {
                    const { data: invData } = await supabase.from('user_inventory').select('pokemon_id, level').eq('id', targetId).single();
                    if (invData) {
                        const { data: dictData } = await supabase.from('pokemon_dict').select('name_ko, rarity, official_art_url, sprite_url').eq('id', invData.pokemon_id).single();
                        if (dictData) {
                            rarityText = `\`[ ${dictData.rarity || '일반'} ]\``;
                            broadcastName = `[Lv.${invData.level}] ${dictData.name_ko}`;
                            thumbnailImg = dictData.official_art_url || dictData.sprite_url;
                        }
                    }
                } else {
                    rarityText = '📦 `[ 아이템 ]`';
                    broadcastName = targetId;
                }

                // 2. 웹 API 등록 요청
                const payload = { 
                    seller_id: player.id, 
                    sell_type: type, 
                    inventory_item_id: type === 'pokemon' ? targetId : null, 
                    item_name: type === 'item' ? targetId : null, 
                    quantity: 1, 
                    start_price: startPrice, 
                    duration_hours: durationHours 
                };
                
                const response = await fetch(`${baseApiUrl}/auction`, { 
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/json' }, 
                    body: JSON.stringify(payload) 
                });
                const data = await response.json();
                
                if (data.success) {
                    // 3-1. [전체 공개] 채널에 확성기 알림
                    const broadcastEmbed = new EmbedBuilder()
                        .setColor(0xFF9800)
                        .setDescription(`📢 **${userName}** 님이 경매장에 새로운 매물을 등록했습니다!\n\n` +
                                        `**➔ 매물:** ${rarityText} **${broadcastName}**\n` +
                                        `**➔ 시작가:** 💰 **${startPrice.toLocaleString()} P**\n` +
                                        `**➔ 진행 시간:** ⏳ **${durationHours}시간**`)
                        .setFooter({ text: '명령어를 통해 경매장을 확인해 보세요!' });

                    if (thumbnailImg) broadcastEmbed.setThumbnail(thumbnailImg);
                    await interaction.channel.send({ embeds: [broadcastEmbed] });

                    // 3-2. [본인 전용] 성공 메시지
                    await interaction.editReply(`✅ **등록 완료!** 채널에 알림이 전송되었습니다.`);
                } else {
                    await interaction.editReply(`❌ 등록 실패: ${data.message}`);
                }
            } catch (error) { 
                console.error(error);
                interaction.editReply('오류가 발생했습니다.'); 
            }
        }
        
        // 💸 [입찰 처리]
        else if (interaction.customId.startsWith('modal_bid_')) {
            await interaction.deferReply({ ephemeral: true });
            const auctionId = interaction.customId.split('_')[2];
            const bidAmount = parseInt(interaction.fields.getTextInputValue('bid_amount'));
            try {
                const { data: player } = await supabase.from('players').select('id').eq('discord_id', interaction.user.id).single();
                if (!player) return;
                
                const res = await fetch(`${baseApiUrl}/auction/bid`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auction_id: auctionId, bidder_id: player.id, bid_amount: bidAmount }) });
                const data = await res.json();
                
                if (data.success) await interaction.editReply(`🎉 입찰 성공! **${bidAmount.toLocaleString()} P**로 최고 입찰자가 되셨습니다!`);
                else await interaction.editReply(`❌ 입찰 실패: ${data.message}`);
            } catch (e) { interaction.editReply('통신 에러가 발생했습니다.'); }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);