const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('산책')
        .setDescription('장착 중인 포켓몬과 함께 산책을 떠나 경험치와 아이템을 획득합니다.'),

    async execute(interaction, supabase) {
        // 슬래시 명령어(/산책)로 실행했든, 버튼 클릭으로 실행했든 동일하게 팝업창(ephemeral)으로 시작
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ ephemeral: true });
        }

        const myDiscordId = interaction.user.id;
        const apiUrl = process.env.NEXT_PUBLIC_SITE_URL ? `${process.env.NEXT_PUBLIC_SITE_URL}/api/pokemon` : 'http://localhost:3000/api/pokemon';

        let isSessionActive = true; // 🔄 '다시 하기'를 위한 상태 루프

        while (isSessionActive) {
            try {
                // 1. 유저 & 장착 포켓몬 정보 확인
                const { data: player } = await supabase.from('players').select('id, points').eq('discord_id', myDiscordId).single();
                if (!player) {
                    return interaction.editReply({ content: '❌ 연동된 계정 정보가 없습니다.', embeds: [], components: [] });
                }

                const { data: equipped } = await supabase.from('user_inventory').select('id, pokemon_id').eq('user_id', player.id).eq('status', 'equipped').maybeSingle();
                if (!equipped) {
                    return interaction.editReply({ content: '❌ 장착 중인 포켓몬이 없습니다. `/장착`을 먼저 해주세요.', embeds: [], components: [] });
                }

                // 2. 코스 선택 화면 구성
                const embed = new EmbedBuilder()
                    .setColor(0x4CAF50)
                    .setTitle('🌳 어디로 산책을 갈까요?')
                    .setDescription(`현재 보유 포인트: **${player.points.toLocaleString()} P**\n원하시는 산책 코스를 선택해주세요!`);

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`walk_course_1_${equipped.id}`).setLabel('가벼운 산책 (50P)').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`walk_course_2_${equipped.id}`).setLabel('일반 산책 (100P)').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`walk_course_3_${equipped.id}`).setLabel('하드코어 (150P)').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId('close_walk').setLabel('닫기').setStyle(ButtonStyle.Secondary)
                );

                const msg = await interaction.editReply({ embeds: [embed], components: [row] });

                // 3. 코스 선택 버튼 대기 (60초 타임아웃)
                const selection = await msg.awaitMessageComponent({ filter: i => i.user.id === myDiscordId, time: 60000 });

                // [닫기] 선택 시
                if (selection.customId === 'close_walk') {
                    await selection.update({ components: [] });
                    isSessionActive = false;
                    break;
                }

                // [산책 코스] 선택 시
                if (selection.customId.startsWith('walk_course_')) {
                    const parts = selection.customId.split('_');
                    const hours = parseInt(parts[2]);
                    const inventoryItemId = parts.slice(3).join('_');

                    await selection.update({ 
                        embeds: [new EmbedBuilder().setColor(0x8BC34A).setTitle('👟 신발 끈을 단단히 묶는 중...').setDescription('산책을 준비하고 있습니다. 잠시만 기다려주세요!')], 
                        components: [] 
                    });

                    // 📡 산책 API 호출
                    const res = await fetch(`${apiUrl}/walk`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId: player.id, inventory_item_id: inventoryItemId, hours })
                    });

                    const data = await res.json();
                    if (!data.success) {
                        await interaction.editReply({ content: `❌ 산책 실패: ${data.message}`, embeds: [], components: [] });
                        isSessionActive = false;
                        break;
                    }

                    const { logs, summary } = data.data;

                    let currentLogIndex = 0;
                    let isSkipped = false;
                    let delay = 2000; 
                    const displayedLogs = [];

                    const controlRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`speed_${myDiscordId}`).setLabel('배속 (x1)').setEmoji('⏩').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId(`skip_${myDiscordId}`).setLabel('스킵').setEmoji('⏭️').setStyle(ButtonStyle.Danger)
                    );

                    // 📺 실시간 스트리밍 애니메이션
                    while (currentLogIndex < logs.length && !isSkipped) {
                        displayedLogs.push(logs[currentLogIndex]);
                        const visibleLogs = displayedLogs.slice(-5).join('\n');
                        const progress = Math.floor(((currentLogIndex + 1) / logs.length) * 10);
                        const progressBar = '🟩'.repeat(progress) + '⬜'.repeat(10 - progress);

                        const walkingEmbed = new EmbedBuilder()
                            .setColor(0x4CAF50)
                            .setTitle('🐾 산책 진행 중...')
                            .setDescription(`**[진행도: ${progressBar}]**\n\`\`\`text\n${visibleLogs}\n\`\`\``)
                            .setFooter({ text: '하단 버튼을 눌러 속도를 조절하거나 스킵할 수 있습니다.' });

                        await interaction.editReply({ embeds: [walkingEmbed], components: [controlRow] });

                        try {
                            const btnInteraction = await msg.awaitMessageComponent({ filter: i => i.user.id === myDiscordId, time: delay });

                            if (btnInteraction.customId.startsWith('speed_')) {
                                delay = delay === 2000 ? 800 : 2000;
                                const speedLabel = delay === 2000 ? '배속 (x1)' : '배속 (x3)';
                                controlRow.components[0].setLabel(speedLabel).setStyle(delay === 2000 ? ButtonStyle.Primary : ButtonStyle.Warning);
                                await btnInteraction.deferUpdate();
                            } 
                            else if (btnInteraction.customId.startsWith('skip_')) {
                                isSkipped = true;
                                await btnInteraction.deferUpdate();
                            }
                        } catch (e) { /* 버튼 대기 시간 초과 시 다음 로그로 패스 */ }

                        currentLogIndex++;
                    }

                    // 🏆 최종 정산 화면
                    const fullLogText = logs.join('\n');
                    const resultEmbed = new EmbedBuilder()
                        .setColor(0xFFC107)
                        .setTitle('🎉 산책 대성공!')
                        .setDescription(`총 **${logs.length}번**의 행동을 무사히 마쳤습니다.\n\`\`\`text\n${fullLogText}\n\`\`\`### 📊 획득 보상\n`)
                        .addFields(
                            { name: '✨ 경험치', value: `**+${summary.totalExp} EXP**`, inline: true },
                            { name: '💰 포인트', value: `**+${summary.gainedPoints} P**`, inline: true }
                        );

                    if (summary.levelUps > 0) resultEmbed.addFields({ name: '🎊 레벨 업!', value: `**+${summary.levelUps} Lv 상승!**`, inline: false });
                    if (summary.foundItems && Object.keys(summary.foundItems).length > 0) {
                        const itemsStr = Object.entries(summary.foundItems).map(([name, qty]) => `* ${name} x**${qty}**`).join('\n');
                        resultEmbed.addFields({ name: '💎 발견한 아이템', value: itemsStr, inline: false });
                    }
                    if (summary.caughtPokemons && summary.caughtPokemons.length > 0) {
                        const pokesStr = summary.caughtPokemons.map(p => `* [${p.name}]`).join('\n');
                        resultEmbed.addFields({ name: '🤝 새로 포획한 포켓몬', value: `${pokesStr}\n*(보관함을 확인하세요!)*`, inline: false });
                    }

                    const endRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('re_walk_pet').setLabel('다시 하기').setEmoji('🔄').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId('close_walk').setLabel('종료').setEmoji('✖️').setStyle(ButtonStyle.Secondary)
                    );

                    await interaction.editReply({ embeds: [resultEmbed], components: [endRow] });

                    // 🔄 다시 하기 또는 종료 대기
                    const endSelection = await msg.awaitMessageComponent({ filter: i => i.user.id === myDiscordId, time: 120000 });
                    
                    if (endSelection.customId === 're_walk_pet') {
                        await endSelection.deferUpdate();
                        // while 루프가 처음으로 돌아가 코스 선택창을 다시 띄움!
                    } else {
                        await endSelection.update({ components: [] });
                        isSessionActive = false;
                    }
                }
            } catch (error) {
                // 시간 초과 등으로 상호작용이 끊어졌을 때의 안전망
                console.error('산책 진행 중 에러/타임아웃:', error);
                await interaction.editReply({ components: [] }).catch(()=>{});
                isSessionActive = false;
            }
        }
    }
};