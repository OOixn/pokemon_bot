const { SlashCommandBuilder, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('경매등록')
        .setDescription('내 포켓몬이나 아이템을 경매장에 등록합니다.')
        .addStringOption(option =>
            option.setName('매물')
                .setDescription('판매할 포켓몬이나 아이템을 검색해서 선택하세요.')
                .setRequired(true)
                .setAutocomplete(true)
        ),

    // ✨ 자동완성: 장착 안 한 포켓몬 + 보유 중인 아이템 혼합 검색
    async autocomplete(interaction, supabase) {
        const focusedValue = interaction.options.getFocused();
        const myDiscordId = interaction.user.id;

        try {
            const { data: player } = await supabase.from('players').select('id').eq('discord_id', myDiscordId).single();
            if (!player) return await interaction.respond([]);
            
            // 1. 포켓몬 가져오기 (idle 상태)
            const { data: invData } = await supabase.from('user_inventory').select('id, level, pokemon_id').eq('user_id', player.id).eq('status', 'idle');
            const { data: dictData } = await supabase.from('pokemon_dict').select('id, name_ko');
            
            let choices = (invData || []).map(item => {
                const poke = dictData.find(p => p.id === item.pokemon_id);
                return { name: `[포켓몬] Lv.${item.level} ${poke?.name_ko}`, value: `pokemon_${item.id}` };
            });

            // 2. 아이템 가져오기
            const { data: itemsData } = await supabase.from('user_items').select('item_name, quantity').eq('user_id', player.id).gt('quantity', 0);
            (itemsData || []).forEach(i => {
                choices.push({ name: `[아이템] ${i.item_name} (보유: ${i.quantity}개)`, value: `item_${i.item_name}` });
            });

            const filtered = choices.filter(choice => choice.name.includes(focusedValue)).slice(0, 25);
            await interaction.respond(filtered);
        } catch (error) { await interaction.respond([]); }
    },

    // 🚀 실행 시 모달창 띄우기
    async execute(interaction, supabase) {
        const selectedValue = interaction.options.getString('매물'); // 예: pokemon_123 또는 item_불꽃의 돌

        const modal = new ModalBuilder()
            .setCustomId(`modal_register_${selectedValue}`)
            .setTitle('경매 매물 등록');

        // 웹 API 구조에 맞춰 시작가와 시간만 받습니다 (즉시 구매가 없음)
        const priceInput = new TextInputBuilder()
            .setCustomId('start_price')
            .setLabel('경매 시작 가격 (P)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const durationInput = new TextInputBuilder()
            .setCustomId('duration_hours')
            .setLabel('진행 시간 (6, 12, 24 중 택 1)')
            .setValue('12')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(priceInput), new ActionRowBuilder().addComponents(durationInput));
        await interaction.showModal(modal);
    }
};

// index.js (메인 파일)의 interactionCreate 이벤트 안에 이 제출 처리 로직이 포함되어야 합니다.
// (위 auction_board.js 처럼 이벤트 리스너를 붙이거나 index.js에서 라우팅 처리 필요)