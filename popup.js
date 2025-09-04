const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const quickBtn = document.getElementById('quick');
const reportBtn = document.getElementById('report');
const copyBtn = document.getElementById('copy');
const output = document.getElementById('output');

function setBusy(on) {
  [startBtn, stopBtn, quickBtn, reportBtn, copyBtn].forEach(b => b.disabled = !!on && b !== copyBtn);
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1000);
  });
}

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

startBtn.addEventListener('click', async () => {
  setBusy(true);
  const res = await send({ type: 'POPUP_START' });
  output.value = res?.ok ? 'Monitoring started.' : `Failed to start: ${res?.error || 'unknown'}`;
  setBusy(false);
});

stopBtn.addEventListener('click', async () => {
  setBusy(true);
  const res = await send({ type: 'POPUP_STOP' });
  output.value = res?.ok ? 'Monitoring stopped.' : `Failed to stop: ${res?.error || 'unknown'}`;
  setBusy(false);
});

quickBtn.addEventListener('click', async () => {
  setBusy(true);
  output.value = 'Profiling for ~10s...';
  const res = await send({ type: 'POPUP_QUICK_PROFILE', durationMs: 10000 });
  if (res?.ok) {
    output.value = res.report || 'No report generated';
  } else {
    output.value = `Failed: ${res?.error || 'unknown'}`;
  }
  setBusy(false);
});

reportBtn.addEventListener('click', async () => {
  setBusy(true);
  const res = await send({ type: 'POPUP_BUILD_REPORT' });
  output.value = res?.report || 'No report available. Try Start/Stop or Quick Profile.';
  setBusy(false);
});

copyBtn.addEventListener('click', () => {
  if (output.value) copyToClipboard(output.value);
});

