const api = globalThis.browser ?? globalThis.chrome;
const status = document.getElementById('status');
const buttons = [...document.querySelectorAll('button')];

async function run(mode) {
  buttons.forEach(b => (b.disabled = true));
  status.className = '';
  status.textContent = 'Capture en cours…';
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const res = await api.runtime.sendMessage({
      type: 'export',
      tabId: tab.id,
      mode,
      embedImages: document.getElementById('embed').checked,
    });
    if (!res?.ok) throw new Error(res?.error || 'Échec inconnu');
    status.textContent = `✓ ${res.filename} (${res.stats.nodes} calques)`;
  } catch (e) {
    status.className = 'error';
    status.textContent = e.message;
  } finally {
    buttons.forEach(b => (b.disabled = false));
  }
}

document.getElementById('viewport').onclick = () => run('viewport');
document.getElementById('full').onclick = () => run('full');
