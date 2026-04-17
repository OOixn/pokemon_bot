const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');

// 💡 웹 프론트엔드와 동일한 교배 규칙 세팅
const BREEDING_RULES = {
    '일반': { cost: 80, successRate: 30, next: '희귀' },
    '희귀': { cost: 150, successRate: 10, next: '에픽' },
    '에픽': { cost: 300, successRate: 5, next: '전설' },
    '전설': { cost: 500, successRate: 2, next: '환상' },
    '환상': { cost: 700, successRate: 0.5, next: '히든' }
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('교배')
        .setDescription('보유한 동일 등급의 포켓몬을 다중 교배합니다.'),

    async execute(interaction, supabase) {
        // 🌟 [핵심 변경] 교배의 모든 과정은 '나만 보기'로 진행됩니다.
        await interaction.deferReply({ ephemeral: true });
        const myDiscordId = interaction.user.id;
        
        // 서버 닉네임 최우선 가져오기
        const userName = interaction.member?.displayName || interaction.user.username;

        try {
            // 1. 유저 ID 및 포인트 가져오기
            const { data: player } = await supabase.from('players').select('id, points').eq('discord_id', myDiscordId).single();
            if (!player) return interaction.editReply('❌ 연동된 계정 정보가 없습니다. 마이페이지에서 연동해주세요!');
            const myPlayerId = player.id;

            // 2. 인벤토리(상태가 idle인 것만) & 도감 정보 매핑
            const { data: invData } = await supabase.from('user_inventory').select('*').eq('user_id', myPlayerId).eq('status', 'idle');
            const { data: dictData } = await supabase.from('pokemon_dict').select('*');
            
            const myPokemons = (invData || []).map(item => {
                const poke = dictData.find(p => p.id === item.pokemon_id);
                return { ...item, pokemon: poke || {} };
            }).filter(item => item.pokemon && item.pokemon.rarity !== '히든' && item.pokemon.id !== 0);

            if (myPokemons.length === 0) {
                return interaction.editReply('❌ 교배 가능한 포켓몬이 없습니다. (장착 중이거나 경매에 등록된 포켓몬은 제외됩니다.)');
            }

            // 3. 등급별 보유 수 계산
            const counts = { '일반': 0, '희귀': 0, '에픽': 0, '전설': 0, '환상': 0 };
            myPokemons.forEach(p => {
                const r = p.pokemon.rarity;
                if (counts[r] !== undefined) counts[r]++;
            });

            // 4. 교배 가능한 등급(2마리 이상 보유)만 드롭다운에 추가
            const rarityOptions = [];
            for (const [rarity, count] of Object.entries(counts)) {
                if (count >= 2) {
                    rarityOptions.push({ label: `${rarity} 교배 (보유: ${count}마리)`, value: rarity });
                }
            }

            if (rarityOptions.length === 0) {
                return interaction.editReply('❌ 교배를 진행하려면 **동일한 등급의 포켓몬이 2마리 이상** 필요합니다.');
            }

            // --- UI 1단계: 등급 선택 메뉴 ---
            const raritySelect = new StringSelectMenuBuilder()
                .setCustomId('select_rarity')
                .setPlaceholder('교배할 등급을 먼저 선택하세요')
                .addOptions(rarityOptions);

            const initialEmbed = new EmbedBuilder()
                .setColor(0x9C27B0)
                .setTitle('💞 포켓몬 연구소 (다중 교배)')
                .setDescription('교배에 사용된 포켓몬은 **소모되어 사라집니다.**\n아래 메뉴에서 교배할 등급을 선택해주세요.');

            const message = await interaction.editReply({ 
                embeds: [initialEmbed], 
                components: [new ActionRowBuilder().addComponents(raritySelect)] 
            });

            // 콜렉터 생성 (3분 유지)
            const collector = message.createMessageComponentCollector({ time: 180000 });

            let selectedRarity = null;
            let availableForBreed = [];
            let selectedPokemonIds = [];

            collector.on('collect', async i => {
                if (i.user.id !== interaction.user.id) return;

                // ==========================================
                // 액션 1: 등급을 선택했을 때 (제물 선택 메뉴 띄우기)
                // ==========================================
                if (i.customId === 'select_rarity') {
                    selectedRarity = i.values[0];
                    selectedPokemonIds = []; 

                    availableForBreed = myPokemons.filter(p => p.pokemon.rarity === selectedRarity).slice(0, 25);
                    const rule = BREEDING_RULES[selectedRarity];

                    const pokemonSelect = new StringSelectMenuBuilder()
                        .setCustomId('select_pokemon')
                        .setPlaceholder('교배할 부모 포켓몬을 선택하세요 (다중 선택)')
                        .setMinValues(2)
                        .setMaxValues(Math.min(10, Math.floor(availableForBreed.length / 2) * 2))
                        .addOptions(availableForBreed.map(p => ({
                            label: `[Lv.${p.level}] ${p.pokemon.name_ko}`,
                            value: p.id.toString()
                        })));

                    const step2Embed = new EmbedBuilder()
                        .setColor(0x03A9F4)
                        .setTitle(`💞 \`[ ${selectedRarity} ]\` 등급 교배 준비`)
                        .setDescription(`아래 메뉴에서 **짝수 개(2~10마리)**를 선택해주세요.\n` +
                                        `> 🎯 **성공 확률:** ${rule.successRate}%\n` +
                                        `> 💸 **소모 비용:** 쌍당 ${rule.cost}P\n` +
                                        `> 🌟 **성공 시:** \`[ ${rule.next} ]\` 등급 획득`);

                    await i.update({
                        embeds: [step2Embed],
                        components: [
                            new ActionRowBuilder().addComponents(raritySelect),
                            new ActionRowBuilder().addComponents(pokemonSelect) 
                        ]
                    });
                }

                // ==========================================
                // 액션 2: 포켓몬을 다중 선택했을 때
                // ==========================================
                else if (i.customId === 'select_pokemon') {
                    selectedPokemonIds = i.values;
                    const rule = BREEDING_RULES[selectedRarity];
                    const isEven = selectedPokemonIds.length % 2 === 0;
                    const pairsCount = Math.floor(selectedPokemonIds.length / 2);
                    const totalCost = rule.cost * pairsCount;

                    const step3Embed = new EmbedBuilder()
                        .setColor(isEven ? 0x4CAF50 : 0xFF5252)
                        .setTitle('💞 교배 확인')
                        .setDescription(`현재 **${selectedPokemonIds.length}마리** 선택됨\n\n` +
                            (isEven 
                                ? `총 **${pairsCount}쌍**을 교배합니다.\n소모 포인트: **${totalCost} P**\n\n준비가 완료되었다면 아래 [교배 시작] 버튼을 눌러주세요!` 
                                : `⚠️ **포켓몬을 짝수 단위로 선택해주세요!** (현재 ${selectedPokemonIds.length}마리)`));

                    const components = [
                        new ActionRowBuilder().addComponents(raritySelect),
                        new ActionRowBuilder().addComponents(i.component) 
                    ];

                    if (isEven) {
                        const startBtn = new ButtonBuilder()
                            .setCustomId('start_breed')
                            .setLabel(`🔥 교배 시작 (${totalCost}P)`)
                            .setStyle(ButtonStyle.Success);
                        components.push(new ActionRowBuilder().addComponents(startBtn));
                    }

                    await i.update({ embeds: [step3Embed], components });
                }

                // ==========================================
                // 액션 3: 교배 시작 버튼 클릭 (API 호출)
                // ==========================================
                else if (i.customId === 'start_breed') {
                    await i.update({
                        embeds: [new EmbedBuilder().setColor(0xFF4500).setTitle('🧬 교배가 진행 중입니다...').setDescription('유전자 합성 중... 잠시만 기다려주세요!')],
                        components: [] 
                    });

                    const pairs = [];
                    for (let j = 0; j < selectedPokemonIds.length; j += 2) {
                        pairs.push([selectedPokemonIds[j], selectedPokemonIds[j + 1]]);
                    }

                    const results = [];
                    let finalPoints = 0;

                    const apiUrl = process.env.NEXT_PUBLIC_SITE_URL 
                        ? `${process.env.NEXT_PUBLIC_SITE_URL}/api/pokemon/breed`
                        : 'https://pokeball-lol.vercel.app/api/pokemon/breed';

                    try {
                        for (const [p1, p2] of pairs) {
                            const res = await fetch(apiUrl, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ userId: myPlayerId, parent1Id: p1, parent2Id: p2 })
                            });

                            const data = await res.json();
                            if (data.success) {
                                results.push(data.result);
                                finalPoints = data.result.remaining_points;
                            } else {
                                results.push({ isSuccess: false, error: data.message, pokemon: { name_ko: '오류', rarity: '-' } });
                            }
                        }

                        // 가중치 함수 (에픽 이상 판별용)
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

                        // 디스코드용 결과 텍스트 만들기
                        let resultText = `총 **${pairs.length}쌍**의 교배 결과입니다!\n\n`;
                        results.forEach((r, idx) => {
                            if (r.error) {
                                resultText += `${idx + 1}쌍: ❌ 오류 (${r.error})\n`;
                            } else {
                                const status = r.isSuccess ? '🎉 **성공!**' : '💦 실패(유지됨)';
                                resultText += `${idx + 1}쌍: ${status} ➔ \`[ ${r.pokemon.rarity} ]\` ${r.pokemon.name_ko}\n`;
                            }
                        });

                        const resultEmbed = new EmbedBuilder()
                            .setColor(0xFFD700)
                            .setTitle('🎊 교배 완료! 🎊')
                            .setDescription(resultText)
                            .setFooter({ text: finalPoints ? `남은 소환사 포인트: ${finalPoints.toLocaleString()} P` : '교배 시스템' });

                        // 에픽 이상의 성공한 포켓몬 필터링
                        const epicOrHigherSuccesses = results.filter(r => !r.error && r.isSuccess && getRarityWeight(r.pokemon.rarity) >= 4);

                        if (epicOrHigherSuccesses.length > 0) {
                            // 대박이 터졌을 경우 가장 높은 등급을 대표로 뽑아 채널에 방송
                            epicOrHigherSuccesses.sort((a, b) => getRarityWeight(b.pokemon.rarity) - getRarityWeight(a.pokemon.rarity));
                            const bestPoke = epicOrHigherSuccesses[0].pokemon;

                            const broadcastEmbed = new EmbedBuilder()
                                .setColor(0xE91E63)
                                .setDescription(`**${userName}** 님의 헌신적인 연구 끝에\n새로운 \`[ ${bestPoke.rarity} ]\` **${bestPoke.name_ko}**(이)가 탄생했습니다!`)
                                .setThumbnail(bestPoke.official_art_url || bestPoke.sprite_url);

                            // 1. 전체 채널에 전송
                            await interaction.channel.send({ 
                                content: `📢 **${userName}** 님이 교배에 대성공했습니다! 🎉`,
                                embeds: [broadcastEmbed] 
                            });

                            // 2. 명령어를 친 본인 화면 업데이트
                            await interaction.editReply({ 
                                content: `✅ \`[ ${bestPoke.rarity} ]\` 등급 교배에 성공하여 채널에 기쁜 소식이 공유되었습니다!`,
                                embeds: [resultEmbed] 
                            });
                        } else {
                            // 에픽 미만이거나 모두 실패했을 경우 조용히 본인에게만 결과 출력
                            const validResults = results.filter(r => !r.error);
                            if (validResults.length > 0) {
                                const lastPoke = validResults[validResults.length - 1].pokemon;
                                resultEmbed.setThumbnail(lastPoke.official_art_url || lastPoke.sprite_url);
                            }
                            await interaction.editReply({ embeds: [resultEmbed] });
                        }

                    } catch (apiError) {
                        console.error('교배 API 통신 에러:', apiError);
                        await interaction.editReply({ content: '❌ 웹 서버와의 통신 중 오류가 발생했습니다. (진행된 교배까지만 반영됩니다.)', embeds: [] });
                    }
                }
            });

            collector.on('end', () => {
                interaction.editReply({ components: [] }).catch(() => {});
            });

        } catch (error) {
            console.error('교배 에러:', error);
            await interaction.editReply('데이터를 불러오는 중 오류가 발생했습니다.');
        }
    },
};