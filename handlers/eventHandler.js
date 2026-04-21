const fs = require("node:fs/promises");
const path = require("node:path");

async function loadEvents(client) {
  const eventFiles = await fs.readdir(client.paths.events);

  for (const file of eventFiles) {
    if (!file.endsWith(".js")) {
      continue;
    }

    const filePath = path.join(client.paths.events, file);
    delete require.cache[require.resolve(filePath)];
    const event = require(filePath);

    if (!event?.name || typeof event.execute !== "function") {
      continue;
    }

    if (event.once) {
      client.once(event.name, (...args) => event.execute(client, ...args));
    } else {
      client.on(event.name, (...args) => event.execute(client, ...args));
    }
  }
}

module.exports = {
  loadEvents
};

