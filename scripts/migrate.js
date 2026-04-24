const sql = require('mssql');
const fs = require('fs');
const path = require('path');

const config = {
  server: process.env.AZURE_SQL_SERVER,
  database: process.env.AZURE_SQL_DATABASE,
  authentication: {
    type: 'default',
    options: {
      userName: process.env.AZURE_SQL_USER,
      password: process.env.AZURE_SQL_PASSWORD,
    },
  },
  options: {
    encrypt: true,
    trustServerCertificate: false,
    connectTimeout: 15000,
    requestTimeout: 30000,
  },
};

async function run() {
  console.log(`Connecting to ${config.server}/${config.database}...`);
  const pool = await sql.connect(config);
  console.log('Connected.');

  const migrationFile = path.join(__dirname, '../migrations/001_initial_schema.sql');
  const raw = fs.readFileSync(migrationFile, 'utf8');

  // Remove comment lines, then split on semicolons
  const stripped = raw.replace(/--[^\n]*/g, '');
  const statements = stripped
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    try {
      await pool.request().query(stmt);
      const preview = stmt.slice(0, 60).replace(/\n/g, ' ');
      console.log(`  ✓ ${preview}...`);
    } catch (err) {
      // Skip "already exists" errors so migration is idempotent
      if (err.message.includes('already an object named') || err.message.includes('already exists')) {
        console.log(`  ~ skipped (already exists): ${stmt.slice(0, 50)}...`);
      } else {
        console.error(`  ✗ FAILED: ${stmt.slice(0, 80)}`);
        console.error(`    ${err.message}`);
        process.exit(1);
      }
    }
  }

  console.log('\nMigration complete.');
  await pool.close();
}

run().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
