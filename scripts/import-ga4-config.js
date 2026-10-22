import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { initDb } from '../src/db.js';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

const dbArg = argument('--db');
const configArg = argument('--config');
if (!dbArg || !configArg) {
  console.error('Usage: npm run ga4:import-config -- --db <sqlite-path> --config <json-path>');
  process.exitCode = 1;
} else {
  const dbPath = path.resolve(process.cwd(), dbArg);
  const configPath = path.resolve(process.cwd(), configArg);
  const productionDb = path.resolve(process.cwd(), process.env.DB_PATH || './data/processed_messages.sqlite');

  if (dbPath === productionDb && !process.argv.includes('--allow-production-db')) {
    console.error('Refusing to modify the configured production database without --allow-production-db.');
    process.exitCode = 1;
  } else {
    const payload = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (!Array.isArray(payload.properties) || !Array.isArray(payload.reports)) {
      throw new Error('GA4 configuration must contain properties and reports arrays');
    }

    const logger = { info() {}, warn() {}, error() {}, debug() {} };
    const db = await initDb({ dbPath, logger });
    try {
      for (const property of payload.properties) await db.upsertGa4PropertyRoute(property);
      for (const report of payload.reports) await db.upsertGa4ReportDefinition(report);
      console.log(`Imported ${payload.properties.length} GA4 properties and ${payload.reports.length} report definitions into ${dbPath}`);
    } finally {
      await db.close();
    }
  }
}
