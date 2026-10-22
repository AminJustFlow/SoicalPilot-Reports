import crypto from 'node:crypto';

const MONTHS = new Map([
  ['january', 0], ['february', 1], ['march', 2], ['april', 3], ['may', 4], ['june', 5],
  ['july', 6], ['august', 7], ['september', 8], ['october', 9], ['november', 10], ['december', 11]
]);

const STANDARD_REPORT_LABELS = new Map([
  ['reports_snapshot', 'Reports_snapshot'],
  ['traffic_acquisition_session_source_medium', 'Traffic_acquisition_Session_source_medium'],
  ['user_acquisition_first_user_primary_channel_group', 'User_acquisition_First_user_primary_channel_group_(Default_Channel_Group)'],
  ['user_acquisition_first_user_campaign', 'User_acquisition_First_user_campaign'],
  ['campaign_content_and_term', 'Campaign_content_and_term'],
  ['pages_and_screens_page_path_and_screen_class', 'Pages_and_screens_Page_path_and_screen_class'],
  ['pages_and_screens', 'Pages_and_screens_Page_path_and_screen_class'],
  ['landing_page', 'Landing_page_Landing_page'],
  ['exit_pages', 'Exit_pages'],
  ['events', 'Events'],
  ['page_not_found', 'Page_not_found'],
  ['searched_terms', 'Searched_terms']
]);

export function normalizeGa4Identifier(value) {
  return String(value || '').trim().toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_');
}

export function standardGa4ReportLabel(reportTitle) {
  return STANDARD_REPORT_LABELS.get(normalizeGa4Identifier(reportTitle)) || null;
}

export function validatePdfAttachment(attachment, { maxBytes = 25 * 1024 * 1024 } = {}) {
  const content = attachment?.content;
  if (!Buffer.isBuffer(content) || content.length < 5) return { valid: false, reason: 'Attachment has no PDF content' };
  if (content.length > maxBytes) return { valid: false, reason: `PDF exceeds ${maxBytes} byte limit` };
  if (content.subarray(0, 5).toString('ascii') !== '%PDF-') return { valid: false, reason: 'Attachment does not have a valid PDF signature' };
  if (String(attachment.contentType || '').toLowerCase() !== 'application/pdf') return { valid: false, reason: 'Attachment MIME type is not application/pdf' };
  return { valid: true, checksum: crypto.createHash('sha256').update(content).digest('hex') };
}

export async function extractPdfText(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({ data: new Uint8Array(buffer), disableWorker: true }).promise;
  const pages = [];
  const pageLimit = Math.min(document.numPages, 4);
  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str || '').join(' '));
  }
  await document.destroy();
  return pages.join('\n').replace(/\s+/g, ' ').trim();
}

export function parseGa4BodyMetadata({ text = '', html = '' } = {}) {
  const source = `${text}\n${String(html).replace(/<[^>]+>/g, ' ')}`.replace(/\s+/g, ' ').trim();
  const match = source.match(/attached\s+is\s+your\s+(.+?)\s+report\s+on\s+(.+?)\s+property\b/i);
  return {
    reportTitle: match?.[1]?.trim() || '',
    propertyName: match?.[2]?.trim() || ''
  };
}

function validUtcDate(year, monthIndex, day) {
  const date = new Date(Date.UTC(year, monthIndex, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === monthIndex && date.getUTCDate() === day ? date : null;
}

export function parseReportingPeriod(value) {
  const source = String(value || '').replace(/[–—]/g, '-').replace(/\s+/g, ' ');
  const sameMonth = source.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\s*-\s*(\d{1,2}),\s*(\d{4})\b/i);
  if (sameMonth) {
    const month = MONTHS.get(sameMonth[1].toLowerCase());
    const year = Number(sameMonth[4]);
    const start = validUtcDate(year, month, Number(sameMonth[2]));
    const end = validUtcDate(year, month, Number(sameMonth[3]));
    if (start && end && start <= end) return { start, end };
  }

  const full = source.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\s*-\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i);
  if (!full) return null;
  const start = validUtcDate(Number(full[3]), MONTHS.get(full[1].toLowerCase()), Number(full[2]));
  const end = validUtcDate(Number(full[6]), MONTHS.get(full[4].toLowerCase()), Number(full[5]));
  return start && end && start <= end ? { start, end } : null;
}

export function isCompleteCalendarMonth(period) {
  if (!period?.start || !period?.end) return false;
  const { start, end } = period;
  return start.getUTCFullYear() === end.getUTCFullYear() &&
    start.getUTCMonth() === end.getUTCMonth() &&
    start.getUTCDate() === 1 &&
    end.getUTCDate() === new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
}

export function previousCompleteCalendarMonth(value) {
  const received = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(received.getTime())) return null;
  const end = new Date(Date.UTC(received.getUTCFullYear(), received.getUTCMonth(), 0));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  return { start, end };
}

export function formatBatchDate(period) {
  if (!period?.end) return '';
  const batch = new Date(Date.UTC(period.end.getUTCFullYear(), period.end.getUTCMonth() + 1, 1));
  return `${String(batch.getUTCFullYear()).slice(-2)}${String(batch.getUTCMonth() + 1).padStart(2, '0')}01`;
}

export function reportingMonthName(period) {
  return period?.start ? new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(period.start) : '';
}

export function buildGa4Filename({ batchDate, clientCode, reportLabel }) {
  const clean = (value, separator) => String(value || '').trim().replace(/\.pdf$/i, '')
    .replace(/[^A-Za-z0-9]+/g, separator).replace(new RegExp(`\\${separator}+`, 'g'), separator)
    .replace(new RegExp(`^\\${separator}|\\${separator}$`, 'g'), '');
  const date = String(batchDate || '').trim();
  if (!/^\d{6}$/.test(date)) throw new Error('GA4 batch date must be YYMMDD');
  const code = clean(clientCode, '-').toUpperCase();
  if (!/^[A-Z0-9]+$/.test(code)) throw new Error('GA4 client code must contain only letters and numbers');
  const parts = [date, code, clean(reportLabel, '_')];
  if (parts.some((part) => !part)) throw new Error('GA4 filename fields must not be empty');
  return `${parts.join('-')}.pdf`;
}

export function expandGa4Destination(template, { batchDate, reportingMonth, clientCode }) {
  const replacements = { batchDate, reportingMonth, clientCode };
  return String(template || '').replace(/\{(batchDate|reportingMonth|clientCode)\}/g, (_, key) => replacements[key] || '');
}
