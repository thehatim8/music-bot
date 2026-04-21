const createSupabase = require("./supabase");

class PlaylistRepository {
  constructor(config) {
    this.supabase = createSupabase(config);
  }

  formatDatabaseError(action, error) {
    const message = error?.message || "Unknown database error";

    if (message.startsWith(`Failed to ${action}:`)) {
      return message;
    }

    if (
      message.includes("Could not find the table 'public.playlists'") ||
      message.includes("Could not find the table 'public.playlist_songs'")
    ) {
      return `Failed to ${action}: the Supabase playlist tables do not exist yet. Run the SQL in database/schema.sql first.`;
    }

    if (
      message.includes("fetch failed") ||
      message.includes("Connect Timeout") ||
      message.includes("UND_ERR_CONNECT_TIMEOUT") ||
      message.includes("timed out")
    ) {
      return `Failed to ${action}: Supabase could not be reached. Check SUPABASE_URL, your internet connection, and whether your firewall or ISP is blocking the request.`;
    }

    return `Failed to ${action}: ${message}`;
  }

  async createPlaylist(userId, name, isPublic = false) {
    try {
      const existing = await this.getPlaylist(userId, name);

      if (existing) {
        throw new Error(`You already have a playlist named "${name}".`);
      }

      const { data, error } = await this.supabase
        .from("playlists")
        .insert({
          user_id: userId,
          name: name.trim(),
          is_public: isPublic
        })
        .select("*")
        .single();

      if (error) {
        throw new Error(this.formatDatabaseError("create playlist", error));
      }

      return {
        ...data,
        songs: []
      };
    } catch (error) {
      throw new Error(this.formatDatabaseError("create playlist", error));
    }
  }

  async deletePlaylist(userId, name) {
    try {
      const playlist = await this.getPlaylist(userId, name);

      if (!playlist) {
        throw new Error(`Playlist "${name}" was not found.`);
      }

      const { error } = await this.supabase.from("playlists").delete().eq("id", playlist.id);

      if (error) {
        throw new Error(this.formatDatabaseError("delete playlist", error));
      }
    } catch (error) {
      throw new Error(this.formatDatabaseError("delete playlist", error));
    }
  }

  async getPlaylist(userId, name) {
    try {
      const { data, error } = await this.supabase
        .from("playlists")
        .select("*")
        .eq("user_id", userId)
        .ilike("name", name.trim())
        .maybeSingle();

      if (error) {
        throw new Error(this.formatDatabaseError("fetch playlist", error));
      }

      if (!data) {
        return null;
      }

      const songs = await this.getSongs(data.id);

      return {
        ...data,
        songs
      };
    } catch (error) {
      throw new Error(this.formatDatabaseError("fetch playlist", error));
    }
  }

  async listPlaylists(userId) {
    try {
      const { data, error } = await this.supabase
        .from("playlists")
        .select("id, name, is_public, created_at, playlist_songs(id)")
        .eq("user_id", userId)
        .order("created_at", { ascending: true });

      if (error) {
        throw new Error(this.formatDatabaseError("list playlists", error));
      }

      return data.map((playlist) => ({
        id: playlist.id,
        name: playlist.name,
        isPublic: playlist.is_public,
        createdAt: playlist.created_at,
        songCount: Array.isArray(playlist.playlist_songs) ? playlist.playlist_songs.length : 0
      }));
    } catch (error) {
      throw new Error(this.formatDatabaseError("list playlists", error));
    }
  }

  async addSong(userId, playlistName, song) {
    try {
      const playlist = await this.getPlaylist(userId, playlistName);

      if (!playlist) {
        throw new Error(`Playlist "${playlistName}" was not found.`);
      }

      const position = playlist.songs.length + 1;
      const { data, error } = await this.supabase
        .from("playlist_songs")
        .insert({
          playlist_id: playlist.id,
          title: song.title,
          url: song.url,
          duration: song.duration,
          position
        })
        .select("*")
        .single();

      if (error) {
        throw new Error(this.formatDatabaseError("add song to playlist", error));
      }

      return data;
    } catch (error) {
      throw new Error(this.formatDatabaseError("add song to playlist", error));
    }
  }

  async removeSong(userId, playlistName, index) {
    try {
      const playlist = await this.getPlaylist(userId, playlistName);

      if (!playlist) {
        throw new Error(`Playlist "${playlistName}" was not found.`);
      }

      const target = playlist.songs[index - 1];

      if (!target) {
        throw new Error(`Song #${index} does not exist in "${playlistName}".`);
      }

      const { error } = await this.supabase.from("playlist_songs").delete().eq("id", target.id);

      if (error) {
        throw new Error(this.formatDatabaseError("remove song from playlist", error));
      }

      const reorderTargets = playlist.songs.filter((song) => song.position > target.position);
      for (const song of reorderTargets) {
        const { error: updateError } = await this.supabase
          .from("playlist_songs")
          .update({ position: song.position - 1 })
          .eq("id", song.id);

        if (updateError) {
          throw new Error(this.formatDatabaseError("reorder playlist after removing a song", updateError));
        }
      }

      return target;
    } catch (error) {
      throw new Error(this.formatDatabaseError("remove song from playlist", error));
    }
  }

  async getSongs(playlistId) {
    try {
      const { data, error } = await this.supabase
        .from("playlist_songs")
        .select("*")
        .eq("playlist_id", playlistId)
        .order("position", { ascending: true });

      if (error) {
        throw new Error(this.formatDatabaseError("fetch playlist songs", error));
      }

      return data;
    } catch (error) {
      throw new Error(this.formatDatabaseError("fetch playlist songs", error));
    }
  }
}

module.exports = PlaylistRepository;
