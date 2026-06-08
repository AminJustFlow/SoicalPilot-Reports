import { simpleParser } from 'mailparser';

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function normalizeAddress(address) {
  return String(address || '').trim().toLowerCase();
}

function extractAddressList(addressObj) {
  if (!addressObj || !Array.isArray(addressObj.value)) {
    return [];
  }

  return addressObj.value
    .map((entry) => normalizeAddress(entry?.address))
    .filter(Boolean);
}

function extractHeaderAddresses(headerValue) {
  return toArray(headerValue)
    .flatMap((entry) => String(entry || '').split(','))
    .map((part) => normalizeAddress(part.replace(/[<>]/g, '')))
    .filter((value) => value.includes('@'));
}

function unique(values) {
  return [...new Set(values)];
}

export async function parseEmail(rawSource) {
  const parsed = await simpleParser(rawSource, {
    skipTextToHtml: true
  });

  const recipients = unique([
    ...extractAddressList(parsed.to),
    ...extractAddressList(parsed.cc),
    ...extractHeaderAddresses(parsed.headers.get('delivered-to')),
    ...extractHeaderAddresses(parsed.headers.get('x-original-to'))
  ]);

  const fromAddresses = unique(extractAddressList(parsed.from));
  const fromText = String(parsed.from?.text || '').trim();

  return {
    messageId: String(parsed.messageId || '').trim(),
    subject: String(parsed.subject || '').trim(),
    date: parsed.date || null,
    fromAddresses,
    fromText,
    recipients,
    text: String(parsed.text || ''),
    html: typeof parsed.html === 'string' ? parsed.html : ''
  };
}
