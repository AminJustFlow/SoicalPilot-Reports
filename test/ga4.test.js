import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { detectReportProvider, REPORT_PROVIDERS } from '../src/providerDetector.js';
import {
  buildGa4Filename,
  expandGa4Destination,
  formatBatchDate,
  isCompleteCalendarMonth,
  normalizeGa4Identifier,
  parseGa4BodyMetadata,
  parseReportingPeriod,
  previousCompleteCalendarMonth,
  standardGa4ReportLabel,
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

test('falls back to the previous complete month for scheduled reports without a printed range', () => {
  const period = previousCompleteCalendarMonth(new Date('2026-10-22T12:00:00Z'));
  assert.equal(period.start.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(period.end.toISOString(), '2026-09-30T00:00:00.000Z');
  assert.equal(formatBatchDate(period), '261001');
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

test('uses the reusable client filename convention without a property name', () => {
  const name = buildGa4Filename({ batchDate: '261001', clientCode: 'soc', reportLabel: 'Reports_snapshot.pdf' });
  assert.equal(name, '261001-SOC-Reports_snapshot.pdf');
  assert.equal(name.includes('-GA4-'), false);
  assert.equal(/-\d{2}-/.test(name), false);
  assert.equal(name.endsWith('.pdf.pdf'), false);
});

test('standardizes the approved GA4 report names exactly', () => {
  assert.equal(standardGa4ReportLabel('Reports Snapshot'), 'Reports_snapshot');
  assert.equal(standardGa4ReportLabel('Traffic Acquisition, Session Source / Medium'), 'Traffic_acquisition_Session_source_medium');
  assert.equal(standardGa4ReportLabel('Traffic acquisition: Session default channel group'), 'Traffic_acquisition_Session_source_medium');
  assert.equal(standardGa4ReportLabel('User Acquisition, First User Primary Channel Group'), 'User_acquisition_First_user_primary_channel_group_(Default_Channel_Group)');
  assert.equal(standardGa4ReportLabel('Pages and Screens, Page Path and Screen Class'), 'Pages_and_screens_Page_path_and_screen_class');
  assert.equal(standardGa4ReportLabel('Landing Page'), 'Landing_page_Landing_page');
  assert.equal(standardGa4ReportLabel('Landing page: Landing page'), 'Landing_page_Landing_page');
});

test('uses the month after a partial or multi-month reporting period', () => {
  assert.equal(formatBatchDate(parseReportingPeriod('August 1, 2026 - September 30, 2026')), '261001');
  assert.equal(formatBatchDate(parseReportingPeriod('June 1, 2026 - October 21, 2026')), '261101');
  assert.equal(formatBatchDate(parseReportingPeriod('October 1-20, 2026')), '261101');
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
  const fileName = '261001-SOC-Reports_snapshot.pdf';
  try {
    await uploader.uploadPdf({ buffer: Buffer.from('first'), destinationFolder: '/', fileName, conflictBehavior: 'error' });
    await assert.rejects(() => uploader.uploadPdf({ buffer: Buffer.from('different'), destinationFolder: '/', fileName, conflictBehavior: 'error' }), (error) => error.code === 'DESTINATION_CONFLICT');
    const files = await fs.readdir(dir);
    assert.deepEqual(files, [fileName]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('only complete calendar months qualify for monthly GA4 archiving', () => {
  assert.equal(isCompleteCalendarMonth(parseReportingPeriod('September 1–30, 2026')), true);
  assert.equal(isCompleteCalendarMonth(parseReportingPeriod('September 2–30, 2026')), false);
  assert.equal(isCompleteCalendarMonth(parseReportingPeriod('September 1–29, 2026')), false);
  assert.equal(isCompleteCalendarMonth(parseReportingPeriod('February 1–28, 2028')), false);
  assert.equal(isCompleteCalendarMonth(parseReportingPeriod('February 1–29, 2028')), true);
});
