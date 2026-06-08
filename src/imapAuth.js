function parseJwtExpirationEpochMs(accessToken) {
  try {
    const parts = String(accessToken || '').split('.');
    if (parts.length < 2) return null;

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const exp = Number(payload?.exp);
    if (!Number.isFinite(exp) || exp <= 0) return null;

    return exp * 1000;
  } catch {
    return null;
  }
}

async function fetchMicrosoftAccessToken({ oauth2, refreshToken, logger }) {
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('client_id', oauth2.clientId);
  body.set('refresh_token', refreshToken);
  body.set('scope', oauth2.scope);

  if (oauth2.clientSecret) {
    body.set('client_secret', oauth2.clientSecret);
  }

  const response = await fetch(oauth2.tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded'
    },
    body
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(`Microsoft token endpoint rejected request (${response.status})`);
    error.authenticationFailed = response.status < 500;
    error.oauthError = payload?.error || null;
    error.oauthErrorDescription = payload?.error_description || null;
    throw error;
  }

  const accessToken = String(payload?.access_token || '').trim();
  if (!accessToken) {
    const error = new Error('Microsoft token endpoint did not return an access_token');
    error.authenticationFailed = true;
    throw error;
  }

  const returnedRefreshToken = String(payload?.refresh_token || '').trim();
  const expiresInSeconds = Number(payload?.expires_in);
  const expiresAtMs =
    Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
      ? Date.now() + (expiresInSeconds * 1000)
      : parseJwtExpirationEpochMs(accessToken);

  logger.debug(
    {
      tokenEndpoint: oauth2.tokenEndpoint,
      expiresAtMs
    },
    'Fetched IMAP OAuth2 access token from Microsoft'
  );

  return {
    accessToken,
    refreshToken: returnedRefreshToken || refreshToken,
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null
  };
}

export function createImapAuthResolver({ config, logger }) {
  const auth = config.imap.auth;
  if (auth.method === 'password') {
    return {
      async getAuth() {
        return {
          user: auth.user,
          pass: auth.pass
        };
      },
      invalidateAccessToken() {}
    };
  }

  const oauth2 = auth.oauth2 || {};
  let accessToken = oauth2.accessToken || '';
  let expiresAtMs = parseJwtExpirationEpochMs(accessToken);
  let refreshToken = String(oauth2.refreshToken || '').trim();
  const refreshSkewMs = 60 * 1000;

  return {
    async getAuth() {
      const tokenNeedsRefresh =
        Boolean(refreshToken) &&
        (!accessToken || !expiresAtMs || (Date.now() + refreshSkewMs >= expiresAtMs));

      if (tokenNeedsRefresh) {
        const refreshed = await fetchMicrosoftAccessToken({
          oauth2,
          refreshToken,
          logger
        });
        accessToken = refreshed.accessToken;
        expiresAtMs = refreshed.expiresAtMs;
        if (refreshed.refreshToken) {
          refreshToken = String(refreshed.refreshToken).trim();
        }
      }

      if (!accessToken) {
        const error = new Error('OAuth2 is configured but there is no IMAP access token available.');
        error.authenticationFailed = true;
        throw error;
      }

      return {
        user: auth.user,
        accessToken
      };
    },
    invalidateAccessToken() {
      accessToken = '';
      expiresAtMs = null;
    }
  };
}
