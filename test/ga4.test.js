import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { detectReportProvider, REPORT_PROVIDERS } from '../src/providerDetector.js';
import {
  buildGa4Filename,
  expandGa4Destination,
  formatBatchDate,
  normalizeGa4Identifier,
  parseGa4BodyMetadata,
  parseReportingPeriod,
  validatePdfAttachment
} from '../src/ga4Parser.js';
import { extractSocialPilotLinks, formatDateForFilename } from '../src/linkExtractor.js';
import { parseEmail } from '../src/emailParser.js';
import os from 'node:os';
import path from 'node:path';
import { createLocalUploader } from '../src/localUploader.js';

test('mail parser exposes sanitized GA4 PDF attachments as buffers', async () => {
  const raw = await fs.readFile(new URL('./fixtures/ga4-sample.eml', import.meta.url));
  const parsed = await parseEmail(raw);
  assert.deepEqual(parsed.fromAddresses, ['noreply-analytics@google.com']);
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].filename, 'report.pdf');
  assert.equal(Buffer.isBuffer(parsed.attachments[0].content), true);
  assert.equal(validatePdfAttachment(parsed.attachments[0]).valid, true);
});

test('recognizes GA4 only from the exact sender with a real PDF attachment', () => {
  const content = Buffer.from('%PDF-1.7 test');
  assert.equal(detectReportProvider({ fromAddresses: ['noreply-analytics@google.com'], attachments: [{ contentType: 'application/pdf', content }] }), REPORT_PROVIDERS.GA4);
  assert.equal(detectReportProvider({ fromAddresses: ['attacker@example.com'], attachments: [{ contentType: 'application/pdf', content }] }), null);
  assert.equal(detectReportProvider({ fromAddresses: ['noreply-analytics@google.com'], attachments: [{ contentType: 'application/pdf', content: Buffer.from('not pdf') }] }), REPORT_PROVIDERS.GA4);
});

test('extracts the verified GA4 body metadata', () => {
  assert.deepEqual(parseGa4BodyMetadata({ text: 'Hi, Attached is your Reports snapshot report on Socha Companies GA4 property.' }), {
    reportTitle: 'Reports snapshot', propertyName: 'Socha Companies GA4'
  });
});

test('creates the next-month batch date from the reporting period', () => {
  const period = parseReportingPeriod('September 1–30, 2026');
  assert.equal(formatBatchDate(period), '261001');
  assert.equal(formatBatchDate(parseReportingPeriod('December 1-31, 2026')), '270101');
});

test('uses the superseding Socha filename convention', () => {
  const name = buildGa4Filename({ batchDate: '261001', clientCode: 'SOC', propertyLabel: 'Boulder Way', reportLabel: 'Reports snapshot.pdf' });
  assert.equal(name, '261001-SOC-Boulder-Way-Reports_snapshot.pdf');
  assert.equal(name.includes('-GA4-'), false);
  assert.equal(/-\d{2}-/.test(name), false);
  assert.equal(name.endsWith('.pdf.pdf'), false);
});

test('expands one monthly destination without adding a property subfolder', () => {
  const folder = expandGa4Destination('/Socha/Website-Analytics/{batchDate}-SOC-{reportingMonth}-GA4-Analytics', {
    batchDate: '261001', reportingMonth: 'September', clientCode: 'SOC'
  });
  assert.equal(folder, '/Socha/Website-Analytics/261001-SOC-September-GA4-Analytics');
  assert.equal(folder.includes('Boulder Way'), false);
});

test('validates signature, MIME type, size and checksum', () => {
  const valid = validatePdfAttachment({ contentType: 'application/pdf', content: Buffer.from('%PDF-1.7 sample') });
  assert.equal(valid.valid, true);
  assert.match(valid.checksum, /^[a-f0-9]{64}$/);
  assert.equal(validatePdfAttachment({ contentType: 'application/pdf', content: Buffer.from('bad') }).valid, false);
});

test('normalization is exact and deterministic', () => {
  assert.equal(normalizeGa4Identifier('Socha Companies GA4'), 'socha_companies_ga4');
  assert.notEqual(normalizeGa4Identifier('Boulder Way GA4'), normalizeGa4Identifier('Boulder Ways GA4'));
});

test('SocialPilot link extraction and date formatting remain unchanged', () => {
  const url = 'https://sp-mongoprod-socialmedia-report.s3.amazonaws.com/FMB_FB_09012026_to_09302026_abcd1234.pdf';
  assert.deepEqual(extractSocialPilotLinks({ text: `Download ${url}` }), [url]);
  assert.equal(formatDateForFilename(new Date('2026-09-30T12:00:00Z')), '260930');
});

test('GA4 collision mode never creates an arbitrary numeric suffix', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ga4-upload-'));
  const uploader = createLocalUploader({
    localRoot: dir,
    logger: { info() {}, warn() {}, error() {} },
    retryConfig: { attempts: 1, baseDelayMs: 0, maxDelayMs: 1, jitterMs: 0 }
  });
  const fileName = '261001-SOC-Boulder-Way-Reports_snapshot.pdf';
  try {
    await uploader.uploadPdf({ buffer: Buffer.from('first'), destinationFolder: '/', fileName, conflictBehavior: 'error' });
    await assert.rejects(() => uploader.uploadPdf({ buffer: Buffer.from('different'), destinationFolder: '/', fileName, conflictBehavior: 'error' }), (error) => error.code === 'DESTINATION_CONFLICT');
    const files = await fs.readdir(dir);
    assert.deepEqual(files, [fileName]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
