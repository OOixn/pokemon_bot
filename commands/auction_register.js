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
            const { data: player } = await supabase
                .from('players')
                .select('id')
                .eq('discord_id', myDiscordId)
                .single();

            if (!player) return await interaction.respond([]);

            // ✅ [수정] pokemon_dict 전체를 별도로 가져오는 대신 join으로 한 번에 조회
            // 기존: DB 호출 2번(user_inventory + pokemon_dict 전체) → JS에서 find()로 매칭
            // 수정: DB 호출 1번으로 포켓몬 이름까지 함께 가져옴
            const [invRes, itemRes] = await Promise.all([
                supabase
                    .from('user_inventory')
                    .select('id, level, pokemon:pokemon_dict(name_ko)')
                    .eq('user_id', player.id)
                    .eq('status', 'idle'),
                supabase
                    .from('user_items')
                    .select('item_name, quantity')
                    .eq('user_id', player.id)
                    .gt('quantity', 0)
            ]);

            const invData = invRes.data || [];
            const itemsData = itemRes.data || [];

            // 포켓몬 선택지
            const pokemonChoices = invData
                .filter(item => item.pokemon) // pokemon_dict에 없는 항목 방어
                .map(item => {
                    const pokeName = Array.isArray(item.pokemon)
                        ? item.pokemon[0]?.name_ko
                        : item.pokemon?.name_ko;
                    return {
                        name: `[포켓몬] Lv.${item.level} ${pokeName || '???'}`,
                        value: `pokemon_${item.id}`
                    };
                });

            // 아이템 선택지
            const itemChoices = itemsData.map(i => ({
                name: `[아이템] ${i.item_name} (보유: ${i.quantity}개)`,
                value: `item_${i.item_name}`
            }));

            const allChoices = [...pokemonChoices, ...itemChoices];

            // 검색어 필터 (대소문자 무시)
            const filtered = focusedValue
                ? allChoices.filter(c => c.name.toLowerCase().includes(focusedValue.toLowerCase()))
                : allChoices;

            await interaction.respond(filtered.slice(0, 25));

        } catch (error) {
            console.error('경매등록 자동완성 에러:', error);
            await interaction.respond([]);
        }
    },

    // 🚀 실행 시 모달창 띄우기
    async execute(interaction, supabase) {
        const selectedValue = interaction.options.getString('매물');
        // selectedValue 예시: "pokemon_7ba36314-58df-4808-9ccd-b8091ad83456" 또는 "item_불꽃의돌"
        // index.js에서 modal_register_ 이후를 firstIndexOf('_')로 파싱하므로 구조 유지

        const modal = new ModalBuilder()
            .setCustomId(`modal_register_${selectedValue}`)
            .setTitle('경매 매물 등록');

        const priceInput = new TextInputBuilder()
            .setCustomId('start_price')
            .setLabel('경매 시작 가격 (P)')
            .setPlaceholder('숫자만 입력하세요. 예: 500')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const durationInput = new TextInputBuilder()
            .setCustomId('duration_hours')
            .setLabel('진행 시간 (6, 12, 24 중 택 1)')
            .setValue('12')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder().addComponents(priceInput),
            new ActionRowBuilder().addComponents(durationInput)
        );

        await interaction.showModal(modal);
    }
};