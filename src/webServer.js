import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createDropboxFolderBrowser } from './dropboxUploader.js';
import { parseSubjectRouteCandidate } from './routeKey.js';

function constantTimeEquals(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseBasicAuthHeader(headerValue) {
  const raw = String(headerValue || '');
  if (!raw.toLowerCase().startsWith('basic ')) {
    return null;
  }

  const encoded = raw.slice(6).trim();
  if (!encoded) {
    return null;
  }

  let decoded;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return null;
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex < 0) {
    return null;
  }

  return {
    username: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1)
  };
}

function createAdminAuthMiddleware({ config, logger }) {
  const authConfig = config.adminAuth || {};
  if (!authConfig.enabled) {
    logger.warn('Admin auth is disabled. Set ADMIN_USERNAME and ADMIN_PASSWORD before exposing the routes UI.');
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    const credentials = parseBasicAuthHeader(req.headers.authorization);
    const passwordHash = credentials?.password
      ? crypto.createHash('sha256').update(credentials.password).digest('hex')
      : '';

    const usernameMatches = constantTimeEquals(credentials?.username || '', authConfig.username);
    const passwordMatches = constantTimeEquals(passwordHash, authConfig.passwordHash);

    if (usernameMatches && passwordMatches) {
      next();
      return;
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="SocialPilot Routes", charset="UTF-8"');
    res.status(401).type('text/plain').send('Authentication required');
  };
}

function isPathInside(basePath, targetPath) {
  const relative = path.relative(basePath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isWindowsAbsolutePath(value) {
  const input = String(value || '');
  return /^[a-zA-Z]:[\\/]/.test(input) || input.startsWith('\\\\');
}

function toDropboxFolderPath({ localRoot, absolutePath }) {
  const root = path.resolve(localRoot);
  const target = path.resolve(absolutePath);
  if (!isPathInside(root, target)) {
    throw new Error('Path must be inside LOCAL_DROPBOX_ROOT');
  }

  const relative = path.relative(root, target);
  if (!relative) {
    return '/';
  }

  return `/${relative.split(path.sep).join('/')}`;
}

function resolveBrowserPath({ localRoot, inputPath }) {
  const root = path.resolve(localRoot);
  const raw = String(inputPath || '').trim();
  if (!raw || raw === '/' || raw === '\\') {
    return root;
  }

  const resolved = isWindowsAbsolutePath(raw)
    ? path.resolve(raw)
    : path.resolve(
        root,
        raw
          .replace(/\\/g, '/')
          .replace(/^\/+/, '')
      );

  if (!isPathInside(root, resolved)) {
    return root;
  }

  return resolved;
}

async function resolveExistingBrowserDirectory({ localRoot, inputPath }) {
  const root = path.resolve(localRoot);
  let candidate = resolveBrowserPath({
    localRoot: root,
    inputPath
  });

  while (true) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        throw error;
      }
    }

    const parent = path.dirname(candidate);
    if (!parent || parent === candidate || !isPathInside(root, parent)) {
      return root;
    }

    candidate = parent;
  }
}

async function listFoldersForBrowser({ localRoot, inputPath }) {
  const root = path.resolve(localRoot);
  const currentPath = await resolveExistingBrowserDirectory({
    localRoot: root,
    inputPath
  });

  let entries;
  try {
    entries = await fs.readdir(currentPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`LOCAL_DROPBOX_ROOT does not exist: ${root}`);
    }
    throw error;
  }
  const folders = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const folderPath = path.join(currentPath, entry.name);
      return {
        name: entry.name,
        absolutePath: folderPath,
        dropboxFolder: toDropboxFolderPath({
          localRoot: root,
          absolutePath: folderPath
        })
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const parentPath = path.resolve(currentPath) === root
    ? null
    : path.dirname(currentPath);

  return {
    localRoot: root,
    absolutePath: currentPath,
    dropboxFolder: toDropboxFolderPath({
      localRoot: root,
      absolutePath: currentPath
    }),
    parentPath,
    folders
  };
}

function renderRoutesPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Dropbox Routing Rules</title>
  <style>
    :root {
      --bg: #f4f6f8;
      --card: #ffffff;
      --text: #1f2933;
      --muted: #5f6c7b;
      --border: #d9e2ec;
      --primary: #0b6ef3;
      --danger: #c62828;
      --success: #0f9d58;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
      background: linear-gradient(180deg, #eef3f8 0%, var(--bg) 100%);
      color: var(--text);
    }
    .container {
      max-width: 1080px;
      margin: 0 auto;
      padding: 24px 16px 40px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 28px;
    }
    .subtitle {
      margin: 0 0 20px;
      color: var(--muted);
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 16px;
    }
    @media (min-width: 900px) {
      .grid {
        grid-template-columns: 340px 1fr;
      }
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
    }
    label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      margin: 10px 0 6px;
    }
    input[type="text"], textarea {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 14px;
      color: var(--text);
      background: #fff;
    }
    textarea {
      min-height: 72px;
      resize: vertical;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
      color: var(--muted);
      font-size: 13px;
    }
    .actions {
      display: flex;
      gap: 8px;
      margin-top: 14px;
      flex-wrap: wrap;
    }
    button {
      border: 1px solid transparent;
      border-radius: 8px;
      padding: 9px 12px;
      font-size: 13px;
      cursor: pointer;
    }
    .btn-primary {
      background: var(--primary);
      color: #fff;
    }
    .btn-secondary {
      background: #eef2f7;
      color: #1b2a41;
      border-color: #d9e2ec;
    }
    .btn-danger {
      background: #fff5f5;
      color: var(--danger);
      border-color: #ffd1d1;
    }
    .meta {
      margin-bottom: 12px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    .meta code {
      background: #f0f4f8;
      padding: 2px 6px;
      border-radius: 5px;
      font-size: 12px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      text-align: left;
      border-bottom: 1px solid var(--border);
      padding: 10px 8px;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .tag {
      display: inline-block;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      font-weight: 600;
    }
    .tag-active {
      color: #05603a;
      background: #d8f3e5;
    }
    .tag-inactive {
      color: #6b7280;
      background: #eceff3;
    }
    .status {
      margin-top: 10px;
      min-height: 20px;
      font-size: 13px;
    }
    .status.ok { color: var(--success); }
    .status.err { color: var(--danger); }
    .empty {
      color: var(--muted);
      font-size: 14px;
      padding: 16px 8px;
    }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.55);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 16px;
    }
    .modal-card {
      width: min(760px, 100%);
      max-height: 85vh;
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: 0 10px 28px rgba(15, 23, 42, 0.25);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .modal-header {
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      background: #f8fafc;
    }
    .modal-path {
      margin: 6px 0 0;
      font-size: 12px;
      color: var(--muted);
      word-break: break-all;
    }
    .modal-body {
      padding: 8px 14px;
      overflow: auto;
      flex: 1;
    }
    .folder-list {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .folder-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid #eef2f7;
    }
    .folder-name {
      font-size: 14px;
      word-break: break-word;
      flex: 1;
    }
    .modal-footer {
      padding: 12px 14px;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
      background: #f8fafc;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Dropbox Routing Rules</h1>
    <p class="subtitle">Manage route keys to Dropbox folder mappings used by the SocialPilot watcher.</p>
    <div class="grid">
      <section class="card">
        <h2 style="margin:0 0 6px;font-size:18px;">Add / Edit Rule</h2>
        <p style="margin:0;color:var(--muted);font-size:13px;">Route key can be a client code from subject (example: <code>fmb</code>, <code>sfg</code>) or an email address.</p>
        <label for="routeKey">Route Key</label>
        <input id="routeKey" type="text" placeholder="fmb or client@example.com" />
        <label for="dropboxFolder">Dropbox Folder</label>
        <div style="display:flex;gap:8px;align-items:center;">
          <input id="dropboxFolder" type="text" placeholder="/SocialPilot Reports/ClientA" style="flex:1;" />
          <button class="btn-secondary" id="browseFolderBtn" type="button" disabled>Browse...</button>
        </div>
        <label for="notes">Notes (optional)</label>
        <textarea id="notes" placeholder="Client label or internal note"></textarea>
        <div class="row">
          <input id="isActive" type="checkbox" checked />
          <label for="isActive" style="margin:0;font-weight:500;">Rule active</label>
        </div>
        <div class="actions">
          <button class="btn-primary" id="saveBtn">Save Rule</button>
          <button class="btn-secondary" id="resetBtn" type="button">Clear</button>
        </div>
	        <div id="status" class="status"></div>
	        <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border);">
	          <h3 style="margin:0 0 6px;font-size:15px;color:var(--danger);">Admin</h3>
	          <p style="margin:0 0 10px;color:var(--muted);font-size:13px;">
	            Export all current routing rules to JSON, or import rules JSON with merge/replace mode.
	          </p>
	          <div class="actions">
	            <button class="btn-secondary" id="exportRulesBtn" type="button">Export Rules</button>
	            <button class="btn-secondary" id="importRulesBtn" type="button">Import Rules</button>
	            <select id="importMode" style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:13px;">
	              <option value="merge">Import Mode: Merge</option>
	              <option value="replace">Import Mode: Replace</option>
	            </select>
	            <input id="importRulesFile" type="file" accept=".json,application/json" style="display:none;" />
	          </div>
	          <div id="rulesTransferStatus" class="status"></div>
	          <div style="margin-top:14px;padding-top:12px;border-top:1px dashed var(--border);">
	          <p style="margin:0 0 10px;color:var(--muted);font-size:13px;">
	            Step 1: discover route keys from mailbox subjects. Step 2: start downloads after routes are mapped.
	          </p>
	          <div class="actions">
	            <button class="btn-secondary" id="discoverKeysBtn" type="button">Fetch Route Keys</button>
	            <button class="btn-primary" id="startProcessingBtn" type="button">Start Downloading</button>
	          </div>
	          <div id="importStatus" class="status"></div>
	          </div>
	          <div style="margin-top:14px;padding-top:12px;border-top:1px dashed var(--border);">
	          <p style="margin:0 0 10px;color:var(--muted);font-size:13px;">
	            Clear processed message history and restart the service to force a full re-import on next boot.
	          </p>
	          <button class="btn-danger" id="resetImportBtn" type="button">Clear DB + Restart</button>
          <div id="adminStatus" class="status"></div>
          </div>
        </div>
	      </section>
	      <section class="card">
	        <details id="rulesPanel">
	          <summary style="cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:8px;">
	            <strong style="font-size:18px;">Current Rules</strong>
	            <span id="rulesSummaryCount" class="tag tag-inactive">Loading...</span>
	          </summary>
	          <div id="meta" class="meta" style="margin-top:10px;">Loading settings...</div>
	          <div style="overflow:auto;">
	            <table>
	              <thead>
	                <tr>
	                <th>Route Key</th>
	                  <th>Dropbox Folder</th>
	                  <th>Status</th>
	                  <th>Updated</th>
	                  <th>Actions</th>
	                </tr>
	              </thead>
	              <tbody id="routesBody"></tbody>
	            </table>
	            <div id="emptyState" class="empty" style="display:none;">No routing rules configured yet.</div>
	          </div>
	        </details>
	        <details id="suggestionsPanel" style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border);">
	          <summary style="cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:8px;">
	            <strong style="font-size:16px;">Discovered Client Names (From Subjects)</strong>
	            <span id="suggestionsSummaryCount" class="tag tag-inactive">Loading...</span>
	          </summary>
	          <p style="margin:10px 0;color:var(--muted);font-size:13px;">
	            Only unmapped keys are shown here. Add a route rule and the key will disappear from this list.
	          </p>
	          <div style="overflow:auto;">
	            <table>
	              <thead>
	                <tr>
	                  <th>Client Name</th>
	                  <th>Route Key</th>
	                  <th>Seen</th>
	                  <th>Last Seen</th>
	                  <th>Action</th>
	                </tr>
	              </thead>
	              <tbody id="suggestionsBody"></tbody>
	            </table>
	            <div id="suggestionsEmptyState" class="empty" style="display:none;">No unmapped subject keys right now.</div>
	          </div>
	        </details>
      </section>
    </div>
  </div>
  <div id="folderModal" class="modal-backdrop" aria-hidden="true">
    <div class="modal-card">
      <div class="modal-header">
        <strong id="folderModalTitle">Select Dropbox Folder</strong>
        <p id="folderModalPath" class="modal-path"></p>
      </div>
      <div class="modal-body">
        <ul id="folderModalList" class="folder-list"></ul>
        <div id="folderModalEmpty" class="empty" style="display:none;">No subfolders found in this location.</div>
      </div>
      <div class="modal-footer">
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button id="folderModalUpBtn" class="btn-secondary" type="button">Up</button>
          <button id="folderModalSelectBtn" class="btn-primary" type="button">Select This Folder</button>
        </div>
        <button id="folderModalCloseBtn" class="btn-secondary" type="button">Close</button>
      </div>
    </div>
  </div>
  <script>
    const els = {
      routeKey: document.getElementById('routeKey'),
      dropboxFolder: document.getElementById('dropboxFolder'),
      browseFolderBtn: document.getElementById('browseFolderBtn'),
      notes: document.getElementById('notes'),
      isActive: document.getElementById('isActive'),
	      saveBtn: document.getElementById('saveBtn'),
	      resetBtn: document.getElementById('resetBtn'),
	      exportRulesBtn: document.getElementById('exportRulesBtn'),
	      importRulesBtn: document.getElementById('importRulesBtn'),
	      importMode: document.getElementById('importMode'),
	      importRulesFile: document.getElementById('importRulesFile'),
	      discoverKeysBtn: document.getElementById('discoverKeysBtn'),
	      startProcessingBtn: document.getElementById('startProcessingBtn'),
	      resetImportBtn: document.getElementById('resetImportBtn'),
	      status: document.getElementById('status'),
	      rulesTransferStatus: document.getElementById('rulesTransferStatus'),
	      importStatus: document.getElementById('importStatus'),
	      adminStatus: document.getElementById('adminStatus'),
	      rulesPanel: document.getElementById('rulesPanel'),
	      rulesSummaryCount: document.getElementById('rulesSummaryCount'),
	      routesBody: document.getElementById('routesBody'),
	      emptyState: document.getElementById('emptyState'),
	      suggestionsPanel: document.getElementById('suggestionsPanel'),
	      suggestionsBody: document.getElementById('suggestionsBody'),
	      suggestionsSummaryCount: document.getElementById('suggestionsSummaryCount'),
	      suggestionsEmptyState: document.getElementById('suggestionsEmptyState'),
	      meta: document.getElementById('meta'),
      folderModal: document.getElementById('folderModal'),
      folderModalTitle: document.getElementById('folderModalTitle'),
      folderModalPath: document.getElementById('folderModalPath'),
      folderModalList: document.getElementById('folderModalList'),
      folderModalEmpty: document.getElementById('folderModalEmpty'),
      folderModalUpBtn: document.getElementById('folderModalUpBtn'),
      folderModalSelectBtn: document.getElementById('folderModalSelectBtn'),
      folderModalCloseBtn: document.getElementById('folderModalCloseBtn')
    };
    const pageState = {
      uploadBackend: null,
      localDropboxRoot: null,
      folderBrowser: null
    };

    function setStatus(message, kind) {
      els.status.textContent = message || '';
      els.status.className = 'status' + (kind ? ' ' + kind : '');
    }

    function clearForm() {
      els.routeKey.value = '';
      els.dropboxFolder.value = '';
      els.notes.value = '';
      els.isActive.checked = true;
      setStatus('');
      els.routeKey.focus();
    }

    function setAdminStatus(message, kind) {
      els.adminStatus.textContent = message || '';
      els.adminStatus.className = 'status' + (kind ? ' ' + kind : '');
    }

	    function setImportStatus(message, kind) {
	      els.importStatus.textContent = message || '';
	      els.importStatus.className = 'status' + (kind ? ' ' + kind : '');
	    }

	    function setRulesTransferStatus(message, kind) {
	      els.rulesTransferStatus.textContent = message || '';
	      els.rulesTransferStatus.className = 'status' + (kind ? ' ' + kind : '');
	    }

    function fmtDate(value) {
      if (!value) return '';
      const d = new Date(value.replace(' ', 'T') + 'Z');
      if (Number.isNaN(d.getTime())) return value;
      return d.toLocaleString();
    }

    async function loadMeta() {
      const res = await fetch('/api/meta');
      if (!res.ok) {
        els.meta.textContent = 'Unable to load service metadata.';
        return;
      }
      const data = await res.json();
      const importState = data.import || {};
      pageState.uploadBackend = data.uploadBackend || 'dropbox_api';
      pageState.localDropboxRoot = data.localDropboxRoot || null;
      const canBrowseFolders = pageState.uploadBackend === 'local_fs' || pageState.uploadBackend === 'dropbox_api';
      els.browseFolderBtn.disabled = !canBrowseFolders;
      els.browseFolderBtn.title = pageState.uploadBackend === 'local_fs'
        ? 'Browse folders under LOCAL_DROPBOX_ROOT'
        : 'Browse folders through the Dropbox API';
      els.meta.innerHTML =
        'Upload backend: <code>' + (data.uploadBackend || 'dropbox_api') + '</code><br>' +
        'Folder prefix: <code>' + (data.folderPrefix || '-') + '</code><br>' +
        'Local root: <code>' + (data.localDropboxRoot || '-') + '</code><br>' +
        'Default folder: <code>' + data.defaultFolder + '</code><br>' +
        'Dry run: <code>' + (data.dryRun ? 'true' : 'false') + '</code><br>' +
        'Start mode: <code>' + (importState.startMode || 'auto') + '</code><br>' +
        'Processing enabled: <code>' + (importState.processingEnabled ? 'true' : 'false') + '</code><br>' +
        'Discovery running: <code>' + (importState.discoveryRunning ? 'true' : 'false') + '</code>';
    }

    function rowButton(label, className, onClick) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = className;
      btn.textContent = label;
      btn.addEventListener('click', onClick);
      return btn;
    }

	    function escapeHtml(value) {
	      return String(value || '')
	        .replace(/&/g, '&amp;')
	        .replace(/</g, '&lt;')
	        .replace(/>/g, '&gt;')
	        .replace(/"/g, '&quot;')
	        .replace(/'/g, '&#39;');
	    }

	    function readFileAsText(file) {
	      return new Promise((resolve, reject) => {
	        const reader = new FileReader();
	        reader.onload = () => resolve(String(reader.result || ''));
	        reader.onerror = () => reject(new Error('Failed to read file'));
	        reader.readAsText(file);
	      });
	    }

	    function parseContentDispositionFileName(dispositionHeader) {
	      const header = String(dispositionHeader || '');
	      const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
	      if (utf8Match?.[1]) {
	        try {
	          return decodeURIComponent(utf8Match[1]).replace(/["']/g, '');
	        } catch (_error) {
	          return utf8Match[1].replace(/["']/g, '');
	        }
	      }

	      const basicMatch = header.match(/filename="?([^"]+)"?/i);
	      return basicMatch?.[1] || null;
	    }

    function closeFolderModal() {
      els.folderModal.style.display = 'none';
      els.folderModal.setAttribute('aria-hidden', 'true');
      pageState.folderBrowser = null;
    }

    function openFolderModal() {
      els.folderModal.style.display = 'flex';
      els.folderModal.setAttribute('aria-hidden', 'false');
    }

    function renderFolderBrowser() {
      const state = pageState.folderBrowser;
      if (!state) return;

      els.folderModalTitle.textContent = 'Select Dropbox Folder';
      const locationLabel = state.backend === 'dropbox_api' ? 'Dropbox path' : 'Absolute';
      const warningHtml = state.warning
        ? '<br><span style="color:#c62828;">' + escapeHtml(state.warning) + '</span>'
        : '';
      els.folderModalPath.innerHTML =
        'Current: <code>' + escapeHtml(state.dropboxFolder || '/') + '</code><br>' +
        locationLabel + ': <code>' + escapeHtml(state.absolutePath || '') + '</code>' +
        warningHtml;
      els.folderModalUpBtn.disabled = !state.parentPath;
      els.folderModalList.innerHTML = '';

      const folders = Array.isArray(state.folders) ? state.folders : [];
      if (!folders.length) {
        els.folderModalEmpty.style.display = 'block';
        return;
      }

      els.folderModalEmpty.style.display = 'none';
      for (const folder of folders) {
        const li = document.createElement('li');
        li.className = 'folder-row';

        const name = document.createElement('div');
        name.className = 'folder-name';
        name.textContent = folder.name || folder.dropboxFolder || '';

        const actions = document.createElement('div');
        actions.style.display = 'flex';
        actions.style.gap = '6px';

        const openBtn = rowButton('Open', 'btn-secondary', () => {
          loadFolderBrowser(folder.absolutePath).catch((error) => {
            setStatus(error && error.message ? error.message : 'Failed to open folder', 'err');
          });
        });
        const selectBtn = rowButton('Select', 'btn-primary', () => {
          els.dropboxFolder.value = folder.dropboxFolder || '/';
          closeFolderModal();
          setStatus('Folder selected', 'ok');
        });

        actions.appendChild(openBtn);
        actions.appendChild(selectBtn);
        li.appendChild(name);
        li.appendChild(actions);
        els.folderModalList.appendChild(li);
      }
    }

    async function loadFolderBrowser(pathHint) {
      const params = new URLSearchParams();
      if (pathHint) {
        params.set('path', pathHint);
      }

      const endpoint = pageState.uploadBackend === 'dropbox_api'
        ? '/api/admin/dropbox-folders'
        : '/api/admin/local-folders';
      const url = endpoint + (params.toString() ? ('?' + params.toString()) : '');
      const res = await fetch(url);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || 'Unable to load folders');
      }

      pageState.folderBrowser = body;
      renderFolderBrowser();
    }

	    async function loadRoutes() {
	      const res = await fetch('/api/routes');
	      if (!res.ok) {
	        setStatus('Failed to load routing rules', 'err');
	        els.rulesSummaryCount.textContent = 'Error';
	        return;
	      }

	      const data = await res.json();
	      const rules = Array.isArray(data.rules) ? data.rules : [];
	      els.routesBody.innerHTML = '';
	      const activeCount = rules.filter((rule) => rule?.isActive).length;
	      els.rulesSummaryCount.textContent = activeCount + ' active / ' + rules.length + ' total';

	      if (!rules.length) {
	        els.emptyState.style.display = 'block';
	        return;
	      }

      els.emptyState.style.display = 'none';

      for (const rule of rules) {
        const tr = document.createElement('tr');

        const tdEmail = document.createElement('td');
        tdEmail.textContent = rule.routeKey;

        const tdFolder = document.createElement('td');
        tdFolder.textContent = rule.dropboxFolder;

        const tdStatus = document.createElement('td');
        const tag = document.createElement('span');
        tag.className = 'tag ' + (rule.isActive ? 'tag-active' : 'tag-inactive');
        tag.textContent = rule.isActive ? 'Active' : 'Inactive';
        tdStatus.appendChild(tag);

        const tdUpdated = document.createElement('td');
        tdUpdated.textContent = fmtDate(rule.updatedAt);

        const tdActions = document.createElement('td');
        tdActions.style.whiteSpace = 'nowrap';

        tdActions.appendChild(rowButton('Edit', 'btn-secondary', () => {
          els.routeKey.value = rule.routeKey;
          els.dropboxFolder.value = rule.dropboxFolder;
          els.notes.value = rule.notes || '';
          els.isActive.checked = !!rule.isActive;
          setStatus('Loaded rule for editing', 'ok');
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }));

        tdActions.appendChild(document.createTextNode(' '));

        tdActions.appendChild(rowButton('Delete', 'btn-danger', async () => {
          if (!confirm('Delete rule for ' + rule.routeKey + '?')) return;

          const delRes = await fetch('/api/routes/' + encodeURIComponent(rule.routeKey), {
            method: 'DELETE'
          });
          if (!delRes.ok) {
            const err = await delRes.json().catch(() => ({}));
            setStatus(err.error || 'Failed to delete rule', 'err');
            return;
          }

	          setStatus('Rule deleted', 'ok');
	          await loadRoutes();
	          await loadSuggestions();
	        }));

        tr.appendChild(tdEmail);
        tr.appendChild(tdFolder);
        tr.appendChild(tdStatus);
        tr.appendChild(tdUpdated);
        tr.appendChild(tdActions);
        els.routesBody.appendChild(tr);
      }
    }

	    async function loadSuggestions() {
	      const res = await fetch('/api/route-suggestions');
	      if (!res.ok) {
	        els.suggestionsSummaryCount.textContent = 'Error';
	        return;
	      }

	      const data = await res.json().catch(() => ({}));
	      const allSuggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
	      const suggestions = allSuggestions.filter((suggestion) => !suggestion.hasRule);
	      els.suggestionsBody.innerHTML = '';
	      els.suggestionsSummaryCount.textContent = suggestions.length + ' unmapped';

	      if (!suggestions.length) {
	        els.suggestionsEmptyState.style.display = 'block';
	        return;
	      }

      els.suggestionsEmptyState.style.display = 'none';

      for (const suggestion of suggestions) {
        const tr = document.createElement('tr');

        const tdName = document.createElement('td');
        tdName.textContent = suggestion.clientName || '';

        const tdKey = document.createElement('td');
        tdKey.textContent = suggestion.routeKey || '';

        const tdSeen = document.createElement('td');
        tdSeen.textContent = String(suggestion.seenCount || 0);

	        const tdLastSeen = document.createElement('td');
	        tdLastSeen.textContent = fmtDate(suggestion.lastSeenAt);

	        const tdAction = document.createElement('td');
	        const useBtn = document.createElement('button');
	        useBtn.type = 'button';
	        useBtn.className = 'btn-secondary';
        useBtn.textContent = 'Use Key';
        useBtn.addEventListener('click', () => {
          els.routeKey.value = suggestion.routeKey || '';
          if (!els.dropboxFolder.value.trim()) {
            els.dropboxFolder.value = '/SocialPilot Reports/' + (suggestion.clientName || 'Client');
          }
          setStatus('Loaded suggested route key into form', 'ok');
          window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        tdAction.appendChild(useBtn);

        tr.appendChild(tdName);
	        tr.appendChild(tdKey);
	        tr.appendChild(tdSeen);
	        tr.appendChild(tdLastSeen);
	        tr.appendChild(tdAction);
	        els.suggestionsBody.appendChild(tr);
	      }
	    }

	    async function saveRule() {
	      const payload = {
	        routeKey: els.routeKey.value.trim(),
	        dropboxFolder: els.dropboxFolder.value.trim(),
        notes: els.notes.value.trim(),
        isActive: els.isActive.checked
      };

      const res = await fetch('/api/routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(body.error || 'Failed to save rule', 'err');
        return;
      }

	      setStatus('Rule saved successfully', 'ok');
	      await loadRoutes();
	      await loadSuggestions();
	    }

	    async function exportRules() {
	      els.exportRulesBtn.disabled = true;
	      setRulesTransferStatus('Preparing rules export...', 'ok');

	      try {
	        const res = await fetch('/api/routes/export');
	        if (!res.ok) {
	          const body = await res.json().catch(() => ({}));
	          throw new Error(body.error || 'Failed to export rules');
	        }

	        const blob = await res.blob();
	        const disposition = res.headers.get('content-disposition');
	        const fileName = parseContentDispositionFileName(disposition) || 'routing-rules.json';

	        const downloadUrl = URL.createObjectURL(blob);
	        const link = document.createElement('a');
	        link.href = downloadUrl;
	        link.download = fileName;
	        document.body.appendChild(link);
	        link.click();
	        link.remove();
	        URL.revokeObjectURL(downloadUrl);

	        setRulesTransferStatus('Rules exported successfully', 'ok');
	      } catch (error) {
	        setRulesTransferStatus(error && error.message ? error.message : 'Failed to export rules', 'err');
	      } finally {
	        els.exportRulesBtn.disabled = false;
	      }
	    }

	    async function importRulesFromFile(file) {
	      if (!file) {
	        setRulesTransferStatus('No file selected for import', 'err');
	        return;
	      }

	      els.importRulesBtn.disabled = true;
	      els.importMode.disabled = true;
	      setRulesTransferStatus('Importing rules from file...', 'ok');

	      try {
	        const text = await readFileAsText(file);
	        const parsed = JSON.parse(text);
	        const rules = Array.isArray(parsed)
	          ? parsed
	          : Array.isArray(parsed?.rules)
	            ? parsed.rules
	            : null;

	        if (!rules) {
	          throw new Error('Invalid rules JSON. Expected an array or { "rules": [...] }.');
	        }

	        const mode = String(els.importMode.value || 'merge');
	        if (mode === 'replace') {
	          const confirmed = confirm('Replace mode will delete all existing routing rules before import. Continue?');
	          if (!confirmed) {
	            setRulesTransferStatus('Import cancelled', '');
	            return;
	          }
	        }
	        const res = await fetch('/api/routes/import', {
	          method: 'POST',
	          headers: { 'Content-Type': 'application/json' },
	          body: JSON.stringify({
	            mode,
	            rules
	          })
	        });
	        const body = await res.json().catch(() => ({}));
	        if (!res.ok) {
	          throw new Error(body.error || 'Failed to import rules');
	        }

	        setRulesTransferStatus(
	          'Rules imported: ' + (body.importedCount || 0) + ' (' + mode + ' mode)',
	          'ok'
	        );
	        await loadRoutes();
	        await loadSuggestions();
	      } catch (error) {
	        setRulesTransferStatus(error && error.message ? error.message : 'Failed to import rules', 'err');
	      } finally {
	        els.importRulesBtn.disabled = false;
	        els.importMode.disabled = false;
	        els.importRulesFile.value = '';
	      }
	    }

	    async function resetImportState() {
      const confirmation = prompt('Type RESET to clear processed message history and restart service.');
      if (confirmation == null) return;

      if (String(confirmation).trim().toUpperCase() !== 'RESET') {
        setAdminStatus('Cancelled. Confirmation text did not match RESET.', 'err');
        return;
      }

      els.resetImportBtn.disabled = true;
      setAdminStatus('Clearing processed history and requesting restart...', 'ok');

      try {
        const res = await fetch('/api/admin/reset-and-restart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: 'RESET' })
        });
        const body = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(body.error || 'Failed to clear history and restart');
        }

        setAdminStatus(
          'Cleared ' + (body.clearedRows || 0) + ' rows. Restart requested; page will disconnect shortly.',
          'ok'
        );
      } catch (error) {
        els.resetImportBtn.disabled = false;
        setAdminStatus(error && error.message ? error.message : 'Failed to clear history and restart', 'err');
      }
    }

    async function discoverRouteKeys() {
      els.discoverKeysBtn.disabled = true;
      setImportStatus('Discovering route keys from mailbox subjects...', 'ok');

      try {
        const res = await fetch('/api/admin/discover-route-keys', {
          method: 'POST'
        });
        const body = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(body.error || 'Failed to discover route keys');
        }

        if (body.alreadyRunning) {
          setImportStatus('Discovery is already running. Please wait.', 'ok');
        } else {
          setImportStatus(
            'Discovery completed: scanned ' + (body.scanned || 0) + ' messages, discovered ' + (body.discovered || 0) + ' candidates.',
            'ok'
          );
        }

        await loadSuggestions();
        await loadMeta();
      } catch (error) {
        setImportStatus(error && error.message ? error.message : 'Failed to discover route keys', 'err');
      } finally {
        els.discoverKeysBtn.disabled = false;
      }
    }

    async function startProcessing() {
      els.startProcessingBtn.disabled = true;

      try {
        const res = await fetch('/api/admin/start-processing', {
          method: 'POST'
        });
        const body = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(body.error || 'Failed to start processing');
        }

        if (body.alreadyRunning) {
          setImportStatus(
            body.scanRequested
              ? 'Processing is running. Mailbox rescan requested.'
              : 'Processing is already running and reconnecting. Try again after IMAP connects.',
            body.scanRequested ? 'ok' : 'err'
          );
        } else if (body.started) {
          setImportStatus('Processing started. Reports will now download and route by configured rules.', 'ok');
        } else {
          setImportStatus('Processing state unchanged.', 'ok');
        }

        await loadMeta();
      } catch (error) {
        setImportStatus(error && error.message ? error.message : 'Failed to start processing', 'err');
      } finally {
        els.startProcessingBtn.disabled = false;
      }
    }

    async function browseDropboxFolder() {
      if (pageState.uploadBackend !== 'local_fs' && pageState.uploadBackend !== 'dropbox_api') {
        setStatus('Folder browser is only available for Dropbox upload backends', 'err');
        return;
      }

      els.browseFolderBtn.disabled = true;
      setStatus('Loading folder browser...', 'ok');

      try {
        openFolderModal();
        await loadFolderBrowser(els.dropboxFolder.value.trim());
        setStatus('', '');
      } catch (error) {
        closeFolderModal();
        setStatus(error && error.message ? error.message : 'Unable to load folder browser', 'err');
      } finally {
        const shouldDisable = pageState.uploadBackend !== 'local_fs' && pageState.uploadBackend !== 'dropbox_api';
        els.browseFolderBtn.disabled = shouldDisable;
      }
    }

    els.saveBtn.addEventListener('click', () => {
      saveRule().catch((error) => {
        setStatus(error && error.message ? error.message : 'Failed to save rule', 'err');
      });
    });

	    els.resetBtn.addEventListener('click', () => clearForm());
	    els.exportRulesBtn.addEventListener('click', () => {
	      exportRules().catch((error) => {
	        setRulesTransferStatus(error && error.message ? error.message : 'Failed to export rules', 'err');
	      });
	    });
	    els.importRulesBtn.addEventListener('click', () => {
	      els.importRulesFile.click();
	    });
	    els.importRulesFile.addEventListener('change', () => {
	      const file = els.importRulesFile.files && els.importRulesFile.files[0]
	        ? els.importRulesFile.files[0]
	        : null;
	      importRulesFromFile(file).catch((error) => {
	        setRulesTransferStatus(error && error.message ? error.message : 'Failed to import rules', 'err');
	      });
	    });
	    els.browseFolderBtn.addEventListener('click', () => {
	      browseDropboxFolder().catch((error) => {
	        setStatus(error && error.message ? error.message : 'Unable to load folder browser', 'err');
      });
    });
    els.folderModalCloseBtn.addEventListener('click', () => {
      closeFolderModal();
    });
    els.folderModalUpBtn.addEventListener('click', () => {
      const parentPath = pageState.folderBrowser?.parentPath;
      if (!parentPath) return;
      loadFolderBrowser(parentPath).catch((error) => {
        setStatus(error && error.message ? error.message : 'Unable to open parent folder', 'err');
      });
    });
    els.folderModalSelectBtn.addEventListener('click', () => {
      const selected = pageState.folderBrowser?.dropboxFolder;
      if (!selected) return;
      els.dropboxFolder.value = selected;
      closeFolderModal();
      setStatus('Folder selected', 'ok');
    });
    els.folderModal.addEventListener('click', (event) => {
      if (event.target === els.folderModal) {
        closeFolderModal();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && els.folderModal.style.display === 'flex') {
        closeFolderModal();
      }
    });
    els.discoverKeysBtn.addEventListener('click', () => {
      discoverRouteKeys().catch((error) => {
        setImportStatus(error && error.message ? error.message : 'Failed to discover route keys', 'err');
      });
    });
    els.startProcessingBtn.addEventListener('click', () => {
      startProcessing().catch((error) => {
        setImportStatus(error && error.message ? error.message : 'Failed to start processing', 'err');
      });
    });
    els.resetImportBtn.addEventListener('click', () => {
      resetImportState().catch((error) => {
        els.resetImportBtn.disabled = false;
        setAdminStatus(error && error.message ? error.message : 'Failed to clear history and restart', 'err');
      });
    });

    Promise.all([loadMeta(), loadRoutes(), loadSuggestions()]).catch(() => {
      setStatus('Failed to initialize page', 'err');
    });
  </script>
</body>
</html>`;
}

function toErrorResponse(error) {
  return {
    error: error?.message || 'Unexpected error'
  };
}

export async function startWebServer({
  host,
  port,
  logger,
  healthState,
  db,
  config,
  onDiscoverRouteKeys,
  onStartProcessing,
  onPrepareResetImportState,
  onResetImportStateFailed,
  onResetAndRestart
}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  const dropboxFolderBrowser = config.dropbox.backend === 'dropbox_api'
    ? createDropboxFolderBrowser({
        accessToken: config.dropbox.accessToken,
        appKey: config.dropbox.appKey,
        appSecret: config.dropbox.appSecret,
        refreshToken: config.dropbox.refreshToken,
        pathRootMode: config.dropbox.pathRootMode,
        pathRootNamespaceId: config.dropbox.pathRootNamespaceId,
        folderPrefix: config.dropbox.folderPrefix,
        logger,
        retryConfig: config.retry
      })
    : null;

  app.get('/health', (_req, res) => {
    if (healthState.shuttingDown) {
      res.status(503).type('text/plain').send('NOT_OK');
      return;
    }

    if (!healthState.processingEnabled) {
      res.status(200).type('text/plain').send('OK');
      return;
    }

    if (healthState.imapLoopRunning && healthState.imapConnected) {
      res.status(200).type('text/plain').send('OK');
      return;
    }

    res.status(503).type('text/plain').send('NOT_OK');
  });

  app.use(createAdminAuthMiddleware({ config, logger }));

  app.get('/', (_req, res) => {
    res.redirect('/routes');
  });

  app.get('/routes', (_req, res) => {
    res.status(200).type('html').send(renderRoutesPage());
  });

  app.get('/api/meta', async (_req, res) => {
    try {
      res.status(200).json({
        defaultFolder: config.dropbox.folderDefault,
        dryRun: config.dryRun,
        uploadBackend: config.dropbox.backend,
        folderPrefix: config.dropbox.folderPrefix || null,
        localDropboxRoot: config.dropbox.localRoot || null,
        import: {
          startMode: healthState.importStartMode || config.runtime?.importStartMode || 'auto',
          processingEnabled: Boolean(healthState.processingEnabled),
          discoveryRunning: Boolean(healthState.discoveryRunning)
        },
        imap: {
          loopRunning: Boolean(healthState.imapLoopRunning),
          connected: Boolean(healthState.imapConnected),
          authFailed: Boolean(healthState.imapAuthFailed),
          lastError: healthState.imapLastError || null
        }
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to load service metadata');
      res.status(500).json({ error: 'Unable to load service metadata' });
    }
  });

  app.get('/api/routes', async (_req, res) => {
    const rules = await db.listRoutingRules();
    res.status(200).json({ rules });
  });

  app.get('/api/routes/export', async (_req, res) => {
    try {
      const rules = await db.listRoutingRules();
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        ruleCount: rules.length,
        rules
      };

      const timestamp = payload.exportedAt.replace(/[:.]/g, '-');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="routing-rules-${timestamp}.json"`);
      res.status(200).send(JSON.stringify(payload, null, 2));
    } catch (error) {
      logger.error({ err: error }, 'Failed to export routing rules');
      res.status(500).json({ error: 'Failed to export routing rules' });
    }
  });

  app.post('/api/routes/import', async (req, res) => {
    try {
      const mode = String(req.body?.mode || 'merge').trim().toLowerCase();
      const bodyRules = Array.isArray(req.body)
        ? req.body
        : Array.isArray(req.body?.rules)
          ? req.body.rules
          : null;

      if (!bodyRules) {
        res.status(400).json({ error: 'Invalid payload. Expected array or { mode, rules }.' });
        return;
      }

      const result = await db.importRoutingRules(bodyRules, { mode });
      const releaseKeys = bodyRules
        .filter((rule) => rule?.isActive !== false)
        .flatMap((rule) => [rule?.routeKey, rule?.recipientEmail]);
      const { released: releasedPending } = await db.releasePendingMessagesForRoutes(releaseKeys);
      logger.info(
        {
          mode: result.mode,
          importedCount: result.importedCount,
          replacedRows: result.replacedRows,
          changedRows: result.changedRows,
          releasedPending
        },
        'Routing rules imported from web UI'
      );

      res.status(200).json({
        ok: true,
        ...result,
        releasedPending
      });
    } catch (error) {
      res.status(400).json(toErrorResponse(error));
    }
  });

  app.get('/api/route-suggestions', async (_req, res) => {
    try {
      const [storedSuggestions, subjectStats, rules] = await Promise.all([
        db.listRouteKeySuggestions(),
        db.listProcessedSubjectStats(),
        db.listRoutingRules()
      ]);

      const mappedRuleKeys = new Set(
        rules
          .filter((rule) => rule?.isActive !== false)
          .map((rule) => String(rule.routeKey || '').trim().toLowerCase())
          .filter(Boolean)
      );

      const suggestionsByKey = new Map();
      for (const suggestion of storedSuggestions) {
        const key = String(suggestion.routeKey || '').trim().toLowerCase();
        if (!key) continue;

        suggestionsByKey.set(key, {
          clientName: suggestion.clientName || key,
          routeKey: key,
          seenCount: Number(suggestion.seenCount) || 0,
          lastSeenAt: suggestion.lastSeenAt || null
        });
      }

      for (const stat of subjectStats) {
        const parsed = parseSubjectRouteCandidate(stat.subject);
        if (!parsed?.routeKey) continue;

        const key = parsed.routeKey;
        const existing = suggestionsByKey.get(key);
        if (!existing) {
          suggestionsByKey.set(key, {
            clientName: parsed.clientName,
            routeKey: key,
            seenCount: stat.seenCount,
            lastSeenAt: stat.lastSeenAt
          });
          continue;
        }

        existing.seenCount = Math.max(existing.seenCount, stat.seenCount);
        if (
          stat.lastSeenAt &&
          (!existing.lastSeenAt || new Date(stat.lastSeenAt) > new Date(existing.lastSeenAt))
        ) {
          existing.lastSeenAt = stat.lastSeenAt;
          existing.clientName = parsed.clientName;
        }
      }

      const suggestions = [...suggestionsByKey.values()]
        .map((suggestion) => ({
          ...suggestion,
          hasRule: mappedRuleKeys.has(suggestion.routeKey)
        }))
        .sort((a, b) => {
          if (b.seenCount !== a.seenCount) return b.seenCount - a.seenCount;
          return String(a.clientName || '').localeCompare(String(b.clientName || ''));
        });

      res.status(200).json({ suggestions });
    } catch (error) {
      logger.error({ err: error }, 'Failed to build route suggestions');
      res.status(500).json({ error: 'Unable to load route suggestions' });
    }
  });

  app.post('/api/routes', async (req, res) => {
    try {
      const saved = await db.upsertRoutingRule({
        routeKey: req.body?.routeKey,
        recipientEmail: req.body?.recipientEmail,
        dropboxFolder: req.body?.dropboxFolder,
        isActive: req.body?.isActive !== false,
        notes: req.body?.notes
      });
      const { released: releasedPending } = saved.isActive
        ? await db.releasePendingMessagesForRoutes([saved.routeKey])
        : { released: 0 };

      logger.info(
        {
          routeKey: saved.routeKey,
          dropboxFolder: saved.dropboxFolder,
          isActive: saved.isActive,
          releasedPending
        },
        'Routing rule saved from web UI'
      );

      res.status(200).json({
        rule: saved,
        releasedPending
      });
    } catch (error) {
      res.status(400).json(toErrorResponse(error));
    }
  });

  app.delete('/api/routes/:routeKey', async (req, res) => {
    try {
      const routeKey = decodeURIComponent(String(req.params.routeKey || ''));
      const deleted = await db.deleteRoutingRule(routeKey);

      if (!deleted) {
        res.status(404).json({ error: 'Routing rule not found' });
        return;
      }

      await db.upsertRouteKeySuggestion({
        routeKey,
        clientName: routeKey,
        source: 'deleted_route',
        lastSeenAt: new Date()
      });

      logger.info({ routeKey }, 'Routing rule deleted from web UI');
      res.status(200).json({ deleted: true });
    } catch (error) {
      res.status(400).json(toErrorResponse(error));
    }
  });

  app.get('/api/admin/local-folders', async (req, res) => {
    try {
      if (config.dropbox.backend !== 'local_fs') {
        res.status(400).json({ error: 'Folder browser is only available when UPLOAD_BACKEND=local_fs' });
        return;
      }

      if (!config.dropbox.localRoot) {
        res.status(400).json({ error: 'LOCAL_DROPBOX_ROOT is not configured' });
        return;
      }

      const listing = await listFoldersForBrowser({
        localRoot: config.dropbox.localRoot,
        inputPath: String(req.query?.path || '').trim()
      });

      res.status(200).json(listing);
    } catch (error) {
      logger.error({ err: error }, 'Failed to list local folders for browser');
      res.status(500).json({ error: error?.message || 'Failed to list local folders' });
    }
  });

  app.get('/api/admin/dropbox-folders', async (req, res) => {
    try {
      if (config.dropbox.backend !== 'dropbox_api') {
        res.status(400).json({ error: 'Dropbox folder browser is only available when UPLOAD_BACKEND=dropbox_api' });
        return;
      }

      if (!dropboxFolderBrowser) {
        res.status(500).json({ error: 'Dropbox folder browser is not configured' });
        return;
      }

      const listing = await dropboxFolderBrowser.listFolders({
        inputPath: String(req.query?.path || '').trim()
      });

      res.status(200).json(listing);
    } catch (error) {
      logger.error({ err: error }, 'Failed to list Dropbox folders for browser');
      res.status(500).json({ error: error?.message || 'Failed to list Dropbox folders' });
    }
  });

  app.post('/api/admin/discover-route-keys', async (_req, res) => {
    try {
      if (typeof onDiscoverRouteKeys !== 'function') {
        res.status(501).json({ error: 'Route key discovery is not enabled' });
        return;
      }

      const result = await onDiscoverRouteKeys({
        trigger: 'web_ui'
      });
      res.status(200).json({
        ok: true,
        ...result
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to discover route keys from web UI');
      res.status(500).json({ error: error?.message || 'Failed to discover route keys' });
    }
  });

  app.post('/api/admin/start-processing', async (_req, res) => {
    try {
      if (typeof onStartProcessing !== 'function') {
        res.status(501).json({ error: 'Start processing is not enabled' });
        return;
      }

      const result = await onStartProcessing({
        trigger: 'web_ui'
      });
      res.status(200).json({
        ok: true,
        ...result
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to start processing from web UI');
      res.status(500).json({ error: error?.message || 'Failed to start processing' });
    }
  });

  app.post('/api/admin/reset-and-restart', async (req, res) => {
    let resetPrepared = false;

    try {
      const confirmation = String(req.body?.confirm || '').trim().toUpperCase();
      if (confirmation !== 'RESET') {
        res.status(400).json({ error: 'Confirmation failed. Send confirm=RESET.' });
        return;
      }

      if (typeof onPrepareResetImportState === 'function') {
        await onPrepareResetImportState({
          trigger: 'web_ui'
        });
        resetPrepared = true;
      }

      const { deletedRows } = await db.clearProcessedMessages();
      logger.warn({ deletedRows }, 'Processed message history cleared from web UI');

      res.status(202).json({
        ok: true,
        clearedRows: deletedRows,
        restarting: true
      });

      const timer = setTimeout(() => {
        if (typeof onResetAndRestart === 'function') {
          Promise.resolve(
            onResetAndRestart({
              trigger: 'web_ui',
              clearedRows: deletedRows
            })
          ).catch((error) => {
            logger.error({ err: error }, 'Failed to restart after reset request');
          });
        }
      }, 100);
      timer.unref?.();
    } catch (error) {
      if (resetPrepared && typeof onResetImportStateFailed === 'function') {
        try {
          await onResetImportStateFailed({
            trigger: 'web_ui',
            error
          });
        } catch (rollbackError) {
          logger.error({ err: rollbackError }, 'Failed to rollback reset state after error');
        }
      }

      logger.error({ err: error }, 'Failed to clear processed history and restart');
      res.status(500).json({ error: 'Failed to clear processed history and restart' });
    }
  });

  app.use((error, _req, res, _next) => {
    logger.error({ err: error }, 'Unhandled web server error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return new Promise((resolve, reject) => {
    const server = app
      .listen(port, host, () => {
        logger.info({ webHost: host, webPort: port }, 'Web server started');
        resolve(server);
      })
      .on('error', reject);
  });
}
