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

// 2. 디스코드 클라이언트 생성
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

const voiceSessions = new Map();

// 💡 URL 슬래시 겹침 방지 헬퍼 함수
const getSafeBaseApiUrl = () => {
    const rawUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
    const cleanUrl = rawUrl.endsWith('/') ? rawUrl.slice(0, -1) : rawUrl;
    return `${cleanUrl}/api/pokemon`;
};

// 봇 준비 완료 이벤트
client.once('ready', async () => {
    console.log(`✅ 로그인 성공! 봇 이름: ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commandsForRegister });
        console.log('✅ 슬래시 명령어 등록 완료!');
    } catch (error) { console.error('명령어 등록 에러:', error); }

    // 🔄 [재부팅 동기화]
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

    const GUILD_ID = process.env.DISCORD_GUILD_ID;
    const AUCTION_CHANNEL_ID = '1494514674547298448'; 

    // 📡 [리스너 1] 웹 장착 감지 및 디스코드 역할 지급
    if (GUILD_ID) {
        supabase.channel('equip-listener')
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'user_inventory', filter: 'status=eq.equipped' },
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
                    } catch (error) { console.error('🚨 웹 장착 감지 에러:', error); }
                }
            ).subscribe();
    }

    // 📡 [새로운 리스너 2] 웹/봇 통합: 경매 매물 등록 실시간 감지 알림
    supabase.channel('auction-insert-listener')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'auctions' },
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
                        const { data: inv } = await supabase.from('user_inventory').select('pokemon:pokemon_dict(name_ko, rarity, official_art_url, sprite_url)').eq('id', auction.inventory_item_id).single();
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
                        .setDescription(`<@${seller.discord_id}>님이 새로운 매물을 등록했습니다!\n\n**[${rarity}] ${itemName}**\n💰 시작가: **${auction.start_price.toLocaleString()} P**\n⏳ 마감: <t:${Math.floor(new Date(auction.end_at).getTime() / 1000)}:R>`)
                        .setTimestamp();

                    if (thumb) embed.setThumbnail(thumb);

                    await channel.send({ content: `📢 **새로운 경매 매물 등록**`, embeds: [embed] });
                } catch (error) { console.error('🚨 경매 등록 알림 에러:', error); }
            }
        ).subscribe();

    // ⏰ [자동 알림] 1분마다 경매 마감 체크
    const announcedAuctions = new Set();
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
                if (endAt <= now && !announcedAuctions.has(a.id)) {
                    announcedAuctions.add(a.id);
                    if (now - endAt > 5 * 60 * 1000) continue;

                    const channel = client.channels.cache.get(AUCTION_CHANNEL_ID);
                    if (!channel) continue;

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

// 🎙️ [음성 파밍]
client.on('voiceStateUpdate', async (oldState, newState) => {
    if (newState.member?.user.bot) return;
    const discordId = newState.member.id;
    const now = Date.now();

    if (!oldState.channelId && newState.channelId) {
        if (!voiceSessions.has(discordId)) {
            voiceSessions.set(discordId, { joinedAt: now, accumulated: 0 });
        } else {
            const session = voiceSessions.get(discordId);
            session.joinedAt = now;
        }
    }
    else if (oldState.channelId && !newState.channelId) {
        const session = voiceSessions.get(discordId);
        if (session && session.joinedAt) {
            session.accumulated += (now - session.joinedAt);
            session.joinedAt = null;
        }
    }
});

setInterval(async () => {
    const now = Date.now();
    const REWARD_INTERVAL = 10 * 60 * 1000; 

    for (const [discordId, session] of voiceSessions.entries()) {
        const guild = client.guilds.cache.first();
        if (!guild) continue;
        const member = await guild.members.fetch(discordId).catch(() => null);
        if (!member) continue;

        let currentTotal = session.accumulated;
        if (member.voice.channelId && session.joinedAt) {
            currentTotal += (now - session.joinedAt);
        }

        if (currentTotal >= REWARD_INTERVAL) {
            try {
                const { data: player } = await supabase.from('players').select('id, points').eq('discord_id', discordId).single();
                if (player) {
                    const amount = 5;
                    const newPoints = (player.points || 0) + amount;
                    await supabase.from('players').update({ points: newPoints }).eq('id', player.id);
                    await supabase.from('point_logs').insert({ user_id: player.id, amount: amount, reason: '음성 채널 유지 보상 (10분)' });
                }
            } catch (e) { console.error('보상 지급 중 에러:', e); }

            if (member.voice.channelId) {
                session.joinedAt = now;
                session.accumulated = currentTotal - REWARD_INTERVAL;
            } else {
                session.accumulated -= REWARD_INTERVAL;
            }
        }
    }
}, 60 * 1000);

// 🤖 상호작용 (명령어, 버튼, 모달) 처리
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
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, 
                    body: JSON.stringify({ auction_id: auctionId, user_id: interaction.user.id }) 
                });
                
                // 🌟 무조건 JSON을 파싱해서 API의 메시지를 꺼냅니다!
                const data = await res.json().catch(() => ({ success: false, message: '서버 응답 파싱 실패' }));
                
                if (data.success) {
                    await interaction.update({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('판매 취소됨').setDescription('매물이 보관함으로 반환되었습니다.')], components: [] });
                } else {
                    await interaction.reply({ content: `❌ 취소 실패: ${data.message}`, ephemeral: true });
                }
            } catch(e) { console.error(e); }
        }
        else if (interaction.customId.startsWith('bid_')) {
            const withoutPrefix = interaction.customId.replace('bid_', ''); 
            const lastUnderscore = withoutPrefix.lastIndexOf('_');
            const auctionId = withoutPrefix.slice(0, lastUnderscore);  
            const minBid = withoutPrefix.slice(lastUnderscore + 1);    
            const modal = new ModalBuilder().setCustomId(`modal_bid_${auctionId}`).setTitle('경매 입찰');
            modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bid_amount').setLabel(`입찰 금액 (최소 ${minBid}P)`).setStyle(TextInputStyle.Short).setRequired(true)));
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
        // ========== [경매 등록 모달] ==========
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
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, 
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
                
                // 🌟 핵심: 에러가 나더라도 무조건 JSON을 뜯어서 상세 사유를 꺼냅니다!
                const data = await res.json().catch(() => ({ success: false, message: `통신 상태 오류 (${res.status})` }));
                
                if (data.success) {
                    await interaction.editReply('✅ 경매 등록이 완료되었습니다!');
                } else {
                    // API에서 보내준 친절한 메시지 (예: 이미 등록된 매물입니다)를 출력
                    await interaction.editReply(`❌ 등록 실패: ${data.message}`);
                }
            } catch (e) { 
                console.error('등록 에러:', e); 
                interaction.editReply('❌ 시스템 내부 오류가 발생했습니다.'); 
            }
        }
        // ========== [입찰 모달] ==========
        else if (interaction.customId.startsWith('modal_bid_')) {
            await interaction.deferReply({ ephemeral: true });
            const auctionId = interaction.customId.replace('modal_bid_', '');
            const bidAmount = parseInt(interaction.fields.getTextInputValue('bid_amount'));
            try {
                const res = await fetch(`${baseApiUrl}/auction/bid`, { 
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, 
                    body: JSON.stringify({ auction_id: auctionId, bidder_id: interaction.user.id, bid_amount: bidAmount }) 
                });
                
                // 🌟 입찰 시에도 API 메시지를 뜯어옵니다!
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