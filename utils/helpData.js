module.exports = [
  {
    title: "Playback",
    commands: [
      "`/play <query>` or `,play <query>`",
      "`/pause` or `,pause`",
      "`/resume` or `,resume`",
      "`/skip` or `,skip`",
      "`/stop` or `,stop`",
      "`/seek <seconds>` or `,seek <seconds>`"
    ]
  },
  {
    title: "Queue",
    commands: [
      "`/queue` or `,queue`",
      "`/clear` or `,clear`",
      "`/shuffle` or `,shuffle`",
      "`/loop <track|queue|off>` or `,loop <track|queue|off>`"
    ]
  },
  {
    title: "Playlists",
    commands: [
      "`/playlist create <name>` or `,playlist create <name>`",
      "`/playlist delete <name>` or `,playlist delete <name>`",
      "`/playlist add <name> <song>` or `,playlist add <name> <song>`",
      "`/playlist remove <name> <index>` or `,playlist remove <name> <index>`",
      "`/playlist play <name>` or `,playlist play <name>`",
      "`/playlist list` or `,playlist list`",
      "`/playlist info <name>` or `,playlist info <name>`"
    ]
  },
  {
    title: "Settings",
    commands: [
      "`/setprefix <prefix>` or `,setprefix <prefix>`",
      "`/help` or `,help`"
    ]
  }
];
