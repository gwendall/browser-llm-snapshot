const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const quickBtn = document.getElementById('quick');
const deepBtn = document.getElementById('deep');
const refreshBtn = document.getElementById('refresh');
const copyBtn = document.getElementById('copy');
const statusEl = document.getElementById('status');
const reportEl = document.getElementById('report');

function setBusy(msg) {
  statusEl.textContent = msg || '';
  const busy = !!msg;
  [startBtn, stopBtn, quickBtn, refreshBtn].forEach(b => b.disabled = busy);
}

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function buildReport() {
  const res = await send({ type: 'POPUP_BUILD_REPORT' });
  reportEl.value = res?.report || 'No report available. Try Start/Stop or Quick 10s.';
}

startBtn.addEventListener('click', async () => {
  setBusy('Starting...');
  await send({ type: 'POPUP_START' });
  setBusy('');
});

stopBtn.addEventListener('click', async () => {
  setBusy('Stopping...');
  await send({ type: 'POPUP_STOP' });
  await buildReport();
  setBusy('');
});

quickBtn.addEventListener('click', async () => {
  setBusy('Profiling ~10s...');
  const res = await send({ type: 'POPUP_QUICK_PROFILE', durationMs: 10000 });
  reportEl.value = res?.ok ? (res.report || 'No report') : (res?.error || 'Failed');
  setBusy('');
});

deepBtn.addEventListener('click', async () => {
  setBusy('Deep snapshot in progress... (can take a while)');
  const res = await send({ type: 'POPUP_DEEP_SNAPSHOT' });
  reportEl.value = res?.ok ? (res.report || 'No report') : (res?.error || 'Failed');
  setBusy('');
});

refreshBtn.addEventListener('click', async () => {
  setBusy('Refreshing...');
  await buildReport();
  setBusy('');
});

copyBtn.addEventListener('click', () => {
  if (reportEl.value) navigator.clipboard.writeText(reportEl.value);
});

// Auto-refresh on open
buildReport();
