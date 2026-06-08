import fs from 'node:fs/promises';
import path from 'node:path';

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
        'Local upload operation failed and will be retried'
      );

      await sleep(delayMs);
    }
  }

  throw lastError;
}

function sanitizeFileName(fileName) {
  const safeFileName = String(fileName || '').replace(/[\\/]+/g, '-').trim();
  if (!safeFileName) {
    throw new Error('File name is required for local upload');
  }
  return safeFileName;
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

function isWindowsAbsolutePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(String(value || '')) || String(value || '').startsWith('\\\\');
}

function isPathInside(basePath, targetPath) {
  const relative = path.relative(basePath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveDestinationFolder({ localRoot, destinationFolder }) {
  const resolvedRoot = path.resolve(localRoot);
  const raw = String(destinationFolder || '').trim();

  if (!raw || raw === '/' || raw === '\\') {
    return resolvedRoot;
  }

  if (isWindowsAbsolutePath(raw)) {
    return path.resolve(raw);
  }

  if (process.platform !== 'win32' && raw.startsWith('/')) {
    return path.resolve(raw);
  }

  const normalizedRelative = raw
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  const resolved = path.resolve(resolvedRoot, normalizedRelative);

  if (!isPathInside(resolvedRoot, resolved)) {
    throw new Error(`Destination folder escapes LOCAL_DROPBOX_ROOT: ${destinationFolder}`);
  }

  return resolved;
}

export function createLocalUploader({ localRoot, logger, retryConfig }) {
  const resolvedRoot = path.resolve(localRoot);

  return {
    async uploadPdf({ buffer, destinationFolder, fileName }) {
      const safeFileName = sanitizeFileName(fileName);

      return withRetry({
        operationName: 'local_fs_upload_pdf',
        logger,
        retryConfig,
        task: async (attempt) => {
          const destinationPath = resolveDestinationFolder({
            localRoot: resolvedRoot,
            destinationFolder
          });
          await fs.mkdir(destinationPath, { recursive: true });

          for (let suffixIndex = 1; suffixIndex <= 1000; suffixIndex += 1) {
            const candidateFileName = withNumberSuffix(safeFileName, suffixIndex);
            const candidatePath = path.join(destinationPath, candidateFileName);

            try {
              await fs.writeFile(candidatePath, buffer, { flag: 'wx' });

              if (suffixIndex > 1) {
                logger.info(
                  {
                    suffixIndex,
                    originalFileName: safeFileName,
                    resolvedFileName: candidateFileName
                  },
                  'Resolved local filename conflict with numeric suffix'
                );
              }

              logger.info(
                {
                  attempt,
                  bytes: buffer.length,
                  localPath: candidatePath
                },
                'Saved report to local Dropbox-synced folder'
              );

              return {
                path_display: candidatePath,
                path_lower: process.platform === 'win32' ? candidatePath.toLowerCase() : candidatePath
              };
            } catch (error) {
              if (error?.code === 'EEXIST') {
                continue;
              }
              throw error;
            }
          }

          throw new Error(`Could not resolve a unique local filename for: ${safeFileName}`);
        }
      });
    }
  };
}
