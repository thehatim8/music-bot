module.exports = {
  name: "voiceStateUpdate",
  async execute(client, oldState, newState) {
    const state = client.playerManager.getState(oldState.guild.id);

    if (!state || !state.voiceChannelId) {
      return;
    }

    if (state.isDestroying) {
      return;
    }

    if (oldState.id === client.user.id && oldState.channelId === state.voiceChannelId && newState.channelId !== state.voiceChannelId) {
      await client.playerManager.destroy(
        oldState.guild.id,
        "I was disconnected from the voice channel, so I cleaned up the player."
      );
      return;
    }

    if (oldState.channelId !== state.voiceChannelId && newState.channelId !== state.voiceChannelId) {
      return;
    }

    const channel =
      oldState.guild.channels.cache.get(state.voiceChannelId) ||
      newState.guild.channels.cache.get(state.voiceChannelId);

    if (!channel?.isVoiceBased?.()) {
      return;
    }

    const humanMembers = channel.members.filter((member) => !member.user.bot);

    if (humanMembers.size === 0) {
      await client.playerManager.destroy(
        oldState.guild.id,
        "Everyone left the voice channel, so I disconnected and cleared the player."
      );
    }
  }
};

