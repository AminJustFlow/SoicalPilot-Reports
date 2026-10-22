import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initDb } from '../src/db.js';
import { createLocalUploader } from '../src/localUploader.js';
import { createGa4Processor } from '../src/ga4Processor.js';

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };

test('configured Socha report routes end-to-end into the shared monthly folder', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ga4-e2e-'));
  const uploadRoot = path.join(temp, 'dropbox');
  const db = await initDb({ dbPath: path.join(temp, 'test.sqlite'), logger });
  try {
    const configFile = JSON.parse(await fs.readFile(new URL('../config/socha-ga4.json', import.meta.url), 'utf8'));
    for (const route of configFile.properties) await db.upsertGa4PropertyRoute(route);
    for (const definition of configFile.reports) await db.upsertGa4ReportDefinition(definition);

    const uploader = createLocalUploader({
      localRoot: uploadRoot,
      logger,
      retryConfig: { attempts: 1, baseDelayMs: 0, maxDelayMs: 1, jitterMs: 0 }
    });
    const processor = createGa4Processor({
      db,
      uploader,
      logger,
      config: { dryRun: false, ga4: { maxPdfBytes: 1024 * 1024, pendingDir: path.join(temp, 'pending') } }
    });

    const result = await processor.processMessage({
      message: { uidValidity: 'fixture', uid: 100 },
      parsed: {
        messageId: 'ga4-e2e@example.com', subject: 'Scheduled Analytics report', html: '',
        text: 'Attached is your Reports snapshot report on Boulder Way GA4 property. Reporting period: September 1-30, 2026.',
        attachments: [{ index: 0, filename: 'report.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 sanitized integration fixture') }]
      }
    });

    assert.equal(result[0].status, 'uploaded');
    assert.equal(result[0].generatedFilename, '261001-SOC-Reports_snapshot.pdf');
    assert.equal(result[0].destinationFolder, '/Socha-Companies-(SOC)/Projects/Analytics/Website-Analytics/261001-SOC-September-GA4-Analytics');
    const uploaded = path.join(uploadRoot, 'Socha-Companies-(SOC)', 'Projects', 'Analytics', 'Website-Analytics', '261001-SOC-September-GA4-Analytics', '261001-SOC-Reports_snapshot.pdf');
    assert.equal((await fs.stat(uploaded)).isFile(), true);
  } finally {
    await db.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
