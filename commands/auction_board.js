const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('경매장')
        .setDescription('현재 진행 중인 경매 매물을 확인하고 입찰하거나 결과를 수령합니다.'),

    async execute(interaction, supabase) {
        // 🌟 [핵심 변경] 경매장 조회 과정을 명령어를 친 본인만 볼 수 있도록 숨깁니다.
        await interaction.deferReply({ ephemeral: true });
        
        const myDiscordId = interaction.user.id;
        const apiUrl = process.env.NEXT_PUBLIC_SITE_URL ? `${process.env.NEXT_PUBLIC_SITE_URL}/api/pokemon` : 'http://localhost:3000/api/pokemon';

        try {
            const { data: player } = await supabase.from('players').select('id, points').eq('discord_id', myDiscordId).single();
            if (!player) return interaction.editReply('❌ 연동된 계정 정보가 없습니다.');
            const myPlayerId = player.id;

            // 1. 웹 API를 통해 경매장 데이터 가져오기
            const aucRes = await fetch(`${apiUrl}/auction`);
            const aucData = await aucRes.json();
            if (!aucData.success) return interaction.editReply('❌ 경매장 데이터를 불러오는 데 실패했습니다.');

            const auctions = aucData.data || [];

            // 2. 진행 중인 매물과 수령 대기 중인 매물 분리
            const activeAuctions = [];
            const claimableAuctions = [];

            auctions.forEach(a => {
                const isClosed = (new Date(a.end_at).getTime() - new Date().getTime()) <= 0;
                if (!isClosed && a.status === 'active') {
                    activeAuctions.push(a);
                } else if (isClosed && a.status !== 'claimed') {
                    const isSeller = a.seller_id === myPlayerId;
                    const isWinner = a.highest_bidder_id === myPlayerId;
                    if ((isSeller && !a.seller_claimed) || (isWinner && !a.buyer_claimed)) {
                        claimableAuctions.push(a);
                    }
                }
            });

            // 3. 메인 화면 구성
            const mainEmbed = new EmbedBuilder()
                .setColor(0x3B82F6)
                .setTitle('⚖️ 통합 경매장')
                .setDescription(`현재 진행 중인 매물: **${activeAuctions.length}개**\n나의 수령 대기 건수: **${claimableAuctions.length}건**\n\n아래 메뉴에서 원하는 작업을 선택하세요.`);

            const selectOptions = [];
            
            // 수령함 옵션 (비어있을 때와 아닐 때 분리)
            if (claimableAuctions.length > 0) {
                selectOptions.push({ label: `🎁 내 수령함 확인 (${claimableAuctions.length}건 대기 중)`, value: 'check_claims', emoji: '🎁' });
            } else {
                selectOptions.push({ label: '🎁 내 수령함 확인 (비어있음)', value: 'check_claims_empty', emoji: '📦' });
            }

            // 활성 매물 옵션 추가
            activeAuctions.slice(0, 24).forEach(a => {
                const itemName = a.sell_type === 'item' ? `${a.item_name} x${a.quantity}` : a.pokemon.name_ko;
                const price = a.current_bid;
                const isMyItem = a.seller_id === myPlayerId ? '(내 매물) ' : '';
                selectOptions.push({
                    label: `${isMyItem}[${price.toLocaleString()}P] ${itemName}`,
                    description: `판매자: ${a.seller_name}`,
                    value: `auction_${a.id}` // a.id는 매우 긴 문자열/BigInt 값입니다.
                });
            });

            if (activeAuctions.length === 0) {
                selectOptions.push({ label: '현재 진행 중인 매물이 없습니다.', value: 'empty_auction', emoji: '🍃' });
            }

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('auction_menu')
                .setPlaceholder('확인할 매물이나 수령함을 선택하세요.')
                .addOptions(selectOptions);

            const row = new ActionRowBuilder().addComponents(selectMenu);
            const message = await interaction.editReply({ embeds: [mainEmbed], components: [row] });

            // 4. 상호작용 콜렉터
            const collector = message.createMessageComponentCollector({ time: 180000 });

            collector.on('collect', async i => {
                // 이미 ephemeral 이지만 안전장치로 유지
                if (i.user.id !== interaction.user.id) return;

                const selected = i.values[0];

                // ----------------------------------------
                // 🛑 예외 처리: 빈 수령함 / 빈 경매장 클릭 시 친절한 안내!
                // ----------------------------------------
                if (selected === 'check_claims_empty') {
                    // 이미 본인만 보는 창이므로 바로 업데이트 처리
                    return i.update({ 
                        embeds: [new EmbedBuilder().setColor(0x808080).setDescription('📦 **현재 수령 대기 중인 항목이 없습니다.**\n경매에 참여해 새로운 포켓몬이나 아이템을 낙찰받아 보세요!')],
                        components: [row] // 메인 메뉴는 유지
                    });
                }
                if (selected === 'empty_auction') {
                    return i.update({ 
                        embeds: [new EmbedBuilder().setColor(0x808080).setDescription('🍃 **현재 진행 중인 경매 매물이 없습니다.**\n`/경매등록` 명령어로 첫 매물을 올려보시는 건 어떨까요?')],
                        components: [row]
                    });
                }

                // ----------------------------------------
                // 🎁 결과 수령함 로직
                // ----------------------------------------
                if (selected === 'check_claims') {
                    await i.deferUpdate(); // 처리 시간 확보 (로딩)
                    let successCount = 0;
                    for (const a of claimableAuctions) {
                        try {
                            const res = await fetch(`${apiUrl}/auction/claim`, {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ auction_id: a.id, user_id: myPlayerId })
                            });
                            const claimData = await res.json();
                            if (claimData.success) successCount++;
                        } catch (e) { console.error('수령 에러:', e); }
                    }
                    
                    const claimEmbed = new EmbedBuilder()
                        .setColor(0x00FF00)
                        .setTitle('🎁 일괄 수령 완료!')
                        .setDescription(`대기 중이던 **${successCount}건**의 아이템 및 포인트를 수령했습니다!\n*(마이페이지 또는 /내정보 에서 확인하세요)*`);
                    
                    await interaction.editReply({ embeds: [claimEmbed], components: [] });
                    return;
                }

                // ----------------------------------------
                // ⚖️ 특정 매물 선택 로직 (상세보기)
                // ----------------------------------------
                if (selected.startsWith('auction_')) {
                    const auctionId = selected.split('_')[1]; 
                    const targetAuc = activeAuctions.find(a => String(a.id) === auctionId);
                    
                    if (!targetAuc) {
                        return i.update({ 
                            embeds: [new EmbedBuilder().setColor(0xFF0000).setDescription('❌ 매물 정보를 찾을 수 없습니다. (이미 종료되었을 수 있습니다)')],
                            components: [row]
                        });
                    }

                    const isMyItem = targetAuc.seller_id === myPlayerId;
                    const itemName = targetAuc.sell_type === 'item' ? targetAuc.item_name : targetAuc.pokemon.name_ko;
                    const rarity = targetAuc.sell_type === 'item' ? '아이템' : targetAuc.pokemon.rarity || '일반';
                    const minBid = targetAuc.highest_bidder_id ? targetAuc.current_bid + 10 : targetAuc.current_bid;

                    const detailEmbed = new EmbedBuilder()
                        .setColor(isMyItem ? 0xFF9800 : 0x2196F3)
                        .setTitle(`상세 매물 정보: [${rarity}] ${itemName}`)
                        .setDescription(`**판매자:** ${targetAuc.seller_name}\n**현재 최고가:** ${targetAuc.current_bid.toLocaleString()} P\n**마감 시간:** <t:${Math.floor(new Date(targetAuc.end_at).getTime() / 1000)}:R>`);

                    if (targetAuc.pokemon) {
                        detailEmbed.setThumbnail(targetAuc.pokemon.official_art_url || targetAuc.pokemon.sprite_url);
                    }

                    // 버튼 구성 (입찰 / 내 매물 취소 / 최고 입찰자 방어)
                    const btnRow = new ActionRowBuilder();
                    
                    if (isMyItem) {
                        if (targetAuc.highest_bidder_id) {
                            btnRow.addComponents(new ButtonBuilder().setCustomId('no_cancel').setLabel('입찰자가 있어 취소 불가').setStyle(ButtonStyle.Secondary).setDisabled(true));
                        } else {
                            btnRow.addComponents(new ButtonBuilder().setCustomId(`cancel_${auctionId}`).setLabel('내 매물 판매 취소').setStyle(ButtonStyle.Danger));
                        }
                        
                        detailEmbed.addFields({ name: '💡 안내', value: '본인이 등록한 매물에는 입찰할 수 없습니다.' });

                    } else if (targetAuc.highest_bidder_id === myPlayerId) {
                        btnRow.addComponents(new ButtonBuilder().setCustomId('already_top').setLabel('내가 최고 입찰자입니다').setStyle(ButtonStyle.Success).setDisabled(true));
                    } else {
                        btnRow.addComponents(new ButtonBuilder().setCustomId(`bid_${auctionId}_${minBid}`).setLabel(`입찰하기 (최소 ${minBid.toLocaleString()}P)`).setStyle(ButtonStyle.Primary));
                    }

                    // 드롭다운 메뉴를 유지한 채로 아래에 상세 임베드와 버튼을 추가 업데이트
                    await i.update({ embeds: [mainEmbed, detailEmbed], components: [row, btnRow] });
                }
            });
            
        } catch (error) {
            console.error(error);
            await interaction.editReply('오류가 발생했습니다.');
        }
    },
};