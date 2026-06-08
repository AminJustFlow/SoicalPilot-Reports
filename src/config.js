import 'dotenv/config';
import path from 'node:path';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'n', 'off']);

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function parseIntegerEnv(name, defaultValue, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, received: ${raw}`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`Environment variable ${name} must be between ${min} and ${max}, received: ${parsed}`);
  }

  return parsed;
}

function parseBooleanEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;

  const normalized = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;

  throw new Error(`Environment variable ${name} must be boolean-like (true/false), received: ${raw}`);
}

function parseImportStartMode() {
  const raw = (process.env.IMPORT_START_MODE?.trim().toLowerCase() || 'manual');
  if (!['auto', 'manual'].includes(raw)) {
    throw new Error(`IMPORT_START_MODE must be one of: auto, manual. Received: ${raw}`);
  }
  return raw;
}

function parseDropboxPathRootMode() {
  const raw = process.env.DROPBOX_PATH_ROOT_MODE?.trim().toLowerCase() || 'auto';
  if (!['auto', 'home', 'none', 'namespace_id'].includes(raw)) {
    throw new Error(`DROPBOX_PATH_ROOT_MODE must be one of: auto, home, none, namespace_id. Received: ${raw}`);
  }
  return raw;
}

function parseSecretEnv(name) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return '';
  if (/^replace-with[-_]/i.test(raw)) return '';
  return raw;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isWindowsAbsolutePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(String(value || ''));
}

function normalizeDestinationFolder(folder, { forceLeadingSlash = false } = {}) {
  const raw = String(folder || '').trim();
  if (!raw || raw === '/' || raw === '\\') return '/';

  if (isWindowsAbsolutePath(raw) || raw.startsWith('\\\\')) {
    return raw.replace(/[\\/]+$/, '');
  }

  const normalized = raw
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');

  if (forceLeadingSlash) {
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
  }

  return normalized || '/';
}

function parseImapAuthConfig({ imapUser }) {
  const methodRaw = process.env.IMAP_AUTH_METHOD?.trim().toLowerCase() || 'password';
  if (!['password', 'oauth2'].includes(methodRaw)) {
    throw new Error(`IMAP_AUTH_METHOD must be one of: password, oauth2. Received: ${methodRaw}`);
  }

  if (methodRaw === 'password') {
    return {
      method: 'password',
      user: imapUser,
      pass: getRequiredEnv('IMAP_PASS')
    };
  }

  const tenantId = process.env.IMAP_OAUTH_TENANT_ID?.trim() || 'common';
  const accessToken = parseSecretEnv('IMAP_OAUTH_ACCESS_TOKEN');
  const refreshToken = parseSecretEnv('IMAP_OAUTH_REFRESH_TOKEN');
  const clientId = parseSecretEnv('IMAP_OAUTH_CLIENT_ID');
  const clientSecret = parseSecretEnv('IMAP_OAUTH_CLIENT_SECRET');
  const scope = process.env.IMAP_OAUTH_SCOPE?.trim() || 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access';
  const tokenEndpoint =
    process.env.IMAP_OAUTH_TOKEN_ENDPOINT?.trim() ||
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;

  if (!clientId) {
    throw new Error('IMAP oauth2 requires IMAP_OAUTH_CLIENT_ID');
  }
  if (!refreshToken) {
    throw new Error('IMAP oauth2 headless mode requires IMAP_OAUTH_REFRESH_TOKEN');
  }

  return {
    method: 'oauth2',
    user: imapUser,
    oauth2: {
      tenantId,
      clientId,
      clientSecret,
      refreshToken,
      accessToken,
      scope,
      tokenEndpoint
    }
  };
}

function parseBootstrapRoutes({ forceLeadingSlash = false } = {}) {
  const routeMap = new Map();

  const rawFolder900 = process.env.DROPBOX_FOLDER_900;
  if (rawFolder900 && rawFolder900.trim()) {
    routeMap.set('900@justflownh.com', normalizeDestinationFolder(rawFolder900, { forceLeadingSlash }));
  }

  const rawJson = process.env.MAIL_TO_DROPBOX_MAP_JSON;
  if (rawJson && rawJson.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(rawJson);
    } catch (error) {
      throw new Error(`MAIL_TO_DROPBOX_MAP_JSON is not valid JSON: ${error.message}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('MAIL_TO_DROPBOX_MAP_JSON must be a JSON object of "routeKey":"dropbox folder" pairs');
    }

    for (const [email, folder] of Object.entries(parsed)) {
      const routeKey = normalizeEmail(email);
      if (!routeKey) {
        throw new Error(`Invalid key in MAIL_TO_DROPBOX_MAP_JSON: ${email}`);
      }

      routeMap.set(routeKey, normalizeDestinationFolder(folder, { forceLeadingSlash }));
    }
  }

  return [...routeMap.entries()].map(([routeKey, dropboxFolder]) => ({
    routeKey,
    dropboxFolder
  }));
}

export function loadConfig() {
  const dryRun = parseBooleanEnv('DRY_RUN', false);
  const imapHost = getRequiredEnv('IMAP_HOST');
  const imapUser = getRequiredEnv('IMAP_USER');
  const imapAuth = parseImapAuthConfig({ imapUser });
  const dropboxAccessToken = parseSecretEnv('DROPBOX_ACCESS_TOKEN');
  const dropboxRefreshToken = parseSecretEnv('DROPBOX_REFRESH_TOKEN');
  const dropboxAppKey = parseSecretEnv('DROPBOX_APP_KEY');
  const dropboxAppSecret = parseSecretEnv('DROPBOX_APP_SECRET');
  const dropboxPathRootMode = parseDropboxPathRootMode();
  const dropboxPathRootNamespaceId = String(process.env.DROPBOX_PATH_ROOT_NAMESPACE_ID || '').trim();
  const dropboxFolderPrefix = normalizeDestinationFolder(process.env.DROPBOX_FOLDER_PREFIX || '', {
    forceLeadingSlash: true
  });
  if (dropboxRefreshToken.startsWith('sl.')) {
    throw new Error('DROPBOX_REFRESH_TOKEN looks like a short-lived Dropbox access token. Put this value in DROPBOX_ACCESS_TOKEN, or generate a real Dropbox refresh token.');
  }
  const hasDropboxApiCredentials = Boolean(dropboxAccessToken || (dropboxRefreshToken && dropboxAppKey));
  const uploadBackend = (process.env.UPLOAD_BACKEND?.trim().toLowerCase() || (hasDropboxApiCredentials ? 'dropbox_api' : 'local_fs'));
  if (!['dropbox_api', 'local_fs'].includes(uploadBackend)) {
    throw new Error(`UPLOAD_BACKEND must be one of: dropbox_api, local_fs. Received: ${uploadBackend}`);
  }
  if (uploadBackend === 'dropbox_api' && dropboxPathRootMode === 'namespace_id' && !dropboxPathRootNamespaceId) {
    throw new Error('DROPBOX_PATH_ROOT_NAMESPACE_ID is required when DROPBOX_PATH_ROOT_MODE=namespace_id');
  }

  const localDropboxRootRaw = String(process.env.LOCAL_DROPBOX_ROOT || '').trim();
  const localDropboxRoot = localDropboxRootRaw ? path.resolve(process.cwd(), localDropboxRootRaw) : null;

  if (!dryRun && uploadBackend === 'dropbox_api' && !dropboxAccessToken && !(dropboxRefreshToken && dropboxAppKey)) {
    throw new Error('DROPBOX_ACCESS_TOKEN or DROPBOX_REFRESH_TOKEN + DROPBOX_APP_KEY is required when UPLOAD_BACKEND=dropbox_api');
  }
  if (!dryRun && uploadBackend === 'local_fs' && !localDropboxRoot) {
    throw new Error('LOCAL_DROPBOX_ROOT is required when UPLOAD_BACKEND=local_fs');
  }

  const dropboxFolderDefault = normalizeDestinationFolder(getRequiredEnv('DROPBOX_FOLDER_DEFAULT'), {
    forceLeadingSlash: uploadBackend === 'dropbox_api'
  });

  const imapPort = parseIntegerEnv('IMAP_PORT', 993, { min: 1, max: 65535 });
  const importStartMode = parseImportStartMode();

  return {
    nodeEnv: process.env.NODE_ENV?.trim() || 'production',
    logLevel: process.env.LOG_LEVEL?.trim() || 'info',
    dryRun,
    health: {
      host: process.env.HEALTH_HOST?.trim() || '127.0.0.1',
      port: parseIntegerEnv('HEALTH_PORT', 3100, { min: 1, max: 65535 })
    },
    db: {
      path: path.resolve(process.cwd(), process.env.DB_PATH?.trim() || './data/processed_messages.sqlite')
    },
    retry: {
      attempts: parseIntegerEnv('RETRY_ATTEMPTS', 5, { min: 1, max: 15 }),
      baseDelayMs: parseIntegerEnv('RETRY_BASE_DELAY_MS', 1000, { min: 0, max: 600000 }),
      maxDelayMs: parseIntegerEnv('RETRY_MAX_DELAY_MS', 15000, { min: 1, max: 600000 }),
      jitterMs: parseIntegerEnv('RETRY_JITTER_MS', 250, { min: 0, max: 600000 })
    },
    download: {
      timeoutMs: parseIntegerEnv('DOWNLOAD_TIMEOUT_MS', 60000, { min: 1000, max: 600000 })
    },
    imap: {
      host: imapHost,
      port: imapPort,
      secure: parseBooleanEnv('IMAP_SECURE', imapPort === 993),
      auth: imapAuth,
      mailbox: process.env.IMAP_MAILBOX?.trim() || 'INBOX',
      searchWindowDays: parseIntegerEnv('IMAP_SEARCH_WINDOW_DAYS', 30, { min: 1, max: 3650 }),
      pollIntervalMs: parseIntegerEnv('IMAP_POLL_INTERVAL_MS', 120000, { min: 10000, max: 3600000 }),
      reconnectBaseDelayMs: parseIntegerEnv('IMAP_RECONNECT_BASE_DELAY_MS', 2000, { min: 1000, max: 600000 }),
      reconnectMaxDelayMs: parseIntegerEnv('IMAP_RECONNECT_MAX_DELAY_MS', 60000, { min: 1000, max: 600000 }),
      tlsRejectUnauthorized: parseBooleanEnv('IMAP_TLS_REJECT_UNAUTHORIZED', true),
      markSeenAfterHandled: parseBooleanEnv('MARK_EMAIL_SEEN_AFTER_HANDLED', false)
    },
    runtime: {
      importStartMode
    },
    dropbox: {
      backend: uploadBackend,
      accessToken: dropboxAccessToken || null,
      refreshToken: dropboxRefreshToken || null,
      appKey: dropboxAppKey || null,
      appSecret: dropboxAppSecret || null,
      pathRootMode: dropboxPathRootMode,
      pathRootNamespaceId: dropboxPathRootNamespaceId || null,
      folderPrefix: dropboxFolderPrefix === '/' ? null : dropboxFolderPrefix,
      localRoot: localDropboxRoot,
      folderDefault: dropboxFolderDefault,
      bootstrapRoutes: parseBootstrapRoutes({
        forceLeadingSlash: uploadBackend === 'dropbox_api'
      })
    }
  };
}
