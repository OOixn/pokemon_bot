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

            const { data: invData } = await supabase.from('user_inventory').select('id, level, pokemon_id').eq('user_id', player.id);
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
        await interaction.deferReply();
        
        const myDiscordId = interaction.user.id;
        const selectedInventoryId = interaction.options.getString('포켓몬');
        // 🌟 [수정 핵심] 유저의 서버 내 별명을 가져옵니다.
        const userDisplayName = interaction.member.displayName;

        try {
            const { data: player } = await supabase.from('players').select('id').eq('discord_id', myDiscordId).single();
            if (!player) return interaction.editReply('❌ 연동된 계정 정보가 없습니다.');
            const myPlayerId = player.id;

            const { data: targetItem } = await supabase.from('user_inventory').select('*').eq('id', selectedInventoryId).eq('user_id', myPlayerId).single();
            if (!targetItem) return interaction.editReply('❌ 해당 포켓몬을 찾을 수 없습니다.');

            const { data: pokeDict } = await supabase.from('pokemon_dict').select('name_ko, rarity, official_art_url, sprite_url').eq('id', targetItem.pokemon_id).single();
            
            const pokemonName = pokeDict.name_ko;
            const rarity = pokeDict.rarity || '일반';
            const targetRarities = ['에픽', '전설', '환상', '히든'];

            await supabase.from('user_inventory').update({ status: 'idle' }).eq('user_id', myPlayerId).eq('status', 'equipped');
            await supabase.from('user_inventory').update({ status: 'equipped' }).eq('id', selectedInventoryId);

            const member = interaction.member;
            let roleAssignedText = '';

            if (targetRarities.includes(rarity)) {
                const roleToAdd = interaction.guild.roles.cache.find(role => role.name === pokemonName);
                
                if (roleToAdd) {
                    await member.roles.add(roleToAdd).catch(console.error);
                    roleAssignedText = `\n🎖️ **[@${pokemonName}]** 역할이 자동 부여되었습니다!`;
                } else {
                    roleAssignedText = `\n⚠️ (서버에 **'${pokemonName}'** 역할이 없어 부여하지 못했습니다.)`;
                }
            }

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle(`🎉 장착 완료!`)
                // 🌟 username 대신 userDisplayName 사용
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