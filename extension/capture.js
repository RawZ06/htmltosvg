/*
 * HTML → SVG « calqué »
 *
 * Parcourt le DOM tel qu'il est rendu (positions via getBoundingClientRect,
 * styles via getComputedStyle) et produit un SVG statique où :
 *  - chaque élément visible devient un groupe <g id="tag-nom">,
 *  - fonds, bordures, ombres, dégradés deviennent des formes vectorielles,
 *  - le texte reste du vrai texte (<text>), une ligne par <tspan>,
 *  - les images sont des <image> (intégrées en data URL par le background).
 *
 * MVP : pas d'auto-layout, pas de transforms, pas de pseudo-éléments.
 */
(() => {
  if (window.__htmlToDesign) return;

  const XLINK = 'http://www.w3.org/1999/xlink';
  const SKIP_TAGS = new Set(['head', 'script', 'style', 'link', 'meta', 'title', 'noscript', 'template', 'source', 'track', 'base', 'datalist', 'param']);
  const LEAF_TAGS = new Set(['img', 'svg', 'canvas', 'video', 'iframe', 'input', 'textarea', 'select', 'object', 'embed', 'audio', 'meter', 'progress']);
  const SVG_SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'use']);

  let S; // état de la capture en cours

  // ───────────────────────── utilitaires ─────────────────────────

  const n = v => Math.round(v * 100) / 100;
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function splitTop(str, sep = ',') {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of str) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === sep && depth === 0) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function uid(prefix) { return `h2d-${prefix}${++S.defId}`; }

  function layerId(el) {
    const tag = el.localName;
    let name = el.id || el.getAttribute('aria-label') || (el.classList && el.classList[0]) || '';
    let base = (name ? `${tag}-${name}` : tag).replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(0, 48);
    if (!/^[A-Za-z_]/.test(base)) base = 'l-' + base;
    const count = (S.ids.get(base) || 0) + 1;
    S.ids.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  }

  function intersects(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function intersect(a, b) {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
  }

  function toBox(r) {
    return { x: r.left + S.scrollX - S.area.x, y: r.top + S.scrollY - S.area.y, w: r.width, h: r.height };
  }

  // ───────────────────────── couleurs ─────────────────────────

  const colorCache = new Map();
  let colorCtx;

  /** Retourne { hex, a } ou null si transparent. Gère oklch/lab/etc. via un canvas. */
  function parseColor(str) {
    if (!str || str === 'transparent' || str === 'none') return null;
    if (colorCache.has(str)) return colorCache.get(str);
    let r, g, b, a = 1;
    const m = str.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/);
    if (m) {
      [r, g, b] = [m[1], m[2], m[3]].map(Number);
      if (m[4] !== undefined) a = m[5] ? Number(m[4]) / 100 : Number(m[4]);
    } else {
      if (!colorCtx) {
        const c = document.createElement('canvas');
        c.width = c.height = 1;
        colorCtx = c.getContext('2d', { willReadFrequently: true });
      }
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillStyle = '#000';
      colorCtx.fillStyle = str;
      colorCtx.fillRect(0, 0, 1, 1);
      const d = colorCtx.getImageData(0, 0, 1, 1).data;
      [r, g, b, a] = [d[0], d[1], d[2], d[3] / 255];
    }
    const hex = '#' + [r, g, b].map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
    const res = a > 0.001 ? { hex, a: Math.round(a * 1000) / 1000 } : null;
    colorCache.set(str, res);
    return res;
  }

  const fillAttr = (c, k = 'fill') => `${k}="${c.hex}"${c.a < 1 ? ` ${k}-opacity="${c.a}"` : ''}`;

  // ───────────────────────── formes ─────────────────────────

  function radii(cs, b) {
    const raw = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius']
      .map(p => {
        const v = cs.getPropertyValue(p).split(' ')[0];
        return v.endsWith('%') ? (parseFloat(v) / 100) * Math.min(b.w, b.h) : parseFloat(v) || 0;
      });
    // règle CSS : on réduit proportionnellement si les rayons se chevauchent
    const [tl, tr, br, bl] = raw;
    const f = Math.min(1,
      b.w / (tl + tr || 1), b.w / (bl + br || 1),
      b.h / (tl + bl || 1), b.h / (tr + br || 1));
    return raw.map(r => Math.max(0, r * f));
  }

  function shapeEl(b, rad, attrs) {
    const [tl, tr, br, bl] = rad;
    if (tl === tr && tr === br && br === bl) {
      return `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}"${tl ? ` rx="${n(tl)}"` : ''} ${attrs}/>`;
    }
    const { x, y, w, h } = b;
    const d = `M${n(x + tl)} ${n(y)}H${n(x + w - tr)}A${n(tr)} ${n(tr)} 0 0 1 ${n(x + w)} ${n(y + tr)}` +
      `V${n(y + h - br)}A${n(br)} ${n(br)} 0 0 1 ${n(x + w - br)} ${n(y + h)}` +
      `H${n(x + bl)}A${n(bl)} ${n(bl)} 0 0 1 ${n(x)} ${n(y + h - bl)}` +
      `V${n(y + tl)}A${n(tl)} ${n(tl)} 0 0 1 ${n(x + tl)} ${n(y)}Z`;
    return `<path d="${d}" ${attrs}/>`;
  }

  function defineClip(b, rad) {
    const id = uid('clip');
    S.defs.push(`<clipPath id="${id}">${shapeEl(b, rad, '')}</clipPath>`);
    return id;
  }

  function borderWidths(cs) {
    return ['top', 'right', 'bottom', 'left'].map(s => parseFloat(cs.getPropertyValue(`border-${s}-width`)) || 0);
  }

  function contentBox(cs, b) {
    const [bt, br, bb, bl] = borderWidths(cs);
    const [pt, pr, pb, pl] = ['top', 'right', 'bottom', 'left'].map(s => parseFloat(cs.getPropertyValue(`padding-${s}`)) || 0);
    return { x: b.x + bl + pl, y: b.y + bt + pt, w: Math.max(0, b.w - bl - br - pl - pr), h: Math.max(0, b.h - bt - bb - pt - pb) };
  }

  // ───────────────────────── ombres ─────────────────────────

  function parseShadows(v) {
    if (!v || v === 'none') return [];
    return splitTop(v).map(s => {
      const inset = /\binset\b/.test(s);
      const cm = s.match(/(?:rgba?|hsla?|color|oklch|oklab|lab|lch)\([^)]*\)|#[\da-f]{3,8}/i);
      const color = parseColor(cm ? cm[0] : 'black');
      const nums = (cm ? s.replace(cm[0], '') : s).match(/-?[\d.]+(?=px)/g)?.map(Number) || [];
      return { inset, color, x: nums[0] || 0, y: nums[1] || 0, blur: nums[2] || 0 };
    }).filter(s => !s.inset && s.color);
  }

  function defineShadow(shadows) {
    const id = uid('shadow');
    let body = '', merge = '';
    shadows.slice().reverse().forEach((s, i) => {
      const { hex, a } = s.color;
      const [r, g, b] = [1, 3, 5].map(k => n(parseInt(hex.slice(k, k + 2), 16) / 255));
      body += `<feOffset in="SourceAlpha" dx="${n(s.x)}" dy="${n(s.y)}" result="o${i}"/>` +
        `<feGaussianBlur in="o${i}" stdDeviation="${n(s.blur / 2)}" result="b${i}"/>` +
        `<feColorMatrix in="b${i}" type="matrix" values="0 0 0 0 ${r} 0 0 0 0 ${g} 0 0 0 0 ${b} 0 0 0 ${a} 0" result="s${i}"/>`;
      merge += `<feMergeNode in="s${i}"/>`;
    });
    S.defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">${body}<feMerge>${merge}<feMergeNode in="SourceGraphic"/></feMerge></filter>`);
    return id;
  }

  // ───────────────────────── dégradés ─────────────────────────

  function parseStops(parts, length) {
    const stops = [];
    for (const p of parts) {
      const m = p.match(/^((?:[a-z-]+\((?:[^()]|\([^()]*\))*\))|#[\da-f]+|[a-z]+)\s*(.*)$/i);
      if (!m) continue;
      const color = parseColor(m[1]) || { hex: '#000000', a: 0 };
      const positions = m[2].split(/\s+/).filter(Boolean).map(t =>
        t.endsWith('%') ? parseFloat(t) / 100 : t.endsWith('px') ? parseFloat(t) / (length || 1) : null);
      if (!positions.length) stops.push({ color, pos: null });
      else positions.forEach(pos => stops.push({ color, pos }));
    }
    if (!stops.length) return stops;
    if (stops[0].pos == null) stops[0].pos = 0;
    if (stops[stops.length - 1].pos == null) stops[stops.length - 1].pos = 1;
    for (let i = 1; i < stops.length; i++) {
      if (stops[i].pos == null) {
        let j = i;
        while (stops[j].pos == null) j++;
        const start = stops[i - 1].pos, step = (stops[j].pos - start) / (j - i + 1);
        for (let k = i; k < j; k++) stops[k].pos = start + step * (k - i + 1);
      }
      stops[i].pos = Math.max(stops[i].pos, stops[i - 1].pos);
    }
    return stops;
  }

  const stopsSvg = stops => stops.map(s =>
    `<stop offset="${n(s.pos)}" stop-color="${s.color.hex}"${s.color.a < 1 ? ` stop-opacity="${s.color.a}"` : ''}/>`).join('');

  function defineLinear(args, b) {
    const parts = splitTop(args);
    let ux = 0, uy = 1; // 180deg par défaut (vers le bas)
    const head = parts[0].replace(/\bin\s+[\w-]+(\s+\w+\s+hue)?/, '').trim();
    if (/^(to\s|-?[\d.]+(deg|rad|turn|grad)|in\s)/.test(parts[0])) {
      parts.shift();
      const ang = head.match(/^(-?[\d.]+)(deg|rad|turn|grad)$/);
      if (ang) {
        const v = parseFloat(ang[1]);
        const rad = { deg: v * Math.PI / 180, rad: v, turn: v * 2 * Math.PI, grad: v * Math.PI / 200 }[ang[2]];
        ux = Math.sin(rad); uy = -Math.cos(rad);
      } else if (head.startsWith('to ')) {
        const sx = /right/.test(head) ? 1 : /left/.test(head) ? -1 : 0;
        const sy = /bottom/.test(head) ? 1 : /top/.test(head) ? -1 : 0;
        if (sx && sy) { ux = sx * b.h; uy = sy * b.w; } else { ux = sx; uy = sy; }
        const len = Math.hypot(ux, uy) || 1;
        ux /= len; uy /= len;
      }
    }
    const L = Math.abs(b.w * ux) + Math.abs(b.h * uy);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const stops = parseStops(parts, L);
    if (!stops.length) return null;
    const id = uid('lg');
    S.defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(cx - ux * L / 2)}" y1="${n(cy - uy * L / 2)}" x2="${n(cx + ux * L / 2)}" y2="${n(cy + uy * L / 2)}">${stopsSvg(stops)}</linearGradient>`);
    return id;
  }

  function defineRadial(args, b) {
    const parts = splitTop(args);
    let px = 0.5, py = 0.5, circle = false;
    if (/^(circle|ellipse|closest|farthest|at\s|[\d.]+(px|%)|in\s)/.test(parts[0])) {
      const head = parts.shift();
      circle = /circle/.test(head);
      const at = head.match(/at\s+([\d.]+)%\s+([\d.]+)%/);
      if (at) { px = parseFloat(at[1]) / 100; py = parseFloat(at[2]) / 100; }
    }
    const cx = b.x + b.w * px, cy = b.y + b.h * py;
    const dx = Math.max(cx - b.x, b.x + b.w - cx), dy = Math.max(cy - b.y, b.y + b.h - cy);
    const rx = circle ? Math.hypot(dx, dy) : dx * Math.SQRT2;
    const ry = circle ? rx : dy * Math.SQRT2;
    const stops = parseStops(parts, rx);
    if (!stops.length || !rx) return null;
    const id = uid('rg');
    const tf = ry !== rx ? ` gradientTransform="translate(${n(cx)} ${n(cy)}) scale(1 ${n(ry / rx)}) translate(${n(-cx)} ${n(-cy)})"` : '';
    S.defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${n(cx)}" cy="${n(cy)}" r="${n(rx)}"${tf}>${stopsSvg(stops)}</radialGradient>`);
    return id;
  }

  // ───────────────────────── images ─────────────────────────

  /** Renvoie la valeur à mettre dans xlink:href (data URL, ou jeton remplacé par le background). */
  function imageHref(url, imgEl) {
    if (!url) return null;
    if (url.startsWith('data:')) return esc(url);
    if (url.startsWith('blob:') && imgEl) {
      try {
        const c = document.createElement('canvas');
        c.width = imgEl.naturalWidth; c.height = imgEl.naturalHeight;
        c.getContext('2d').drawImage(imgEl, 0, 0);
        return c.toDataURL('image/png');
      } catch { /* on tente quand même via le background */ }
    }
    const abs = new URL(url, location.href).href;
    if (!S.imageIndex.has(abs)) {
      S.imageIndex.set(abs, S.images.length);
      S.images.push(abs);
    }
    S.stats.images++;
    return `__H2D_IMG_${S.imageIndex.get(abs)}__`;
  }

  /** Les fonds en url() ont besoin de la taille naturelle de l'image : on pose un marqueur et on résout après. */
  function backgroundImageJob(url, cs, layerIdx, b, rad) {
    const key = S.bgJobs.length;
    const pick = prop => splitTop(cs.getPropertyValue(prop))[layerIdx] ?? splitTop(cs.getPropertyValue(prop))[0];
    S.bgJobs.push({
      url, b, rad,
      origin: contentBox({ getPropertyValue: p => p.startsWith('padding') ? '0' : cs.getPropertyValue(p) }, b),
      size: pick('background-size'), position: pick('background-position'), repeat: pick('background-repeat'),
    });
    return `<!--H2DBG${key}-->`;
  }

  async function resolveBackgroundJobs(svg) {
    const sizes = await Promise.all(S.bgJobs.map(job => new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
      img.onerror = () => resolve(null);
      img.src = job.url;
    })));
    return svg.replace(/<!--H2DBG(\d+)-->/g, (_, k) => {
      const job = S.bgJobs[k], nat = sizes[k];
      if (!nat || !nat[0]) return '';
      const area = job.origin;
      const [iw, ih] = nat;
      let tw, th;
      if (job.size === 'cover' || job.size === 'contain') {
        const s = (job.size === 'cover' ? Math.max : Math.min)(area.w / iw, area.h / ih);
        tw = iw * s; th = ih * s;
      } else {
        const [sw = 'auto', sh = 'auto'] = job.size.split(/\s+/);
        const len = (v, ref) => v === 'auto' ? null : v.endsWith('%') ? parseFloat(v) / 100 * ref : parseFloat(v);
        tw = len(sw, area.w); th = len(sh, area.h);
        if (tw == null && th == null) { tw = iw; th = ih; }
        else if (tw == null) tw = th * iw / ih;
        else if (th == null) th = tw * ih / iw;
      }
      const [pxv = '0%', pyv = '0%'] = job.position.split(/\s+/);
      const pos = (v, free) => v.endsWith('%') ? parseFloat(v) / 100 * free : parseFloat(v) || 0;
      const x = area.x + pos(pxv, area.w - tw), y = area.y + pos(pyv, area.h - th);
      const href = imageHref(job.url);
      if (job.repeat !== 'no-repeat' && (tw < area.w - 0.5 || th < area.h - 0.5)) {
        const pid = uid('pat');
        S.defs.push(`<pattern id="${pid}" patternUnits="userSpaceOnUse" x="${n(x)}" y="${n(y)}" width="${n(tw)}" height="${n(th)}"><image width="${n(tw)}" height="${n(th)}" preserveAspectRatio="none" xlink:href="${href}"/></pattern>`);
        return shapeEl(job.b, job.rad, `fill="url(#${pid})"`);
      }
      const clip = defineClip(job.b, job.rad);
      return `<g clip-path="url(#${clip})"><image x="${n(x)}" y="${n(y)}" width="${n(tw)}" height="${n(th)}" preserveAspectRatio="none" xlink:href="${href}"/></g>`;
    });
  }

  // ───────────────────────── boîte : fond, ombre, bordure ─────────────────────────

  function renderBox(el, cs, b) {
    const out = [];
    const rad = radii(cs, b);
    const bg = el === S.bgSource || el === document.documentElement ? null : parseColor(cs.backgroundColor);
    const shadows = parseShadows(cs.boxShadow);
    if (bg) {
      const filter = shadows.length ? ` filter="url(#${defineShadow(shadows)})"` : '';
      out.push(shapeEl(b, rad, fillAttr(bg) + filter));
    }

    const bgImage = cs.backgroundImage;
    if (bgImage && bgImage !== 'none') {
      const layers = splitTop(bgImage);
      for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        const fn = layer.match(/^([\w-]+)\((.*)\)$/s);
        if (!fn) continue;
        if (fn[1] === 'url') {
          const url = fn[2].trim().replace(/^["']|["']$/g, '');
          out.push(backgroundImageJob(url, cs, i, b, rad));
        } else if (fn[1] === 'linear-gradient') {
          const id = defineLinear(fn[2], b);
          if (id) out.push(shapeEl(b, rad, `fill="url(#${id})"`));
        } else if (fn[1] === 'radial-gradient') {
          const id = defineRadial(fn[2], b);
          if (id) out.push(shapeEl(b, rad, `fill="url(#${id})"`));
        }
      }
    }

    out.push(renderBorders(cs, b, rad));
    return out.join('');
  }

  function renderBorders(cs, b, rad) {
    const widths = borderWidths(cs);
    const sides = ['top', 'right', 'bottom', 'left'].map((s, i) => ({
      w: widths[i],
      style: cs.getPropertyValue(`border-${s}-style`),
      color: parseColor(cs.getPropertyValue(`border-${s}-color`)),
    }));
    const visible = s => s.w > 0 && s.color && s.style !== 'none' && s.style !== 'hidden';
    if (!sides.some(visible)) return '';
    const [t, r, bo, l] = sides;
    const same = sides.every(s => visible(s) && s.w === t.w && s.style === t.style && s.color.hex === t.color.hex && s.color.a === t.color.a);
    if (same) {
      const w = t.w;
      const inner = { x: b.x + w / 2, y: b.y + w / 2, w: Math.max(0, b.w - w), h: Math.max(0, b.h - w) };
      const dash = t.style === 'dashed' ? ` stroke-dasharray="${n(w * 3)} ${n(w * 2)}"` : t.style === 'dotted' ? ` stroke-dasharray="${n(w)} ${n(w)}"` : '';
      return shapeEl(inner, rad.map(v => Math.max(0, v - w / 2)), `fill="none" ${fillAttr(t.color, 'stroke')} stroke-width="${n(w)}"${dash}`);
    }
    const rects = [
      [t, b.x, b.y, b.w, t.w],
      [r, b.x + b.w - r.w, b.y, r.w, b.h],
      [bo, b.x, b.y + b.h - bo.w, b.w, bo.w],
      [l, b.x, b.y, l.w, b.h],
    ];
    return rects.filter(([s]) => visible(s))
      .map(([s, x, y, w, h]) => `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" ${fillAttr(s.color)}/>`).join('');
  }

  // ───────────────────────── texte ─────────────────────────

  const metricsCache = new Map();
  let measureCtx;

  function fontMetrics(cs) {
    const key = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    if (metricsCache.has(key)) return metricsCache.get(key);
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = key;
    const m = measureCtx.measureText('Hg');
    const size = parseFloat(cs.fontSize);
    const res = { asc: m.fontBoundingBoxAscent ?? size * 0.8, desc: m.fontBoundingBoxDescent ?? size * 0.2 };
    metricsCache.set(key, res);
    return res;
  }

  const SYSTEM_FONTS = new Set(['system-ui', '-apple-system', 'blinkmacsystemfont', 'ui-sans-serif', 'ui-rounded']);
  const isMac = /Mac/.test(navigator.platform);
  const isWin = /Win/.test(navigator.platform);

  function pickFamily(list) {
    const first = splitTop(list)[0]?.replace(/^["']|["']$/g, '') || 'sans-serif';
    const low = first.toLowerCase();
    if (SYSTEM_FONTS.has(low)) return isMac ? 'SF Pro Text' : isWin ? 'Segoe UI' : 'Roboto';
    if (low === 'sans-serif') return isMac ? 'Helvetica' : 'Arial';
    if (low === 'serif' || low === 'ui-serif') return 'Times New Roman';
    if (low === 'monospace' || low === 'ui-monospace') return isMac ? 'Menlo' : isWin ? 'Consolas' : 'DejaVu Sans Mono';
    return first;
  }

  function decorationOf(el) {
    // text-decoration ne s'hérite pas mais se propage depuis les ancêtres inline et le bloc parent
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      const line = cs.textDecorationLine;
      if (/underline|line-through/.test(line)) return line.match(/underline|line-through/)[0];
      if (!cs.display.startsWith('inline') && cs.display !== 'contents') break;
    }
    return null;
  }

  function textAttrs(cs, color, el) {
    let a = `font-family="${esc(pickFamily(cs.fontFamily))}" font-size="${n(parseFloat(cs.fontSize))}"`;
    const w = cs.fontWeight;
    if (w !== '400' && w !== 'normal') a += ` font-weight="${w}"`;
    if (cs.fontStyle !== 'normal') a += ' font-style="italic"';
    const ls = parseFloat(cs.letterSpacing);
    if (ls) a += ` letter-spacing="${n(ls)}"`;
    const deco = el && decorationOf(el);
    if (deco) a += ` text-decoration="${deco}"`;
    return `${a} ${fillAttr(color)}`;
  }

  function transformText(str, tt) {
    if (tt === 'uppercase') return str.toUpperCase();
    if (tt === 'lowercase') return str.toLowerCase();
    if (tt === 'capitalize') return str.replace(/(^|\s)(\S)/g, (_, s, c) => s + c.toUpperCase());
    return str;
  }

  function renderText(node, clip) {
    const el = node.parentElement;
    if (!el) return '';
    const text = node.data;
    const s = text.search(/\S/);
    if (s < 0) return '';
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible') return '';
    const color = parseColor(cs.color);
    if (!color) return '';

    const pre = /^(pre|pre-wrap|break-spaces)$/.test(cs.whiteSpace);
    const e = text.length - (text.length - text.trimEnd().length);
    const range = document.createRange();

    // Découpe en lignes : on mesure chaque mot et on regroupe ceux qui partagent la même ligne.
    const lines = [];
    const pushRect = (r, start, end) => {
      if (!r.width && !r.height) return;
      const last = lines[lines.length - 1];
      if (last && Math.abs(r.top - last.top) < r.height / 2 && r.left >= last.left - 1) {
        last.end = end; last.right = Math.max(last.right, r.right);
      } else {
        lines.push({ start, end, top: r.top, left: r.left, right: r.right, height: r.height });
      }
    };

    range.setStart(node, s);
    range.setEnd(node, e);
    const whole = [...range.getClientRects()].filter(r => r.width || r.height);
    if (whole.length === 1) {
      pushRect(whole[0], s, e);
    } else if (whole.length > 1) {
      const re = /\S+/g;
      let m;
      while ((m = re.exec(text))) {
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const rects = range.getClientRects();
        if (rects.length > 1) {
          // mot coupé sur plusieurs lignes : caractère par caractère
          for (let i = 0; i < m[0].length; i++) {
            range.setStart(node, m.index + i);
            range.setEnd(node, m.index + i + 1);
            const cr = range.getClientRects()[0];
            if (cr) pushRect(cr, m.index + i, m.index + i + 1);
          }
        } else if (rects.length) {
          pushRect(rects[0], m.index, m.index + m[0].length);
        }
      }
    }
    if (!lines.length) return '';

    const { asc, desc } = fontMetrics(cs);
    const spans = [];
    for (const line of lines) {
      const lb = toBox({ left: line.left, top: line.top, width: line.right - line.left, height: line.height });
      if (!intersects(lb, clip)) continue;
      let str = text.slice(line.start, line.end);
      str = pre ? str.replace(/\t/g, '    ') : str.replace(/\s+/g, ' ');
      str = transformText(str, cs.textTransform);
      const baseline = lb.y + (lb.h - (asc + desc)) / 2 + asc;
      spans.push({ x: lb.x, y: baseline, str });
    }
    if (!spans.length) return '';
    S.stats.texts++;
    const space = pre ? ' xml:space="preserve"' : '';
    const attrs = textAttrs(cs, color, el);
    if (spans.length === 1) {
      const sp = spans[0];
      return `<text x="${n(sp.x)}" y="${n(sp.y)}" ${attrs}${space}>${esc(sp.str)}</text>`;
    }
    return `<text ${attrs}${space}>${spans.map(sp => `<tspan x="${n(sp.x)}" y="${n(sp.y)}">${esc(sp.str)}</tspan>`).join('')}</text>`;
  }

  // ───────────────────────── éléments remplacés ─────────────────────────

  function objectFitPar(cs) {
    const fit = cs.objectFit;
    if (fit === 'fill') return 'none';
    const [px = '50%', py = '50%'] = cs.objectPosition.split(/\s+/);
    const al = (v, a, b, c) => { const p = parseFloat(v); return p < 34 ? a : p > 66 ? c : b; };
    const align = `${al(px, 'xMin', 'xMid', 'xMax')}${al(py, 'YMin', 'YMid', 'YMax')}`;
    return `${align} ${fit === 'cover' || fit === 'none' ? 'slice' : 'meet'}`;
  }

  function imageWithClip(href, cs, b, par = 'none') {
    const cb = contentBox(cs, b);
    const img = `<image x="${n(cb.x)}" y="${n(cb.y)}" width="${n(cb.w)}" height="${n(cb.h)}" preserveAspectRatio="${par}" xlink:href="${href}"/>`;
    const rad = radii(cs, b);
    if (rad.some(r => r > 0)) return `<g clip-path="url(#${defineClip(b, rad)})">${img}</g>`;
    return img;
  }

  function renderReplaced(el, cs, b) {
    const tag = el.localName;
    if (tag === 'img') {
      if (!el.complete || !el.naturalWidth) return '';
      const href = imageHref(el.currentSrc || el.src, el);
      return href ? imageWithClip(href, cs, b, objectFitPar(cs)) : '';
    }
    if (tag === 'canvas') {
      try { return imageWithClip(el.toDataURL('image/png'), cs, b); } catch { return placeholder(b, 'canvas'); }
    }
    if (tag === 'video') {
      try {
        if (el.videoWidth) {
          const c = document.createElement('canvas');
          c.width = el.videoWidth; c.height = el.videoHeight;
          c.getContext('2d').drawImage(el, 0, 0);
          return imageWithClip(c.toDataURL('image/jpeg', 0.9), cs, b, objectFitPar(cs));
        }
      } catch { /* vidéo cross-origin */ }
      if (el.poster) return imageWithClip(imageHref(el.poster), cs, b, objectFitPar(cs));
      return placeholder(b, 'video');
    }
    if (tag === 'iframe' || tag === 'object' || tag === 'embed') return placeholder(b, tag);
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return renderControl(el, cs, b);
    return '';
  }

  function placeholder(b, label) {
    return `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" fill="#e5e5e5"/>` +
      `<text x="${n(b.x + b.w / 2)}" y="${n(b.y + b.h / 2)}" text-anchor="middle" font-family="Arial" font-size="12" fill="#888888">${label}</text>`;
  }

  function renderControl(el, cs, b) {
    const type = (el.type || '').toLowerCase();
    const accent = parseColor(cs.accentColor !== 'auto' ? cs.accentColor : '#0060df');
    if (type === 'checkbox' || type === 'radio') {
      const s = Math.min(b.w, b.h), x = b.x + (b.w - s) / 2, y = b.y + (b.h - s) / 2;
      if (type === 'radio') {
        const c = `cx="${n(x + s / 2)}" cy="${n(y + s / 2)}"`;
        return el.checked
          ? `<circle ${c} r="${n(s / 2)}" ${fillAttr(accent)}/><circle ${c} r="${n(s / 5)}" fill="#ffffff"/>`
          : `<circle ${c} r="${n(s / 2 - 0.5)}" fill="#ffffff" stroke="#8f8f9d"/>`;
      }
      return el.checked
        ? `<rect x="${n(x)}" y="${n(y)}" width="${n(s)}" height="${n(s)}" rx="${n(s / 5)}" ${fillAttr(accent)}/><path d="M${n(x + s * .25)} ${n(y + s * .52)}l${n(s * .17)} ${n(s * .17)} ${n(s * .33)}-${n(s * .38)}" fill="none" stroke="#ffffff" stroke-width="${n(s / 8)}" stroke-linecap="round" stroke-linejoin="round"/>`
        : `<rect x="${n(x + .5)}" y="${n(y + .5)}" width="${n(s - 1)}" height="${n(s - 1)}" rx="${n(s / 5)}" fill="#ffffff" stroke="#8f8f9d"/>`;
    }
    if (type === 'color') {
      const cb = contentBox(cs, b);
      return `<rect x="${n(cb.x)}" y="${n(cb.y)}" width="${n(cb.w)}" height="${n(cb.h)}" fill="${esc(el.value)}"/>`;
    }
    if (['range', 'file', 'hidden', 'image'].includes(type)) return '';

    let value, color = parseColor(cs.color);
    if (el.localName === 'select') value = el.options[el.selectedIndex]?.text || '';
    else value = el.value;
    if (type === 'password') value = '•'.repeat(value.length);
    if (!value && el.placeholder) {
      value = el.placeholder;
      color = parseColor(getComputedStyle(el, '::placeholder').color) || color;
    }
    if (!value || !color) return '';
    const cb = contentBox(cs, b);
    const { asc, desc } = fontMetrics(cs);
    const attrs = textAttrs(cs, color);
    const centered = ['button', 'submit', 'reset'].includes(type);
    let out = '';
    if (el.localName === 'textarea') {
      const lh = cs.lineHeight === 'normal' ? parseFloat(cs.fontSize) * 1.2 : parseFloat(cs.lineHeight);
      const lines = value.split('\n');
      out = `<text ${attrs} xml:space="preserve">${lines.map((l, i) => `<tspan x="${n(cb.x)}" y="${n(cb.y + (lh - asc - desc) / 2 + asc + i * lh)}">${esc(l)}</tspan>`).join('')}</text>`;
    } else {
      const y = cb.y + (cb.h - (asc + desc)) / 2 + asc;
      const x = centered ? cb.x + cb.w / 2 : cb.x;
      out = `<text x="${n(x)}" y="${n(y)}"${centered ? ' text-anchor="middle"' : ''} ${attrs}>${esc(value)}</text>`;
    }
    if (el.localName === 'select') {
      const cx = b.x + b.w - 14, cy = b.y + b.h / 2;
      out += `<path d="M${n(cx - 4)} ${n(cy - 2)}l4 4 4-4" fill="none" ${fillAttr(color, 'stroke')} stroke-width="1.5"/>`;
    }
    const clip = defineClip(b, [0, 0, 0, 0]);
    return `<g clip-path="url(#${clip})">${out}</g>`;
  }

  // ───────────────────────── SVG inline ─────────────────────────

  function renderInlineSvg(el, b, id) {
    if (!b.w || !b.h) return '';
    const clone = el.cloneNode(true);
    const srcs = [el, ...el.querySelectorAll('*')];
    const dsts = [clone, ...clone.querySelectorAll('*')];
    srcs.forEach((src, i) => {
      const dst = dsts[i];
      if (!SVG_SHAPES.has(src.localName)) return;
      const cs = getComputedStyle(src);
      if (cs.display === 'none') { dst.setAttribute('display', 'none'); return; }
      for (const prop of ['fill', 'stroke']) {
        const v = cs.getPropertyValue(prop);
        if (v.startsWith('url(')) {
          const ref = v.match(/#([^"')]+)/);
          if (ref) dst.setAttribute(prop, `url(#${ref[1]})`);
        } else if (v === 'none') {
          dst.setAttribute(prop, 'none');
        } else {
          const c = parseColor(v);
          if (!c) { dst.setAttribute(prop, 'none'); continue; }
          dst.setAttribute(prop, c.hex);
          const op = parseFloat(cs.getPropertyValue(`${prop}-opacity`)) * c.a;
          if (op < 1) dst.setAttribute(`${prop}-opacity`, n(op));
        }
      }
      if (cs.stroke !== 'none') {
        dst.setAttribute('stroke-width', parseFloat(cs.strokeWidth) || 1);
        dst.setAttribute('stroke-linecap', cs.strokeLinecap);
        dst.setAttribute('stroke-linejoin', cs.strokeLinejoin);
        if (cs.strokeDasharray && cs.strokeDasharray !== 'none') dst.setAttribute('stroke-dasharray', cs.strokeDasharray.replace(/px/g, ''));
      }
      dst.setAttribute('fill-rule', cs.fillRule);
      if (parseFloat(cs.opacity) < 1) dst.setAttribute('opacity', cs.opacity);
      if (src.localName === 'text' || src.localName === 'tspan') {
        dst.setAttribute('font-family', pickFamily(cs.fontFamily));
        dst.setAttribute('font-size', parseFloat(cs.fontSize));
        dst.setAttribute('font-weight', cs.fontWeight);
      }
      if (src.localName === 'use') dst.__srcColor = parseColor(cs.color);
    });

    // <use href="#sprite"> pointant hors du SVG : on recopie le symbole référencé
    const root = el.getRootNode();
    for (const use of [...clone.querySelectorAll('use')]) {
      const href = use.getAttribute('href') || use.getAttributeNS(XLINK, 'href') || '';
      if (!href.startsWith('#')) continue;
      const refId = href.slice(1);
      if (clone.querySelector(`[id="${CSS.escape(refId)}"]`)) continue;
      const ref = (root.getElementById ? root.getElementById(refId) : null) || document.getElementById(refId);
      if (!ref) continue;
      const isSymbol = ref.localName === 'symbol';
      const rep = document.createElementNS('http://www.w3.org/2000/svg', isSymbol ? 'svg' : 'g');
      for (const attr of ['fill', 'stroke', 'stroke-width', 'fill-opacity', 'stroke-opacity', 'opacity', 'class']) {
        if (use.hasAttribute(attr)) rep.setAttribute(attr, use.getAttribute(attr));
      }
      const ux = use.getAttribute('x') || 0, uy = use.getAttribute('y') || 0;
      if (isSymbol) {
        if (ref.getAttribute('viewBox')) rep.setAttribute('viewBox', ref.getAttribute('viewBox'));
        rep.setAttribute('x', ux); rep.setAttribute('y', uy);
        rep.setAttribute('width', use.getAttribute('width') || '100%');
        rep.setAttribute('height', use.getAttribute('height') || '100%');
        for (const c of ref.childNodes) rep.appendChild(c.cloneNode(true));
      } else {
        rep.setAttribute('transform', `translate(${ux} ${uy})`);
        rep.appendChild(ref.cloneNode(true));
      }
      const cur = use.__srcColor;
      if (cur) {
        for (const e of [rep, ...rep.querySelectorAll('*')]) {
          for (const attr of ['fill', 'stroke']) if (e.getAttribute(attr) === 'currentColor') e.setAttribute(attr, cur.hex);
        }
      }
      use.replaceWith(rep);
    }

    clone.querySelectorAll('style, script').forEach(e => e.remove());
    clone.removeAttribute('class');
    clone.removeAttribute('style');
    if (!clone.hasAttribute('viewBox')) {
      const w = parseFloat(el.getAttribute('width')) || b.w, h = parseFloat(el.getAttribute('height')) || b.h;
      clone.setAttribute('viewBox', `0 0 ${w} ${h}`);
    }
    clone.setAttribute('id', id);
    clone.setAttribute('x', n(b.x));
    clone.setAttribute('y', n(b.y));
    clone.setAttribute('width', n(b.w));
    clone.setAttribute('height', n(b.h));
    clone.setAttribute('overflow', 'hidden');
    S.stats.nodes++;
    return new XMLSerializer().serializeToString(clone)
      .replace(/ xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '');
  }

  // ───────────────────────── parcours ─────────────────────────

  function childNodesOf(el) {
    if (el.localName === 'slot') return el.assignedNodes({ flatten: true });
    return el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes;
  }

  /** Ordre de peinture approximatif : z-index négatifs, flux normal, positionnés, z-index positifs. */
  function paintOrder(nodes) {
    return [...nodes].map((node, i) => {
      let tier = 1, z = 0;
      if (node.nodeType === 1) {
        const cs = getComputedStyle(node);
        const zi = parseInt(cs.zIndex, 10);
        if (cs.position !== 'static') {
          if (!isNaN(zi) && zi < 0) { tier = 0; z = zi; }
          else if (!isNaN(zi) && zi > 0) { tier = 3; z = zi; }
          else tier = 2;
        }
      }
      return { node, i, tier, z };
    }).sort((a, b) => a.tier - b.tier || a.z - b.z || a.i - b.i).map(o => o.node);
  }

  function renderNode(node, clip) {
    if (node.nodeType === 3) return renderText(node, clip);
    if (node.nodeType === 1) return renderElement(node, clip);
    return '';
  }

  function renderElement(el, clip) {
    const tag = el.localName;
    if (SKIP_TAGS.has(tag)) return '';
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return '';
    const opacity = parseFloat(cs.opacity);
    if (opacity === 0) return '';

    const b = toBox(el.getBoundingClientRect());
    const id = layerId(el);

    if (tag === 'svg') {
      if (cs.visibility !== 'visible' || !intersects(b, clip)) return '';
      const svg = renderInlineSvg(el, b, id);
      return opacity < 1 ? `<g opacity="${n(opacity)}">${svg}</g>` : svg;
    }

    let self = '';
    const drawSelf = cs.visibility === 'visible' && b.w > 0 && b.h > 0 && intersects(b, clip);
    if (drawSelf) {
      self = renderBox(el, cs, b);
      if (LEAF_TAGS.has(tag)) self += renderReplaced(el, cs, b);
    }

    const parts = [];
    let clipId = null;
    if (!LEAF_TAGS.has(tag)) {
      const isRoot = el === document.documentElement || el === document.body;
      const clips = !isRoot && cs.overflowX !== 'visible' && cs.overflowY !== 'visible';
      const innerClip = clips ? intersect(clip, b) : clip;
      // élément masqué façon « sr-only » : rien à dessiner dedans
      const hidden = clips && (innerClip.w < 2 || innerClip.h < 2);
      if (!hidden) {
        const inside = [], escaped = [];
        for (const child of paintOrder(childNodesOf(el))) {
          // un élément fixed échappe à l'overflow de ses parents
          const fixed = child.nodeType === 1 && clips && getComputedStyle(child).position === 'fixed';
          const out = renderNode(child, fixed ? S.rootClip : innerClip);
          if (out) (fixed ? escaped : inside).push(out);
        }
        if (inside.length && clips) {
          clipId = defineClip(b, radii(cs, b));
          parts.push(`<g clip-path="url(#${clipId})">${inside.join('')}</g>`);
        } else parts.push(...inside);
        parts.push(...escaped);
      }
    }

    if (!self && !parts.length) return '';
    // on évite les groupes inutiles : un seul enfant, pas de fond, pas d'opacité → on remonte l'enfant
    if (!self && parts.length === 1 && opacity === 1) return parts[0];
    S.stats.nodes++;
    return `<g id="${id}"${opacity < 1 ? ` opacity="${n(opacity)}"` : ''}>${self}${parts.join('')}</g>`;
  }

  // ───────────────────────── point d'entrée ─────────────────────────

  async function capture({ mode = 'viewport' } = {}) {
    const de = document.documentElement;
    const full = mode === 'full';
    S = {
      scrollX: window.scrollX, scrollY: window.scrollY,
      area: full
        ? { x: 0, y: 0, w: Math.max(de.scrollWidth, document.body?.scrollWidth || 0), h: Math.max(de.scrollHeight, document.body?.scrollHeight || 0) }
        : { x: window.scrollX, y: window.scrollY, w: de.clientWidth, h: de.clientHeight },
      defs: [], defId: 0, ids: new Map(),
      images: [], imageIndex: new Map(), bgJobs: [],
      stats: { nodes: 0, texts: 0, images: 0 },
    };
    const { w, h } = S.area;
    S.rootClip = { x: 0, y: 0, w, h };

    // Le fond du canvas vient de <html>, ou de <body> si <html> est transparent.
    const htmlBg = parseColor(getComputedStyle(de).backgroundColor);
    const bodyBg = document.body && parseColor(getComputedStyle(document.body).backgroundColor);
    S.bgSource = htmlBg ? de : bodyBg ? document.body : null;
    const canvasBg = htmlBg || bodyBg || { hex: '#ffffff', a: 1 };

    let content = renderElement(de, S.rootClip);
    content = await resolveBackgroundJobs(content);

    const title = document.title || location.hostname;
    const rootId = 'page-' + (title.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'capture');
    const clipRoot = full ? '' : ` clip-path="url(#h2d-viewport)"`;
    if (!full) S.defs.push(`<clipPath id="h2d-viewport"><rect width="${w}" height="${h}"/></clipPath>`);

    const svg = `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="${XLINK}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n` +
      `<title>${esc(title)}</title>\n` +
      `<defs>${S.defs.join('')}</defs>\n` +
      `<g id="${rootId}"${clipRoot}>` +
      `<rect id="background" width="${w}" height="${h}" ${fillAttr(canvasBg)}/>` +
      content +
      `</g>\n</svg>\n`;

    return { svg, images: S.images, stats: S.stats, title: document.title, host: location.hostname };
  }

  window.__htmlToDesign = { capture };
})();
