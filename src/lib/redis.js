const Redis = require('ioredis');

// Azure Cache for Redis uses TLS on port 6380
let client = null;

function getClient() {
  if (!client) {
    client = new Redis({
      host: process.env.REDIS_HOST,       // e.g. redis-billy-prepng.redis.cache.windows.net
      port: 6380,
      password: process.env.REDIS_KEY,
      tls: { servername: process.env.REDIS_HOST },
      connectTimeout: 5000,
      lazyConnect: true,
    });

    client.on('error', (err) => {
      console.error('[redis] connection error:', err.message);
    });
  }
  return client;
}

/**
 * Checks whether this phone+zip combo has been seen within the dedup window.
 * Uses SET NX EX — atomically sets the key only if it doesn't exist.
 *
 * Returns true if this is a DUPLICATE (key already existed).
 * Returns false if this is the FIRST occurrence (key was just set).
 */
async function checkDuplicate(phone, zip, windowSeconds = 60) {
  const key = `dedup:${phone}:${zip ?? 'null'}`;
  const redis = getClient();
  // Returns 'OK' if set (first time), null if already existed
  const result = await redis.set(key, '1', 'NX', 'EX', windowSeconds);
  return result === null; // null = already existed = duplicate
}

module.exports = { checkDuplicate };
