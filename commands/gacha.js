const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('뽑기')
        .setDescription('포인트를 소모하여 랜덤 포켓몬 알을 부화시킵니다.'),

    async execute(interaction, supabase) {
        const myDiscordId = interaction.user.id;
        
        // 🌟 [추가] 서버에서 설정한 별명을 최우선으로 가져옵니다.
        const userName = interaction.member?.displayName || interaction.user.username;

        try {
            const { data: player } = await supabase.from('players').select('id, points').eq('discord_id', myDiscordId).single();
            if (!player) return interaction.reply({ content: '❌ 연동된 계정 정보가 없습니다. 마이페이지에서 디스코드 연동을 먼저 진행해 주세요!', ephemeral: true });

            const myPlayerId = player.id;
            const currentPoints = player.points || 0;

            const staticEggUrl = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items/lucky-egg.png';

            const initialEmbed = new EmbedBuilder()
                .setColor(0xFFA500)
                .setTitle('🥚 신비한 포켓몬 알')
                // 🌟 [문구 수정] 좀 더 기대감을 주는 문구로 변경
                .setDescription(`현재 보유 포인트: **${currentPoints.toLocaleString()} P**\n\n알에서 어떤 포켓몬이 깨어날까요?\n두근거리는 마음으로 부화 방식을 선택해 주세요!`)
                .setThumbnail(staticEggUrl); 

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('gacha_1')
                    .setLabel('1회 부화 (100 P)')
                    .setEmoji('🥚')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('gacha_10')
                    .setLabel('10회 부화 (1000 P)')
                    .setEmoji('✨')
                    .setStyle(ButtonStyle.Primary)
            );

            const message = await interaction.reply({ 
                embeds: [initialEmbed], 
                components: [row], 
                ephemeral: true, 
                fetchReply: true 
            });

            const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000 });

            collector.on('collect', async i => {
                if (i.user.id !== interaction.user.id) return; 

                const isTenPull = i.customId === 'gacha_10';
                const pullCount = isTenPull ? 10 : 1;
                
                await i.update({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0xFFA500)
                            .setTitle('🥚 알이 부화하고 있습니다...') // 문구 다듬기
                            .setThumbnail(staticEggUrl) 
                    ],
                    components: [] 
                });

                const apiUrl = process.env.NEXT_PUBLIC_SITE_URL 
                    ? `${process.env.NEXT_PUBLIC_SITE_URL}/api/pokemon/gacha`
                    : 'https://pokeball-lol.vercel.app/api/pokemon/gacha';

                try {
                    const response = await fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId: myPlayerId, count: pullCount })
                    });
                    const data = await response.json();

                    if (!data.success) {
                        return interaction.editReply({ content: `❌ 뽑기 실패: ${data.message}`, embeds: [] });
                    }

                    const pokemons = data.result.pokemons || [data.result.pokemon];
                    const remainingPoints = data.result.remaining_points;

                    const getRarityWeight = (rarity) => {
                        switch (rarity) {
                            case '히든': return 7;
                            case '환상': return 6;
                            case '전설': return 5;
                            case '에픽': return 4;
                            case '진화체': return 3;
                            case '희귀': return 2;
                            case '일반': return 1;
                            default: return 0;
                        }
                    };
                    
                    const sortedPokemons = [...pokemons].sort((a, b) => getRarityWeight(b.rarity) - getRarityWeight(a.rarity));
                    const bestPoke = sortedPokemons[0]; 

                    // 에픽(가중치 4) 이상이 포함되어 있는지 체크
                    const hasHighRarity = sortedPokemons.some(p => getRarityWeight(p.rarity) >= 4);

                    const getRarityColor = (rarity) => {
                        switch (rarity) {
                            case '일반': return 0x9E9E9E; 
                            case '희귀': return 0x0288D1; 
                            case '에픽': return 0x9C27B0; 
                            case '전설': return 0xED6C02; 
                            case '환상': return 0xBA68C8; 
                            case '히든': return 0xD32F2F; 
                            default: return 0x9E9E9E;
                        }
                    };

                    // 🌟 [문구 수정] 내정보, 보관함 명령어와 동일하게 `[ 등급 ]` 형태로 예쁘게 출력
                    const resultListText = sortedPokemons.map((p, index) => `**${index + 1}.** \`[ ${p.rarity || '일반'} ]\` ${p.name_ko}`).join('\n');

                    const resultEmbed = new EmbedBuilder()
                        .setColor(getRarityColor(bestPoke.rarity))
                        .setTitle(isTenPull ? '🎊 10회 연속 부화 대성공! 🎊' : '🎊 부화 성공! 🎊')
                        .setThumbnail(bestPoke.official_art_url || bestPoke.sprite_url) 
                        .setFooter({ text: `남은 포인트: ${remainingPoints.toLocaleString()} P` });

                    // 🌟 [문구 수정] 최고 보상 등급 표시도 통일
                    const description = isTenPull 
                        ? `✨ **[최고 보상]**\n\`[ ${bestPoke.rarity || '일반'} ]\` **${bestPoke.name_ko}**\n\n━━━━━━━━━━━━━━━━━━━━\n### 📜 획득 목록\n${resultListText}`
                        : `🎉 \`[ ${bestPoke.rarity || '일반'} ]\` **${bestPoke.name_ko}**(이)가 태어났습니다!`;
                    
                    resultEmbed.setDescription(description);

                    // 🌟 [출력 로직 분기]
                    if (hasHighRarity) {
                        // 1. 에픽 이상이 떴을 경우: 채널에 닉네임 + 등급 + 포켓몬 이름 공개
                        await interaction.channel.send({ 
                            content: `📢 **${userName}** 님의 알에서 \`[ ${bestPoke.rarity || '일반'} ]\` **${bestPoke.name_ko}**(이)가 깨어났습니다!`,
                            embeds: [resultEmbed] 
                        });
                        // 2. 본인 전용 메시지는 깔끔한 시스템 안내로 교체
                        await interaction.editReply({ 
                            content: `✅ \`[ ${bestPoke.rarity || '일반'} ]\` 등급 획득! 채널에 결과가 공유되었습니다.`, 
                            embeds: [] 
                        });
                    } else {
                        // 에픽 미만일 경우: 계속 나만 보기로 결과 출력
                        await interaction.editReply({ embeds: [resultEmbed] });
                    }

                } catch (apiError) {
                    console.error(apiError);
                    await interaction.editReply({ content: '❌ 통신 중 오류가 발생했습니다.', embeds: [] });
                }
            });

            collector.on('end', () => {
                interaction.editReply({ components: [] }).catch(() => {});
            });

        } catch (error) {
            console.error(error);
            await interaction.reply({ content: '오류가 발생했습니다.', ephemeral: true });
        }
    },
};