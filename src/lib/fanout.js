const { getActiveFanoutEndpoints } = require('./config-cache');

const FANOUT_TIMEOUT_MS = 2000;

/**
 * Evaluates a ping + ringba result against an endpoint's rules.
 * Empty rules object = match everything.
 * All specified rule fields must match (AND logic).
 *
 * Matchable fields: campaign, publisher_id, zip, won, is_duplicate
 */
function matchesRules(pingData, rules) {
  if (!rules || Object.keys(rules).length === 0) return true;
  for (const [field, expected] of Object.entries(rules)) {
    if (pingData[field] !== expected) return false;
  }
  return true;
}

/**
 * Fire-and-forget fan-out to all matching enabled endpoints.
 * Call without await — returns immediately.
 */
async function fanout(pingData) {
  let endpoints;
  try {
    endpoints = await getActiveFanoutEndpoints();
  } catch (err) {
    console.error('[fanout] failed to load endpoints:', err.message);
    return;
  }

  const matching = endpoints.filter((ep) => matchesRules(pingData, ep.rules));
  if (matching.length === 0) return;

  const payload = JSON.stringify(pingData);

  await Promise.allSettled(
    matching.map((ep) => sendToEndpoint(ep, payload))
  );
}

async function sendToEndpoint(endpoint, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FANOUT_TIMEOUT_MS);

  try {
    const isGet = endpoint.method === 'GET';
    const url = isGet
      ? `${endpoint.url}?${new URLSearchParams(JSON.parse(payload))}`
      : endpoint.url;

    await fetch(url, {
      method: endpoint.method,
      headers: isGet ? undefined : { 'Content-Type': 'application/json' },
      body: isGet ? undefined : payload,
      signal: controller.signal,
    });
  } catch (err) {
    console.error(`[fanout] endpoint "${endpoint.name}" failed:`, err.message);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fanout, matchesRules };
