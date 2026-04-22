const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('내정보')
        .setDescription('나의 포켓몬 상태와 보유 자산, 그리고 MVP 구독 정보를 확인합니다.'),

    async execute(interaction, supabase) {
        await interaction.deferReply({ ephemeral: true }); 
        const myDiscordId = interaction.user.id;
        
        // 서버 내 별명 최우선
        const userName = interaction.member?.displayName || interaction.user.username;
        const eggEmoji = '<:3F3F3F:1493572170931241051>';

        try {
            const { data: player } = await supabase.from('players')
                .select('id, points, is_mvp, mvp_expires_at, premium_tier_expires_at')
                .eq('discord_id', myDiscordId).single();
                
            if (!player) return interaction.editReply('❌ 연동된 계정 정보가 없습니다.');

            const { data: equippedInv } = await supabase.from('user_inventory').select('*').eq('user_id', player.id).eq('status', 'equipped').maybeSingle();
            if (!equippedInv) return interaction.editReply('🎒 장착 중인 포켓몬이 없습니다. `/장착`을 먼저 해주세요!');

            const { data: pokeDict } = await supabase.from('pokemon_dict').select('*').eq('id', equippedInv.pokemon_id).single();
            const { data: items } = await supabase.from('user_items').select('item_name, quantity').eq('user_id', player.id).gt('quantity', 0);

            const rarity = pokeDict.rarity || '일반';
            const rarityText = `[ ${rarity} ]`;

            const stoneIcons = { '불꽃의 돌': '🔥', '물의 돌': '💧', '천둥의 돌': '⚡', '리프의 돌': '🍃', '달의 돌': '🌙' };
            const stoneText = items?.length > 0 
                ? items.map(i => `${stoneIcons[i.item_name] || '💎'} ${i.quantity}`).join(' ')
                : '없음';

            // ==========================================
            // 🌟 [추가] MVP 구독 상태 및 혜택 텍스트 생성
            // ==========================================
            const now = new Date();
            const premiumExp = player.premium_tier_expires_at ? new Date(player.premium_tier_expires_at) : null;
            const mvpExp = player.mvp_expires_at ? new Date(player.mvp_expires_at) : null;

            let mvpTitle = '👤 일반 등급';
            let mvpBenefits = '음성방 5P / 내전 20P';
            let mvpExpireText = '';
            let embedColor = 0x2B2D31; // 일반 색상

            // 1순위: 최고 티어 (3개월권)
            if (premiumExp && premiumExp > now) {
                mvpTitle = '💎 최고 티어 MVP (Tier 2)';
                mvpBenefits = '음성방 8P / 내전 30P';
                embedColor = 0x03A9F4; // 파란색
                mvpExpireText = `\n⏳ **만료일:** <t:${Math.floor(premiumExp.getTime()/1000)}:f> (<t:${Math.floor(premiumExp.getTime()/1000)}:R>)`;
            } 
            // 2순위: 일반 MVP
            else if (mvpExp && mvpExp > now) {
                mvpTitle = '👑 일반 MVP (Tier 1)';
                mvpBenefits = '음성방 7P / 내전 20P';
                embedColor = 0xFFD700; // 황금색
                mvpExpireText = `\n⏳ **만료일:** <t:${Math.floor(mvpExp.getTime()/1000)}:f> (<t:${Math.floor(mvpExp.getTime()/1000)}:R>)`;
            }

            // ==========================================
            // 경험치 바 로직
            // ==========================================
            const maxExp = 100;
            const currentExp = equippedInv.exp || 0;
            const filledBlocks = Math.floor((currentExp / maxExp) * 10); 

            const emojis = {
                l_fill: '<:exp_L_fill:1493583981885653063>', m_fill: '<:exp_M_fill:1493584014366343358>', r_fill: '<:exp_R_fill:1493584049434787992>',
                l_emp:  '<:exp_L_emp:1493584084361019412>', m_emp:  '<:exp_M_emp:1493584109891616870>', r_emp:  '<:exp_R_emp:1493584150219854026>'
            };

            let expBar = '';
            expBar += (filledBlocks > 0) ? emojis.l_fill : emojis.l_emp;
            
            let midFilledCount = Math.max(0, filledBlocks - 1);
            let midEmptyCount = Math.max(0, 8 - midFilledCount);
            midFilledCount = Math.min(midFilledCount, 8); 
            midEmptyCount = 8 - midFilledCount;

            expBar += emojis.m_fill.repeat(midFilledCount);
            expBar += emojis.m_emp.repeat(midEmptyCount);
            
            expBar += (filledBlocks === 10) ? emojis.r_fill : emojis.r_emp;

            const content = [
                `> ### **Lv.${equippedInv.level} ${pokeDict.name_ko}** \`${rarityText}\``,
                `${expBar}`, 
                `-# ${eggEmoji} (${currentExp}/${maxExp} XP)`, 
                '',
                `* **보유 포인트**: 💰 **${player.points.toLocaleString()} P**`,
                `* **진화의 돌**: ${stoneText}`,
                '',
                `**[현재 구독 혜택]**`,
                `**${mvpTitle}** (적용 혜택: ${mvpBenefits})${mvpExpireText}`
            ].join('\n');

            const embed = new EmbedBuilder()
                .setColor(embedColor) // 등급에 따라 임베드 색상도 바뀜!
                .setTitle(`📊 ${userName} 님의 정보`)
                .setDescription(content)
                .setThumbnail(pokeDict.official_art_url || pokeDict.sprite_url);

            const btnRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('walk_pet').setLabel('산책').setEmoji('🌳').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('evolve_pet').setLabel('진화').setEmoji('✨').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('open_inventory').setLabel('보관함').setEmoji('🎒').setStyle(ButtonStyle.Secondary)
            );

            await interaction.editReply({ embeds: [embed], components: [btnRow] });

        } catch (error) {
            console.error(error);
            await interaction.editReply('데이터를 불러오는 중 오류가 발생했습니다.');
        }
    },
};