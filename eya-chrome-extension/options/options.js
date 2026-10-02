const EXPLAIN = {
  connected: ['connected', 'Eya can see and use this browser.'],
  connecting: ['waiting', 'Looking for Eya on this PC… make sure the Eya app is running.'],
  disconnected: ['off', 'Eya is not reachable right now. Start the Eya app and this will reconnect on its own. (Keep Developer mode on in the extensions page, or the browser turns this extension off when it restarts.)'],
  waiting_for_pairing: ['waiting', 'Eya is running but has not been told to connect to this browser. Say "connect Chrome" to Eya (or ask her to connect my browser), then this will turn green.'],
};

function render(info) {
  const pill = document.getElementById('pill');
  const known = EXPLAIN[info.status];
  const [cls, text] = known ?? ['off', info.status.startsWith('refused') ? `Eya refused the connection (${info.status.split(':')[1]}).` : info.status];
  pill.className = `pill ${cls}`;
  pill.textContent = info.status === 'connected' ? 'Connected' : info.status === 'waiting_for_pairing' ? 'Waiting to be paired' : cls === 'waiting' ? 'Connecting' : 'Not connected';
  document.getElementById('explain').textContent = text;
  document.getElementById('browser').textContent = info.browser ?? '—';
  document.getElementById('version').textContent = info.version ?? '—';
  document.getElementById('extid').textContent = info.extensionId ?? '—';
}

async function refresh() {
  try {
    render(await chrome.runtime.sendMessage({ t: 'status' }));
  } catch {
    render({ status: 'disconnected' });
  }
}

document.getElementById('forget').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ t: 'forget_pairing' });
  await refresh();
});

await refresh();
setInterval(refresh, 2000);
