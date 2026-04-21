async function registerSlashCommands(target, client) {
  const slashPayload = [...client.slashCommands.values()].map((command) => command.data.toJSON());
  return target.commands.set(slashPayload);
}

module.exports = {
  registerSlashCommands
};

