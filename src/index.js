import process from 'node:process';

import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { initDb, normalizeMessageId } from './db.js';
import { startWebServer } from './webServer.js';
import { parseEmail } from './emailParser.js';
import {
  deriveReportName,
  extractSocialPilotLinks,
  formatDateForFilename,
  parseReportMetadataFromLink,
  sanitizeReportName
} from './linkExtractor.js';
import { downloadPdf } from './downloader.js';
import { createDropboxUploader } from './dropboxUploader.js';
import { createLocalUploader } from './localUploader.js';
import { discoverRouteKeyCandidates, startImapWatcher } from './imapWatcher.js';
import { parseSubjectRouteCandidate } from './routeKey.js';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractEnvelopeRecipients(envelope) {
  const toRecipients = Array.isArray(envelope?.to) ? envelope.to : [];
  const ccRecipients = Array.isArray(envelope?.cc) ? envelope.cc : [];

  return [...toRecipients, ...ccRecipients]
    .map((entry) => String(entry?.address || '').trim().toLowerCase())
    .filter((value) => value.includes('@'));
}

function extractEnvelopeFrom(envelope) {
  const fromEntries = Array.isArray(envelope?.from) ? envelope.from : [];
  const addresses = fromEntries
    .map((entry) => String(entry?.address || '').trim().toLowerCase())
    .filter((value) => value.includes('@'));

  const text = fromEntries
    .map((entry) => `${String(entry?.name || '').trim()} ${String(entry?.address || '').trim()}`.trim())
    .join(' ')
    .toLowerCase();

  return {
    addresses: unique(addresses),
    text
  };
}

function matchesReportFilter({ fromAddresses, fromText, subject }) {
  const normalizedSubject = String(subject || '').toLowerCase();
  if (!normalizedSubject.includes('report generated')) {
    return false;
  }

  const normalizedFromAddresses = (fromAddresses || []).map((address) => String(address).toLowerCase());
  const normalizedFromText = String(fromText || '').toLowerCase();

  const exactMatch = normalizedFromAddresses.includes('support@socialpilot.co');
  const containsSocialPilot =
    normalizedFromText.includes('socialpilot') ||
    normalizedFromAddresses.some((address) => address.includes('socialpilot'));

  return exactMatch || containsSocialPilot;
}

function extractClientKeyFromSubject(subject) {
  const value = String(subject || '');
  if (!value) return null;

  const patterns = [
    /-\s*([a-z0-9_]+)\s*-[a-z0-9_]+-report\b/i,
    /report\s*-\s*-([a-z0-9_]+)-[a-z0-9_]+-report\b/i,
    /-([a-z0-9_]+)-report\b/i
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) {
      return String(match[1]).trim().toLowerCase();
    }
  }

  return null;
}

function closeServer(server) {
  if (!server || !server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
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

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const healthState = {
    imapLoopRunning: false,
    imapConnected: false,
    imapAuthFailed: false,
    imapLastError: null,
    importStartMode: config.runtime.importStartMode,
    processingEnabled: false,
    discoveryRunning: false,
    shuttingDown: false
  };

  const db = await initDb({
    dbPath: config.db.path,
    logger
  });

  const bootstrappedRouteCount = await db.bootstrapRoutingRules(config.dropbox.bootstrapRoutes);
  if (bootstrappedRouteCount > 0) {
    logger.info({ bootstrappedRouteCount }, 'Bootstrapped routing rules from environment');
  }

  const existingRules = await db.listRoutingRules();
  const activeRouteKeys = existingRules
    .filter((rule) => rule?.isActive !== false)
    .map((rule) => rule.routeKey);
  const { released: releasedPendingAtStartup } = await db.releasePendingMessagesForRoutes(activeRouteKeys);
  if (releasedPendingAtStartup > 0) {
    logger.info(
      { releasedPendingAtStartup },
      'Released pending-route messages with newly available mappings'
    );
  }

  const abortController = new AbortController();
  let shuttingDown = false;
  let resetAndRestartRequested = false;
  let forceExitTimer = null;
  let watcherPromise = null;

  function requestShutdown(signalName) {
    if (shuttingDown) return;
    shuttingDown = true;

    healthState.shuttingDown = true;
    healthState.imapLoopRunning = false;
    healthState.imapConnected = false;

    logger.info({ signal: signalName }, 'Shutdown signal received');
    abortController.abort();
  }

  const webServer = await startWebServer({
    host: config.health.host,
    port: config.health.port,
    logger,
    healthState,
    db,
    config,
    onDiscoverRouteKeys: async ({ trigger }) => {
      if (healthState.shuttingDown || resetAndRestartRequested) {
        throw new Error('Service is shutting down. Discovery is temporarily unavailable.');
      }

      if (healthState.discoveryRunning) {
        return {
          alreadyRunning: true
        };
      }

      healthState.discoveryRunning = true;
      logger.info({ trigger }, 'Route key discovery started');

      try {
        const result = await discoverRouteKeyCandidates({
          config,
          logger,
          signal: abortController.signal,
          onCandidate: async ({ routeKey, clientName, subject, internalDate }) => {
            await db.upsertRouteKeySuggestion({
              routeKey,
              clientName,
              subject,
              source: 'imap_discovery',
              lastSeenAt: internalDate
            });
          }
        });

        logger.info(
          { trigger, scanned: result.scanned, discovered: result.discovered },
          'Route key discovery completed'
        );

        return result;
      } finally {
        healthState.discoveryRunning = false;
      }
    },
    onStartProcessing: async ({ trigger }) => {
      if (healthState.shuttingDown || resetAndRestartRequested) {
        throw new Error('Service is shutting down. Start processing is temporarily unavailable.');
      }
      return startWatcher({ trigger });
    },
    onPrepareResetImportState: async ({ trigger }) => {
      if (resetAndRestartRequested) return;
      resetAndRestartRequested = true;
      healthState.shuttingDown = true;
      logger.warn({ trigger }, 'Reset requested from web UI; pausing message processing');
    },
    onResetImportStateFailed: async ({ trigger, error }) => {
      if (shuttingDown) return;

      resetAndRestartRequested = false;
      healthState.shuttingDown = false;
      healthState.processingEnabled = Boolean(watcherPromise);
      healthState.imapLoopRunning = Boolean(watcherPromise);

      logger.error(
        { trigger, err: error },
        'Reset request failed; resumed normal message processing'
      );
    },
    onResetAndRestart: ({ trigger, clearedRows }) => {
      logger.warn(
        { trigger, clearedRows },
        'Restart requested from web UI after clearing processed history'
      );

      requestShutdown('WEB_UI_RESET_AND_RESTART');

      if (!forceExitTimer) {
        forceExitTimer = setTimeout(() => {
          logger.warn('Forcing process exit so external supervisor can restart service');
          process.exit(0);
        }, 2500);
        forceExitTimer.unref?.();
      }
    }
  });

  const uploader = config.dryRun
    ? null
    : config.dropbox.backend === 'local_fs'
      ? createLocalUploader({
          localRoot: config.dropbox.localRoot,
          logger,
          retryConfig: config.retry
        })
      : createDropboxUploader({
          accessToken: config.dropbox.accessToken,
          appKey: config.dropbox.appKey,
          appSecret: config.dropbox.appSecret,
          refreshToken: config.dropbox.refreshToken,
          pathRootMode: config.dropbox.pathRootMode,
          pathRootNamespaceId: config.dropbox.pathRootNamespaceId,
          logger,
          retryConfig: config.retry
        });

  logger.info(
    {
      uploadBackend: config.dropbox.backend,
      localRoot: config.dropbox.backend === 'local_fs' ? config.dropbox.localRoot : undefined
    },
    'Upload backend initialized'
  );

  process.once('SIGINT', () => requestShutdown('SIGINT'));
  process.once('SIGTERM', () => requestShutdown('SIGTERM'));

  const runWatcher = async () => {
    healthState.imapLoopRunning = true;
    healthState.processingEnabled = true;

    try {
      await startImapWatcher({
        config,
        logger,
        signal: abortController.signal,
        isProcessedMessage: db.isProcessedMessage,
        onMessage,
        onStatus: (status) => {
          if (status.type === 'connected') {
            healthState.imapConnected = true;
            healthState.imapAuthFailed = false;
            healthState.imapLastError = null;
            return;
          }

          if (status.type === 'error') {
            healthState.imapConnected = false;
            healthState.imapLastError = status.errorMessage || 'IMAP watcher error';
            if (status.authenticationFailed) {
              healthState.imapAuthFailed = true;
            }
            return;
          }

          if (status.type === 'disconnected' || status.type === 'stopped') {
            healthState.imapConnected = false;
          }
        }
      });
    } catch (error) {
      logger.error({ err: error }, 'IMAP watcher exited with error');
      healthState.imapLastError = error?.message || 'IMAP watcher exited with error';
      healthState.imapConnected = false;
      healthState.imapAuthFailed = Boolean(error?.authenticationFailed);
      throw error;
    } finally {
      healthState.imapLoopRunning = false;
      healthState.imapConnected = false;
      watcherPromise = null;
      if (!healthState.shuttingDown) {
        healthState.processingEnabled = false;
      }
    }
  };

  function startWatcher({ trigger }) {
    if (watcherPromise) {
      return {
        started: false,
        alreadyRunning: true
      };
    }

    healthState.processingEnabled = true;
    logger.info({ trigger }, 'Processing start requested');
    watcherPromise = runWatcher();
    watcherPromise.catch((error) => {
      if (!abortController.signal.aborted) {
        logger.error({ err: error }, 'IMAP watcher promise rejected');
      }
    });

    return {
      started: true,
      alreadyRunning: false
    };
  }

  const onMessage = async (message) => {
    const messageLogger = logger.child({
      uid: message.uid,
      uidValidity: message.uidValidity
    });

    if (resetAndRestartRequested || healthState.shuttingDown) {
      messageLogger.info('Skipping message because reset or shutdown is in progress');
      return false;
    }

    const envelopeSubject = String(message.envelope?.subject || '').trim();
    const envelopeFrom = extractEnvelopeFrom(message.envelope);
    const envelopeMessageId = normalizeMessageId(message.envelope?.messageId);

    let parsed = null;
    let filterSubject = envelopeSubject;
    let filterFromAddresses = envelopeFrom.addresses;
    let filterFromText = envelopeFrom.text;

    if (!filterSubject || (!filterFromAddresses.length && !filterFromText)) {
      parsed = await parseEmail(message.source);
      filterSubject = filterSubject || parsed.subject;
      filterFromAddresses = filterFromAddresses.length ? filterFromAddresses : parsed.fromAddresses;
      filterFromText = filterFromText || parsed.fromText;
    }

    if (!matchesReportFilter({ fromAddresses: filterFromAddresses, fromText: filterFromText, subject: filterSubject })) {
      await db.markMessageProcessed({
        uidValidity: message.uidValidity,
        imapUid: message.uid,
        messageId: normalizeMessageId(parsed?.messageId || envelopeMessageId),
        fromAddress: filterFromAddresses[0] || null,
        subject: filterSubject || null,
        status: 'skipped_filter',
        notes: 'Message does not match sender/subject filter for SocialPilot reports'
      });

      messageLogger.debug(
        {
          from: filterFromAddresses,
          subject: filterSubject
        },
        'Message skipped (sender/subject filter)'
      );
      return true;
    }

    if (!parsed) {
      parsed = await parseEmail(message.source);
    }

    const messageId = normalizeMessageId(parsed.messageId || envelopeMessageId);
    const subject = parsed.subject || filterSubject;
    const fromAddresses = parsed.fromAddresses.length ? parsed.fromAddresses : filterFromAddresses;
    const subjectRouteCandidate = parseSubjectRouteCandidate(subject);

    const recipients = unique([
      ...parsed.recipients,
      ...extractEnvelopeRecipients(message.envelope)
    ]);
    const primaryRecipient = recipients[0] || null;

    if (subjectRouteCandidate?.routeKey) {
      await db.upsertRouteKeySuggestion({
        routeKey: subjectRouteCandidate.routeKey,
        clientName: subjectRouteCandidate.clientName,
        subject,
        source: 'processed_message',
        lastSeenAt: parsed.date || message.internalDate || null
      });
    }

    const clientKey = extractClientKeyFromSubject(subject);

    const links = extractSocialPilotLinks({
      text: parsed.text,
      html: parsed.html
    });

    if (!links.length) {
      await db.markMessageProcessed({
        uidValidity: message.uidValidity,
        imapUid: message.uid,
        messageId,
        recipient: primaryRecipient,
        fromAddress: fromAddresses[0] || null,
        subject: subject || null,
        status: 'skipped_no_link',
        notes: 'No SocialPilot S3 report links found in email body'
      });

      messageLogger.info('Message skipped (no SocialPilot report links found)');
      return true;
    }

    const reportLink = links[0];
    const parsedReportMetadata = parseReportMetadataFromLink(reportLink);
    const routeCandidates = unique([
      clientKey,
      subjectRouteCandidate?.routeKey,
      parsedReportMetadata?.clientNetworkRouteKey,
      parsedReportMetadata?.clientRouteKey,
      ...recipients
    ]);
    const matchedRoute = await db.resolveRouteByKeys(routeCandidates);
    const initialReportKey = parsedReportMetadata?.canonicalKey || null;
    if (!matchedRoute) {
      const pendingNotes = routeCandidates.length
        ? `Route mapping missing for keys: ${routeCandidates.join(', ')}`
        : 'Route mapping missing for message';

      await db.markMessageProcessed({
        uidValidity: message.uidValidity,
        imapUid: message.uid,
        messageId,
        recipient: primaryRecipient,
        fromAddress: fromAddresses[0] || null,
        subject: subject || null,
        reportKey: initialReportKey,
        reportUrl: reportLink,
        dropboxPath: null,
        status: 'pending_route',
        notes: pendingNotes
      });

      messageLogger.info(
        {
          recipient: primaryRecipient,
          routeCandidates,
          reportKey: initialReportKey,
          reportUrl: reportLink
        },
        'Message held (route key not mapped yet)'
      );

      return true;
    }

    const recipientMatch = {
      recipient: primaryRecipient,
      ...matchedRoute
    };

    const existingReport = await db.findProcessedReport({
      reportKey: initialReportKey,
      reportUrl: reportLink
    });

    if (existingReport) {
      const duplicateNotes = existingReport.dropboxPath
        ? `Duplicate report skipped; already stored at ${existingReport.dropboxPath}`
        : `Duplicate report skipped; already processed with status ${existingReport.status}`;

      await db.markMessageProcessed({
        uidValidity: message.uidValidity,
        imapUid: message.uid,
        messageId,
        recipient: recipientMatch.recipient,
        fromAddress: fromAddresses[0] || null,
        subject: subject || null,
        reportKey: initialReportKey,
        reportUrl: reportLink,
        dropboxPath: existingReport.dropboxPath || null,
        status: 'skipped_duplicate_report',
        notes: duplicateNotes
      });

      messageLogger.info(
        {
          recipient: recipientMatch.recipient,
          routeKey: recipientMatch.routeKey || clientKey || null,
          reportKey: initialReportKey,
          duplicateOfUid: existingReport.imapUid || null,
          existingStatus: existingReport.status,
          existingPath: existingReport.dropboxPath || null
        },
        'Message skipped (duplicate report already processed)'
      );

      return true;
    }

    const reportName = sanitizeReportName(
      parsedReportMetadata?.displayName || deriveReportName({
        subject,
        link: reportLink
      })
    );

    const reportDate = formatDateForFilename(parsed.date || message.internalDate || new Date());
    const fileName = `${reportDate} - SocialPilot - ${reportName}.pdf`;

    const { buffer, finalUrl } = await downloadPdf(reportLink, {
      logger: messageLogger,
      retryConfig: config.retry,
      timeoutMs: config.download.timeoutMs
    });
    const resolvedReportUrl = finalUrl || reportLink;
    const resolvedReportMetadata = parseReportMetadataFromLink(resolvedReportUrl) || parsedReportMetadata;
    const resolvedReportKey = resolvedReportMetadata?.canonicalKey || initialReportKey;

    const duplicateAfterDownload = await db.findProcessedReport({
      reportKey: resolvedReportKey,
      reportUrl: resolvedReportUrl
    });
    if (duplicateAfterDownload) {
      const duplicateNotes = duplicateAfterDownload.dropboxPath
        ? `Duplicate report skipped; already stored at ${duplicateAfterDownload.dropboxPath}`
        : `Duplicate report skipped; already processed with status ${duplicateAfterDownload.status}`;

      await db.markMessageProcessed({
        uidValidity: message.uidValidity,
        imapUid: message.uid,
        messageId,
        recipient: recipientMatch.recipient,
        fromAddress: fromAddresses[0] || null,
        subject: subject || null,
        reportKey: resolvedReportKey,
        reportUrl: resolvedReportUrl,
        dropboxPath: duplicateAfterDownload.dropboxPath || null,
        status: 'skipped_duplicate_report',
        notes: duplicateNotes
      });

      messageLogger.info(
        {
          recipient: recipientMatch.recipient,
          routeKey: recipientMatch.routeKey || clientKey || null,
          reportKey: resolvedReportKey,
          duplicateOfUid: duplicateAfterDownload.imapUid || null,
          existingStatus: duplicateAfterDownload.status,
          existingPath: duplicateAfterDownload.dropboxPath || null
        },
        'Message skipped (duplicate report detected after download)'
      );

      return true;
    }

    if (config.dryRun) {
      await db.markMessageProcessed({
        uidValidity: message.uidValidity,
        imapUid: message.uid,
        messageId,
        recipient: recipientMatch.recipient,
        fromAddress: fromAddresses[0] || null,
        subject: subject || null,
        reportKey: resolvedReportKey,
        reportUrl: resolvedReportUrl,
        dropboxPath: null,
        status: 'dry_run_downloaded',
        notes: 'DRY_RUN enabled; upload skipped'
      });

      messageLogger.info(
        {
          dryRun: true,
          recipient: recipientMatch.recipient,
          routeKey: recipientMatch.routeKey || clientKey || null,
          destinationFolder: recipientMatch.folder,
          route: recipientMatch.route,
          fileName
        },
        'Report downloaded but not uploaded (DRY_RUN)'
      );

      return true;
    }

    const uploaded = await uploader.uploadPdf({
      buffer,
      destinationFolder: recipientMatch.folder,
      fileName
    });

    await db.markMessageProcessed({
      uidValidity: message.uidValidity,
      imapUid: message.uid,
      messageId,
      recipient: recipientMatch.recipient,
      fromAddress: fromAddresses[0] || null,
      subject: subject || null,
      reportKey: resolvedReportKey,
      reportUrl: resolvedReportUrl,
      dropboxPath: uploaded.path_display || uploaded.path_lower || null,
      status: 'uploaded',
      notes: null
    });

    messageLogger.info(
      {
        recipient: recipientMatch.recipient,
        routeKey: recipientMatch.routeKey || clientKey || null,
        destinationFolder: recipientMatch.folder,
        route: recipientMatch.route,
        fileName,
        dropboxPath: uploaded.path_display || uploaded.path_lower || null
      },
      'SocialPilot report processed successfully'
    );

    return true;
  };

  try {
    if (config.runtime.importStartMode === 'auto') {
      startWatcher({ trigger: 'startup_auto' });
    } else {
      healthState.processingEnabled = false;
      logger.info(
        {
          importStartMode: config.runtime.importStartMode
        },
        'Manual import mode enabled; waiting for Start Downloading action from web UI'
      );
    }

    await Promise.race([
      waitForAbort(abortController.signal),
      (async () => {
        while (!abortController.signal.aborted) {
          if (!watcherPromise) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            continue;
          }

          try {
            await watcherPromise;
          } catch (error) {
            if (abortController.signal.aborted) {
              break;
            }
            logger.error({ err: error }, 'Watcher loop terminated unexpectedly');
          }
        }
      })()
    ]);
  } finally {
    healthState.imapLoopRunning = false;
    healthState.imapConnected = false;

    await Promise.allSettled([
      db.close(),
      closeServer(webServer)
    ]);

    logger.info('Shutdown complete');
  }
}

main().catch((error) => {
  console.error(`[fatal] ${error?.stack || error?.message || error}`);
  process.exitCode = 1;
});
