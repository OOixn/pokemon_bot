const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('진화')
        .setDescription('모든 진화 조건(레벨, 포인트, 아이템)을 만족한 포켓몬을 진화시킵니다.'),

    async execute(interaction, supabase) {
        // 🌟 [핵심 변경] ephemeral: true 를 추가하여 진화 과정 전체를 명령어를 친 본인에게만 보여줍니다.
        await interaction.deferReply({ ephemeral: true });
        const myDiscordId = interaction.user.id;

        try {
            // 1. 유저 정보 및 인벤토리 가져오기
            const { data: player } = await supabase.from('players').select('id, points').eq('discord_id', myDiscordId).single();
            if (!player) return interaction.editReply('❌ 연동된 계정 정보가 없습니다.');

            const myPlayerId = player.id;

            // 내가 보유한 모든 포켓몬 (경매장 등록 중 제외) 및 아이템
            const { data: invData } = await supabase.from('user_inventory').select('*').eq('user_id', myPlayerId).neq('status', 'auction');
            const { data: dictData } = await supabase.from('pokemon_dict').select('*');
            const { data: myItems } = await supabase.from('user_items').select('*').eq('user_id', myPlayerId).gt('quantity', 0);

            if (!invData || invData.length === 0) {
                return interaction.editReply('보유 중인 포켓몬이 없습니다.');
            }

            // 🌟 2. 완벽한 진화 조건 필터링
            const evolvablePokemons = [];
            const invMap = new Map();
            const stoneNames = ['불꽃의 돌', '물의 돌', '천둥의 돌', '리프의 돌', '달의 돌', '태양의 돌', '얼음의 돌', '페어리의 돌', '에스퍼의 돌'];

            for (const item of invData) {
                const pokeInfo = dictData.find(p => p.id === item.pokemon_id);
                
                // 타겟이 없는(최종 진화체거나 진화 불가) 포켓몬 제외
                if (!pokeInfo || !pokeInfo.evolution_target || pokeInfo.evolution_target.length === 0) continue;

                const reqLv = pokeInfo.evolution_req_level || 1;
                const reqPoint = pokeInfo.evolution_req_point || 0;
                const reqItem = pokeInfo.evolution_req_item;

                // 조건 1. 레벨이 모자라면 제외
                if (item.level < reqLv) continue;

                // 조건 2. 포인트가 모자라면 제외
                if (player.points < reqPoint) continue;

                // 조건 3. 아이템(진화의 돌)이 모자라면 제외
                if (reqItem === '선택') {
                    const hasAnyStone = (myItems || []).some(it => stoneNames.includes(it.item_name));
                    if (!hasAnyStone) continue;
                } else if (reqItem) {
                    const hasSpecificItem = (myItems || []).some(it => it.item_name === reqItem);
                    if (!hasSpecificItem) continue;
                }

                evolvablePokemons.push({ ...item, dict: pokeInfo });
                invMap.set(item.id.toString(), { ...item, dict: pokeInfo });
            }

            if (evolvablePokemons.length === 0) {
                return interaction.editReply('❌ 현재 레벨, 포인트, 진화의 돌 조건을 모두 만족하여 **즉시 진화가 가능한 포켓몬**이 없습니다.');
            }

            // 3. 1단계: 진화할 포켓몬 선택 메뉴 (최대 25개)
            const options = evolvablePokemons.slice(0, 25).map(p => {
                const reqPoint = p.dict.evolution_req_point || 0;
                const reqItem = p.dict.evolution_req_item ? ` + ${p.dict.evolution_req_item}` : '';
                
                return {
                    label: `[Lv.${p.level}] ${p.dict.name_ko} ✨`,
                    description: `소모 재화: ${reqPoint}P${reqItem}`,
                    value: p.id.toString(),
                };
            });

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_evolve_target')
                .setPlaceholder('✨ 진화시킬 포켓몬을 선택하세요')
                .addOptions(options);

            const row = new ActionRowBuilder().addComponents(selectMenu);
            
            const embed = new EmbedBuilder()
                .setColor(0x9C27B0)
                .setTitle('✨ 진화의 방')
                .setDescription(`현재 **${evolvablePokemons.length}마리**의 포켓몬이 진화할 준비를 마쳤습니다!\n아래 메뉴에서 진화시킬 포켓몬을 선택해주세요.`);

            const message = await interaction.editReply({ embeds: [embed], components: [row] });
            const collector = message.createMessageComponentCollector({ time: 180000 });

            let selectedInvItem = null;
            let targetPokeInfo = null; 
            let usedItemName = null; 

            collector.on('collect', async i => {
                // 이미 ephemeral 이라 타인이 누를 일은 없지만, 안전망으로 유지
                if (i.user.id !== interaction.user.id) return;

                // ==========================================
                // 🟢 1단계: 포켓몬 선택 완료
                // ==========================================
                if (i.customId === 'select_evolve_target') {
                    const invId = i.values[0];
                    selectedInvItem = invMap.get(invId);
                    
                    const dict = selectedInvItem.dict;
                    const reqPoint = dict.evolution_req_point || 0;
                    const reqItem = dict.evolution_req_item;

                    // 🌿 "선택" 진화의 돌 (이브이 등)
                    if (reqItem === '선택') {
                        const stoneNames = ['불꽃의 돌', '물의 돌', '천둥의 돌', '리프의 돌', '달의 돌', '태양의 돌', '얼음의 돌', '페어리의 돌', '에스퍼의 돌'];
                        const myStones = (myItems || []).filter(item => stoneNames.includes(item.item_name));

                        const stoneOptions = myStones.map(stone => ({
                            label: `${stone.item_name} (보유: ${stone.quantity}개)`,
                            value: stone.item_name
                        }));

                        const stoneMenu = new StringSelectMenuBuilder()
                            .setCustomId('select_evolve_stone')
                            .setPlaceholder('사용할 진화의 돌을 선택하세요')
                            .addOptions(stoneOptions);

                        const stoneEmbed = new EmbedBuilder()
                            .setColor(0x00BCD4)
                            .setTitle(`✨ [${dict.name_ko}] 진화 준비`)
                            .setDescription(`어떤 진화의 돌을 사용하시겠습니까?\n(선택한 돌에 따라 진화 형태가 달라집니다.)`);

                        await i.update({ embeds: [stoneEmbed], components: [new ActionRowBuilder().addComponents(stoneMenu)] });
                        return;
                    }

                    // 🌿 일반적인 단일 타겟 진화
                    if (reqItem && reqItem !== '선택') usedItemName = reqItem;

                    const targetId = dict.evolution_target[0];
                    targetPokeInfo = dictData.find(p => p.id === targetId);

                    const confirmEmbed = new EmbedBuilder()
                        .setColor(0xE91E63)
                        .setTitle(`✨ [${dict.name_ko}] 진화 확인`)
                        .setDescription(`조건이 모두 충족되었습니다!\n\n**➔ 진화 대상:** [ ${targetPokeInfo.name_ko} ]\n**➔ 소모 재화:** ${reqPoint} P ${usedItemName ? `+ ${usedItemName}` : ''}\n\n정말로 진화하시겠습니까?`)
                        .setThumbnail(dict.official_art_url || dict.sprite_url);

                    const confirmBtn = new ButtonBuilder()
                        .setCustomId('confirm_evolve')
                        .setLabel('진화 시작!')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('✨');

                    await i.update({ embeds: [confirmEmbed], components: [new ActionRowBuilder().addComponents(confirmBtn)] });
                }

                // ==========================================
                // 🟢 2단계: "선택" 진화에서 돌을 골랐을 때
                // ==========================================
                else if (i.customId === 'select_evolve_stone') {
                    usedItemName = i.values[0];
                    const dict = selectedInvItem.dict;
                    
                    let targetId = dict.evolution_target[0]; // 안전망 기본값

                    // 이브이 계열 하드코딩 매핑
                    if (dict.name_ko === '이브이') {
                        if (usedItemName === '물의 돌') targetId = 134; 
                        else if (usedItemName === '천둥의 돌') targetId = 135;
                        else if (usedItemName === '불꽃의 돌') targetId = 136;
                        else if (usedItemName === '에스퍼의 돌' || usedItemName === '태양의 돌') targetId = 196; 
                        else if (usedItemName === '달의 돌') targetId = 197; 
                        else if (usedItemName === '리프의 돌') targetId = 470; 
                        else if (usedItemName === '얼음의 돌') targetId = 471; 
                        else if (usedItemName === '페어리의 돌') targetId = 700; 
                    } else if (dict.name_ko === '냄새꼬') {
                        if (usedItemName === '리프의 돌') targetId = 45; 
                        else if (usedItemName === '태양의 돌') targetId = 182; 
                    }

                    targetPokeInfo = dictData.find(p => p.id === targetId);
                    const reqPoint = dict.evolution_req_point || 0;

                    const confirmEmbed = new EmbedBuilder()
                        .setColor(0xE91E63)
                        .setTitle(`✨ [${dict.name_ko}] 진화 확인`)
                        .setDescription(`선택하신 **[${usedItemName}]**의 힘이 공명합니다!\n\n**➔ 진화 대상:** [ ${targetPokeInfo ? targetPokeInfo.name_ko : '???'} ]\n**➔ 소모 재화:** ${reqPoint} P + ${usedItemName}\n\n정말로 진화하시겠습니까?`)
                        .setThumbnail(dict.official_art_url || dict.sprite_url);

                    const confirmBtn = new ButtonBuilder()
                        .setCustomId('confirm_evolve')
                        .setLabel('진화 시작!')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('✨');

                    await i.update({ embeds: [confirmEmbed], components: [new ActionRowBuilder().addComponents(confirmBtn)] });
                }

                // ==========================================
                // 🟢 3단계: 최종 진화 시작 (API 호출)
                // ==========================================
                else if (i.customId === 'confirm_evolve') {
                    await i.update({ 
                        embeds: [new EmbedBuilder().setColor(0xFFFFFF).setTitle('✨ 진화 중...').setDescription('신비한 빛이 포켓몬을 감싸고 있습니다!')],
                        components: []
                    });

                    const apiUrl = process.env.NEXT_PUBLIC_SITE_URL ? `${process.env.NEXT_PUBLIC_SITE_URL}/api/pokemon` : 'http://localhost:3000/api/pokemon';

                    try {
                        const res = await fetch(`${apiUrl}/evolve`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                userId: myPlayerId,
                                inventory_item_id: selectedInvItem.id.toString(), 
                                target_pokemon_id: targetPokeInfo.id,
                                used_item: usedItemName 
                            })
                        });

                        const data = await res.json();

                        if (!data.success) {
                            return interaction.editReply({ content: `❌ 진화 실패: ${data.message}`, embeds: [], components: [] });
                        }

                        const newPoke = data.newPokemon;
                        const resultEmbed = new EmbedBuilder()
                            .setColor(0xFFD700) 
                            .setTitle('🎉 진화 완료! 🎉')
                            .setDescription(`축하합니다! **${selectedInvItem.dict.name_ko}** 이(가)\n새로운 모습인 **${newPoke.name_ko}** (으)로 진화했습니다!`)
                            .setImage(newPoke.official_art_url || newPoke.sprite_url)
                            .setFooter({ text: '새로운 힘을 확인해 보세요!' });

                        await interaction.editReply({ embeds: [resultEmbed], components: [] });

                    } catch (error) {
                        console.error('진화 API 통신 에러:', error);
                        await interaction.editReply({ content: '❌ 웹 서버와의 통신 중 오류가 발생했습니다.', embeds: [], components: [] });
                    }
                }
            });

            collector.on('end', () => {
                interaction.editReply({ components: [] }).catch(() => {});
            });

        } catch (error) {
            console.error('진화 에러:', error);
            await interaction.editReply('데이터를 불러오는 중 오류가 발생했습니다.');
        }
    },
};