const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('mvp')
        .setDescription('나의 몬스터 볼 MVP 구독 상태와 적용 중인 혜택, 남은 기간을 확인합니다.'),

    async execute(interaction, supabase) {
        // 본인만 볼 수 있도록 처리
        await interaction.deferReply({ ephemeral: true }); 
        const myDiscordId = interaction.user.id;
        const userName = interaction.member?.displayName || interaction.user.username;

        try {
            // 유저의 포인트와 MVP 만료일 정보만 가볍게 조회
            const { data: player } = await supabase.from('players')
                .select('points, is_mvp, mvp_expires_at, premium_tier_expires_at')
                .eq('discord_id', myDiscordId)
                .single();
                
            if (!player) return interaction.editReply('❌ 연동된 계정 정보가 없습니다. 마이페이지에서 연동해주세요!');

            const now = new Date();
            const premiumExp = player.premium_tier_expires_at ? new Date(player.premium_tier_expires_at) : null;
            const mvpExp = player.mvp_expires_at ? new Date(player.mvp_expires_at) : null;

            let embed;

            // 1순위: 최고 티어 (Tier 2) 혜택
            if (premiumExp && premiumExp > now) {
                embed = new EmbedBuilder()
                    .setColor(0x03A9F4) // 파란색 보석 느낌
                    .setTitle('💎 몬스터 볼 프리미엄 멤버십 (Tier 2)')
                    .setDescription(`**${userName}** 님은 현재 **최고 티어 MVP 혜택**을 받고 계십니다!\n\n` +
                                    `**[적용 중인 혜택]**\n` +
                                    `🎙️ **음성방 보상:** 10분당 **8 P**\n` +
                                    `⚔️ **내전 완료 보상:** 승리 **30 P** / 패배 **25 P**\n\n` +
                                    `**[만료 일시]**\n` +
                                    `⏳ <t:${Math.floor(premiumExp.getTime()/1000)}:f> (<t:${Math.floor(premiumExp.getTime()/1000)}:R>)`)
                    .setFooter({ text: '언제나 든든한 후원에 감사드립니다!' });
            } 
            // 2순위: 일반 MVP (Tier 1) 혜택
            else if (mvpExp && mvpExp > now) {
                embed = new EmbedBuilder()
                    .setColor(0xFFD700) // 황금색
                    .setTitle('👑 몬스터 볼 MVP 멤버십 (Tier 1)')
                    .setDescription(`**${userName}** 님은 현재 **일반 MVP 혜택**을 받고 계십니다!\n\n` +
                                    `**[적용 중인 혜택]**\n` +
                                    `🎙️ **음성방 보상:** 10분당 **7 P**\n` +
                                    `⚔️ **내전 완료 보상:** 승리 **20 P** / 패배 **15 P**\n\n` +
                                    `**[만료 일시]**\n` +
                                    `⏳ <t:${Math.floor(mvpExp.getTime()/1000)}:f> (<t:${Math.floor(mvpExp.getTime()/1000)}:R>)`)
                    .setFooter({ text: '언제나 든든한 후원에 감사드립니다!' });
            } 
            // 3순위: 혜택 없음 (일반 유저)
            else {
                embed = new EmbedBuilder()
                    .setColor(0x808080) // 회색
                    .setTitle('👤 일반 소환사')
                    .setDescription(`**${userName}** 님은 현재 적용 중인 MVP 혜택이 없습니다.\n\n` +
                                    `**[기본 혜택]**\n` +
                                    `🎙️ **음성방 보상:** 10분당 **5 P**\n` +
                                    `⚔️ **내전 완료 보상:** 승리 **20 P** / 패배 **15 P**\n\n` +
                                    `💡 *관리자에게 후원하고 풍성한 MVP 혜택을 누려보세요!*`);
            }

            // 현재 보유 포인트 추가 정보로 삽입
            embed.addFields({ name: '💰 내 지갑', value: `현재 잔액: **${(player.points || 0).toLocaleString()} P**` });

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('MVP 명령어 에러:', error);
            await interaction.editReply('구독 정보를 불러오는 중 오류가 발생했습니다.');
        }
    }
};