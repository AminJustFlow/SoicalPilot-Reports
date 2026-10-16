export const REPORT_PROVIDERS = Object.freeze({
  SOCIALPILOT: 'socialpilot',
  GA4: 'ga4'
});

export function isSocialPilotMessage({ fromAddresses = [], fromText = '', subject = '' }) {
  const normalizedSubject = String(subject).toLowerCase();
  if (!normalizedSubject.includes('report generated')) return false;

  const addresses = fromAddresses.map((value) => String(value).toLowerCase());
  const senderText = String(fromText).toLowerCase();
  return addresses.includes('support@socialpilot.co') ||
    addresses.some((value) => value.includes('socialpilot')) ||
    senderText.includes('socialpilot');
}

export function isGa4Message({ fromAddresses = [], attachments = [] }) {
  const expectedSender = fromAddresses
    .map((value) => String(value).trim().toLowerCase())
    .includes('noreply-analytics@google.com');
  if (!expectedSender) return false;

  return attachments.some((attachment) => {
    const type = String(attachment?.contentType || '').toLowerCase();
    const filename = String(attachment?.filename || '').toLowerCase();
    return type === 'application/pdf' || filename.endsWith('.pdf');
  });
}

export function detectReportProvider(message) {
  if (isSocialPilotMessage(message)) return REPORT_PROVIDERS.SOCIALPILOT;
  if (isGa4Message(message)) return REPORT_PROVIDERS.GA4;
  return null;
}
