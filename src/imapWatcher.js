import { ImapFlow } from 'imapflow';
import { createImapAuthResolver } from './imapAuth.js';
import { parseSubjectRouteCandidate } from './routeKey.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    function onAbort() {
      cleanup();
      reject(new Error('Aborted'));
    }

    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (signal?.aborted) {
      cleanup();
      reject(new Error('Aborted'));
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForAbort(signal) {
  if (!signal) {
    return new Promise(() => {});
  }

  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    function onAbort() {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function computeBackoffMs(attempt, baseDelayMs, maxDelayMs) {
  return Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
}

async function scanMailbox({ client, config, logger, signal, isProcessedMessage, onMessage, reason }) {
  if (signal?.aborted) return;

  const lock = await client.getMailboxLock(config.imap.mailbox);
  try {
    const sinceDate = new Date(Date.now() - (config.imap.searchWindowDays * ONE_DAY_MS));
    const uidList = await client.search({ since: sinceDate }, { uid: true });

    if (!uidList.length) {
      logger.debug({ reason }, 'No messages found in mailbox scan window');
      return;
    }

    uidList.sort((a, b) => a - b);

    logger.info({ reason, candidates: uidList.length }, 'Scanning mailbox for candidate messages');

    const uidValidity = client.mailbox?.uidValidity ?? 'unknown';

    for (const uid of uidList) {
      if (signal?.aborted) return;

      let message;
      try {
        message = await client.fetchOne(
          String(uid),
          {
            uid: true,
            envelope: true,
            source: true,
            internalDate: true,
            flags: true
          },
          { uid: true }
        );
      } catch (error) {
        logger.error({ err: error, uid }, 'Unable to fetch message from IMAP');
        continue;
      }

      if (!message?.source) {
        logger.warn({ uid }, 'Message has no source; skipping');
        continue;
      }

      const alreadyProcessed = await isProcessedMessage({
        uidValidity,
        imapUid: uid,
        messageId: message.envelope?.messageId || ''
      });
      if (alreadyProcessed) {
        continue;
      }

      try {
        const handled = await onMessage({
          uid,
          uidValidity,
          source: message.source,
          envelope: message.envelope || null,
          internalDate: message.internalDate || null,
          flags: message.flags || null
        });

        if (handled && config.imap.markSeenAfterHandled) {
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        }
      } catch (error) {
        logger.error({ err: error, uid }, 'Message processing failed');
      }
    }
  } finally {
    lock.release();
  }
}

export async function startImapWatcher({
  config,
  logger,
  signal,
  isProcessedMessage,
  onMessage,
  onStatus,
  onScanControl
}) {
  let reconnectAttempt = 0;
  const authResolver = createImapAuthResolver({ config, logger });

  const emitStatus = (type, payload = {}) => {
    if (typeof onStatus !== 'function') return;
    onStatus({ type, ...payload });
  };

  while (!signal?.aborted) {
    emitStatus('connecting');

    let client = null;

    let scanInProgress = false;
    let rescanRequested = false;

    const runScan = async (reason) => {
      if (scanInProgress) {
        rescanRequested = true;
        return;
      }

      scanInProgress = true;
      try {
        let currentReason = reason;
        do {
          rescanRequested = false;
          await scanMailbox({
            client,
            config,
            logger,
            signal,
            isProcessedMessage,
            onMessage,
            reason: currentReason
          });
          currentReason = 'queued';
        } while (rescanRequested && !signal?.aborted);
      } finally {
        scanInProgress = false;
      }
    };

    try {
      const resolvedAuth = await authResolver.getAuth();

      client = new ImapFlow({
        host: config.imap.host,
        port: config.imap.port,
        secure: config.imap.secure,
        auth: resolvedAuth,
        tls: {
          rejectUnauthorized: config.imap.tlsRejectUnauthorized
        },
        disableAutoIdle: true,
        maxIdleTime: 4 * 60 * 1000,
        logger: false
      });

      client.on('error', (error) => {
        logger.error({ err: error }, 'IMAP client emitted an error');
      });

      await client.connect();
      await client.mailboxOpen(config.imap.mailbox);
      reconnectAttempt = 0;
      emitStatus('connected');

      if (typeof onScanControl === 'function') {
        onScanControl((reason = 'manual') => runScan(reason));
      }

      logger.info(
        {
          host: config.imap.host,
          port: config.imap.port,
          mailbox: config.imap.mailbox,
          user: config.imap.auth.user
        },
        'Connected to IMAP server'
      );

      await runScan('startup');

      while (!signal?.aborted && client.usable) {
        logger.debug('Entering IMAP IDLE');

        const idleResult = await Promise.race([
          client.idle().then(() => 'idle'),
          waitForAbort(signal).then(() => 'aborted')
        ]);

        if (idleResult === 'aborted' || signal?.aborted) {
          break;
        }

        logger.debug('IMAP IDLE released; scanning mailbox');
        await runScan('idle');
      }
    } catch (error) {
      if (signal?.aborted) {
        break;
      }

      if (error?.authenticationFailed) {
        authResolver.invalidateAccessToken();
      }

      emitStatus('error', {
        errorMessage: error?.message || 'IMAP watcher cycle failed',
        authenticationFailed: Boolean(error?.authenticationFailed),
        reconnectAttempt: reconnectAttempt + 1
      });

      reconnectAttempt += 1;
      const backoffMs = computeBackoffMs(
        reconnectAttempt,
        config.imap.reconnectBaseDelayMs,
        config.imap.reconnectMaxDelayMs
      );

      logger.error(
        {
          err: error,
          reconnectAttempt,
          reconnectInMs: backoffMs
        },
        'IMAP watcher cycle failed'
      );

      await sleep(backoffMs, signal).catch(() => {});
    } finally {
      if (typeof onScanControl === 'function') {
        onScanControl(null);
      }
      emitStatus('disconnected');

      try {
        if (client?.usable) {
          await client.logout();
        }
      } catch (error) {
        logger.warn({ err: error }, 'Error while logging out IMAP client');
      }
    }
  }

  emitStatus('stopped');
  logger.info('IMAP watcher stopped');
}

export async function discoverRouteKeyCandidates({
  config,
  logger,
  signal,
  onCandidate
}) {
  const authResolver = createImapAuthResolver({ config, logger });
  const resolvedAuth = await authResolver.getAuth();

  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: resolvedAuth,
    tls: {
      rejectUnauthorized: config.imap.tlsRejectUnauthorized
    },
    disableAutoIdle: true,
    logger: false
  });

  let scanned = 0;
  let discovered = 0;

  try {
    await client.connect();
    await client.mailboxOpen(config.imap.mailbox);

    const sinceDate = new Date(Date.now() - (config.imap.searchWindowDays * ONE_DAY_MS));
    const uidList = await client.search({ since: sinceDate }, { uid: true });
    uidList.sort((a, b) => a - b);

    for (const uid of uidList) {
      if (signal?.aborted) break;

      let message = null;
      try {
        message = await client.fetchOne(
          String(uid),
          {
            uid: true,
            envelope: true,
            internalDate: true
          },
          { uid: true }
        );
      } catch (error) {
        logger.warn({ err: error, uid }, 'Unable to fetch message envelope during route key discovery');
        continue;
      }

      scanned += 1;
      const subject = String(message?.envelope?.subject || '').trim();
      const parsed = parseSubjectRouteCandidate(subject);
      if (!parsed?.routeKey) {
        continue;
      }

      discovered += 1;
      if (typeof onCandidate === 'function') {
        await onCandidate({
          uid,
          subject,
          routeKey: parsed.routeKey,
          clientName: parsed.clientName,
          internalDate: message?.internalDate || null
        });
      }
    }
  } finally {
    try {
      if (client?.usable) {
        await client.logout();
      }
    } catch (error) {
      logger.warn({ err: error }, 'Error while closing IMAP client after route key discovery');
    }
  }

  return {
    scanned,
    discovered
  };
}
