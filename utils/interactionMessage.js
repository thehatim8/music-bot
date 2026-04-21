function wrapReplyHandle(message, editFn) {
  if (!message) {
    return {
      edit: editFn
    };
  }

  const originalEdit = typeof message.edit === "function" ? message.edit.bind(message) : null;
  message.edit = (payload) => (editFn ? editFn(payload) : originalEdit?.(payload));
  return message;
}

function createInteractionMessage(interaction) {
  let initialResponseSent = false;

  return {
    guild: interaction.guild,
    member: interaction.member,
    author: interaction.user,
    channel: interaction.channel,
    async reply(payload) {
      if (interaction.deferred && !initialResponseSent) {
        initialResponseSent = true;
        await interaction.editReply(payload);
        const originalReply = await interaction.fetchReply();
        return wrapReplyHandle(originalReply, (nextPayload) => interaction.editReply(nextPayload));
      }

      if (interaction.replied || interaction.deferred) {
        const followUp = await interaction.followUp(payload);
        return wrapReplyHandle(followUp);
      }

      await interaction.reply(payload);
      initialResponseSent = true;

      const originalReply = await interaction.fetchReply();
      return wrapReplyHandle(originalReply, (nextPayload) => interaction.editReply(nextPayload));
    }
  };
}

module.exports = {
  createInteractionMessage
};
