const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('이모지추출')
        .setDescription('이 서버에 있는 모든 커스텀 이모지의 코드를 한 번에 뽑아줍니다.'),

    async execute(interaction) {
        // 서버에 있는 모든 커스텀 이모지를 가져옵니다.
        const emojis = interaction.guild.emojis.cache;

        if (emojis.size === 0) {
            return interaction.reply({ content: '이 서버에는 커스텀 이모지가 하나도 없네요!', ephemeral: true });
        }

        // 이모지 이미지와 복사하기 편한 코드 형태(<:이름:ID>)로 변환해서 리스트로 만듭니다.
        const emojiList = emojis.map(e => `${e} : \`<${e.animated ? 'a' : ''}:${e.name}:${e.id}>\``).join('\n');

        await interaction.reply({ 
            content: `**서버 이모지 목록 (총 ${emojis.size}개)**\n아래 코드를 그대로 복사해서 쓰세요!\n\n${emojiList}`, 
            ephemeral: true 
        });
    },
};