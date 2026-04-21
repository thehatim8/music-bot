const fs = require("node:fs/promises");
const path = require("node:path");

async function loadCommands(client) {
  const commandFiles = await fs.readdir(client.paths.commands);

  for (const file of commandFiles) {
    if (!file.endsWith(".js")) {
      continue;
    }

    const filePath = path.join(client.paths.commands, file);
    delete require.cache[require.resolve(filePath)];
    const command = require(filePath);

    if (command.name && typeof command.executePrefix === "function") {
      client.prefixCommands.set(command.name, command);

      if (Array.isArray(command.aliases)) {
        for (const alias of command.aliases) {
          client.commandAliases.set(alias, command.name);
        }
      }
    }

    if (command.data && typeof command.executeSlash === "function") {
      client.slashCommands.set(command.data.name, command);
    }
  }
}

module.exports = {
  loadCommands
};

