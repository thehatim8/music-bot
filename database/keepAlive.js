const { SUPABASE_KEEPALIVE_INTERVAL_MS, SUPABASE_KEEPALIVE_RETRY_MS } = require("../utils/constants");

const PING_TIMEOUT_MS = 15000;

// Supabase pauses free-tier projects after a week with no database activity, so run a
// tiny query once a day (and on every start) to keep the project awake.
function startSupabaseKeepAlive(supabase) {
  const schedule = (delayMs) => {
    setTimeout(ping, delayMs).unref();
  };

  async function ping() {
    try {
      const { error } = await supabase
        .from("playlists")
        .select("id")
        .limit(1)
        .abortSignal(AbortSignal.timeout(PING_TIMEOUT_MS));

      if (error) {
        throw error;
      }

      console.log("Supabase keep-alive ping OK");
      schedule(SUPABASE_KEEPALIVE_INTERVAL_MS);
    } catch (error) {
      console.error(
        `Supabase keep-alive ping failed, retrying in ${SUPABASE_KEEPALIVE_RETRY_MS / 60000} minutes:`,
        error?.message || error
      );
      schedule(SUPABASE_KEEPALIVE_RETRY_MS);
    }
  }

  void ping();
}

module.exports = {
  startSupabaseKeepAlive
};
