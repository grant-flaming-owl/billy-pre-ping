const { getConfig } = require('./config-cache');

/**
 * Forward a normalized ping to Ringba's RTB endpoint.
 * Timeout is read from system_config ringba_rtb_timeout_ms (default 2000ms).
 * Always returns a result object — never throws.
 * Returns:
 *   { status, statusCode, outboundPayload, response, responseTimeMs }
 *   status: 'bid' | 'no_bid' | 'timeout' | 'error' | 'unconfigured'
 */
async function forwardToRingba(pingData, rtbUrl) {
  if (!rtbUrl) {
    console.error('[ringba] rtb url not configured');
    return { status: 'unconfigured', statusCode: null, outboundPayload: null, response: null, responseTimeMs: 0 };
  }

  const outboundPayload = {
    CID: pingData.phone,
    zipcode: pingData.zip ?? '',
    exposeCallerId: 'yes',
    source: pingData.subid ?? pingData.publisher_id ?? '',
  };

  const startedAt = Date.now();

  try {
    const res = await fetch(rtbUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(outboundPayload),
    });
    const responseTimeMs = Date.now() - startedAt;

    // Always capture Ringba's exact response body
    let response = null;
    const rawText = await res.text().catch(() => null);
    if (rawText) {
      try { response = JSON.parse(rawText); } catch { response = { raw: rawText }; }
    }

    // Ringba returns bidAmount (camelCase) — treat > 0 as a real bid
    const hasBid = response && (response.bidAmount > 0 || response.bid_amount > 0 || response.price > 0);
    const status = !res.ok ? 'error' : hasBid ? 'bid' : 'no_bid';

    return { status, statusCode: res.status, outboundPayload, response, responseTimeMs };
  } catch (err) {
    const responseTimeMs = Date.now() - startedAt;
    console.error('[ringba] forward error:', err.message);
    return { status: 'error', statusCode: null, outboundPayload, response: null, responseTimeMs };
  }
}

/**
 * Forward a call post to Ringba's call routing endpoint.
 * Returns Ringba's response verbatim or null on failure.
 */
async function forwardCallToRingba(callData, callUrl) {
  if (!callUrl) {
    console.error('[ringba] call url not configured');
    return null;
  }

  try {
    const res = await fetch(callUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(callData),
    });
    return await res.json();
  } catch (err) {
    console.error('[ringba] call forward error:', err.message);
    return null;
  }
}

module.exports = { forwardToRingba, forwardCallToRingba };
