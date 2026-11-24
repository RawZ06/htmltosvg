const api = globalThis.browser ?? globalThis.chrome;

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'export') return false;
  exportTab(msg)
    .then(sendResponse)
    .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // réponse asynchrone
});

async function exportTab({ tabId, mode, embedImages }) {
  await api.scripting.executeScript({ target: { tabId }, files: ['capture.js'] });
  const [injection] = await api.scripting.executeScript({
    target: { tabId },
    func: opts => window.__htmlToDesign.capture(opts),
    args: [{ mode }],
  });
  const result = injection?.result;
  if (!result?.svg) throw new Error("Impossible de capturer cette page (page protégée ?)");

  let svg = result.svg;
  // Les images sont référencées par jeton ; on les récupère ici car le
  // script d'arrière-plan n'est pas soumis au CORS de la page.
  const dataUrls = await Promise.all(
    result.images.map(url => (embedImages ? toDataUrl(url) : Promise.resolve(null)))
  );
  result.images.forEach((url, i) => {
    svg = svg.split(`__H2D_IMG_${i}__`).join(escapeAttr(dataUrls[i] || url));
  });

  const filename = buildFilename(result.title, result.host, mode);
  await download(svg, filename);
  return { ok: true, filename, stats: result.stats };
}

async function toDataUrl(url) {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return null;
    const type = res.headers.get('content-type')?.split(';')[0] || 'image/png';
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return `data:${type};base64,${btoa(bin)}`;
  } catch {
    return null;
  }
}

async function download(text, filename) {
  const blob = new Blob([text], { type: 'image/svg+xml' });
  if (typeof URL.createObjectURL === 'function') {
    const url = URL.createObjectURL(blob);
    try {
      await api.downloads.download({ url, filename, saveAs: false });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  } else {
    // Service worker Chrome : pas de blob URL
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
    await api.downloads.download({ url, filename, saveAs: false });
  }
}

function buildFilename(title, host, mode) {
  const base = (title || host || 'page')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page';
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return `${base}-${mode}-${stamp}.svg`;
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
