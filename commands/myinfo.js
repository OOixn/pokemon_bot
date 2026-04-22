const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('내정보')
        .setDescription('나의 파티(장착 포켓몬) 상태와 보유 자산, 그리고 MVP 구독 정보를 확인합니다.'),

    async execute(interaction, supabase) {
        await interaction.deferReply({ ephemeral: true }); 
        const myDiscordId = interaction.user.id;
        
        // 서버 내 별명 최우선
        const userName = interaction.member?.displayName || interaction.user.username;
        const eggEmoji = '<:3F3F3F:1493572170931241051>';

        try {
            // 1. 유저 기본 정보 및 MVP 내역 조회
            const { data: player } = await supabase.from('players')
                .select('id, points, is_mvp, mvp_expires_at, premium_tier_expires_at')
                .eq('discord_id', myDiscordId).single();
                
            if (!player) return interaction.editReply('❌ 연동된 계정 정보가 없습니다.');

            // 🌟 2. [수정] 장착 중인 포켓몬 '전체' 조회 (슬롯 순 정렬)
            const { data: equippedInvs } = await supabase.from('user_inventory')
                .select('*')
                .eq('user_id', player.id)
                .eq('status', 'equipped')
                .order('equip_slot', { ascending: true });

            if (!equippedInvs || equippedInvs.length === 0) {
                return interaction.editReply('🎒 장착 중인 포켓몬이 없습니다. `/장착`을 먼저 해주세요!');
            }

            // 🌟 3. 장착 중인 포켓몬들의 도감 정보 한 번에 조회
            const pokeIds = equippedInvs.map(inv => inv.pokemon_id);
            const { data: pokeDicts } = await supabase.from('pokemon_dict')
                .select('*')
                .in('id', pokeIds);

            // 4. 아이템(진화의 돌) 조회
            const { data: items } = await supabase.from('user_items')
                .select('item_name, quantity')
                .eq('user_id', player.id)
                .gt('quantity', 0);

            const stoneIcons = { '불꽃의 돌': '🔥', '물의 돌': '💧', '천둥의 돌': '⚡', '리프의 돌': '🍃', '달의 돌': '🌙' };
            const stoneText = items?.length > 0 
                ? items.map(i => `${stoneIcons[i.item_name] || '💎'} ${i.quantity}`).join(' ')
                : '없음';

            // 5. MVP 구독 상태 및 혜택 텍스트 생성
            const now = new Date();
            const premiumExp = player.premium_tier_expires_at ? new Date(player.premium_tier_expires_at) : null;
            const mvpExp = player.mvp_expires_at ? new Date(player.mvp_expires_at) : null;

            let mvpTitle = '👤 일반 등급';
            let mvpBenefits = '음성방 5P / 내전 20P';
            let mvpExpireText = '';
            let embedColor = 0x2B2D31;

            if (premiumExp && premiumExp > now) {
                mvpTitle = '💎 최고 티어 MVP (Tier 2)';
                mvpBenefits = '음성방 8P / 내전 30P';
                embedColor = 0x03A9F4;
                mvpExpireText = `\n⏳ **만료일:** <t:${Math.floor(premiumExp.getTime()/1000)}:f> (<t:${Math.floor(premiumExp.getTime()/1000)}:R>)`;
            } else if (mvpExp && mvpExp > now) {
                mvpTitle = '👑 일반 MVP (Tier 1)';
                mvpBenefits = '음성방 7P / 내전 20P';
                embedColor = 0xFFD700;
                mvpExpireText = `\n⏳ **만료일:** <t:${Math.floor(mvpExp.getTime()/1000)}:f> (<t:${Math.floor(mvpExp.getTime()/1000)}:R>)`;
            }

            // 🌟 6. 파티 포켓몬 정보 텍스트 조합 루프
            let pokeContent = '';
            let mainThumbnail = null;

            const emojis = {
                l_fill: '<:exp_L_fill:1493583981885653063>', m_fill: '<:exp_M_fill:1493584014366343358>', r_fill: '<:exp_R_fill:1493584049434787992>',
                l_emp:  '<:exp_L_emp:1493584084361019412>', m_emp:  '<:exp_M_emp:1493584109891616870>', r_emp:  '<:exp_R_emp:1493584150219854026>'
            };

            for (let i = 0; i < equippedInvs.length; i++) {
                const inv = equippedInvs[i];
                const dict = pokeDicts.find(d => d.id === inv.pokemon_id);
                if (!dict) continue;

                const rarityText = `[ ${dict.rarity || '일반'} ]`;
                const maxExp = 100;
                const currentExp = inv.exp || 0;
                const filledBlocks = Math.floor((currentExp / maxExp) * 10); 

                // 경험치 바 생성
                let expBar = '';
                expBar += (filledBlocks > 0) ? emojis.l_fill : emojis.l_emp;
                let midFilledCount = Math.max(0, Math.min(filledBlocks - 1, 8));
                let midEmptyCount = Math.max(0, 8 - midFilledCount);
                expBar += emojis.m_fill.repeat(midFilledCount);
                expBar += emojis.m_emp.repeat(midEmptyCount);
                expBar += (filledBlocks === 10) ? emojis.r_fill : emojis.r_emp;

                // 슬롯 뱃지 (메인/서브)
                const slotPrefix = inv.equip_slot === 1 ? '🥇 메인' : (inv.equip_slot === 2 ? '🥈 서브' : '🥉 서브');

                pokeContent += `> ### **${slotPrefix} | Lv.${inv.level} ${dict.name_ko}** \`${rarityText}\`\n`;
                pokeContent += `${expBar} -# ${eggEmoji} (${currentExp}/${maxExp} XP)\n\n`;

                // 첫 번째 포켓몬(메인)의 이미지를 대표 썸네일로 설정
                if (inv.equip_slot === 1 || i === 0) {
                    mainThumbnail = dict.official_art_url || dict.sprite_url;
                }
            }

            const content = [
                pokeContent.trim(),
                '',
                `* **보유 포인트**: 💰 **${player.points.toLocaleString()} P**`,
                `* **진화의 돌**: ${stoneText}`,
                '',
                `**[현재 구독 혜택]**`,
                `**${mvpTitle}** (적용 혜택: ${mvpBenefits})${mvpExpireText}`
            ].join('\n');

            const embed = new EmbedBuilder()
                .setColor(embedColor)
                .setTitle(`📊 ${userName} 님의 파티 정보`)
                .setDescription(content);
            
            if (mainThumbnail) embed.setThumbnail(mainThumbnail);

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