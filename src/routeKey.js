function stripReplyPrefixes(value) {
  let current = String(value || '').trim();
  while (/^(re|fwd):\s*/i.test(current)) {
    current = current.replace(/^(re|fwd):\s*/i, '').trim();
  }
  return current;
}

function cleanClientName(value) {
  let cleaned = String(value || '')
    .replace(/\.(pdf|xlsx?|csv)$/i, '')
    .replace(/^[-:\s]+/, '')
    .replace(/[-:\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  while (/^(?:socialpilot\s+)?report\s*[-:]\s*/i.test(cleaned)) {
    cleaned = cleaned.replace(/^(?:socialpilot\s+)?report\s*[-:]\s*/i, '').trim();
  }

  return cleaned;
}

export function normalizeRouteKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

export function extractClientNameFromSubject(subject) {
  const source = stripReplyPrefixes(subject);
  if (!source) return '';

  const patterns = [
    /report generated\s*:?\s*you can now download(?:\s+report)?\s*-\s*(.+)$/i,
    /you can now download(?:\s+report)?\s*-\s*(.+)$/i,
    /report generated\s*-\s*(.+)$/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match?.[1]) continue;

    const clientName = cleanClientName(match[1]);
    if (clientName) return clientName;
  }

  const splitParts = source.split(/\s-\s/);
  if (splitParts.length > 1) {
    const last = cleanClientName(splitParts[splitParts.length - 1]);
    if (
      last &&
      !/^report generated$/i.test(last) &&
      !/^you can now download(?: report)?$/i.test(last)
    ) {
      return last;
    }
  }

  return cleanClientName(source);
}

export function parseSubjectRouteCandidate(subject) {
  const clientName = extractClientNameFromSubject(subject);
  const routeKey = normalizeRouteKey(clientName);
  if (!clientName || !routeKey) {
    return null;
  }

  return {
    clientName,
    routeKey
  };
}
