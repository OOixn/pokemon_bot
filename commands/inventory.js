const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('보관함')
        .setDescription('내 포켓몬 보유 현황을 확인하고 등급별로 조회합니다.'),

    async execute(interaction, supabase) {
        // 🌟 [핵심 변경] ephemeral: true 를 추가하여 '명령어를 친 본인'에게만 보이고 타인에겐 보이지 않게 합니다.
        await interaction.deferReply({ ephemeral: true });
        const discordId = interaction.user.id;

        // 서버 닉네임 최우선 적용
        const userName = interaction.member?.displayName || interaction.user.username;

        // 🌟 커스텀 이모지 매핑
        const rarityIcons = {
            '일반': '<:pokeball:1493611180520898711>',
            '희귀': '<:greatball:1493611163450081480>',
            '진화체': '<:greatball:1493611163450081480>', 
            '에픽': '<:ultraball:1493611150368309388>',
            '전설': '<:masterball:1493611136363266139>',
            '환상': '<:premierball:1493611120278110390>',
            '히든': '<:luxuryball:1493611101126918337>'
        };
        const eggEmoji = '<:3F3F3F:1493572170931241051>';

        try {
            // 1️⃣ players 테이블에서 discord_id로 '진짜 id' 찾기
            const { data: player, error: playerError } = await supabase
                .from('players')
                .select('id')
                .eq('discord_id', discordId)
                .single();

            if (playerError || !player) {
                return interaction.editReply('❌ 연동된 계정 정보가 없습니다. 마이페이지에서 디스코드 연동을 먼저 진행해 주세요!');
            }

            const myPlayerId = player.id; 

            // 2️⃣ 도감 데이터와 내 보관함 데이터 가져오기
            const { data: dictData } = await supabase.from('pokemon_dict').select('*');
            const { data: invData } = await supabase.from('user_inventory').select('*').eq('user_id', myPlayerId);

            if (!invData || invData.length === 0) {
                return interaction.editReply(`${eggEmoji} 보관함이 비어있습니다. 상점에서 알을 부화시켜 보세요!`);
            }

            // 3️⃣ 인벤토리 데이터에 도감 정보 매핑 및 등급 분류
            const myPokemons = invData.map(item => {
                const poke = dictData.find(p => p.id === item.pokemon_id) || {};
                return { ...item, name: poke.name_ko || '알 수 없음', rarity: poke.rarity || '일반' };
            });

            // 등급별 카운트 계산
            const counts = { '일반': 0, '희귀': 0, '진화체': 0, '에픽': 0, '전설': 0, '환상': 0, '히든': 0 };
            myPokemons.forEach(p => { if (counts[p.rarity] !== undefined) counts[p.rarity]++; });

            // 4️⃣ 초기 요약 화면 (Embed) 생성 - 이모지 적용
            const summaryEmbed = new EmbedBuilder()
                .setColor(0x2B2D31)
                .setTitle(`🎒 ${userName} 님의 보관함 요약`)
                .setDescription(
                    `> ${eggEmoji} **총 보유 수: ${myPokemons.length}마리**\n\n` +
                    `${rarityIcons['일반']} 일반: **${counts['일반']}**마리\n` +
                    `${rarityIcons['희귀']} 희귀: **${counts['희귀']}**마리\n` +
                    `${rarityIcons['진화체']} 진화체: **${counts['진화체']}**마리\n` +
                    `${rarityIcons['에픽']} 에픽: **${counts['에픽']}**마리\n` +
                    `${rarityIcons['전설']} 전설: **${counts['전설']}**마리\n` +
                    `${rarityIcons['환상']} 환상: **${counts['환상']}**마리\n` +
                    `${rarityIcons['히든']} 히든: **${counts['히든']}**마리`
                )
                .setFooter({ text: '아래 메뉴에서 등급을 선택해 상세 목록을 확인하세요!' });

            // 5️⃣ 드롭다운 메뉴 생성 (emoji 속성에는 ID 숫자만 입력해야 합니다)
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('rarity_select')
                .setPlaceholder('조회할 등급을 선택하세요')
                .addOptions(
                    { label: '전체 요약 보기', value: 'summary', emoji: '1493572170931241051' }, // 알 이모지
                    { label: '일반 포켓몬', value: '일반', emoji: '1493611180520898711' }, // 몬스터볼
                    { label: '희귀 포켓몬', value: '희귀', emoji: '1493611163450081480' }, // 슈퍼볼
                    { label: '진화체 포켓몬', value: '진화체', emoji: '1493611163450081480' }, // 슈퍼볼
                    { label: '에픽 포켓몬', value: '에픽', emoji: '1493611150368309388' }, // 하이퍼볼
                    { label: '전설 포켓몬', value: '전설', emoji: '1493611136363266139' }, // 마스터볼
                    { label: '환상 포켓몬', value: '환상', emoji: '1493611120278110390' }, // 프레미어볼
                    { label: '히든 포켓몬', value: '히든', emoji: '1493611101126918337' }  // 럭셔리볼
                );

            const row = new ActionRowBuilder().addComponents(selectMenu);

            // 6️⃣ 메시지 전송 및 상호작용 설정
            const message = await interaction.editReply({ embeds: [summaryEmbed], components: [row] });

            const collector = message.createMessageComponentCollector({ time: 300000 });

            let currentPage = 0;
            let currentRarity = 'summary';
            let filteredList = [];
            const ITEMS_PER_PAGE = 10;

            collector.on('collect', async i => {
                // 이미 ephemeral 이라 타인이 누를 일은 없지만, 안전망으로 유지
                if (i.user.id !== interaction.user.id) return;

                if (i.isStringSelectMenu()) {
                    currentRarity = i.values[0];
                    currentPage = 0; // 메뉴를 바꾸면 1페이지로 리셋
                } else if (i.isButton()) {
                    if (i.customId === 'prev_page') currentPage--;
                    if (i.customId === 'next_page') currentPage++;
                }

                // 요약 화면으로 돌아가기
                if (currentRarity === 'summary') {
                    await i.update({ embeds: [summaryEmbed], components: [row] });
                    return;
                }

                // 선택한 등급으로 리스트 필터링 (레벨 내림차순 정렬)
                filteredList = myPokemons
                    .filter(p => p.rarity === currentRarity)
                    .sort((a, b) => b.level - a.level);

                const totalPages = Math.ceil(filteredList.length / ITEMS_PER_PAGE) || 1;

                // 해당 등급이 없을 경우
                if (filteredList.length === 0) {
                    const emptyEmbed = new EmbedBuilder()
                        .setColor(0x808080)
                        .setDescription(`현재 보유 중인 \`[ ${currentRarity} ]\` 등급 포켓몬이 없습니다.`);
                    await i.update({ embeds: [emptyEmbed], components: [row] });
                    return;
                }

                // 페이징 처리
                const start = currentPage * ITEMS_PER_PAGE;
                const currentItems = filteredList.slice(start, start + ITEMS_PER_PAGE);

                // 목록에도 등급별 몬스터볼 이모지 적용
                const currentIcon = rarityIcons[currentRarity] || rarityIcons['일반'];
                
                let listText = currentItems.map((p, index) => 
                    `**${start + index + 1}.** ${currentIcon} **[Lv.${p.level}] ${p.name}** (EXP: ${p.exp}/100) ${p.status === 'equipped' ? '👑' : ''}`
                ).join('\n');

                const listEmbed = new EmbedBuilder()
                    .setColor(0x2B2D31)
                    .setTitle(`${currentIcon} \`[ ${currentRarity} ]\` 등급 보유 목록 (${filteredList.length}마리)`)
                    .setDescription(listText)
                    .setFooter({ text: `페이지 ${currentPage + 1} / ${totalPages}` });

                // 버튼 동적 생성
                const btnRow = new ActionRowBuilder();
                if (currentPage > 0) {
                    btnRow.addComponents(new ButtonBuilder().setCustomId('prev_page').setLabel('◀ 이전').setStyle(ButtonStyle.Secondary));
                }
                if (currentPage < totalPages - 1) {
                    btnRow.addComponents(new ButtonBuilder().setCustomId('next_page').setLabel('다음 ▶').setStyle(ButtonStyle.Secondary));
                }

                const components = btnRow.components.length > 0 ? [row, btnRow] : [row];
                
                await i.update({ embeds: [listEmbed], components: components });
            });

            // 5분 후 봇 메뉴 조작 만료
            collector.on('end', () => {
                interaction.editReply({ components: [] }).catch(() => {});
            });

        } catch (error) {
            console.error('보관함 에러:', error);
            await interaction.editReply('데이터를 불러오는 중 오류가 발생했습니다.');
        }
    },
};