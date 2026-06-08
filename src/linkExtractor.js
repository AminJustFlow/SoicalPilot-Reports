import { load } from 'cheerio';

import { extractClientNameFromSubject } from './routeKey.js';

const SOCIALPILOT_S3_HOST = 'sp-mongoprod-socialmedia-report.s3.amazonaws.com';
const URL_REGEX = /https?:\/\/[^\s"'<>`]+/gi;
const ENCODED_URL_REGEX = /https?%3A%2F%2F[^\s"'<>`]+/gi;

function decodeRepeatedly(value, maxPasses = 4) {
  let current = String(value || '');

  for (let i = 0; i < maxPasses; i += 1) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }

  return current;
}

function cleanupUrl(rawUrl) {
  let value = String(rawUrl || '').trim();
  value = value.replace(/&amp;/gi, '&');
  value = value.replace(/&#x2F;/gi, '/');
  value = value.replace(/&#47;/gi, '/');
  value = value.replace(/^[\[("'`<]+/, '');
  value = value.replace(/[\])"'`>,.;:!?]+$/, '');
  return value;
}

function tryParseUrl(value) {
  const cleaned = cleanupUrl(value);
  if (!cleaned) return null;

  try {
    return new URL(cleaned);
  } catch {
    return null;
  }
}

function looksLikeEmbeddedUrl(value) {
  const text = String(value || '').toLowerCase();
  return text.includes('http') || text.includes('%2f') || text.includes('amazonaws.com');
}

function extractUrlsFromText(text) {
  const source = String(text || '');
  const urls = [];

  for (const match of source.match(URL_REGEX) || []) {
    urls.push(match);
  }

  for (const match of source.match(ENCODED_URL_REGEX) || []) {
    urls.push(match);
  }

  return urls;
}

function extractUrlsFromHtml(html) {
  const source = String(html || '');
  if (!source.trim()) return [];

  const urls = [];

  let $;
  try {
    $ = load(source, {
      decodeEntities: true,
      scriptingEnabled: false
    });
  } catch {
    return extractUrlsFromText(source);
  }

  $('a[href], area[href], link[href], iframe[src], img[src], source[src]').each((_, el) => {
    const href = $(el).attr('href') || $(el).attr('src');
    if (href) {
      urls.push(href);
    }
  });

  for (const match of source.match(URL_REGEX) || []) {
    urls.push(match);
  }

  for (const match of source.match(ENCODED_URL_REGEX) || []) {
    urls.push(match);
  }

  return urls;
}

function normalizeSocialPilotUrl(rawUrl) {
  const queue = [cleanupUrl(rawUrl)];
  const visited = new Set();

  while (queue.length > 0) {
    const candidate = cleanupUrl(queue.shift());
    if (!candidate || visited.has(candidate)) {
      continue;
    }
    visited.add(candidate);

    const parsed = tryParseUrl(candidate);
    if (parsed && parsed.hostname.toLowerCase() === SOCIALPILOT_S3_HOST) {
      return parsed.toString();
    }

    const decoded = decodeRepeatedly(candidate);
    if (decoded && decoded !== candidate) {
      queue.push(decoded);

      const decodedParsed = tryParseUrl(decoded);
      if (decodedParsed && decodedParsed.hostname.toLowerCase() === SOCIALPILOT_S3_HOST) {
        return decodedParsed.toString();
      }
    }

    const parseBase = parsed || tryParseUrl(decoded);
    if (parseBase) {
      for (const [, value] of parseBase.searchParams) {
        if (!value) continue;

        if (looksLikeEmbeddedUrl(value)) {
          queue.push(value);
          queue.push(decodeRepeatedly(value));
        }
      }
    }

    for (const embedded of candidate.match(URL_REGEX) || []) {
      queue.push(embedded);
    }

    for (const embedded of decoded.match(URL_REGEX) || []) {
      queue.push(embedded);
    }

    for (const embedded of candidate.match(ENCODED_URL_REGEX) || []) {
      queue.push(embedded);
    }

    for (const embedded of decoded.match(ENCODED_URL_REGEX) || []) {
      queue.push(embedded);
    }
  }

  return null;
}

export function sanitizeReportName(name) {
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .trim();

  return (cleaned || 'Report').slice(0, 120);
}

function reportNameFromSubject(subject) {
  let value = String(subject || '').trim();
  if (!value) return '';

  const fromPattern = extractClientNameFromSubject(value);
  if (fromPattern) {
    return sanitizeReportName(fromPattern);
  }

  value = value.replace(/^(re|fwd):\s*/i, '');
  value = value.replace(
    /^report generated\s*:?\s*you can now download(?:\s+report)?\s*-\s*/i,
    ''
  );
  value = value.replace(/^you can now download(?:\s+report)?\s*-\s*/i, '');
  value = value.replace(/^report generated\s*-\s*/i, '');
  value = value.replace(/^(?:socialpilot\s+)?report\s*[-:]\s*/i, '');
  value = value.replace(/\bSocialPilot\b/gi, '');
  value = value.replace(/[-_]+$/g, '').trim();

  return sanitizeReportName(value);
}

function reportNameFromUrl(url) {
  if (!url) return '';

  let token = decodeRepeatedly(url);
  try {
    const parsed = new URL(token);
    token = parsed.pathname.split('/').pop() || '';
  } catch {
    token = token.split('?')[0];
  }

  token = decodeRepeatedly(token);
  token = token.replace(/\.[a-z0-9]{2,5}$/i, '');
  token = token.replace(/^[-_]+/, '');
  token = token.replace(/[_]+/g, ' ');
  token = token.replace(/\s+/g, ' ').trim();

  return sanitizeReportName(token);
}

function parseMmDdYyyy(value) {
  const match = String(value || '').match(/^(\d{2})(\d{2})(\d{4})$/);
  if (!match) return null;

  const month = Number.parseInt(match[1], 10);
  const day = Number.parseInt(match[2], 10);
  const year = Number.parseInt(match[3], 10);

  if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year)) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

function formatDateAsYyMmDd(date) {
  return [
    String(date.getUTCFullYear()).slice(-2),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ].join('');
}

function normalizeKeySegment(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function reportTokenFromUrl(url) {
  if (!url) return '';

  let token = decodeRepeatedly(url);
  try {
    const parsed = new URL(token);
    token = parsed.pathname.split('/').pop() || '';
  } catch {
    token = token.split('?')[0];
  }

  token = decodeRepeatedly(token);
  token = token.replace(/\.[a-z0-9]{2,5}$/i, '');
  return token;
}

export function parseReportMetadataFromLink(link) {
  const token = reportTokenFromUrl(link);
  if (!token) return null;

  const match = token.match(
    /^(?<client>.+?)_(?<network>[a-z0-9]+)_(?<start>\d{8})_to_(?<end>\d{8})(?:_(?<id>[0-9a-f-]{8,}))?$/i
  );
  if (!match?.groups) return null;

  const startDate = parseMmDdYyyy(match.groups.start);
  const endDate = parseMmDdYyyy(match.groups.end);
  if (!startDate || !endDate) return null;

  const clientRaw = String(match.groups.client || '').trim();
  const networkRaw = String(match.groups.network || '').trim().toLowerCase();
  const clientRouteKey = normalizeKeySegment(clientRaw);
  const clientNetworkRouteKey = [
    clientRouteKey,
    normalizeKeySegment(networkRaw)
  ]
    .filter(Boolean)
    .join('_');
  const periodStartYyMmDd = formatDateAsYyMmDd(startDate);
  const periodEndYyMmDd = formatDateAsYyMmDd(endDate);

  const clientLabel = sanitizeReportName(clientRaw.replace(/_+/g, ' '));
  const networkLabel = networkRaw.toUpperCase();
  const displayName = sanitizeReportName(
    `${clientLabel} ${networkLabel} ${periodStartYyMmDd}-${periodEndYyMmDd}`
  );

  const canonicalKey = [
    clientRouteKey,
    normalizeKeySegment(networkRaw),
    periodStartYyMmDd,
    periodEndYyMmDd
  ]
    .filter(Boolean)
    .join('_');

  return {
    clientLabel,
    network: networkRaw,
    clientRouteKey,
    clientNetworkRouteKey,
    periodStartYyMmDd,
    periodEndYyMmDd,
    displayName,
    canonicalKey
  };
}

export function deriveReportName({ subject, link }) {
  const parsedMetadata = parseReportMetadataFromLink(link);
  if (parsedMetadata?.displayName) {
    return parsedMetadata.displayName;
  }

  const fromSubject = reportNameFromSubject(subject);
  if (fromSubject && fromSubject.toLowerCase() !== 'report') {
    return fromSubject;
  }

  const fromUrl = reportNameFromUrl(link);
  return fromUrl || 'Report';
}

export function extractSocialPilotLinks({ text = '', html = '' } = {}) {
  const candidates = [
    ...extractUrlsFromText(text),
    ...extractUrlsFromHtml(html)
  ];

  const links = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const normalized = normalizeSocialPilotUrl(candidate);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    links.push(normalized);
  }

  return links;
}

export function formatDateForFilename(dateInput) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);

  if (Number.isNaN(date.getTime())) {
    const now = new Date();
    return [
      String(now.getFullYear()).slice(-2),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    ].join('');
  }

  return [
    String(date.getFullYear()).slice(-2),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('');
}
