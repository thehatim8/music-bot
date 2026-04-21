const { createClient } = require("@supabase/supabase-js");

const REQUEST_TIMEOUT_MS = 30000;
const RETRY_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(resource, options = {}, attempt = 1) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Supabase request timed out.")), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(resource, {
      ...options,
      signal: options.signal || controller.signal
    });
  } catch (error) {
    if (attempt < 2) {
      await sleep(RETRY_DELAY_MS);
      return fetchWithRetry(resource, options, attempt + 1);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = function createSupabase(config) {
  return createClient(config.supabase.url, config.supabase.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    },
    global: {
      fetch: fetchWithRetry
    }
  });
};
