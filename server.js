const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { loadCredentials } = require('./src/credentials');
const { runPopupJob, siteKey } = require('./src/runner');

const app = express();
const PORT = process.env.PORT || 3847;

const uploadsDir = path.resolve(__dirname, 'uploads');
const flyerDir = path.join(uploadsDir, 'flyer');
const excelDir = path.join(uploadsDir, 'excel');

for (const dir of [uploadsDir, flyerDir, excelDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Sites that already received the current flyer — skipped on re-runs so a
// website never gets the same popup uploaded twice. Reset when a new flyer
// is uploaded.
const completedFile = path.join(uploadsDir, 'completed-sites.json');

function loadCompletedKeys() {
  try {
    const parsed = JSON.parse(fs.readFileSync(completedFile, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCompletedKeys(keys) {
  try {
    fs.writeFileSync(completedFile, JSON.stringify([...new Set(keys)], null, 2));
  } catch {
    // non-fatal
  }
}

function clearCompletedKeys() {
  try {
    if (fs.existsSync(completedFile)) fs.unlinkSync(completedFile);
  } catch {
    // non-fatal
  }
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const flyerStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, flyerDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `flyer${ext}`);
  },
});

const excelStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, excelDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.xlsx';
    cb(null, `credentials${ext}`);
  },
});

const uploadFlyer = multer({
  storage: flyerStorage,
  fileFilter: (_req, file, cb) => {
    const ok = /\.(png|jpe?g|gif|webp)$/i.test(file.originalname);
    cb(ok ? null : new Error('Flyer must be an image (png, jpg, gif, webp)'), ok);
  },
  limits: { fileSize: 20 * 1024 * 1024 },
});

const uploadExcel = multer({
  storage: excelStorage,
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname);
    cb(ok ? null : new Error('Credentials must be Excel or CSV'), ok);
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

/** @type {import('express').Response[]} */
const sseClients = [];

const jobState = {
  status: 'idle', // idle | ready | running | completed | stopped | error
  mode: 'upload', // upload | disable | test
  total: 0,
  done: 0,
  success: 0,
  failed: 0,
  current: null,
  active: [],
  skippedDuplicates: 0,
  skippedAlreadyDone: 0,
  skippedBeforeRow: 0,
  failedSites: [],
  successSites: [],
  flyerName: null,
  excelName: null,
  siteCount: 0,
  popupTitle: 'Weekend Special',
  error: null,
  startedAt: null,
  finishedAt: null,
};

let stopRequested = false;
let runPromise = null;

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of [...sseClients]) {
    try {
      client.write(data);
    } catch {
      // drop broken client
    }
  }
}

function getFlyerPath() {
  if (!fs.existsSync(flyerDir)) return null;
  const files = fs.readdirSync(flyerDir).filter((f) => !f.startsWith('.'));
  return files.length ? path.join(flyerDir, files[0]) : null;
}

function getExcelPath() {
  if (!fs.existsSync(excelDir)) return null;
  const files = fs.readdirSync(excelDir).filter((f) => !f.startsWith('.'));
  return files.length ? path.join(excelDir, files[0]) : null;
}

function refreshReadyState() {
  const flyer = getFlyerPath();
  const excel = getExcelPath();
  jobState.flyerName = flyer ? path.basename(flyer) : null;
  jobState.excelName = excel ? path.basename(excel) : null;

  if (excel) {
    try {
      jobState.siteCount = loadCredentials(excel).length;
    } catch {
      jobState.siteCount = 0;
    }
  } else {
    jobState.siteCount = 0;
  }

  if (jobState.status === 'idle' || jobState.status === 'ready' || jobState.status === 'error') {
    const hasExcel = Boolean(excel && jobState.siteCount > 0);
    const hasFlyer = Boolean(flyer);
    const ready =
      jobState.mode === 'disable' || jobState.mode === 'test'
        ? hasExcel
        : hasExcel && hasFlyer;
    jobState.status = ready ? 'ready' : 'idle';
  }
}

app.get('/api/status', (_req, res) => {
  refreshReadyState();
  res.json({ ...jobState });
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sseClients.push(res);
  refreshReadyState();
  res.write(`data: ${JSON.stringify({ type: 'snapshot', ...jobState })}\n\n`);

  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx >= 0) sseClients.splice(idx, 1);
  });
});

app.post('/api/upload/flyer', (req, res) => {
  uploadFlyer.single('flyer')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No flyer file uploaded' });

    for (const file of fs.readdirSync(flyerDir)) {
      if (file !== req.file.filename) fs.unlinkSync(path.join(flyerDir, file));
    }

    // New flyer = new campaign, so every site is eligible again.
    clearCompletedKeys();

    refreshReadyState();
    broadcast({ type: 'files', ...jobState });
    res.json({
      ok: true,
      filename: req.file.filename,
      originalName: req.file.originalname,
      status: jobState,
    });
  });
});

app.post('/api/upload/credentials', (req, res) => {
  uploadExcel.single('credentials')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No credentials file uploaded' });

    for (const file of fs.readdirSync(excelDir)) {
      if (file !== req.file.filename) fs.unlinkSync(path.join(excelDir, file));
    }

    try {
      const sites = loadCredentials(getExcelPath());
      if (sites.length === 0) {
        return res.status(400).json({
          error: 'No valid rows found. Need Admin URL, User Name, Password columns.',
        });
      }
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    refreshReadyState();
    broadcast({ type: 'files', ...jobState });
    res.json({
      ok: true,
      filename: req.file.filename,
      originalName: req.file.originalname,
      siteCount: jobState.siteCount,
      status: jobState,
    });
  });
});

app.post('/api/mode', (req, res) => {
  if (jobState.status === 'running') {
    return res.status(409).json({ error: 'Cannot change mode while a run is in progress' });
  }

  const mode = String(req.body?.mode || '').trim();
  if (mode !== 'upload' && mode !== 'disable' && mode !== 'test') {
    return res.status(400).json({ error: 'mode must be "upload", "disable", or "test"' });
  }

  jobState.mode = mode;
  refreshReadyState();
  broadcast({ type: 'mode', ...jobState });
  res.json({ ok: true, status: jobState });
});

app.post('/api/start', async (req, res) => {
  const mode = String(req.body?.mode || jobState.mode || 'upload').trim();
  if (mode !== 'upload' && mode !== 'disable' && mode !== 'test') {
    return res.status(400).json({ error: 'mode must be "upload", "disable", or "test"' });
  }

  jobState.mode = mode;
  refreshReadyState();

  if (jobState.status === 'running') {
    return res.status(409).json({ error: 'A run is already in progress' });
  }

  const flyerPath = getFlyerPath();
  const excelPath = getExcelPath();

  if (!excelPath) {
    return res.status(400).json({ error: 'Upload a credentials Excel file first' });
  }

  if (mode === 'upload' && !flyerPath) {
    return res.status(400).json({ error: 'Upload a flyer image first (required for upload mode)' });
  }

  let sites;
  try {
    sites = loadCredentials(excelPath);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  if (sites.length === 0) {
    return res.status(400).json({ error: 'No valid websites in the credentials sheet' });
  }

  const popupTitle = String(req.body?.popupTitle || jobState.popupTitle || 'Weekend Special').trim();
  jobState.popupTitle = popupTitle || 'Weekend Special';

  const concurrency = Math.max(1, Math.min(12, Number(req.body?.concurrency) || 8));
  const startRowRaw = Number(req.body?.startRow);
  const startRow = Number.isFinite(startRowRaw) && startRowRaw > 1 ? Math.floor(startRowRaw) : 1;
  const skipKeys = mode === 'upload' ? loadCompletedKeys() : [];
  const headless = req.body?.showBrowsers !== true && req.body?.headless !== false;
  stopRequested = false;

  Object.assign(jobState, {
    status: 'running',
    mode,
    total: sites.length,
    done: 0,
    success: 0,
    failed: 0,
    current: null,
    active: [],
    skippedDuplicates: 0,
    skippedAlreadyDone: 0,
    failedSites: [],
    successSites: [],
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });

  broadcast({ type: 'started', ...jobState });
  res.json({ ok: true, total: sites.length, status: jobState });

  runPromise = runPopupJob({
    mode,
    credentialsPath: excelPath,
    flyerPath: flyerPath || undefined,
    popupTitle: jobState.popupTitle,
    headless,
    concurrency,
    startRow,
    skipKeys,
    shouldStop: () => stopRequested,
    onProgress: (event) => {
      if (event.type === 'site_success' && mode === 'upload' && event.successSites?.length) {
        saveCompletedKeys([
          ...loadCompletedKeys(),
          ...event.successSites.map((s) => siteKey(s.url)),
        ]);
      }
      jobState.status = event.status;
      jobState.mode = event.mode || mode;
      jobState.total = event.total;
      jobState.done = event.done;
      jobState.success = event.success;
      jobState.failed = event.failed;
      jobState.current = event.current;
      jobState.active = event.active || [];
      jobState.skippedDuplicates = event.skippedDuplicates || 0;
      jobState.skippedAlreadyDone = event.skippedAlreadyDone || 0;
      jobState.skippedBeforeRow = event.skippedBeforeRow || 0;
      jobState.failedSites = event.failedSites;
      jobState.successSites = event.successSites;
      jobState.startedAt = event.startedAt;
      jobState.finishedAt = event.finishedAt;
      broadcast(event);
    },
  })
    .then((finalState) => {
      Object.assign(jobState, {
        status: finalState.status,
        mode: finalState.mode || mode,
        done: finalState.done,
        success: finalState.success,
        failed: finalState.failed,
        current: null,
        active: [],
        skippedDuplicates: finalState.skippedDuplicates || 0,
        failedSites: finalState.failedSites,
        successSites: finalState.successSites,
        finishedAt: finalState.finishedAt,
      });
      broadcast({ type: 'finished', ...jobState });
    })
    .catch((error) => {
      jobState.status = 'error';
      jobState.error = error.message;
      jobState.finishedAt = new Date().toISOString();
      broadcast({ type: 'error', ...jobState });
    })
    .finally(() => {
      runPromise = null;
    });
});

app.post('/api/stop', (_req, res) => {
  if (jobState.status !== 'running') {
    return res.status(400).json({ error: 'No run in progress' });
  }
  stopRequested = true;
  res.json({ ok: true, message: 'Stop requested — will halt after the current site' });
});

refreshReadyState();

function isPlaywrightTransportError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    (err instanceof SyntaxError && /JSON/i.test(msg)) ||
    /Unexpected end of JSON|Target closed|Browser has been closed|Connection closed/i.test(msg)
  );
}

function markJobBrowserCrash(err) {
  console.error('[browser crash]', err);
  if (jobState.status !== 'running') return;
  stopRequested = true;
  jobState.status = 'error';
  jobState.error =
    'Browser crashed mid-run. Click Start upload to resume — finished sites are skipped.';
  jobState.current = null;
  jobState.active = [];
  jobState.finishedAt = new Date().toISOString();
  broadcast({ type: 'error', ...jobState });
  runPromise = null;
}

process.on('uncaughtException', (err) => {
  if (isPlaywrightTransportError(err)) {
    markJobBrowserCrash(err);
    return;
  }
  console.error(err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  if (isPlaywrightTransportError(err)) {
    markJobBrowserCrash(err);
    return;
  }
  console.error(err);
});

app.listen(PORT, () => {
  console.log(`Popup uploader UI: http://localhost:${PORT}`);
});
