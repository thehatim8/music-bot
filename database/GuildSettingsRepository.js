const createSupabase = require("./supabase");

class GuildSettingsRepository {
  constructor(config) {
    this.supabase = createSupabase(config);
    this.defaultPrefix = config.defaultPrefix;
    this.cache = new Map();
  }

  formatDatabaseError(action, error) {
    const message = error?.message || String(error);

    if (message.startsWith(`Failed to ${action}:`)) {
      return message;
    }

    if (message.includes("Could not find the table 'public.guild_settings'")) {
      return `Failed to ${action}: the Supabase table "guild_settings" does not exist yet. Run the SQL in database/schema.sql first.`;
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

  async getPrefix(guildId) {
    try {
      if (this.cache.has(guildId)) {
        return this.cache.get(guildId);
      }

      const { data, error } = await this.supabase
        .from("guild_settings")
        .select("prefix")
        .eq("guild_id", guildId)
        .maybeSingle();

      if (error) {
        throw new Error(this.formatDatabaseError("fetch guild prefix", error));
      }

      const prefix = data?.prefix || this.defaultPrefix;
      this.cache.set(guildId, prefix);
      return prefix;
    } catch (error) {
      throw new Error(this.formatDatabaseError("fetch guild prefix", error));
    }
  }

  async setPrefix(guildId, prefix) {
    try {
      const { error } = await this.supabase.from("guild_settings").upsert(
        {
          guild_id: guildId,
          prefix
        },
        {
          onConflict: "guild_id"
        }
      );

      if (error) {
        throw new Error(this.formatDatabaseError("update prefix", error));
      }

      this.cache.set(guildId, prefix);
      return prefix;
    } catch (error) {
      throw new Error(this.formatDatabaseError("update prefix", error));
    }
  }
}

module.exports = GuildSettingsRepository;
