import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import dotenv from 'dotenv';

const envPath = path.resolve(process.cwd(), '.env');
const redirectUri = 'http://localhost:53682/callback';
const callbackUrl = new URL(redirectUri);
const callbackTimeoutMs = 10 * 60 * 1000;

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

function base64Url(bytes) {
  return bytes.toString('base64url');
}

function openBrowser(url) {
  let command;
  let args;

  if (process.platform === 'win32') {
    command = 'rundll32.exe';
    args = ['url.dll,FileProtocolHandler', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

async function setEnvValue(name, value) {
  const source = await fs.readFile(envPath, 'utf8');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const replacement = `${name}=${JSON.stringify(value)}`;
  let replaced = false;

  const updated = lines.map((line) => {
    if (line.trimStart().startsWith(`${name}=`)) {
      replaced = true;
      return replacement;
    }
    return line;
  });

  if (!replaced) updated.push(replacement);
  await fs.writeFile(envPath, updated.join(newline), 'utf8');
}

function sendPage(res, statusCode, title, message) {
  res.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>${message}</p><p>You may close this window.</p></body></html>`);
}

async function main() {
  const envResult = dotenv.config({ path: envPath });
  if (envResult.error) throw new Error(`Unable to read .env: ${envResult.error.message}`);

  const tenantId = required('IMAP_OAUTH_TENANT_ID');
  const clientId = required('IMAP_OAUTH_CLIENT_ID');
  const clientSecret = String(process.env.IMAP_OAUTH_CLIENT_SECRET || '').trim();
  const configuredScopes = String(process.env.IMAP_OAUTH_SCOPE || '')
    .split(/\s+/)
    .filter(Boolean);
  const scopes = [...new Set([
    ...configuredScopes,
    'https://outlook.office.com/IMAP.AccessAsUser.All',
    'offline_access'
  ])];

  const state = base64Url(crypto.randomBytes(24));
  const codeVerifier = base64Url(crypto.randomBytes(48));
  const codeChallenge = base64Url(
    crypto.createHash('sha256').update(codeVerifier).digest()
  );

  const authorizeUrl = new URL(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize`
  );
  authorizeUrl.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: scopes.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account'
  }).toString();

  let finish;
  const completed = new Promise((resolve, reject) => {
    finish = { resolve, reject };
  });

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || '/', redirectUri);
      if (requestUrl.pathname !== callbackUrl.pathname) {
        sendPage(res, 404, 'Not found', 'This is not the Microsoft OAuth callback URL.');
        return;
      }

      const returnedState = requestUrl.searchParams.get('state');
      const oauthError = requestUrl.searchParams.get('error');
      const oauthErrorDescription = requestUrl.searchParams.get('error_description');
      const code = requestUrl.searchParams.get('code');

      if (returnedState !== state) throw new Error('OAuth state validation failed. Please try again.');
      if (oauthError) throw new Error(oauthErrorDescription || oauthError);
      if (!code) throw new Error('Microsoft did not return an authorization code.');

      const body = new URLSearchParams({
        client_id: clientId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        scope: scopes.join(' '),
        code_verifier: codeVerifier
      });
      if (clientSecret) body.set('client_secret', clientSecret);

      const tokenResponse = await fetch(
        `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body
        }
      );
      const payload = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok) {
        throw new Error(payload.error_description || payload.error || `Token request failed (${tokenResponse.status})`);
      }

      const refreshToken = String(payload.refresh_token || '').trim();
      if (!refreshToken) {
        throw new Error('Microsoft did not return a refresh token. Confirm that offline_access is permitted.');
      }

      await setEnvValue('IMAP_OAUTH_REFRESH_TOKEN', refreshToken);
      await setEnvValue('IMAP_OAUTH_ACCESS_TOKEN', '');
      sendPage(res, 200, 'Microsoft authorization complete', 'The new refresh token was saved securely to the application .env file.');
      finish.resolve();
    } catch (error) {
      sendPage(res, 500, 'Microsoft authorization failed', String(error?.message || error));
      finish.reject(error);
    }
  });

  server.listen(Number(callbackUrl.port), callbackUrl.hostname, () => {
    console.log('Opening Microsoft sign-in in your browser...');
    console.log('Sign in with the mailbox account used by IMAP.');
    console.log(`If the browser does not open, visit:\n${authorizeUrl.toString()}`);
    openBrowser(authorizeUrl.toString());
  });

  const timeout = setTimeout(() => {
    finish.reject(new Error('Timed out waiting for Microsoft sign-in. Run the command again to retry.'));
  }, callbackTimeoutMs);

  try {
    await completed;
    console.log('Authorization succeeded. The new refresh token is saved in .env.');
  } finally {
    clearTimeout(timeout);
    server.close();
  }
}

main().catch((error) => {
  console.error(`Authorization failed: ${error?.message || error}`);
  process.exitCode = 1;
});
