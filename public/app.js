const flyerInput = document.getElementById('flyerInput');
const excelInput = document.getElementById('excelInput');
const flyerDrop = document.getElementById('flyerDrop');
const excelDrop = document.getElementById('excelDrop');
const flyerLabel = document.getElementById('flyerLabel');
const excelLabel = document.getElementById('excelLabel');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const readyLine = document.getElementById('readyLine');
const popupTitle = document.getElementById('popupTitle');
const titleField = document.getElementById('titleField');
const startRowInput = document.getElementById('startRow');
const concurrencyInput = document.getElementById('concurrency');
const showBrowsers = document.getElementById('showBrowsers');
const statusPill = document.getElementById('statusPill');
const meter = document.getElementById('meter');
const meterFill = document.getElementById('meterFill');
const statTotal = document.getElementById('statTotal');
const statDone = document.getElementById('statDone');
const statSuccess = document.getElementById('statSuccess');
const statFailed = document.getElementById('statFailed');
const statSuccessLabel = document.getElementById('statSuccessLabel');
const statFailedLabel = document.getElementById('statFailedLabel');
const currentLine = document.getElementById('currentLine');
const failList = document.getElementById('failList');
const failCount = document.getElementById('failCount');
const failHeading = document.getElementById('failHeading');
const okList = document.getElementById('okList');
const okCount = document.getElementById('okCount');
const okHeading = document.getElementById('okHeading');
const toast = document.getElementById('toast');
const ledeText = document.getElementById('ledeText');
const modeHint = document.getElementById('modeHint');
const modeUpload = document.getElementById('modeUpload');
const modeDisable = document.getElementById('modeDisable');
const modeTest = document.getElementById('modeTest');

let currentMode = 'upload';

function showToast(message) {
  toast.hidden = false;
  toast.textContent = message;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

function bindDrop(zone, input) {
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  });
}

bindDrop(flyerDrop, flyerInput);
bindDrop(excelDrop, excelInput);

async function uploadFile(url, field, file) {
  const body = new FormData();
  body.append(field, file);
  const res = await fetch(url, { method: 'POST', body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

flyerInput.addEventListener('change', async () => {
  const file = flyerInput.files?.[0];
  if (!file) return;
  try {
    flyerLabel.textContent = 'Uploading…';
    const data = await uploadFile('/api/upload/flyer', 'flyer', file);
    flyerLabel.textContent = file.name;
    flyerDrop.classList.add('ready');
    applyStatus(data.status);
    showToast('Flyer uploaded');
  } catch (err) {
    flyerLabel.textContent = 'Drop flyer or browse';
    showToast(err.message);
  }
});

excelInput.addEventListener('change', async () => {
  const file = excelInput.files?.[0];
  if (!file) return;
  try {
    excelLabel.textContent = 'Uploading…';
    const data = await uploadFile('/api/upload/credentials', 'credentials', file);
    excelLabel.textContent = `${file.name} · ${data.siteCount} sites`;
    excelDrop.classList.add('ready');
    applyStatus(data.status);
    showToast(`Credentials loaded (${data.siteCount} websites)`);
  } catch (err) {
    excelLabel.textContent = 'Drop Excel or browse';
    showToast(err.message);
  }
});

function applyModeUi(mode) {
  currentMode = mode === 'disable' ? 'disable' : mode === 'test' ? 'test' : 'upload';
  modeUpload.classList.toggle('active', currentMode === 'upload');
  modeDisable.classList.toggle('active', currentMode === 'disable');
  modeTest.classList.toggle('active', currentMode === 'test');
  document.body.dataset.mode = currentMode;

  if (currentMode === 'disable') {
    ledeText.textContent =
      'Upload the credentials sheet, then delete the flyer popup on each site.';
    modeHint.textContent =
      'Logs in, opens Popup Builder → All Popups, and moves the first popup (flyer) to the Trash using the Remove icon.';
    startBtn.textContent = 'Start delete';
    titleField.hidden = true;
    flyerDrop.classList.add('optional');
    statSuccessLabel.textContent = 'Deleted';
    statFailedLabel.textContent = 'Not deleted';
    okHeading.textContent = 'Deleted websites';
    failHeading.textContent = 'Not deleted websites';
  } else if (currentMode === 'test') {
    ledeText.textContent =
      'Upload the credentials sheet, then check each public website for the flyer popup.';
    modeHint.textContent =
      'Takes only the domain from each Admin URL (e.g. https://duchesspleasanton.com/mary/ → https://duchesspleasanton.com), opens the homepage, and checks whether the flyer popup is present.';
    startBtn.textContent = 'Start test';
    titleField.hidden = true;
    flyerDrop.classList.add('optional');
    statSuccessLabel.textContent = 'Enabled';
    statFailedLabel.textContent = 'Not enabled';
    okHeading.textContent = 'Flyer enabled';
    failHeading.textContent = 'Flyer not found';
  } else {
    ledeText.textContent =
      'Upload a flyer and credentials sheet, then push the image popup to every site in one pass.';
    modeHint.textContent = 'Creates a new image popup on each site from the credentials sheet.';
    startBtn.textContent = 'Start upload';
    titleField.hidden = false;
    flyerDrop.classList.remove('optional');
    statSuccessLabel.textContent = 'Uploaded';
    statFailedLabel.textContent = 'Not uploaded';
    okHeading.textContent = 'Uploaded websites';
    failHeading.textContent = 'Not uploaded websites';
  }
}

async function setMode(mode) {
  applyModeUi(mode);
  try {
    const res = await fetch('/api/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not set mode');
    applyStatus(data.status);
  } catch (err) {
    showToast(err.message);
  }
}

modeUpload.addEventListener('click', () => setMode('upload'));
modeDisable.addEventListener('click', () => setMode('disable'));
modeTest.addEventListener('click', () => setMode('test'));

function applyStatus(state) {
  if (!state) return;

  if (state.mode) applyModeUi(state.mode);

  const total = state.total || state.siteCount || 0;
  const done = state.done || 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const isDisable = currentMode === 'disable';
  const isTest = currentMode === 'test';
  const excelOnly = isDisable || isTest;

  statusPill.textContent = state.status || 'idle';
  statusPill.className = `status-pill ${state.status || 'idle'}`;

  meter.setAttribute('aria-valuenow', String(pct));
  meterFill.style.width = `${pct}%`;

  statTotal.textContent = String(total);
  statDone.textContent = String(done);
  statSuccess.textContent = String(state.success || 0);
  statFailed.textContent = String(state.failed || 0);

  const okWord = isDisable ? 'deleted' : isTest ? 'enabled' : 'uploaded';
  const badWord = isDisable ? 'not deleted' : isTest ? 'not enabled' : 'not uploaded';

  const succeeded = state.successSites || [];
  const failed = state.failedSites || [];
  okCount.textContent = String(succeeded.length);
  failCount.textContent = String(failed.length);

  const activeSites =
    state.active && state.active.length
      ? state.active
      : state.current
        ? [state.current]
        : [];

  if (state.status === 'running' && activeSites.length) {
    currentLine.textContent =
      `Working on ${activeSites.length} site(s): ` +
      activeSites
        .map((s) => `row ${s.row} · ${s.name}${s.retrying ? ' (retry)' : ''}`)
        .join('  |  ');
  } else if (state.status === 'completed') {
    const notes = [];
    if (state.skippedBeforeRow) notes.push(`${state.skippedBeforeRow} row(s) before start row skipped`);
    if (state.skippedDuplicates) notes.push(`${state.skippedDuplicates} duplicate row(s) skipped`);
    if (state.skippedAlreadyDone) notes.push(`${state.skippedAlreadyDone} already-uploaded site(s) skipped`);
    const noteText = notes.length ? ` (${notes.join(', ')})` : '';
    currentLine.textContent = `Finished — ${state.success} ${okWord}, ${state.failed} ${badWord}.${noteText}`;
  } else if (state.status === 'stopped') {
    currentLine.textContent = `Stopped — ${done} of ${total} processed.`;
  } else if (state.status === 'error') {
    currentLine.textContent = state.error || 'Run failed.';
  } else if (state.status === 'ready') {
    currentLine.textContent = isDisable
      ? `Ready to delete flyer popups on ${state.siteCount} website(s).`
      : isTest
        ? `Ready to test flyer popups on ${state.siteCount} website(s).`
        : `Ready to upload to ${state.siteCount} website(s).`;
  } else {
    currentLine.textContent = 'Waiting to start…';
  }

  if (succeeded.length === 0) {
    okList.innerHTML = `<p class="empty">${
      isDisable ? 'Deleted' : isTest ? 'Enabled' : 'Uploaded'
    } sites will appear here.</p>`;
  } else {
    okList.innerHTML = succeeded
      .map(
        (site) => `
      <article class="ok-item">
        <strong>Row ${site.row} · ${escapeHtml(site.name)}</strong>
        <span>${escapeHtml(site.publicUrl || site.url)}</span>
        <code>${
          isTest
            ? 'Flyer enabled'
            : isDisable
              ? site.deletedCount === 0
                ? 'Already empty — nothing to delete'
                : 'Deleted'
            : site.retried
              ? 'Uploaded (retried once)'
              : 'Uploaded'
        }</code>
      </article>`
      )
      .join('');
  }

  if (failed.length === 0) {
    failList.innerHTML = `<p class="empty">${
      isTest ? 'Sites without a flyer' : 'Failed sites'
    } will appear here.</p>`;
  } else {
    failList.innerHTML = failed
      .map(
        (site) => `
      <article class="fail-item">
        <strong>Row ${site.row} · ${escapeHtml(site.name)}</strong>
        <span>${escapeHtml(site.publicUrl || site.url)}</span>
        <code>${escapeHtml(
          site.error ||
            (isTest ? 'Flyer not found' : isDisable ? 'Delete failed' : 'Upload failed')
        )}</code>
      </article>`
      )
      .join('');
  }

  const canStart =
    state.status === 'ready' ||
    state.status === 'completed' ||
    state.status === 'stopped' ||
    state.status === 'error';
  const hasExcel = Boolean(state.excelName && (state.siteCount || state.total));
  const hasFlyer = Boolean(state.flyerName);
  const hasFiles = excelOnly ? hasExcel : hasExcel && hasFlyer;

  startBtn.disabled = !(canStart && hasFiles) || state.status === 'running';
  stopBtn.disabled = state.status !== 'running';

  if (!hasFiles) {
    readyLine.textContent = excelOnly
      ? 'Upload the credentials Excel sheet to unlock Start.'
      : 'Upload both files to unlock Start.';
  } else if (state.status === 'running') {
    readyLine.textContent = isDisable
      ? 'Delete in progress…'
      : isTest
        ? 'Test in progress…'
        : 'Upload in progress…';
  } else if (isDisable) {
    readyLine.textContent = `Ready to delete · ${state.siteCount || state.total} websites`;
  } else if (isTest) {
    readyLine.textContent = `Ready to test · ${state.siteCount || state.total} websites`;
  } else {
    readyLine.textContent = `Ready · ${state.siteCount || state.total} websites · flyer: ${state.flyerName}`;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

startBtn.addEventListener('click', async () => {
  try {
    startBtn.disabled = true;
    const res = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: currentMode,
        popupTitle: popupTitle.value.trim() || 'Weekend Special',
        startRow: Number(startRowInput.value) || 1,
        concurrency: Number(concurrencyInput.value) || 8,
        showBrowsers: Boolean(showBrowsers.checked),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not start');
    applyStatus(data.status);
    showToast(
      currentMode === 'disable'
        ? `Delete started — ${data.total} websites`
        : currentMode === 'test'
          ? `Flyer test started — ${data.total} websites`
          : `Upload started — ${data.total} websites`
    );
  } catch (err) {
    showToast(err.message);
    startBtn.disabled = false;
  }
});

stopBtn.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/stop', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not stop');
    showToast(data.message || 'Stop requested');
  } catch (err) {
    showToast(err.message);
  }
});

async function loadInitial() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    applyStatus(data);
    if (data.flyerName) {
      flyerLabel.textContent = data.flyerName;
      flyerDrop.classList.add('ready');
    }
    if (data.excelName) {
      excelLabel.textContent = `${data.excelName} · ${data.siteCount} sites`;
      excelDrop.classList.add('ready');
    }
  } catch {
    // ignore
  }
}

function connectEvents() {
  const source = new EventSource('/api/events');
  source.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      applyStatus(data);
    } catch {
      // ignore bad payloads
    }
  };
  source.onerror = () => {
    // browser will auto-reconnect
  };
}

applyModeUi('upload');
loadInitial();
connectEvents();
