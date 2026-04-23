const { MessageFlags } = require("discord.js");
const { createErrorEmbed, createNowPlayingPayload, createPlayerControlsRow, createSuccessEmbed } = require("../utils/embeds");

function isUnknownInteractionError(error) {
  return error?.code === 10062 || error?.rawError?.code === 10062 || error?.message?.includes("Unknown interaction");
}

module.exports = {
  name: "interactionCreate",
  async execute(client, interaction) {
    if (interaction.isButton()) {
      return handleMusicControls(client, interaction);
    }

    if (!interaction.isChatInputCommand() || !interaction.inGuild()) {
      return;
    }

    const command = client.slashCommands.get(interaction.commandName);

    if (!command) {
      return;
    }

    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply();
      }

      await command.executeSlash({ client, interaction });
    } catch (error) {
      if (isUnknownInteractionError(error)) {
        console.warn(`Interaction expired before acknowledgement for /${interaction.commandName}.`);
        return;
      }

      console.error(`Slash command failed (${interaction.commandName}):`, error);

      const payload = {
        embeds: [createErrorEmbed(error.message || "That interaction failed unexpectedly.")]
      };

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => null);
      } else {
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => null);
      }
    }
  }
};

async function handleMusicControls(client, interaction) {
  if (!interaction.inGuild() || !interaction.customId.startsWith("music:")) {
    return;
  }

  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }
  } catch (error) {
    if (isUnknownInteractionError(error)) {
      console.warn(`Button interaction expired before acknowledgement for ${interaction.customId}.`);
    }
    return;
  }

  const state = client.playerManager.getState(interaction.guildId);

  if (!state?.current) {
    await interaction.followUp({
      embeds: [createErrorEmbed("There is no active track right now.")],
      flags: MessageFlags.Ephemeral
    }).catch(() => null);
    return;
  }

  const memberVoiceChannelId = interaction.member?.voice?.channelId;

  if (!memberVoiceChannelId) {
    await interaction.followUp({
      embeds: [createErrorEmbed("Join the bot's voice channel before using player controls.")],
      flags: MessageFlags.Ephemeral
    }).catch(() => null);
    return;
  }

  if (memberVoiceChannelId !== state.voiceChannelId) {
    await interaction.followUp({
      embeds: [createErrorEmbed("You need to be in the same voice channel as the bot to use player controls.")],
      flags: MessageFlags.Ephemeral
    }).catch(() => null);
    return;
  }

  const action = interaction.customId.split(":")[1];

  try {
    if (action === "previous") {
      const result = await client.playerManager.previous(interaction.guildId);

      if (result.restarted) {
        await interaction.message.edit(createNowPlayingPayload(result.track, result.state)).catch(() => null);
      }

      return;
    }

    if (action === "pause") {
      if (state.isPaused) {
        await client.playerManager.resume(interaction.guildId);
      } else {
        await client.playerManager.pause(interaction.guildId);
      }

      await interaction.message.edit({
        components: [createPlayerControlsRow(client.playerManager.getState(interaction.guildId))]
      }).catch(() => null);
      return;
    }

    if (action === "autoplay") {
      const updatedState = client.playerManager.toggleAutoplay(interaction.guildId);

      await interaction.message.edit(createNowPlayingPayload(updatedState.current, updatedState)).catch(() => null);

      if (!updatedState.autoplayEnabled) {
        await interaction.followUp({
          embeds: [createSuccessEmbed("Autoplay is now off.", "Autoplay disabled")],
          flags: MessageFlags.Ephemeral
        }).catch(() => null);
        return;
      }

      try {
        const queuedTrack = await client.playerManager.ensureAutoplayQueue(interaction.guildId);
        await interaction.followUp({
          embeds: [
            createSuccessEmbed(
              queuedTrack
                ? `Autoplay is on. Next similar track: **${queuedTrack.info.title}**.`
                : "Autoplay is on. Similar songs will be added when the queue runs out.",
              "Autoplay enabled"
            )
          ],
          flags: MessageFlags.Ephemeral
        }).catch(() => null);
      } catch (error) {
        await interaction.followUp({
          embeds: [createErrorEmbed(error.message || "I could not find a similar song for autoplay.")],
          flags: MessageFlags.Ephemeral
        }).catch(() => null);
      }

      return;
    }

    if (action === "skip") {
      await client.playerManager.skip(interaction.guildId);
      return;
    }

    if (action === "stop") {
      await client.playerManager.stop(interaction.guildId);
      await interaction.message.edit({
        components: [createPlayerControlsRow(null)]
      }).catch(() => null);
    }
  } catch (error) {
    if (isUnknownInteractionError(error)) {
      console.warn(`Button interaction expired during action for ${interaction.customId}.`);
      return;
    }

    await interaction.followUp({
      embeds: [createErrorEmbed(error.message || "That control action failed.")],
      flags: MessageFlags.Ephemeral
    }).catch(() => null);
  }
}
