const { Connectors, Constants, Shoukaku } = require("shoukaku");

const { DEFAULT_PLAYBACK_VOLUME, IDLE_TIMEOUT_MS, PLAYBACK_START_TIMEOUT_MS } = require("../utils/constants");
const { createErrorEmbed, createInfoEmbed, createNowPlayingPayload } = require("../utils/embeds");
const { shuffleArray } = require("../utils/formatters");

const START_TIMEOUT_NOTICE_THROTTLE_MS = 30000;
const PLAYBACK_START_POSITION_GRACE_MS = 1000;
const NEUTRAL_AUDIO_FILTERS = Object.freeze({
  volume: 1,
  equalizer: [],
  karaoke: null,
  timescale: null,
  tremolo: null,
  vibrato: null,
  rotation: null,
  distortion: null,
  channelMix: null,
  lowPass: null
});

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
        restTimeout: 60,
        resume: false,
        resumeByLibrary: false,
        resumeTimeout: 0,
        voiceConnectionTimeout: 30
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

  isStateUsable(guildId, state) {
    if (!this.shoukaku.connections.has(guildId) || !this.shoukaku.players.has(guildId)) {
      return false;
    }

    const botMember = this.client.guilds.cache.get(guildId)?.members.me;

    if (!botMember) {
      return true;
    }

    return botMember.voice.channelId === state.voiceChannelId;
  }

  async createOrGetState({ guildId, voiceChannelId, textChannelId, shardId }) {
    const existing = this.getState(guildId);

    if (existing) {
      if (!this.isStateUsable(guildId, existing)) {
        await this.destroy(guildId);
      } else {
        existing.textChannelId = textChannelId;
        existing.voiceChannelId = voiceChannelId;
        this.clearIdleTimer(existing);
        return existing;
      }
    }

    const player = await this.shoukaku.joinVoiceChannel({
      guildId,
      channelId: voiceChannelId,
      shardId,
      deaf: true
    });

    await this.prepareAudioOutput(player);

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
      isDestroying: false,
      autoplayEnabled: false,
      autoplayResolvePromise: null,
      idleTimer: null,
      playbackStartTimer: null,
      playbackStartRequestedAt: 0,
      lastStartTimeoutNoticeAt: 0
    };

    this.bindPlayerEvents(state);
    this.states.set(guildId, state);
    return state;
  }

  bindPlayerEvents(state) {
    const { player } = state;

    player.on("start", async () => {
      this.clearPlaybackStartTimer(state);
      this.clearIdleTimer(state);
      state.isPaused = false;

      if (state.suppressNextStartMessage) {
        state.suppressNextStartMessage = false;
        return;
      }

      await this.sendNowPlaying(state);
    });

    player.on("update", () => {
      if (!state.playbackStartTimer || !state.current) {
        return;
      }

      const hasHadTimeToStart = Date.now() - state.playbackStartRequestedAt >= PLAYBACK_START_POSITION_GRACE_MS;
      if (hasHadTimeToStart && player.track === state.current.encoded && player.position > 0) {
        this.clearPlaybackStartTimer(state);
      }
    });

    player.on("end", async (event) => {
      if (event.reason === "replaced" || event.reason === "cleanup") {
        return;
      }

      this.clearPlaybackStartTimer(state);
      await this.advanceQueue(state.guildId).catch((error) => this.handleAdvanceError(state, error));
    });

    player.on("stuck", async () => {
      this.clearPlaybackStartTimer(state);
      state.skipLoopOnce = true;
      await this.sendToTextChannel(
        state.textChannelId,
        { embeds: [createErrorEmbed("The current track got stuck, so I skipped to the next item in queue.", "Playback issue")] }
      );
      await this.advanceQueue(state.guildId).catch((error) => this.handleAdvanceError(state, error));
    });

    player.on("exception", async (event) => {
      this.clearPlaybackStartTimer(state);
      console.error(`Playback exception in guild ${state.guildId}:`, event.exception);
      state.skipLoopOnce = true;
      await this.sendToTextChannel(
        state.textChannelId,
        { embeds: [createErrorEmbed("Lavalink reported a playback exception. I tried to keep the queue moving.", "Playback issue")] }
      );
      await this.advanceQueue(state.guildId).catch((error) => this.handleAdvanceError(state, error));
    });

    player.on("closed", async () => {
      this.clearPlaybackStartTimer(state);
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

  buildNeutralAudioFilters() {
    return {
      ...NEUTRAL_AUDIO_FILTERS,
      equalizer: []
    };
  }

  async prepareAudioOutput(player) {
    try {
      await player.update({
        volume: DEFAULT_PLAYBACK_VOLUME,
        filters: this.buildNeutralAudioFilters()
      });
      return;
    } catch (error) {
      console.warn("Failed to reset Lavalink audio filters:", error);
    }

    try {
      await player.setGlobalVolume(DEFAULT_PLAYBACK_VOLUME);
    } catch (error) {
      console.warn("Failed to set Lavalink playback volume:", error);
    }
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

  setAutoplay(guildId, enabled) {
    const state = this.getState(guildId);

    if (!state) {
      throw new Error("There is no active player.");
    }

    state.autoplayEnabled = Boolean(enabled);
    return state;
  }

  toggleAutoplay(guildId) {
    const state = this.getState(guildId);

    if (!state) {
      throw new Error("There is no active player.");
    }

    return this.setAutoplay(guildId, !state.autoplayEnabled);
  }

  getAutoplayExclusions(state, referenceTrack) {
    return [
      referenceTrack,
      state.current,
      ...state.queue,
      ...state.history.slice(-25)
    ].filter(Boolean);
  }

  async resolveAndQueueAutoplayTrack(state, sourceTrack) {
    const requester = sourceTrack?.requester;

    if (!requester?.id) {
      throw new Error("Autoplay needs a valid requester from the current track.");
    }

    const exclusions = this.getAutoplayExclusions(state, sourceTrack);
    const track = await this.client.music.resolveAutoplayTrack(sourceTrack, requester, exclusions);

    if (!state.autoplayEnabled || state.queue.length > 0) {
      return null;
    }

    state.queue.push(track);
    this.clearIdleTimer(state);
    return track;
  }

  async ensureAutoplayQueue(guildId, referenceTrack) {
    const state = this.getState(guildId);

    if (!state || !state.autoplayEnabled || state.queue.length > 0) {
      return null;
    }

    const sourceTrack = referenceTrack || state.current || state.history[state.history.length - 1];

    if (!sourceTrack) {
      return null;
    }

    if (state.autoplayResolvePromise) {
      return state.autoplayResolvePromise;
    }

    const resolvePromise = this.resolveAndQueueAutoplayTrack(state, sourceTrack);
    state.autoplayResolvePromise = resolvePromise;

    try {
      return await resolvePromise;
    } finally {
      if (state.autoplayResolvePromise === resolvePromise) {
        state.autoplayResolvePromise = null;
      }
    }
  }

  async playIfIdle(guildId) {
    const state = this.getState(guildId);

    if (!state) {
      throw new Error("No player exists for this guild yet.");
    }

    if (state.current && state.player.track) {
      return false;
    }

    if (state.current && !state.player.track) {
      await this.playCurrentTrack(state);
      return true;
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

    const autoplaySource = state.current;
    let nextTrack = state.queue.shift();

    if (!nextTrack && state.autoplayEnabled) {
      await this.ensureAutoplayQueue(guildId, autoplaySource).catch((error) => this.handleAdvanceError(state, error));
      nextTrack = state.queue.shift();
    }

    state.current = nextTrack || null;
    state.isPaused = false;

    if (!nextTrack) {
      this.scheduleIdleDestroy(state);
      return;
    }

    try {
      await this.playCurrentTrack(state);
    } catch (error) {
      if (state.current === nextTrack) {
        state.current = null;
        state.queue.unshift(nextTrack);
      }

      throw error;
    }
  }

  async playCurrentTrack(state) {
    if (!state.current) {
      return false;
    }

    const track = state.current;
    this.clearPlaybackStartTimer(state);
    await this.prepareAudioOutput(state.player);
    state.playbackStartRequestedAt = Date.now();
    state.playbackStartTimer = setTimeout(() => {
      void this.handlePlaybackStartTimeout(state.guildId, track).catch((error) => {
        console.error(`Failed to recover from playback start timeout in guild ${state.guildId}:`, error);
      });
    }, PLAYBACK_START_TIMEOUT_MS);

    try {
      await state.player.playTrack({
        track: {
          encoded: track.encoded
        },
        volume: DEFAULT_PLAYBACK_VOLUME
      });
    } catch (error) {
      this.clearPlaybackStartTimer(state);
      throw error;
    }

    return true;
  }

  async handlePlaybackStartTimeout(guildId, track) {
    const state = this.getState(guildId);

    if (!state || state.current !== track) {
      return;
    }

    if (state.player.track === track.encoded && state.player.position > 0) {
      this.clearPlaybackStartTimer(state);
      return;
    }

    console.warn(`Playback did not start within ${PLAYBACK_START_TIMEOUT_MS}ms in guild ${guildId}; skipping ${track.info?.title || "unknown track"}.`);
    this.clearPlaybackStartTimer(state);
    state.skipLoopOnce = true;
    state.current = null;
    state.isPaused = false;

    const now = Date.now();
    if (now - state.lastStartTimeoutNoticeAt >= START_TIMEOUT_NOTICE_THROTTLE_MS) {
      state.lastStartTimeoutNoticeAt = now;
      await this.sendToTextChannel(
        state.textChannelId,
        { embeds: [createErrorEmbed("Playback did not start in time, so I skipped to the next queued track.", "Playback issue")] }
      );
    }

    await this.advanceQueue(guildId).catch((error) => this.handleAdvanceError(state, error));
  }

  async handleAdvanceError(state, error) {
    console.error(`Failed to advance queue in guild ${state.guildId}:`, error);
    await this.sendToTextChannel(
      state.textChannelId,
      { embeds: [createErrorEmbed(error.message || "I could not start the next track.", "Playback issue")] }
    );
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

    this.clearPlaybackStartTimer(state);
    state.skipLoopOnce = true;
    await state.player.stopTrack();
    return state;
  }

  async stop(guildId) {
    const state = this.getState(guildId);

    if (!state) {
      throw new Error("There is no active player to stop.");
    }

    this.clearPlaybackStartTimer(state);
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
    await this.playCurrentTrack(state);

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

  clearPlaybackStartTimer(state) {
    if (state.playbackStartTimer) {
      clearTimeout(state.playbackStartTimer);
      state.playbackStartTimer = null;
    }

    state.playbackStartRequestedAt = 0;
  }

  scheduleIdleDestroy(state) {
    this.clearIdleTimer(state);
    this.clearPlaybackStartTimer(state);

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
    this.clearPlaybackStartTimer(state);
    state.isDestroying = true;

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
