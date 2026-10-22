import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildGa4Filename,
  expandGa4Destination,
  extractPdfText,
  formatBatchDate,
  isCompleteCalendarMonth,
  normalizeGa4Identifier,
  parseGa4BodyMetadata,
  parseReportingPeriod,
  previousCompleteCalendarMonth,
  reportingMonthName,
  validatePdfAttachment
} from './ga4Parser.js';

async function persistPending(buffer, pendingDir, checksum) {
  await fs.mkdir(pendingDir, { recursive: true });
  const target = path.join(pendingDir, `${checksum}.pdf`);
  try {
    await fs.writeFile(target, buffer, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  return target;
}

function exactMatches(text, candidates, field) {
  const normalizedText = normalizeGa4Identifier(text);
  if (!normalizedText) return [];
  return candidates.filter((candidate) =>
    normalizeGa4Identifier(candidate[field]) === normalizedText
  );
}

export function createGa4Processor({ db, uploader, config, logger }) {
  async function processAttachment({ message, parsed, attachment, bufferOverride = null }) {
    const buffer = bufferOverride || attachment.content;
    const validation = validatePdfAttachment({ ...attachment, content: buffer }, { maxBytes: config.ga4.maxPdfBytes });
    if (!validation.valid) {
      logger.warn({ provider: 'ga4', attachmentIndex: attachment.index, reason: validation.reason }, 'Rejected GA4 attachment');
      return { handled: false, status: 'rejected_invalid_pdf', reason: validation.reason };
    }

    const existing = await db.getGa4Attachment({ uidValidity: message.uidValidity, imapUid: message.uid, attachmentIndex: attachment.index });
    if (existing?.status === 'uploaded' || existing?.status === 'dry_run_downloaded' || existing?.status === 'skipped_duplicate') {
      return { handled: true, status: existing.status, duplicate: true };
    }

    let pdfText = '';
    try {
      pdfText = await extractPdfText(buffer);
    } catch (error) {
      logger.warn({ provider: 'ga4', err: error, attachmentIndex: attachment.index }, 'Could not extract GA4 PDF text');
    }

    const bodyMetadata = parseGa4BodyMetadata(parsed);
    // Only the structured GA4 email metadata is authoritative for routing.
    // Searching arbitrary PDF text can match unrelated property names.
    const routes = await db.listGa4PropertyRoutes();
    let propertyMatches = bodyMetadata.propertyName
      ? routes.filter((route) => normalizeGa4Identifier(route.propertyName) === normalizeGa4Identifier(bodyMetadata.propertyName) && route.isActive)
      : [];
    // Never fall back to substring matches in PDF text or email subject.
    const route = propertyMatches.length === 1 ? propertyMatches[0] : null;

    const definitions = await db.listGa4ReportDefinitions();
    const eligibleDefinitions = definitions.filter((definition) => definition.isActive && route && (definition.propertyKey === '*' || definition.propertyKey === route.propertyKey));
    let reportMatches = bodyMetadata.reportTitle
      ? eligibleDefinitions.filter((definition) => normalizeGa4Identifier(definition.reportTitle) === normalizeGa4Identifier(bodyMetadata.reportTitle))
      : [];
    // Report titles must also match exactly to avoid filename collisions.
    const definition = reportMatches.length === 1 ? reportMatches[0] : null;
    const parsedPeriod = parseReportingPeriod(pdfText) || parseReportingPeriod(`${parsed.text} ${parsed.subject}`) ||
      previousCompleteCalendarMonth(parsed.date || message.internalDate);
    const period = isCompleteCalendarMonth(parsedPeriod) ? parsedPeriod : null;
    const batchDate = formatBatchDate(period);

    let status = 'pending_review';
    let reason = 'Reporting period could not be identified reliably';
    if (!route) {
      status = 'pending_route';
      reason = propertyMatches.length > 1 ? 'Multiple GA4 property routes matched' : 'GA4 property is not mapped';
    } else if (!definition) {
      status = 'pending_report_mapping';
      reason = reportMatches.length > 1 ? 'Multiple GA4 report definitions matched' : 'GA4 report title is not mapped';
    }

    const propertyName = route?.propertyName || bodyMetadata.propertyName || null;
    const propertyKey = route?.propertyKey || normalizeGa4Identifier(bodyMetadata.propertyName) || null;
    const reportTitle = definition?.reportTitle || bodyMetadata.reportTitle || null;
    const reportKey = definition?.reportKey || normalizeGa4Identifier(bodyMetadata.reportTitle) || null;
    const destinationFolder = route && period ? expandGa4Destination(route.destinationTemplate, {
      batchDate, reportingMonth: reportingMonthName(period), clientCode: route.clientCode
    }) : null;
    const generatedFilename = route && definition && period ? buildGa4Filename({
      batchDate, clientCode: route.clientCode, propertyLabel: route.propertyLabel, reportLabel: definition.reportLabel
    }) : null;

    const baseRecord = {
      uidValidity: message.uidValidity, imapUid: message.uid, messageId: parsed.messageId,
      attachmentIndex: attachment.index, originalFilename: attachment.filename, checksum: validation.checksum,
      propertyName, propertyKey, reportTitle, reportKey,
      periodStart: period?.start?.toISOString() || null, periodEnd: period?.end?.toISOString() || null,
      batchDate: batchDate || null, generatedFilename, destinationFolder
    };

    if (!route || !definition || !period) {
      const pendingFilePath = await persistPending(buffer, config.ga4.pendingDir, validation.checksum);
      await db.saveGa4Attachment({ ...baseRecord, pendingFilePath, status, errorReason: reason });
      return { handled: true, status, reason };
    }

    const destinationCollision = await db.findGa4DestinationFile({ destinationFolder, generatedFilename });
    if (destinationCollision) {
      if (destinationCollision.checksum === validation.checksum) {
        await db.saveGa4Attachment({ ...baseRecord, status: 'skipped_duplicate', dropboxPath: destinationCollision.dropboxPath });
        return { handled: true, status: 'skipped_duplicate', duplicate: true };
      }
      const pendingFilePath = await persistPending(buffer, config.ga4.pendingDir, validation.checksum);
      await db.saveGa4Attachment({ ...baseRecord, pendingFilePath, status: 'pending_collision', errorReason: 'A different PDF already uses this destination and filename' });
      return { handled: true, status: 'pending_collision' };
    }

    if (config.dryRun) {
      await db.saveGa4Attachment({ ...baseRecord, status: 'dry_run_downloaded' });
      return { handled: true, status: 'dry_run_downloaded', generatedFilename, destinationFolder };
    }

    try {
      const uploaded = await uploader.uploadPdf({ buffer, destinationFolder, fileName: generatedFilename, conflictBehavior: 'error' });
      const dropboxPath = uploaded.path_display || uploaded.path_lower || null;
      await db.saveGa4Attachment({ ...baseRecord, status: 'uploaded', dropboxPath });
      if (existing?.pending_file_path) await fs.unlink(existing.pending_file_path).catch(() => {});
      logger.info({ provider: 'ga4', property: propertyName, reportName: reportTitle, reportingPeriod: `${period.start.toISOString()}/${period.end.toISOString()}`, processingStatus: 'uploaded', destinationPath: dropboxPath }, 'GA4 report processed successfully');
      return { handled: true, status: 'uploaded', generatedFilename, destinationFolder, dropboxPath };
    } catch (error) {
      const pendingFilePath = await persistPending(buffer, config.ga4.pendingDir, validation.checksum);
      const collision = error?.code === 'DESTINATION_CONFLICT';
      await db.saveGa4Attachment({ ...baseRecord, pendingFilePath, status: collision ? 'pending_collision' : 'retryable', errorReason: error.message });
      return { handled: true, status: collision ? 'pending_collision' : 'retryable', reason: error.message };
    }
  }

  return {
    async processMessage({ message, parsed }) {
      const pdfAttachments = parsed.attachments.filter((attachment) =>
        attachment.contentType === 'application/pdf' || String(attachment.filename || '').toLowerCase().endsWith('.pdf')
      );
      const results = [];
      for (const attachment of pdfAttachments) results.push(await processAttachment({ message, parsed, attachment }));
      return results;
    },
    async retryAttachment(id) {
      const rows = await db.listGa4Attachments();
      const record = rows.find((item) => Number(item.id) === Number(id));
      if (!record?.pendingFilePath) throw new Error('Pending GA4 attachment file is unavailable');
      const content = await fs.readFile(record.pendingFilePath);
      return processAttachment({
        message: { uid: record.imapUid, uidValidity: record.uidValidity, internalDate: record.createdAt },
        parsed: {
          messageId: '',
          subject: '',
          text: record.propertyName && record.reportTitle
            ? `Attached is your ${record.reportTitle} report on ${record.propertyName} property.`
            : '',
          html: ''
        },
        attachment: { index: record.attachmentIndex, filename: record.originalFilename, contentType: 'application/pdf', content },
        bufferOverride: content
      });
    }
  };
}
