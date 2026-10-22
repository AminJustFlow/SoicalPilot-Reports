import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDb } from '../src/db.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };

test('GA4 migrations preserve SocialPilot tables and enforce mapping/collision rules', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'socialpilot-ga4-'));
  const db = await initDb({ dbPath: path.join(dir, 'test.sqlite'), logger });
  try {
    await db.upsertRoutingRule({ routeKey: 'fmb', dropboxFolder: '/SocialPilot/FMB' });
    await db.upsertGa4PropertyRoute({ propertyKey: 'socha_companies_ga4', propertyName: 'Socha Companies GA4', clientCode: 'SOC', clientName: 'Socha Companies', propertyLabel: 'Socha Companies', destinationTemplate: '/Socha/{batchDate}-SOC-{reportingMonth}-GA4-Analytics' });
    const automaticLabel = await db.upsertGa4PropertyRoute({ propertyKey: 'studleys_floral', propertyName: "GA4 - Studley's Floral", destinationTemplate: '/Studley-Flower-Gardens-(SFG)/Analytics/{batchDate}-{reportingMonth}' });
    assert.equal(automaticLabel.propertyLabel, "Studley's Floral");
    assert.equal(automaticLabel.clientCode, 'SFG');
    await db.upsertGa4ReportDefinition({ reportTitle: 'Reports snapshot', reportLabel: 'Reports_snapshot' });
    assert.equal((await db.listRoutingRules()).length, 1);
    assert.equal((await db.listGa4PropertyRoutes()).length, 2);
    assert.equal((await db.listGa4ReportDefinitions()).length, 1);
    await assert.rejects(() => db.upsertGa4ReportDefinition({ reportTitle: 'Different report', reportLabel: 'Reports_snapshot' }), /conflicts/);
    await db.saveGa4Attachment({
      uidValidity: '1', imapUid: 42, messageId: 'sample', attachmentIndex: 0,
      originalFilename: 'report.pdf', checksum: 'a'.repeat(64), propertyName: 'Socha Companies GA4',
      propertyKey: 'socha_companies_ga4', reportTitle: 'Reports snapshot', reportKey: 'reports_snapshot',
      periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-09-30T00:00:00.000Z',
      batchDate: '261001', generatedFilename: '261001-SOC-Socha-Companies-Reports_snapshot.pdf',
      destinationFolder: '/Socha/261001-SOC-September-GA4-Analytics', status: 'uploaded', dropboxPath: '/uploaded.pdf'
    });
    const stored = await db.getGa4Attachment({ uidValidity: '1', imapUid: 42, attachmentIndex: 0 });
    assert.equal(stored.status, 'uploaded');
    assert.equal((await db.findGa4DestinationFile({ destinationFolder: '/Socha/261001-SOC-September-GA4-Analytics', generatedFilename: '261001-SOC-Socha-Companies-Reports_snapshot.pdf' })).checksum, 'a'.repeat(64));
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
