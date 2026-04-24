const { getPool, sql } = require('./db');

const CACHE_TTL_MS = 60_000;

// ── Fanout endpoints cache ────────────────────────────────────────────────────

let fanoutCache = { endpoints: [], loadedAt: 0 };

async function getActiveFanoutEndpoints() {
  if (Date.now() - fanoutCache.loadedAt < CACHE_TTL_MS) {
    return fanoutCache.endpoints;
  }
  const pool = await getPool();
  const result = await pool
    .request()
    .query('SELECT * FROM fanout_endpoints WHERE enabled = 1');
  fanoutCache = {
    endpoints: result.recordset.map((row) => ({
      ...row,
      rules: row.rules ? JSON.parse(row.rules) : {},
    })),
    loadedAt: Date.now(),
  };
  return fanoutCache.endpoints;
}

function invalidateFanoutCache() {
  fanoutCache.loadedAt = 0;
}

// ── System config cache ───────────────────────────────────────────────────────

let configCache = { values: {}, loadedAt: 0 };

async function getAllConfig() {
  if (Date.now() - configCache.loadedAt < CACHE_TTL_MS) {
    return configCache.values;
  }
  const pool = await getPool();
  const result = await pool.request().query('SELECT [key], value FROM system_config');
  const values = {};
  for (const row of result.recordset) {
    values[row.key] = row.value;
  }
  configCache = { values, loadedAt: Date.now() };
  return values;
}

async function getConfig(key) {
  const values = await getAllConfig();
  return values[key] ?? null;
}

function invalidateConfigCache() {
  configCache.loadedAt = 0;
}

module.exports = {
  getActiveFanoutEndpoints,
  invalidateFanoutCache,
  getConfig,
  getAllConfig,
  invalidateConfigCache,
};
