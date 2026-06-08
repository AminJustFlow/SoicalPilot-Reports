import fs from 'node:fs/promises';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { parseReportMetadataFromLink } from './linkExtractor.js';
import { parseSubjectRouteCandidate } from './routeKey.js';

function normalizeUidValidity(value) {
  const normalized = String(value ?? '').trim();
  return normalized || 'unknown';
}

function normalizeImapUid(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid IMAP UID: ${value}`);
  }
  return parsed;
}

function normalizeRecipientEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeReportKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeReportUrl(value) {
  return String(value ?? '').trim();
}

function normalizeRouteKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeClientName(value) {
  return String(value ?? '').trim();
}

function toSqliteDateTime(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function isWindowsAbsolutePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(String(value || ''));
}

function normalizeDestinationFolder(folder) {
  const raw = String(folder ?? '').trim();
  if (!raw || raw === '/' || raw === '\\') return '/';

  if (isWindowsAbsolutePath(raw) || raw.startsWith('\\\\')) {
    return raw.replace(/[\\/]+$/, '');
  }

  return raw
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');
}

export function normalizeMessageId(value) {
  return String(value ?? '')
    .trim()
    .replace(/^<+/, '')
    .replace(/>+$/, '');
}

function buildLegacyMessageKey(uidValidity, imapUid) {
  return `imap:${normalizeUidValidity(uidValidity)}:${normalizeImapUid(imapUid)}`;
}

function parseLegacyMessageKey(messageKey) {
  const match = String(messageKey || '').match(/^imap:([^:]+):(\d+)$/);
  if (!match) return null;

  return {
    uidValidity: normalizeUidValidity(match[1]),
    imapUid: normalizeImapUid(match[2])
  };
}

async function ensureColumn(db, columnName, columnType) {
  const columns = await db.all('PRAGMA table_info(processed_messages)');
  const exists = columns.some((column) => column.name === columnName);
  if (exists) return;

  await db.exec(`ALTER TABLE processed_messages ADD COLUMN ${columnName} ${columnType}`);
}

async function migrateProcessedMessages(db, logger) {
  await ensureColumn(db, 'uid_validity', 'TEXT');
  await ensureColumn(db, 'imap_uid', 'INTEGER');
  await ensureColumn(db, 'message_id', 'TEXT');
  await ensureColumn(db, 'message_key', 'TEXT');
  await ensureColumn(db, 'from_address', 'TEXT');
  await ensureColumn(db, 'report_key', 'TEXT');

  const rowsToBackfill = await db.all(`
    SELECT id, message_key, message_id
    FROM processed_messages
    WHERE (uid_validity IS NULL OR imap_uid IS NULL)
      AND message_key IS NOT NULL
  `);

  for (const row of rowsToBackfill) {
    const parsed = parseLegacyMessageKey(row.message_key);
    if (!parsed) continue;

    await db.run(
      `
        UPDATE processed_messages
        SET uid_validity = ?,
            imap_uid = ?,
            message_id = COALESCE(message_id, '')
        WHERE id = ?
      `,
      parsed.uidValidity,
      parsed.imapUid,
      row.id
    );
  }

  const rowsMissingReportKey = await db.all(`
    SELECT id, report_url
    FROM processed_messages
    WHERE (report_key IS NULL OR TRIM(report_key) = '')
      AND report_url IS NOT NULL
      AND TRIM(report_url) <> ''
  `);

  let backfilledReportKeys = 0;
  for (const row of rowsMissingReportKey) {
    const reportKey = normalizeReportKey(parseReportMetadataFromLink(row.report_url)?.canonicalKey);
    if (!reportKey) {
      continue;
    }

    const result = await db.run(
      `
        UPDATE processed_messages
        SET report_key = ?
        WHERE id = ?
      `,
      reportKey,
      row.id
    );
    backfilledReportKeys += result.changes || 0;
  }

  await db.exec(`
    UPDATE processed_messages
    SET uid_validity = 'unknown'
    WHERE uid_validity IS NULL OR TRIM(uid_validity) = '';

    UPDATE processed_messages
    SET message_id = ''
    WHERE message_id IS NULL;

    DROP INDEX IF EXISTS idx_processed_messages_uid_validity_uid;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_processed_messages_uid_validity_uid_msgid
      ON processed_messages (uid_validity, imap_uid, message_id)
      WHERE imap_uid IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_processed_messages_uid_validity_uid
      ON processed_messages (uid_validity, imap_uid)
      WHERE imap_uid IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_processed_messages_message_id
      ON processed_messages (message_id);

    CREATE INDEX IF NOT EXISTS idx_processed_messages_report_key
      ON processed_messages (report_key)
      WHERE report_key IS NOT NULL AND TRIM(report_key) <> '';

    CREATE INDEX IF NOT EXISTS idx_processed_messages_report_url
      ON processed_messages (report_url)
      WHERE report_url IS NOT NULL AND TRIM(report_url) <> '';

    CREATE INDEX IF NOT EXISTS idx_processed_messages_processed_at
      ON processed_messages (processed_at);
  `);

  logger.info(
    {
      migratedRows: rowsToBackfill.length,
      backfilledReportKeys
    },
    'SQLite migration completed'
  );
}

function sanitizeRouteInput({ routeKey, recipientEmail, dropboxFolder }) {
  const normalizedRouteKey = normalizeRecipientEmail(routeKey ?? recipientEmail);
  if (!normalizedRouteKey) {
    throw new Error(`Invalid route key: ${routeKey ?? recipientEmail}`);
  }

  const normalizedDropboxFolder = normalizeDestinationFolder(dropboxFolder);
  if (!normalizedDropboxFolder) {
    throw new Error(`Invalid destination folder: ${dropboxFolder}`);
  }

  return {
    normalizedRouteKey,
    normalizedDropboxFolder
  };
}

function deriveStoredRouteCandidates({ recipient, subject, reportUrl }) {
  const parsedSubject = parseSubjectRouteCandidate(subject);
  const parsedReport = parseReportMetadataFromLink(reportUrl);

  return [...new Set([
    normalizeRecipientEmail(recipient),
    normalizeRouteKey(parsedSubject?.routeKey),
    normalizeRouteKey(parsedReport?.clientNetworkRouteKey),
    normalizeRouteKey(parsedReport?.clientRouteKey)
  ].filter(Boolean))];
}

export async function initDb({ dbPath, logger }) {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  await db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS processed_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid_validity TEXT,
      imap_uid INTEGER,
      message_id TEXT,
      message_key TEXT,
      recipient TEXT,
      from_address TEXT,
      subject TEXT,
      report_key TEXT,
      report_url TEXT,
      dropbox_path TEXT,
      status TEXT NOT NULL,
      notes TEXT,
      processed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS routing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_email TEXT NOT NULL UNIQUE,
      dropbox_folder TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS route_key_suggestions (
      route_key TEXT PRIMARY KEY,
      client_name TEXT NOT NULL,
      last_subject TEXT,
      seen_count INTEGER NOT NULL DEFAULT 0,
      source TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_routing_rules_active_email
      ON routing_rules (is_active, recipient_email);

    CREATE INDEX IF NOT EXISTS idx_route_key_suggestions_seen_count
      ON route_key_suggestions (seen_count DESC, updated_at DESC);
  `);

  await migrateProcessedMessages(db, logger);

  logger.info({ dbPath }, 'SQLite database initialized');

  return {
    async bootstrapRoutingRules(rules = []) {
      if (!Array.isArray(rules) || !rules.length) {
        return 0;
      }

      let inserted = 0;

      for (const rule of rules) {
        const { normalizedRouteKey, normalizedDropboxFolder } = sanitizeRouteInput({
          routeKey: rule?.routeKey,
          recipientEmail: rule?.recipientEmail,
          dropboxFolder: rule?.dropboxFolder
        });

        const result = await db.run(
          `
            INSERT OR IGNORE INTO routing_rules
              (recipient_email, dropbox_folder, is_active, notes, created_at, updated_at)
            VALUES (?, ?, 1, ?, datetime('now'), datetime('now'))
          `,
          normalizedRouteKey,
          normalizedDropboxFolder,
          'Bootstrapped from environment'
        );

        inserted += result.changes || 0;
      }

      return inserted;
    },

    async listRoutingRules() {
      const rows = await db.all(
        `
          SELECT
            recipient_email AS routeKey,
            dropbox_folder AS dropboxFolder,
            is_active AS isActive,
            notes,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM routing_rules
          ORDER BY recipient_email ASC
        `
      );

      return rows.map((row) => ({
        routeKey: row.routeKey,
        dropboxFolder: row.dropboxFolder,
        isActive: Boolean(row.isActive),
        notes: row.notes || '',
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      }));
    },

    async listProcessedSubjectStats() {
      const rows = await db.all(
        `
          SELECT
            subject,
            COUNT(*) AS seenCount,
            MAX(processed_at) AS lastSeenAt
          FROM processed_messages
          WHERE subject IS NOT NULL
            AND TRIM(subject) <> ''
          GROUP BY subject
          ORDER BY lastSeenAt DESC
        `
      );

      return rows.map((row) => ({
        subject: row.subject,
        seenCount: Number(row.seenCount) || 0,
        lastSeenAt: row.lastSeenAt || null
      }));
    },

    async listRouteKeySuggestions() {
      const rows = await db.all(
        `
          SELECT
            route_key AS routeKey,
            client_name AS clientName,
            last_subject AS lastSubject,
            seen_count AS seenCount,
            source,
            last_seen_at AS lastSeenAt,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM route_key_suggestions
          ORDER BY seen_count DESC, updated_at DESC, route_key ASC
        `
      );

      return rows.map((row) => ({
        routeKey: row.routeKey,
        clientName: row.clientName,
        lastSubject: row.lastSubject || '',
        seenCount: Number(row.seenCount) || 0,
        source: row.source || '',
        lastSeenAt: row.lastSeenAt || null,
        createdAt: row.createdAt || null,
        updatedAt: row.updatedAt || null
      }));
    },

    async upsertRouteKeySuggestion({
      routeKey,
      clientName,
      subject = null,
      source = 'imap_subject',
      lastSeenAt = null
    }) {
      const normalizedRouteKey = normalizeRouteKey(routeKey);
      if (!normalizedRouteKey) {
        throw new Error(`Invalid route key suggestion: ${routeKey}`);
      }

      const normalizedClientName = normalizeClientName(clientName) || normalizedRouteKey;
      const normalizedSubject = String(subject ?? '').trim() || null;
      const normalizedSource = String(source ?? '').trim() || 'imap_subject';
      const normalizedLastSeenAt = toSqliteDateTime(lastSeenAt);

      const existing = await db.get(
        'SELECT route_key AS routeKey FROM route_key_suggestions WHERE route_key = ? LIMIT 1',
        normalizedRouteKey
      );

      if (existing?.routeKey) {
        await db.run(
          `
            UPDATE route_key_suggestions
            SET client_name = ?,
                last_subject = COALESCE(?, last_subject),
                seen_count = seen_count + 1,
                source = ?,
                last_seen_at = COALESCE(?, last_seen_at),
                updated_at = datetime('now')
            WHERE route_key = ?
          `,
          normalizedClientName,
          normalizedSubject,
          normalizedSource,
          normalizedLastSeenAt,
          normalizedRouteKey
        );

        return {
          inserted: false,
          updated: true
        };
      }

      await db.run(
        `
          INSERT INTO route_key_suggestions
            (route_key, client_name, last_subject, seen_count, source, last_seen_at, created_at, updated_at)
          VALUES (?, ?, ?, 1, ?, ?, datetime('now'), datetime('now'))
        `,
        normalizedRouteKey,
        normalizedClientName,
        normalizedSubject,
        normalizedSource,
        normalizedLastSeenAt
      );

      return {
        inserted: true,
        updated: false
      };
    },

    async upsertRoutingRule({
      routeKey,
      recipientEmail,
      dropboxFolder,
      isActive = true,
      notes = null
    }) {
      const { normalizedRouteKey, normalizedDropboxFolder } = sanitizeRouteInput({
        routeKey,
        recipientEmail,
        dropboxFolder
      });

      const normalizedNotes = String(notes ?? '').trim() || null;
      const normalizedIsActive = isActive ? 1 : 0;

      await db.run(
        `
          INSERT INTO routing_rules
            (recipient_email, dropbox_folder, is_active, notes, created_at, updated_at)
          VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(recipient_email) DO UPDATE SET
            dropbox_folder = excluded.dropbox_folder,
            is_active = excluded.is_active,
            notes = excluded.notes,
            updated_at = datetime('now')
        `,
        normalizedRouteKey,
        normalizedDropboxFolder,
        normalizedIsActive,
        normalizedNotes
      );

      return {
        routeKey: normalizedRouteKey,
        dropboxFolder: normalizedDropboxFolder,
        isActive: Boolean(normalizedIsActive),
        notes: normalizedNotes || ''
      };
    },

    async deleteRoutingRule(routeKey) {
      const normalizedRouteKey = normalizeRecipientEmail(routeKey);
      if (!normalizedRouteKey) {
        throw new Error(`Invalid route key: ${routeKey}`);
      }

      const result = await db.run(
        'DELETE FROM routing_rules WHERE recipient_email = ?',
        normalizedRouteKey
      );

      return result.changes > 0;
    },

    async clearRoutingRules() {
      const result = await db.run('DELETE FROM routing_rules');
      await db.run(`DELETE FROM sqlite_sequence WHERE name = 'routing_rules'`);

      return {
        deletedRows: result.changes || 0
      };
    },

    async importRoutingRules(rules, { mode = 'merge' } = {}) {
      if (!Array.isArray(rules)) {
        throw new Error('Rules payload must be an array');
      }

      const normalizedMode = String(mode || 'merge').trim().toLowerCase();
      if (!['merge', 'replace'].includes(normalizedMode)) {
        throw new Error(`Invalid import mode: ${mode}`);
      }

      const preparedRules = rules.map((rule, index) => {
        const { normalizedRouteKey, normalizedDropboxFolder } = sanitizeRouteInput({
          routeKey: rule?.routeKey,
          recipientEmail: rule?.recipientEmail,
          dropboxFolder: rule?.dropboxFolder
        });

        const normalizedNotes = String(rule?.notes ?? '').trim() || null;
        const normalizedIsActive = rule?.isActive !== false ? 1 : 0;

        return {
          index,
          routeKey: normalizedRouteKey,
          dropboxFolder: normalizedDropboxFolder,
          notes: normalizedNotes,
          isActive: normalizedIsActive
        };
      });

      let replacedRows = 0;
      let changedRows = 0;

      await db.exec('BEGIN IMMEDIATE TRANSACTION');
      try {
        if (normalizedMode === 'replace') {
          const deleted = await db.run('DELETE FROM routing_rules');
          replacedRows = deleted.changes || 0;
        }

        for (const rule of preparedRules) {
          const result = await db.run(
            `
              INSERT INTO routing_rules
                (recipient_email, dropbox_folder, is_active, notes, created_at, updated_at)
              VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
              ON CONFLICT(recipient_email) DO UPDATE SET
                dropbox_folder = excluded.dropbox_folder,
                is_active = excluded.is_active,
                notes = excluded.notes,
                updated_at = datetime('now')
            `,
            rule.routeKey,
            rule.dropboxFolder,
            rule.isActive,
            rule.notes
          );
          changedRows += result.changes || 0;
        }

        await db.exec('COMMIT');
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }

      return {
        mode: normalizedMode,
        importedCount: preparedRules.length,
        replacedRows,
        changedRows
      };
    },

    async releasePendingMessagesForRoutes(routeKeys = []) {
      const normalizedRouteKeys = [...new Set(
        routeKeys
          .map((key) => normalizeRouteKey(key))
          .filter(Boolean)
      )];

      if (!normalizedRouteKeys.length) {
        return {
          released: 0
        };
      }

      const pendingRows = await db.all(
        `
          SELECT
            id,
            recipient,
            subject,
            report_url AS reportUrl
          FROM processed_messages
          WHERE status = 'pending_route'
        `
      );

      if (!pendingRows.length) {
        return {
          released: 0
        };
      }

      const routeKeySet = new Set(normalizedRouteKeys);
      const idsToRelease = [];

      for (const row of pendingRows) {
        const candidates = deriveStoredRouteCandidates({
          recipient: row.recipient,
          subject: row.subject,
          reportUrl: row.reportUrl
        });

        if (candidates.some((candidate) => routeKeySet.has(candidate))) {
          idsToRelease.push(row.id);
        }
      }

      if (!idsToRelease.length) {
        return {
          released: 0
        };
      }

      const placeholders = idsToRelease.map(() => '?').join(', ');
      const result = await db.run(
        `DELETE FROM processed_messages WHERE id IN (${placeholders})`,
        ...idsToRelease
      );

      return {
        released: result.changes || 0
      };
    },

    async resolveRouteByKeys(routeKeys) {
      const normalizedKeys = [...new Set(
        (routeKeys || [])
          .map((key) => normalizeRecipientEmail(key))
          .filter(Boolean)
      )];

      if (!normalizedKeys.length) {
        return null;
      }

      const placeholders = normalizedKeys.map(() => '?').join(', ');
      const rows = await db.all(
        `
          SELECT recipient_email AS routeKey, dropbox_folder AS dropboxFolder
          FROM routing_rules
          WHERE is_active = 1
            AND recipient_email IN (${placeholders})
        `,
        ...normalizedKeys
      );

      const routeByKey = new Map(
        rows.map((row) => [row.routeKey, row.dropboxFolder])
      );

      for (const routeKey of normalizedKeys) {
        const folder = routeByKey.get(routeKey);
        if (folder) {
          return {
            routeKey,
            folder,
            route: 'db_rule'
          };
        }
      }

      return null;
    },

    async resolveRecipientRoute(recipients) {
      return this.resolveRouteByKeys(recipients);
    },

    async findProcessedReport({ reportKey = '', reportUrl = '' } = {}) {
      const normalizedReportKey = normalizeReportKey(reportKey);
      const normalizedReportUrl = normalizeReportUrl(reportUrl);

      if (!normalizedReportKey && !normalizedReportUrl) {
        return null;
      }

      const row = await db.get(
        `
          SELECT
            uid_validity AS uidValidity,
            imap_uid AS imapUid,
            report_key AS reportKey,
            report_url AS reportUrl,
            dropbox_path AS dropboxPath,
            status,
            processed_at AS processedAt
          FROM processed_messages
          WHERE status IN ('uploaded', 'dry_run_downloaded', 'skipped_duplicate_report')
            AND (
              (? <> '' AND report_key = ?)
              OR
              (? <> '' AND report_url = ?)
            )
          ORDER BY id DESC
          LIMIT 1
        `,
        normalizedReportKey,
        normalizedReportKey,
        normalizedReportUrl,
        normalizedReportUrl
      );

      return row || null;
    },

    async clearProcessedMessages() {
      const result = await db.run('DELETE FROM processed_messages');
      await db.run(`DELETE FROM sqlite_sequence WHERE name = 'processed_messages'`);

      return {
        deletedRows: result.changes || 0
      };
    },

    async isProcessedMessage({ uidValidity, imapUid, messageId = '' }) {
      const normalizedUidValidity = normalizeUidValidity(uidValidity);
      const normalizedImapUid = normalizeImapUid(imapUid);
      const normalizedMessageId = normalizeMessageId(messageId);

      const row = await db.get(
        `
          SELECT 1 AS processed
          FROM processed_messages
          WHERE uid_validity = ?
            AND imap_uid = ?
            AND message_id = ?
          LIMIT 1
        `,
        normalizedUidValidity,
        normalizedImapUid,
        normalizedMessageId
      );

      if (row?.processed) return true;

      const uidOnlyRow = await db.get(
        `
          SELECT 1 AS processed
          FROM processed_messages
          WHERE uid_validity = ?
            AND imap_uid = ?
          LIMIT 1
        `,
        normalizedUidValidity,
        normalizedImapUid
      );
      if (uidOnlyRow?.processed) return true;

      const legacyRow = await db.get(
        `
          SELECT 1 AS processed
          FROM processed_messages
          WHERE message_key = ?
          LIMIT 1
        `,
        buildLegacyMessageKey(normalizedUidValidity, normalizedImapUid)
      );

      return Boolean(legacyRow?.processed);
    },

    async markMessageProcessed({
      uidValidity,
      imapUid,
      messageId = null,
      recipient = null,
      fromAddress = null,
      subject = null,
      reportKey = null,
      reportUrl = null,
      dropboxPath = null,
      status,
      notes = null
    }) {
      const normalizedUidValidity = normalizeUidValidity(uidValidity);
      const normalizedImapUid = normalizeImapUid(imapUid);
      const normalizedMessageId = normalizeMessageId(messageId);
      const normalizedReportKey = normalizeReportKey(reportKey);
      const normalizedReportUrl = normalizeReportUrl(reportUrl);
      const messageKey = buildLegacyMessageKey(normalizedUidValidity, normalizedImapUid);

      const insertResult = await db.run(
        `
          INSERT OR IGNORE INTO processed_messages
            (uid_validity, imap_uid, message_id, message_key, recipient, from_address, subject, report_key, report_url, dropbox_path, status, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        normalizedUidValidity,
        normalizedImapUid,
        normalizedMessageId,
        messageKey,
        recipient,
        fromAddress,
        subject,
        normalizedReportKey || null,
        normalizedReportUrl || null,
        dropboxPath,
        status,
        notes
      );

      if (insertResult.changes > 0) {
        return true;
      }

      const updateResult = await db.run(
        `
          UPDATE processed_messages
          SET
            message_key = ?,
            recipient = ?,
            from_address = ?,
            subject = ?,
            report_key = ?,
            report_url = ?,
            dropbox_path = ?,
            status = ?,
            notes = ?,
            processed_at = datetime('now')
          WHERE uid_validity = ?
            AND imap_uid = ?
            AND message_id = ?
        `,
        messageKey,
        recipient,
        fromAddress,
        subject,
        normalizedReportKey || null,
        normalizedReportUrl || null,
        dropboxPath,
        status,
        notes,
        normalizedUidValidity,
        normalizedImapUid,
        normalizedMessageId
      );

      return updateResult.changes > 0;
    },

    async close() {
      await db.close();
      logger.info('SQLite connection closed');
    }
  };
}
