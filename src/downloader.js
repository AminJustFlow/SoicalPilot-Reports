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
        'Operation failed and will be retried'
      );

      await sleep(delayMs);
    }
  }

  throw lastError;
}

function looksLikePdf(buffer) {
  if (!buffer || buffer.length < 4) return false;
  return buffer.subarray(0, 4).toString('utf8') === '%PDF';
}

function isPdfContentType(contentType) {
  return String(contentType || '').toLowerCase().includes('application/pdf');
}

export async function downloadPdf(url, { logger, retryConfig, timeoutMs }) {
  return withRetry({
    operationName: 'download_pdf',
    logger,
    retryConfig,
    task: async (attempt) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          method: 'GET',
          redirect: 'follow',
          signal: controller.signal
        });

        if (!response.ok) {
          throw new Error(`Download failed with HTTP ${response.status} ${response.statusText}`);
        }

        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        const buffer = Buffer.from(await response.arrayBuffer());

        if (!isPdfContentType(contentType) && !looksLikePdf(buffer)) {
          throw new Error(`Downloaded content is not a PDF (content-type: ${contentType || 'unknown'})`);
        }

        logger.info(
          {
            attempt,
            bytes: buffer.length,
            finalUrl: response.url || url
          },
          'Downloaded SocialPilot PDF report'
        );

        return {
          buffer,
          finalUrl: response.url || url
        };
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new Error(`Download timed out after ${timeoutMs}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
  });
}
