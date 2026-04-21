const { createErrorEmbed } = require("./embeds");

async function ensureMemberInVoice(message) {
  const voiceChannel = message.member?.voice?.channel;

  if (!voiceChannel) {
    await message.reply({
      embeds: [createErrorEmbed("Join a voice channel first, then try that command again.")]
    });
    return null;
  }

  return voiceChannel;
}

async function ensureSameVoiceChannel(message, state) {
  if (!state?.voiceChannelId) {
    return true;
  }

  const memberChannelId = message.member?.voice?.channelId;

  if (memberChannelId !== state.voiceChannelId) {
    await message.reply({
      embeds: [createErrorEmbed("You need to be in the same voice channel as the bot to use that command.")]
    });
    return false;
  }

  return true;
}

async function ensureActivePlayer(message, client) {
  const state = client.playerManager.getState(message.guild.id);

  if (!state || (!state.current && state.queue.length === 0)) {
    await message.reply({
      embeds: [createErrorEmbed("There is nothing in the queue right now.")]
    });
    return null;
  }

  return state;
}

module.exports = {
  ensureActivePlayer,
  ensureMemberInVoice,
  ensureSameVoiceChannel
};

