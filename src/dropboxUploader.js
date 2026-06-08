function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoffMs({ attempt, baseDelayMs, maxDelayMs, jitterMs }) {
  const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
  const jitter = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;
  return Math.min(maxDelayMs, exponential + jitter);
}

async function withRetry({ operationName, logger, retryConfig, task }) {
  let lastError;

  for (let attempt = 1; attempt <= retryConfig.attempts; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;

      if (attempt >= retryConfig.attempts) {
        break;
      }

      const delayMs = computeBackoffMs({
        attempt,
        baseDelayMs: retryConfig.baseDelayMs,
        maxDelayMs: retryConfig.maxDelayMs,
        jitterMs: retryConfig.jitterMs
      });

      logger.warn(
        {
          err: error,
          operationName,
          attempt,
          maxAttempts: retryConfig.attempts,
          retryInMs: delayMs
        },
        'Dropbox operation failed and will be retried'
      );

      await sleep(delayMs);
    }
  }

  throw lastError;
}

function normalizeDropboxPath(pathValue) {
  const raw = String(pathValue || '').trim();
  if (!raw || raw === '/') return '/';
  return `/${raw}`.replace(/\/{2,}/g, '/').replace(/\/$/, '');
}

function sanitizeFileName(fileName) {
  const safeFileName = String(fileName || '').replace(/[\\/]+/g, '-').trim();
  if (!safeFileName) {
    throw new Error('File name is required for Dropbox upload');
  }
  return safeFileName;
}

function buildUploadPath(folder, fileName) {
  const normalizedFolder = normalizeDropboxPath(folder);
  const safeFileName = sanitizeFileName(fileName);

  if (normalizedFolder === '/') {
    return `/${safeFileName}`;
  }

  return `${normalizedFolder}/${safeFileName}`;
}

function withNumberSuffix(fileName, index) {
  if (index <= 1) return fileName;

  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex > 0) {
    const base = fileName.slice(0, dotIndex);
    const ext = fileName.slice(dotIndex);
    return `${base} (${index})${ext}`;
  }

  return `${fileName} (${index})`;
}

async function parseResponseBody(response) {
  const raw = await response.text();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function summarizeDropboxError(parsedBody) {
  if (!parsedBody || typeof parsedBody !== 'object') return '';

  const summary =
    parsedBody.error_description ||
    parsedBody.error_summary ||
    parsedBody.error ||
    parsedBody.raw;

  return summary ? `: ${String(summary)}` : '';
}

async function fetchDropboxAccessToken({ appKey, appSecret, refreshToken }) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded'
  };

  if (appSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${appKey}:${appSecret}`).toString('base64')}`;
  } else {
    params.set('client_id', appKey);
  }

  const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers,
    body: params
  });

  const parsedBody = await parseResponseBody(response);
  if (!response.ok) {
    const error = new Error(`Dropbox oauth2/token failed with HTTP ${response.status}${summarizeDropboxError(parsedBody)}`);
    error.status = response.status;
    error.body = parsedBody;
    throw error;
  }

  if (!parsedBody.access_token) {
    throw new Error('Dropbox oauth2/token response did not include access_token');
  }

  return {
    accessToken: parsedBody.access_token,
    expiresIn: Number(parsedBody.expires_in || 14400)
  };
}

function createAccessTokenProvider({ accessToken, appKey, appSecret, refreshToken, logger }) {
  let cachedAccessToken = accessToken || null;
  let expiresAtMs = accessToken ? Number.POSITIVE_INFINITY : 0;
  const refreshSkewMs = 60000;

  return async function getAccessToken({ forceRefresh = false } = {}) {
    const canRefresh = Boolean(refreshToken && appKey);
    const shouldRefresh =
      canRefresh &&
      (forceRefresh || !cachedAccessToken || Date.now() + refreshSkewMs >= expiresAtMs);

    if (!shouldRefresh) {
      return cachedAccessToken;
    }

    const refreshed = await fetchDropboxAccessToken({
      appKey,
      appSecret,
      refreshToken
    });

    cachedAccessToken = refreshed.accessToken;
    expiresAtMs = Date.now() + Math.max(1, refreshed.expiresIn) * 1000;
    logger.debug({ expiresIn: refreshed.expiresIn }, 'Refreshed Dropbox access token');

    return cachedAccessToken;
  };
}

function buildDropboxHeaders({ accessToken, contentType = 'application/json', pathRoot = null }) {
  const headers = {
    Authorization: `Bearer ${accessToken}`
  };

  if (contentType) {
    headers['Content-Type'] = contentType;
  }

  if (pathRoot) {
    headers['Dropbox-API-Path-Root'] = JSON.stringify(pathRoot);
  }

  return headers;
}

async function dropboxRpcRequest({ accessToken, endpoint, body, pathRoot = null }) {
  const response = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: 'POST',
    headers: buildDropboxHeaders({ accessToken, pathRoot }),
    body: JSON.stringify(body)
  });

  const parsedBody = await parseResponseBody(response);
  if (!response.ok) {
    const error = new Error(`Dropbox API ${endpoint} failed with HTTP ${response.status}${summarizeDropboxError(parsedBody)}`);
    error.status = response.status;
    error.body = parsedBody;
    throw error;
  }

  return parsedBody;
}

async function getCurrentAccount({ accessToken }) {
  return dropboxRpcRequest({
    accessToken,
    endpoint: 'users/get_current_account',
    body: {}
  });
}

function pathRootFromAccount(account) {
  const rootInfo = account?.root_info || {};
  const rootNamespaceId = rootInfo.root_namespace_id;
  const homeNamespaceId = rootInfo.home_namespace_id;

  if (!rootNamespaceId || rootNamespaceId === homeNamespaceId) {
    return null;
  }

  return {
    '.tag': 'root',
    root: rootNamespaceId
  };
}

function createPathRootProvider({ mode = 'auto', namespaceId = null, getAccessToken, logger }) {
  let cachedPathRoot;
  let hasResolved = false;

  return async function getPathRoot({ forceRefresh = false } = {}) {
    if (!forceRefresh && hasResolved) {
      return cachedPathRoot;
    }

    if (mode === 'none') {
      cachedPathRoot = null;
    } else if (mode === 'home') {
      cachedPathRoot = { '.tag': 'home' };
    } else if (mode === 'namespace_id') {
      if (!namespaceId) {
        throw new Error('DROPBOX_PATH_ROOT_NAMESPACE_ID is required when DROPBOX_PATH_ROOT_MODE=namespace_id');
      }
      cachedPathRoot = {
        '.tag': 'namespace_id',
        namespace_id: namespaceId
      };
    } else {
      const account = await getCurrentAccount({
        accessToken: await getAccessToken({ forceRefresh })
      });
      cachedPathRoot = pathRootFromAccount(account);

      logger.debug(
        {
          dropboxPathRootMode: cachedPathRoot?.['.tag'] || 'home',
          rootNamespaceId: account?.root_info?.root_namespace_id || null,
          homeNamespaceId: account?.root_info?.home_namespace_id || null
        },
        'Resolved Dropbox path root'
      );
    }

    hasResolved = true;
    return cachedPathRoot;
  };
}

function isNotFoundError(error) {
  const body = JSON.stringify(error?.body || {});
  return error?.status === 409 && body.includes('not_found');
}

function isConflictError(error) {
  const body = JSON.stringify(error?.body || {});
  return body.includes('conflict');
}

function isDropboxPathNotFoundError(error) {
  const body = JSON.stringify(error?.body || {});
  return error?.status === 409 && body.includes('path/not_found');
}

async function createFolderIfMissing({ accessToken, pathRoot, folderPath }) {
  try {
    await dropboxRpcRequest({
      accessToken,
      pathRoot,
      endpoint: 'files/create_folder_v2',
      body: {
        path: folderPath,
        autorename: false
      }
    });
  } catch (error) {
    if (isConflictError(error)) {
      return;
    }
    throw error;
  }
}

async function ensureFolderPath({ accessToken, pathRoot, folderPath }) {
  const normalized = normalizeDropboxPath(folderPath);
  if (normalized === '/') return;

  const segments = normalized.split('/').filter(Boolean);
  let currentPath = '';

  for (const segment of segments) {
    currentPath += `/${segment}`;
    await createFolderIfMissing({
      accessToken,
      pathRoot,
      folderPath: currentPath
    });
  }
}

async function fileExists({ accessToken, pathRoot, path }) {
  try {
    await dropboxRpcRequest({
      accessToken,
      pathRoot,
      endpoint: 'files/get_metadata',
      body: {
        path,
        include_deleted: false
      }
    });
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function uploadUsingContentEndpoint({ accessToken, pathRoot, path, buffer }) {
  const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      ...buildDropboxHeaders({
        accessToken,
        contentType: 'application/octet-stream',
        pathRoot
      }),
      'Dropbox-API-Arg': JSON.stringify({
        path,
        mode: 'add',
        autorename: false,
        mute: true,
        strict_conflict: true
      })
    },
    body: buffer
  });

  const parsedBody = await parseResponseBody(response);
  if (!response.ok) {
    const error = new Error(`Dropbox files/upload failed with HTTP ${response.status}${summarizeDropboxError(parsedBody)}`);
    error.status = response.status;
    error.body = parsedBody;
    throw error;
  }

  return parsedBody;
}

async function uploadWithUniqueFileName({ accessToken, pathRoot, destinationFolder, fileName, buffer, logger }) {
  const safeFileName = sanitizeFileName(fileName);
  const normalizedFolder = normalizeDropboxPath(destinationFolder);

  for (let suffixIndex = 1; suffixIndex <= 1000; suffixIndex += 1) {
    const candidateFileName = withNumberSuffix(safeFileName, suffixIndex);
    const candidatePath = buildUploadPath(normalizedFolder, candidateFileName);

    const exists = await fileExists({
      accessToken,
      pathRoot,
      path: candidatePath
    });
    if (exists) {
      continue;
    }

    try {
      const uploaded = await uploadUsingContentEndpoint({
        accessToken,
        pathRoot,
        path: candidatePath,
        buffer
      });

      if (suffixIndex > 1) {
        logger.info(
          {
            suffixIndex,
            originalFileName: safeFileName,
            resolvedFileName: candidateFileName
          },
          'Resolved Dropbox filename conflict with numeric suffix'
        );
      }

      return uploaded;
    } catch (error) {
      if (isConflictError(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Could not resolve a unique Dropbox filename for: ${safeFileName}`);
}

function toListFolderPath(folderPath) {
  const normalized = normalizeDropboxPath(folderPath);
  return normalized === '/' ? '' : normalized;
}

function getParentDropboxPath(folderPath) {
  const normalized = normalizeDropboxPath(folderPath);
  if (normalized === '/') return null;

  const segments = normalized.split('/').filter(Boolean);
  segments.pop();

  return segments.length ? `/${segments.join('/')}` : '/';
}

async function listDropboxFolderPage({ accessToken, pathRoot, folderPath }) {
  return dropboxRpcRequest({
    accessToken,
    pathRoot,
    endpoint: 'files/list_folder',
    body: {
      path: toListFolderPath(folderPath),
      recursive: false,
      include_deleted: false,
      include_has_explicit_shared_members: false,
      include_mounted_folders: true,
      include_non_downloadable_files: false
    }
  });
}

async function continueDropboxFolderListing({ accessToken, pathRoot, cursor }) {
  return dropboxRpcRequest({
    accessToken,
    pathRoot,
    endpoint: 'files/list_folder/continue',
    body: {
      cursor
    }
  });
}

async function listDropboxFolders({ accessToken, pathRoot, folderPath }) {
  const requestedFolder = normalizeDropboxPath(folderPath);
  let normalizedFolder = requestedFolder;
  const entries = [];
  let page;

  while (true) {
    try {
      page = await listDropboxFolderPage({
        accessToken,
        pathRoot,
        folderPath: normalizedFolder
      });
      break;
    } catch (error) {
      const parentPath = getParentDropboxPath(normalizedFolder);
      if (!isDropboxPathNotFoundError(error) || !parentPath) {
        throw error;
      }
      normalizedFolder = parentPath;
    }
  }

  entries.push(...(Array.isArray(page.entries) ? page.entries : []));

  while (page.has_more && page.cursor) {
    page = await continueDropboxFolderListing({
      accessToken,
      pathRoot,
      cursor: page.cursor
    });
    entries.push(...(Array.isArray(page.entries) ? page.entries : []));
  }

  const folders = entries
    .filter((entry) => entry?.['.tag'] === 'folder')
    .map((entry) => {
      const dropboxFolder = normalizeDropboxPath(entry.path_display || entry.path_lower || entry.name);
      return {
        name: entry.name || dropboxFolder,
        absolutePath: dropboxFolder,
        dropboxFolder
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    backend: 'dropbox_api',
    pathRootMode: pathRoot?.['.tag'] || 'home',
    localRoot: null,
    absolutePath: normalizedFolder,
    dropboxFolder: normalizedFolder,
    requestedPath: requestedFolder,
    warning: requestedFolder !== normalizedFolder
      ? `Requested path ${requestedFolder} was not found. Showing ${normalizedFolder} instead.`
      : null,
    parentPath: getParentDropboxPath(normalizedFolder),
    folders
  };
}

export function createDropboxFolderBrowser({
  accessToken,
  appKey,
  appSecret,
  refreshToken,
  pathRootMode,
  pathRootNamespaceId,
  logger,
  retryConfig
}) {
  const getAccessToken = createAccessTokenProvider({
    accessToken,
    appKey,
    appSecret,
    refreshToken,
    logger
  });
  const getPathRoot = createPathRootProvider({
    mode: pathRootMode,
    namespaceId: pathRootNamespaceId,
    getAccessToken,
    logger
  });

  return {
    async listFolders({ inputPath }) {
      return withRetry({
        operationName: 'dropbox_list_folders',
        logger,
        retryConfig,
        task: async (attempt) => {
          const forceRefresh = attempt > 1;
          return listDropboxFolders({
            accessToken: await getAccessToken({ forceRefresh }),
            pathRoot: await getPathRoot({ forceRefresh }),
            folderPath: inputPath
          });
        }
      });
    }
  };
}

export function createDropboxUploader({
  accessToken,
  appKey,
  appSecret,
  refreshToken,
  pathRootMode,
  pathRootNamespaceId,
  logger,
  retryConfig
}) {
  const getAccessToken = createAccessTokenProvider({
    accessToken,
    appKey,
    appSecret,
    refreshToken,
    logger
  });
  const getPathRoot = createPathRootProvider({
    mode: pathRootMode,
    namespaceId: pathRootNamespaceId,
    getAccessToken,
    logger
  });

  return {
    async uploadPdf({ buffer, destinationFolder, fileName }) {
      const normalizedFolder = normalizeDropboxPath(destinationFolder);

      await withRetry({
        operationName: 'dropbox_ensure_folder',
        logger,
        retryConfig,
        task: async (attempt) => {
          const forceRefresh = attempt > 1;
          await ensureFolderPath({
            accessToken: await getAccessToken({ forceRefresh }),
            pathRoot: await getPathRoot({ forceRefresh }),
            folderPath: normalizedFolder
          });
        }
      });

      const uploaded = await withRetry({
        operationName: 'dropbox_upload_pdf',
        logger,
        retryConfig,
        task: async (attempt) => {
          const forceRefresh = attempt > 1;
          const uploadAccessToken = await getAccessToken({ forceRefresh });
          const result = await uploadWithUniqueFileName({
            accessToken: uploadAccessToken,
            pathRoot: await getPathRoot({ forceRefresh }),
            destinationFolder: normalizedFolder,
            fileName,
            buffer,
            logger
          });

          logger.info(
            {
              attempt,
              bytes: buffer.length,
              dropboxPath: result.path_display || result.path_lower || null
            },
            'Uploaded report to Dropbox'
          );

          return result;
        }
      });

      return uploaded;
    }
  };
}
