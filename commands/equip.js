const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('장착')
        .setDescription('보관함에 있는 포켓몬을 장착합니다.')
        .addStringOption(option =>
            option.setName('포켓몬')
                .setDescription('장착할 포켓몬을 검색해서 선택하세요.')
                .setRequired(true)
                .setAutocomplete(true)
        ),

    async autocomplete(interaction, supabase) {
        const focusedValue = interaction.options.getFocused();
        const myDiscordId = interaction.user.id;

        try {
            const { data: player } = await supabase.from('players').select('id').eq('discord_id', myDiscordId).single();
            if (!player) return await interaction.respond([]);

            // 🌟 [자동완성 필터링] 경매 중(status: auction)이 아닌 포켓몬만 검색 목록에 표시
            const { data: invData } = await supabase
                .from('user_inventory')
                .select('id, level, pokemon_id')
                .eq('user_id', player.id)
                .neq('status', 'auction'); // 경매 중인 것 제외

            if (!invData || invData.length === 0) return await interaction.respond([]);
            
            const { data: dictData } = await supabase.from('pokemon_dict').select('id, name_ko');

            const choices = invData.map(item => {
                const poke = dictData.find(p => p.id === item.pokemon_id);
                return {
                    name: `[Lv.${item.level}] ${poke ? poke.name_ko : '알수없음'}`,
                    value: item.id.toString()
                };
            });

            const filtered = choices
                .filter(choice => choice.name.includes(focusedValue))
                .slice(0, 25);

            await interaction.respond(filtered);
        } catch (error) {
            console.error('자동완성 에러:', error);
            await interaction.respond([]);
        }
    },

    async execute(interaction, supabase) {
        await interaction.deferReply({ ephemeral: true });
        
        const myDiscordId = interaction.user.id;
        const selectedInventoryId = interaction.options.getString('포켓몬');
        const userDisplayName = interaction.member.displayName;

        try {
            // 1. 유저 확인
            const { data: player } = await supabase.from('players').select('id').eq('discord_id', myDiscordId).single();
            if (!player) return interaction.editReply('❌ 연동된 계정 정보가 없습니다.');
            const myPlayerId = player.id;

            // 2. 포켓몬 정보 및 상태 확인
            const { data: targetItem } = await supabase
                .from('user_inventory')
                .select('*')
                .eq('id', selectedInventoryId)
                .eq('user_id', myPlayerId)
                .single();

            if (!targetItem) return interaction.editReply('❌ 해당 포켓몬을 찾을 수 없습니다.');

            // 🌟 [수정된 핵심 방어] 실제 경매 테이블 교차 검증 (판매자와 구매자 구분)
            const { data: activeAuction } = await supabase
                .from('auctions')
                .select('id, seller_id') // 💡 판매자의 ID를 함께 불러와서 검증
                .eq('inventory_item_id', selectedInventoryId)
                .eq('status', 'active')
                .maybeSingle();

            // 1) 내가 '판매자'일 때만 장착 차단 (꼼수 원천 차단)
            if (activeAuction && activeAuction.seller_id === myPlayerId) {
                // DB 상태가 꼬여있었다면 바로잡아줍니다.
                await supabase.from('user_inventory').update({ status: 'auction' }).eq('id', selectedInventoryId);
                return interaction.editReply('❌ **경매장에 등록된 포켓몬은 장착할 수 없습니다.**\n먼저 경매를 취소하거나 마감될 때까지 기다려주세요.');
            }

            // 2) 구매자이거나 정상적인 포켓몬인데, 이전 버그 때문에 상태가 'auction'으로 굳어버린 경우 자동 복구(Heal)
            if (targetItem.status === 'auction') {
                await supabase.from('user_inventory').update({ status: 'idle' }).eq('id', selectedInventoryId);
            }

            const { data: pokeDict } = await supabase.from('pokemon_dict').select('name_ko, rarity, official_art_url, sprite_url').eq('id', targetItem.pokemon_id).single();
            
            const pokemonName = pokeDict.name_ko;
            const rarity = pokeDict.rarity || '일반';
            const targetRarities = ['에픽', '전설', '환상', '히든'];

            // 3. 상태 업데이트 (기존 장착 해제 -> 새 포켓몬 장착)
            await supabase.from('user_inventory').update({ status: 'idle' }).eq('user_id', myPlayerId).eq('status', 'equipped');
            await supabase.from('user_inventory').update({ status: 'equipped' }).eq('id', selectedInventoryId);

            const member = interaction.member;
            let roleAssignedText = '';

            // 4. 역할 지급 로직
            if (targetRarities.includes(rarity)) {
                const roleToAdd = interaction.guild.roles.cache.find(role => role.name === pokemonName);
                
                if (roleToAdd) {
                    await member.roles.add(roleToAdd).catch(console.error);
                    roleAssignedText = `\n🎖️ **[@${pokemonName}]** 역할이 자동 부여되었습니다!`;
                } else {
                    roleAssignedText = `\n⚠️ (서버에 **'${pokemonName}'** 역할이 없어 부여하지 못했습니다.)`;
                }

                if (rarity === '에픽' || rarity === '전설') {
                    const groupRoleName = `${rarity}포켓몬`;
                    const groupRole = interaction.guild.roles.cache.find(role => role.name === groupRoleName);

                    if (groupRole) {
                        await member.roles.add(groupRole).catch(console.error);
                        roleAssignedText += `\n🏅 **[@${groupRoleName}]** 역할도 함께 부여되었습니다!`;
                    }
                }
            }

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle(`🎉 장착 완료!`)
                .setDescription(`**${userDisplayName}**님이 **[${rarity}]** 등급의 **[${pokemonName}]**(을)를 장착하셨습니다!${roleAssignedText}`)
                .setThumbnail(pokeDict.official_art_url || pokeDict.sprite_url)
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('장착 에러:', error);
            await interaction.editReply('포켓몬을 장착하는 중 오류가 발생했습니다.');
        }
    },
};