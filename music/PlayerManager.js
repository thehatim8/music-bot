const { Connectors, Constants, Shoukaku } = require("shoukaku");

const { IDLE_TIMEOUT_MS } = require("../utils/constants");
const { createErrorEmbed, createInfoEmbed, createNowPlayingPayload } = require("../utils/embeds");
const { shuffleArray } = require("../utils/formatters");

class PlayerManager {
  constructor(client, config) {
    this.client = client;
    this.config = config;
    this.states = new Map();
    this.shoukaku = new Shoukaku(
      new Connectors.DiscordJS(client),
      [
        {
          name: "main",
          url: `${config.lavalink.host}:${config.lavalink.port}`,
          auth: config.lavalink.password
        }
      ],
      {
        moveOnDisconnect: false,
        reconnectTries: 3,
        reconnectInterval: 5,
        restTimeout: 30,
        resume: true,
        resumeByLibrary: true,
        resumeTimeout: 60
      }
    );

    this.shoukaku.on("ready", (name) => {
      console.log(`Lavalink node ready: ${name}`);
    });

    this.shoukaku.on("error", (name, error) => {
      console.error(`Lavalink node error (${name}):`, error);
    });

    this.shoukaku.on("disconnect", (name, reconnectsLeft) => {
      console.warn(`Lavalink node disconnected: ${name}. Reconnects left: ${reconnectsLeft}`);
    });
  }

  getSearchNode() {
    const node = this.shoukaku.getIdealNode();

    if (!node || node.state !== Constants.State.CONNECTED) {
      throw new Error("No Lavalink node is currently connected. Make sure Lavalink is running first.");
    }

    return node;
  }

  getState(guildId) {
    return this.states.get(guildId) || null;
  }

  async createOrGetState({ guildId, voiceChannelId, textChannelId, shardId }) {
    const existing = this.getState(guildId);

    if (existing) {
      existing.textChannelId = textChannelId;
      existing.voiceChannelId = voiceChannelId;
      this.clearIdleTimer(existing);
      return existing;
    }

    const player = await this.shoukaku.joinVoiceChannel({
      guildId,
      channelId: voiceChannelId,
      shardId,
      deaf: true
    });

    await player.setGlobalVolume(100);

    const state = {
      guildId,
      textChannelId,
      voiceChannelId,
      player,
      queue: [],
      history: [],
      current: null,
      loopMode: "off",
      isPaused: false,
      skipLoopOnce: false,
      suppressNextStartMessage: false,
      idleTimer: null
    };

    this.bindPlayerEvents(state);
    this.states.set(guildId, state);
    return state;
  }

  bindPlayerEvents(state) {
    const { player } = state;

    player.on("start", async () => {
      this.clearIdleTimer(state);
      state.isPaused = false;

      if (state.suppressNextStartMessage) {
        state.suppressNextStartMessage = false;
        return;
      }

      await this.sendNowPlaying(state);
    });

    player.on("end", async (event) => {
      if (event.reason === "replaced" || event.reason === "cleanup") {
        return;
      }

      await this.advanceQueue(state.guildId);
    });

    player.on("stuck", async () => {
      state.skipLoopOnce = true;
      await this.sendToTextChannel(
        state.textChannelId,
        { embeds: [createErrorEmbed("The current track got stuck, so I skipped to the next item in queue.", "Playback issue")] }
      );
      await this.advanceQueue(state.guildId);
    });

    player.on("exception", async (event) => {
      console.error(`Playback exception in guild ${state.guildId}:`, event.exception);
      state.skipLoopOnce = true;
      await this.sendToTextChannel(
        state.textChannelId,
        { embeds: [createErrorEmbed("Lavalink reported a playback exception. I tried to keep the queue moving.", "Playback issue")] }
      );
      await this.advanceQueue(state.guildId);
    });

    player.on("closed", async () => {
      await this.destroy(state.guildId, "The voice connection closed, so I cleaned up the player.");
    });
  }

  buildLoopTrack(track) {
    return {
      raw: track.raw,
      encoded: track.encoded,
      info: { ...track.info },
      requester: { ...track.requester },
      sourceLabel: track.sourceLabel
    };
  }

  enqueueTracks(guildId, tracks) {
    const state = this.getState(guildId);

    if (!state) {
      throw new Error("No player exists for this guild yet.");
    }

    state.queue.push(...tracks);
    this.clearIdleTimer(state);
    return state;
  }

  async playIfIdle(guildId) {
    const state = this.getState(guildId);

    if (!state) {
      throw new Error("No player exists for this guild yet.");
    }

    if (state.current || state.player.track) {
      return false;
    }

    await this.advanceQueue(guildId);
    return true;
  }

  async advanceQueue(guildId) {
    const state = this.getState(guildId);

    if (!state) {
      return;
    }

    if (state.current) {
      state.history.push(this.buildLoopTrack(state.current));
      if (state.history.length > 25) {
        state.history.shift();
      }
    }

    if (state.current && !state.skipLoopOnce) {
      if (state.loopMode === "track") {
        state.queue.unshift(this.buildLoopTrack(state.current));
      } else if (state.loopMode === "queue") {
        state.queue.push(this.buildLoopTrack(state.current));
      }
    }

    state.skipLoopOnce = false;

    const nextTrack = state.queue.shift();
    state.current = nextTrack || null;
    state.isPaused = false;

    if (!nextTrack) {
      this.scheduleIdleDestroy(state);
      return;
    }

    await state.player.playTrack({
      track: {
        encoded: nextTrack.encoded
      }
    });
  }

  async pause(guildId) {
    const state = this.getState(guildId);
    if (!state?.current) {
      throw new Error("There is no active track to pause.");
    }

    await state.player.setPaused(true);
    state.isPaused = true;
    return state;
  }

  async resume(guildId) {
    const state = this.getState(guildId);
    if (!state?.current) {
      throw new Error("There is no active track to resume.");
    }

    await state.player.setPaused(false);
    state.isPaused = false;
    return state;
  }

  async skip(guildId) {
    const state = this.getState(guildId);

    if (!state?.current) {
      throw new Error("There is no active track to skip.");
    }

    state.skipLoopOnce = true;
    await state.player.stopTrack();
    return state;
  }

  async stop(guildId) {
    const state = this.getState(guildId);

    if (!state) {
      throw new Error("There is no active player to stop.");
    }

    state.queue.length = 0;
    state.current = null;
    await this.destroy(guildId);
  }

  clearQueue(guildId) {
    const state = this.getState(guildId);

    if (!state) {
      throw new Error("There is no active player.");
    }

    state.queue.length = 0;
    return state;
  }

  shuffleQueue(guildId) {
    const state = this.getState(guildId);

    if (!state) {
      throw new Error("There is no active player.");
    }

    shuffleArray(state.queue);
    return state;
  }

  setLoopMode(guildId, mode) {
    const state = this.getState(guildId);

    if (!state) {
      throw new Error("There is no active player.");
    }

    state.loopMode = mode;
    return state;
  }

  async seek(guildId, positionMs) {
    const state = this.getState(guildId);

    if (!state?.current) {
      throw new Error("There is no active track to seek.");
    }

    await state.player.seekTo(positionMs);
    return state;
  }

  async previous(guildId) {
    const state = this.getState(guildId);

    if (!state?.current) {
      throw new Error("There is no active track to go back from.");
    }

    if (state.history.length === 0) {
      await state.player.seekTo(0);
      state.isPaused = false;
      return {
        state,
        track: state.current,
        restarted: true
      };
    }

    const previousTrack = state.history.pop();
    state.queue.unshift(this.buildLoopTrack(state.current));
    state.skipLoopOnce = true;
    state.current = previousTrack;
    state.isPaused = false;
    await state.player.playTrack({
      track: {
        encoded: previousTrack.encoded
      }
    });

    return {
      state,
      track: previousTrack,
      restarted: false
    };
  }

  async sendNowPlaying(state) {
    if (!state.current) {
      return;
    }

    await this.sendToTextChannel(state.textChannelId, createNowPlayingPayload(state.current, state));
  }

  async sendToTextChannel(channelId, payload) {
    const channel = await this.client.channels.fetch(channelId).catch(() => null);

    if (!channel?.isTextBased()) {
      return null;
    }

    return channel.send(payload).catch(() => null);
  }

  clearIdleTimer(state) {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
  }

  scheduleIdleDestroy(state) {
    this.clearIdleTimer(state);

    state.idleTimer = setTimeout(async () => {
      const latestState = this.getState(state.guildId);

      if (!latestState || latestState.current || latestState.queue.length > 0) {
        return;
      }

      await this.sendToTextChannel(
        latestState.textChannelId,
        { embeds: [createInfoEmbed("The queue stayed empty for 2 minutes, so I disconnected to keep resources clean.", "Disconnected")] }
      );
      await this.destroy(latestState.guildId);
    }, IDLE_TIMEOUT_MS);
  }

  async destroy(guildId, reason) {
    const state = this.getState(guildId);

    if (!state) {
      return;
    }

    this.clearIdleTimer(state);

    try {
      await this.shoukaku.leaveVoiceChannel(guildId);
    } catch (error) {
      console.error(`Failed to leave voice channel for guild ${guildId}:`, error);
      try {
        await state.player.destroy();
      } catch {
        // Ignore secondary destroy errors.
      }
    }

    this.states.delete(guildId);

    if (reason) {
      await this.sendToTextChannel(state.textChannelId, {
        embeds: [createInfoEmbed(reason, "Player cleaned up")]
      });
    }
  }

  async destroyAll(reason) {
    const guildIds = [...this.states.keys()];

    for (const guildId of guildIds) {
      await this.destroy(guildId, reason);
    }
  }
}

module.exports = PlayerManager;
