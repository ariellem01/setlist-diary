'use strict';
/* Setlist — a private concert diary.
   Everything is stored on this device (IndexedDB). Nothing is sent to any server.
   The only things that leave the phone are what you choose to share. */

// ===================== Storage (IndexedDB) =====================
let dbPromise;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('setlist', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('shows', { keyPath: 'id' });
        d.createObjectStore('media', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
async function tx(store, mode, fn) {
  const d = await openDb();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage was blocked'));
  });
}
const dbAll = (s) => tx(s, 'readonly', (st) => st.getAll());
const dbGet = (s, id) => tx(s, 'readonly', (st) => st.get(id));
const dbPut = (s, v) => tx(s, 'readwrite', (st) => st.put(v));
const dbDel = (s, id) => tx(s, 'readwrite', (st) => st.delete(id));

let askedPersist = false;
function askPersist() {
  // Asks the phone not to clear this app's data when storage runs low.
  if (askedPersist) return;
  askedPersist = true;
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
}

// ===================== Helpers =====================
const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function parseDate(iso) { return iso ? new Date(iso + 'T12:00:00') : null; }
function fmtDate(iso, opts = { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' }) {
  const d = parseDate(iso); return d ? d.toLocaleDateString(undefined, opts) : '';
}
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function money(n) {
  return Number(n || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}
function starsHtml(n) {
  n = Number(n) || 0;
  if (!n) return '<span class="muted small">Not rated</span>';
  let s = '';
  for (let i = 1; i <= 5; i++) s += i <= n ? '★' : '<span class="off">★</span>';
  return `<span class="stars" aria-label="${n} out of 5 stars">${s}</span>`;
}
function isEncoreLine(line) { return /^(-+\s*)?encore\b.*$/i.test(line.trim()); }
function songsOnly(setlist) { return (setlist || []).filter((l) => l.trim() && !isEncoreLine(l)); }
function songsHtml(setlist) {
  const lines = (setlist || []).filter((l) => l.trim());
  if (!lines.length) return '<p class="muted">No songs added.</p>';
  return '<ol class="songs">' + lines.map((l) =>
    isEncoreLine(l) ? `<li class="enc">Encore</li>` : `<li>${esc(l)}</li>`).join('') + '</ol>';
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// Object URLs for photos/videos must be released when we leave a screen.
let liveUrls = [];
function blobUrl(blob) { const u = URL.createObjectURL(blob); liveUrls.push(u); return u; }
function releaseUrls() { liveUrls.forEach((u) => URL.revokeObjectURL(u)); liveUrls = []; }

async function shrinkImage(file, max = 1600) {
  // Photos from phones are huge; save a smaller copy so the diary doesn't fill your storage.
  try {
    const url = URL.createObjectURL(file);
    const img = new Image(); img.src = url; await img.decode();
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return out && out.size < file.size ? out : file;
  } catch (e) { return file; }
}

async function shareFiles(files, title) {
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files, title }); return true; }
    catch (e) { if (e.name === 'AbortError') return true; }
  }
  return false;
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function safeName(s) { return String(s || 'show').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'show'; }

// ===================== Router =====================
function setTab(name) {
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
}
async function route() {
  releaseUrls();
  app.onclick = null;
  const h = location.hash || '#/shows';
  window.scrollTo(0, 0);
  try {
    if (h.startsWith('#share=')) { setTab(''); return await viewShared(h.slice(7)); }
    const [, view, id] = h.split('/');
    if (view === 'add') { setTab('add'); return await viewForm(null); }
    if (view === 'plan') { setTab(id ? '' : 'add'); return await viewPlanForm(id || null); }
    if (view === 'upcoming') { setTab('upcoming'); return await viewUpcoming(); }
    if (view === 'edit' && id) { setTab(''); return await viewForm(id); }
    if (view === 'show' && id) { setTab('shows'); return await viewShow(id); }
    if (view === 'stats') { setTab('stats'); return await viewStats(); }
    setTab('shows'); return await viewList();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="empty"><div class="big">⚠️</div><p>Something went wrong: ${esc(e.message)}</p>
      <a class="btn" href="#/shows">Back to My Shows</a></div>`;
  }
}
window.addEventListener('hashchange', route);

// ===================== My Shows =====================
// Diary entries are shows you went to. Future concerts are stored alongside them with kind: 'plan'.
const isPlan = (s) => s.kind === 'plan';
async function attendedShows() { return (await dbAll('shows')).filter((s) => !isPlan(s)); }

async function viewList() {
  const shows = (await attendedShows()).sort((a, b) =>
    (b.date || '').localeCompare(a.date || '') || (b.time || '').localeCompare(a.time || ''));
  if (!shows.length) {
    app.innerHTML = `<div class="empty">
      <div class="big">🎤</div>
      <h1>No shows yet</h1>
      <p class="muted">Log the concerts you've been to: the setlist, your rating, photos and your ticket.</p>
      <a class="btn primary block" href="#/add">＋ Add your first show</a>
      <p class="muted small" style="margin-top:18px">🔒 Your diary is private and stays on this phone.</p>
    </div>`;
    return;
  }
  app.innerHTML = `
    <h1>My Shows</h1>
    <p class="muted small">${shows.length} show${shows.length === 1 ? '' : 's'} · private to this phone</p>
    <input class="search" type="search" placeholder="Search artist, venue, city or song" aria-label="Search shows">
    <ul class="list"></ul>
    <p class="muted empty-search" hidden>No shows match your search.</p>`;
  const ul = $('.list', app);
  const media = new Map((await dbAll('media')).map((m) => [m.id, m]));
  for (const s of shows) {
    const d = parseDate(s.date);
    const firstPhoto = (s.media || []).map((id) => media.get(id)).find((m) => m && m.type.startsWith('image/'));
    const li = document.createElement('li');
    li.dataset.search = [s.artist, s.venue, s.city, ...(s.setlist || [])].join(' ').toLowerCase();
    li.innerHTML = `<a class="card" href="#/show/${s.id}">
      <div class="datebox">${d ? `<div class="m">${d.toLocaleDateString(undefined, { month: 'short' })}</div>
        <div class="d">${d.getDate()}</div><div class="y">${d.getFullYear()}</div>` : ''}</div>
      <div><div class="t">${esc(s.artist)}</div>
        <div class="s">${esc([s.venue, s.city].filter(Boolean).join(' · ')) || '&nbsp;'}</div>
        <div>${starsHtml(s.rating)}</div></div>
      ${firstPhoto ? `<img class="thumb" alt="" src="${blobUrl(firstPhoto.blob)}">` : '<div></div>'}
    </a>`;
    ul.appendChild(li);
  }
  $('.search', app).addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    let any = false;
    ul.querySelectorAll('li').forEach((li) => { const hit = !q || li.dataset.search.includes(q); li.hidden = !hit; any ||= hit; });
    $('.empty-search', app).hidden = any;
  });
}

// ===================== Show detail =====================
async function viewShow(id) {
  const s = await dbGet('shows', id);
  if (!s) { location.hash = '#/shows'; return; }
  if (isPlan(s)) { setTab('upcoming'); return viewPlan(s); }
  const media = (await Promise.all((s.media || []).map((m) => dbGet('media', m)))).filter(Boolean);
  const t = s.ticket || {};
  const ticketFile = t.fileId ? await dbGet('media', t.fileId) : null;
  const hasTicket = t.seat || t.section || t.price || t.order || ticketFile || t.givenTo;

  app.innerHTML = `
    <a class="back" href="#/shows">‹ My Shows</a>
    ${media.length ? `<div class="gallery">${media.map((m) => m.type.startsWith('video/')
      ? `<video src="${blobUrl(m.blob)}" controls playsinline preload="metadata"></video>`
      : `<img src="${blobUrl(m.blob)}" alt="Photo from the show">`).join('')}</div>` : ''}
    <h1>${esc(s.artist)}</h1>
    <div class="meta">${esc(fmtDate(s.date))}${s.time ? ' · ' + esc(fmtTime(s.time)) : ''}</div>
    <div class="meta">${esc([s.venue, s.city].filter(Boolean).join(', '))}</div>
    ${s.withWho ? `<div class="meta">With ${esc(s.withWho)}</div>` : ''}
    <div style="margin-top:6px;font-size:22px">${starsHtml(s.rating)}</div>

    <div class="btnrow">
      <button class="btn primary" id="shareBtn">↗ Share</button>
      <a class="btn" href="#/edit/${s.id}">✎ Edit</a>
    </div>

    <section class="panel"><h2>Setlist <span class="muted small">(${songsOnly(s.setlist).length} songs)</span></h2>${songsHtml(s.setlist)}</section>
    ${s.notes ? `<section class="panel"><h2>My notes</h2><div class="notes">${esc(s.notes)}</div></section>` : ''}

    ${hasTicket ? `<section class="panel"><h2>🎟 Ticket</h2>
      <dl class="kv">
        ${t.section ? `<dt>Section</dt><dd>${esc(t.section)}</dd>` : ''}
        ${t.seat ? `<dt>Row / seat</dt><dd>${esc(t.seat)}</dd>` : ''}
        ${t.price ? `<dt>Paid</dt><dd>${money(t.price)}</dd>` : ''}
        ${t.order ? `<dt>Order #</dt><dd>${esc(t.order)}</dd>` : ''}
        ${t.givenTo ? `<dt>For</dt><dd>${esc(t.givenTo)} ${t.transferred
          ? '<span class="pill ok">✓ Transferred</span>' : '<span class="pill no">Not transferred yet</span>'}</dd>` : ''}
      </dl>
      ${ticketFile ? (ticketFile.type.startsWith('image/')
        ? `<img class="ticketimg" src="${blobUrl(ticketFile.blob)}" alt="Ticket">`
        : `<p class="muted small">📄 ${esc(ticketFile.name || 'Ticket file')}</p>`) : ''}
      ${ticketFile ? `<div class="btnrow">
        <a class="btn" href="${blobUrl(ticketFile.blob)}" target="_blank" rel="noopener">Open ticket</a>
        <button class="btn" id="sendTicket">Send to a friend</button></div>
        <p class="muted small">Only works for print-at-home or PDF tickets. Mobile tickets with a moving barcode must be transferred in the ticket seller's app.</p>` : ''}
    </section>` : ''}

    <div style="margin-top:24px"><button class="btn danger block" id="delBtn">Delete this show</button></div>`;

  $('#shareBtn').onclick = () => openShareDialog(s, media);
  $('#delBtn').onclick = async () => {
    if (!confirm(`Delete ${s.artist} (${fmtDate(s.date, { month: 'short', day: 'numeric', year: 'numeric' })})? Its photos and videos will be deleted too. This can't be undone.`)) return;
    for (const m of [...(s.media || []), t.fileId].filter(Boolean)) await dbDel('media', m);
    await dbDel('shows', s.id);
    toast('Show deleted');
    location.hash = '#/shows';
  };
  const st = $('#sendTicket');
  if (st) st.onclick = async () => {
    const f = new File([ticketFile.blob], ticketFile.name || `ticket-${safeName(s.artist)}`, { type: ticketFile.type });
    if (!(await shareFiles([f], `Ticket: ${s.artist}`))) { download(f, f.name); toast('Ticket saved. Send it from your files.'); }
  };
}

// ===================== Share =====================
function b64u(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function encodeShare(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  if ('CompressionStream' in window) {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return 'z' + b64u(new Uint8Array(await new Response(stream).arrayBuffer()));
    } catch (e) {}
  }
  return 'j' + b64u(bytes);
}
async function decodeShare(code) {
  const kind = code[0]; let bytes = unb64u(code.slice(1));
  if (kind === 'z') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function openShareDialog(s, media) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <h2>Share this show</h2>
    <p class="muted small">Your diary stays private. You choose what to send.</p>
    <button class="btn primary block" data-act="link">🔗 Share a link</button>
    <p class="muted small" style="margin:6px 0 14px">Sends the artist, date, venue, rating and setlist. Photos, your ticket and who you went with are never included.</p>
    <label class="check"><input type="checkbox" data-notes> Include my notes in the link</label>
    <button class="btn block" data-act="card" style="margin-top:8px">🖼 Share as a picture</button>
    <p class="muted small" style="margin:6px 0 14px">Makes an image with ${media.some((m) => m.type.startsWith('image/')) ? 'your first photo, ' : ''}the details and the setlist, ready for Messages or Instagram.</p>
    <button class="btn block" data-act="close">Cancel</button>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'close') return dlg.close();
    if (act === 'link') {
      const payload = { v: 1, a: s.artist, d: s.date, t: s.time, ve: s.venue, c: s.city, r: s.rating, sl: s.setlist };
      if ($('[data-notes]', dlg).checked && s.notes) payload.n = s.notes;
      const url = location.origin + location.pathname + '#share=' + (await encodeShare(payload));
      const text = `${s.artist} · ${fmtDate(s.date, { month: 'short', day: 'numeric', year: 'numeric' })}${s.venue ? ' · ' + s.venue : ''}`;
      dlg.close();
      if (navigator.share) {
        try { await navigator.share({ title: `Setlist: ${s.artist}`, text, url }); return; }
        catch (err) { if (err.name === 'AbortError') return; }
      }
      try { await navigator.clipboard.writeText(url); toast('Link copied. Paste it anywhere.'); }
      catch (err) { prompt('Copy this link:', url); }
    }
    if (act === 'card') {
      dlg.close();
      toast('Making your picture…');
      const blob = await makeCard(s, media.find((m) => m.type.startsWith('image/')));
      const file = new File([blob], `setlist-${safeName(s.artist)}.png`, { type: 'image/png' });
      if (!(await shareFiles([file], `Setlist: ${s.artist}`))) { download(file, file.name); toast('Picture saved.'); }
    }
  });
  dlg.showModal();
}

async function makeCard(s, photo) {
  const W = 1080, H = 1350, P = 72;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#14111f'; g.fillRect(0, 0, W, H);
  let y = P;
  if (photo) {
    try {
      const url = URL.createObjectURL(photo.blob);
      const img = new Image(); img.src = url; await img.decode();
      const ph = 560, r = Math.max(W / img.naturalWidth, ph / img.naturalHeight);
      const sw = W / r, sh = ph / r;
      g.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, W, ph);
      URL.revokeObjectURL(url);
      const grad = g.createLinearGradient(0, ph - 200, 0, ph);
      grad.addColorStop(0, 'rgba(20,17,31,0)'); grad.addColorStop(1, 'rgba(20,17,31,1)');
      g.fillStyle = grad; g.fillRect(0, ph - 200, W, 200);
      y = ph + 10;
    } catch (e) {}
  }
  const font = (w, sz) => `${w} ${sz}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  const fit = (text, w, maxW) => { let t = text; while (g.measureText(t).width > maxW && t.length > 1) t = t.slice(0, -2) + '…'; return t; };
  g.textBaseline = 'top';
  g.fillStyle = '#f5f0ff'; g.font = font(800, 76);
  g.fillText(fit(s.artist, 800, W - 2 * P), P, y); y += 96;
  g.fillStyle = '#b3a9cc'; g.font = font(500, 38);
  g.fillText(fit([fmtDate(s.date, { month: 'long', day: 'numeric', year: 'numeric' }), s.venue, s.city].filter(Boolean).join(' · '), 500, W - 2 * P), P, y); y += 56;
  if (s.rating) { g.fillStyle = '#ff5a5f'; g.font = font(400, 48); g.fillText('★'.repeat(s.rating) + '☆'.repeat(5 - s.rating), P, y); y += 72; }
  y += 16;
  const lines = (s.setlist || []).filter((l) => l.trim());
  const room = Math.floor((H - y - 110) / 46);
  let n = 0;
  g.font = font(500, 34);
  for (let i = 0; i < lines.length && i < room; i++) {
    const l = lines[i];
    if (i === room - 1 && lines.length > room) { g.fillStyle = '#b3a9cc'; g.fillText(`+ ${lines.length - i} more`, P, y); break; }
    if (isEncoreLine(l)) { g.fillStyle = '#ff5a5f'; g.font = font(700, 30); g.fillText('ENCORE', P, y + 4); g.font = font(500, 34); }
    else { n++; g.fillStyle = '#ff5a5f'; g.fillText(String(n).padStart(2, ' ') + '.', P, y); g.fillStyle = '#f5f0ff'; g.fillText(fit(l, 500, W - 2 * P - 80), P + 80, y); }
    y += 46;
  }
  g.fillStyle = '#b3a9cc'; g.font = font(600, 30); g.fillText('♪ Setlist — my concert diary', P, H - P - 30);
  return new Promise((r) => c.toBlob(r, 'image/png'));
}

async function viewShared(code) {
  let s;
  try { s = await decodeShare(code); } catch (e) {
    app.innerHTML = `<div class="empty"><div class="big">🔗</div><h1>This link is broken</h1>
      <p class="muted">It may have been cut off when it was copied. Ask for the link again.</p>
      <a class="btn" href="#/shows">Go to My Shows</a></div>`;
    return;
  }
  const show = { artist: s.a || 'Unknown artist', date: s.d || '', time: s.t || '', venue: s.ve || '', city: s.c || '',
    rating: Number(s.r) || 0, setlist: Array.isArray(s.sl) ? s.sl.map(String) : [], notes: s.n || '' };
  app.innerHTML = `
    <div class="banner">🔗 Someone shared this show with you from their Setlist diary.</div>
    <h1>${esc(show.artist)}</h1>
    <div class="meta">${esc(fmtDate(show.date))}${show.time ? ' · ' + esc(fmtTime(show.time)) : ''}</div>
    <div class="meta">${esc([show.venue, show.city].filter(Boolean).join(', '))}</div>
    <div style="margin-top:6px;font-size:22px">${starsHtml(show.rating)}</div>
    <section class="panel"><h2>Setlist <span class="muted small">(${songsOnly(show.setlist).length} songs)</span></h2>${songsHtml(show.setlist)}</section>
    ${show.notes ? `<section class="panel"><h2>Their notes</h2><div class="notes">${esc(show.notes)}</div></section>` : ''}
    <button class="btn primary block" id="saveCopy" style="margin-top:16px">I was there too: add to my diary</button>
    <a class="btn block" href="#/shows" style="margin-top:10px">Go to My Shows</a>`;
  $('#saveCopy').onclick = async () => {
    const id = uid();
    await dbPut('shows', { ...show, notes: '', rating: 0, id, media: [], ticket: {}, withWho: '', createdAt: Date.now(), updatedAt: Date.now() });
    askPersist();
    toast('Added. Now add your own rating and photos.');
    location.hash = '#/edit/' + id;
  };
}

// ===================== Add / Edit =====================
async function viewForm(id) {
  const existing = id ? await dbGet('shows', id) : null;
  if (id && !existing) { location.hash = '#/shows'; return; }
  const s = existing || { artist: '', date: todayIso(), time: '', venue: '', city: '', withWho: '', rating: 0, setlist: [], notes: '', media: [], ticket: {} };
  const t = s.ticket || {};
  // Media being edited: existing ids plus newly picked files.
  const items = [];
  for (const mid of s.media || []) { const m = await dbGet('media', mid); if (m) items.push({ id: mid, blob: m.blob, type: m.type, name: m.name }); }
  const removed = [];
  let ticketFile = t.fileId ? await dbGet('media', t.fileId) : null;
  let newTicket = null, ticketRemoved = false;
  let rating = Number(s.rating) || 0;

  app.innerHTML = `
    ${existing ? `<a class="back" href="#/show/${existing.id}">‹ Back</a><h1>Edit show</h1>` : `
    <h1>Add a show</h1>
    <div class="seg" role="tablist"><a class="on" href="#/add" aria-current="page">A show I went to</a><a href="#/plan">A show I want to see</a></div>`}
    <form novalidate>
      <label class="field"><span>Artist <b class="req">*</b></span>
        <input name="artist" required autocomplete="off" autocapitalize="words" value="${esc(s.artist)}" placeholder="Who did you see?"></label>
      <div class="grid2">
        <label class="field"><span>Date <b class="req">*</b></span><input name="date" type="date" required value="${esc(s.date)}"></label>
        <label class="field"><span>Time</span><input name="time" type="time" value="${esc(s.time)}"></label>
      </div>
      <label class="field"><span>Venue</span><input name="venue" autocapitalize="words" value="${esc(s.venue)}" placeholder="e.g. Madison Square Garden"></label>
      <label class="field"><span>City</span><input name="city" autocapitalize="words" value="${esc(s.city)}" placeholder="e.g. New York"></label>

      <div class="field"><span>Your rating</span>
        <div class="starpick" role="radiogroup" aria-label="Rating">
          ${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}
        </div></div>

      <label class="field"><span>Setlist: one song per line</span>
        <textarea name="setlist" rows="8" placeholder="Opening song&#10;Second song&#10;…&#10;Encore&#10;Last song">${esc((s.setlist || []).join('\n'))}</textarea>
        <span class="muted small" style="font-weight:400;margin-top:6px">Type <b>Encore</b> on its own line to mark the encore.</span></label>

      <div class="field"><span>Photos &amp; videos</span>
        <div class="mediagrid" id="mg"></div>
        <label class="btn block filebtn">📷 Add photos or videos
          <input type="file" accept="image/*,video/*" multiple id="pickMedia"></label>
      </div>

      <label class="field"><span>Who you went with</span><input name="withWho" value="${esc(s.withWho)}" placeholder="Optional. Never shared."></label>
      <label class="field"><span>Notes</span><textarea name="notes" rows="4" placeholder="Best moment, the opener, what you'll remember…">${esc(s.notes)}</textarea></label>

      <details class="box" ${t.seat || t.section || t.price || t.order || t.fileId || t.givenTo ? 'open' : ''}>
        <summary>🎟 Ticket (optional)</summary>
        <div class="grid2">
          <label class="field"><span>Section</span><input name="section" value="${esc(t.section)}"></label>
          <label class="field"><span>Row / seat</span><input name="seat" value="${esc(t.seat)}"></label>
        </div>
        <div class="grid2">
          <label class="field"><span>Price paid ($)</span><input name="price" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(t.price)}"></label>
          <label class="field"><span>Order #</span><input name="order" value="${esc(t.order)}"></label>
        </div>
        <div class="field"><span>Ticket picture or PDF</span>
          <div id="tf" class="muted small" style="margin-bottom:8px"></div>
          <label class="btn block filebtn">📎 <span id="tfLabel">Attach ticket</span>
            <input type="file" accept="image/*,application/pdf" id="pickTicket"></label></div>
        <label class="field"><span>Ticket is for (if not you)</span><input name="givenTo" value="${esc(t.givenTo)}" placeholder="e.g. Sam"></label>
        <label class="check"><input type="checkbox" name="transferred" ${t.transferred ? 'checked' : ''}> I've transferred it to them</label>
      </details>

      <div class="savebar"><button class="btn primary block" type="submit" id="saveBtn">${existing ? 'Save changes' : 'Save show'}</button></div>
    </form>`;

  const form = $('form', app);
  const paintStars = () => form.querySelectorAll('[data-star]').forEach((b) => {
    const on = Number(b.dataset.star) <= rating; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
  });
  form.querySelector('.starpick').onclick = (e) => {
    const b = e.target.closest('[data-star]'); if (!b) return;
    const n = Number(b.dataset.star); rating = rating === n ? 0 : n; paintStars();
  };
  paintStars();

  const mg = $('#mg', app);
  function paintMedia() {
    mg.innerHTML = '';
    items.forEach((m, i) => {
      const d = document.createElement('div'); d.className = 'mi';
      const url = m.url || (m.url = blobUrl(m.blob));
      d.innerHTML = (m.type.startsWith('video/') ? `<video src="${url}" muted playsinline preload="metadata"></video><span class="vtag">▶ Video</span>`
        : `<img src="${url}" alt="">`) + `<button type="button" class="x" aria-label="Remove">✕</button>`;
      d.querySelector('.x').onclick = () => { if (m.id) removed.push(m.id); items.splice(i, 1); paintMedia(); };
      mg.appendChild(d);
    });
    mg.hidden = !items.length;
  }
  paintMedia();
  $('#pickMedia', app).onchange = (e) => {
    for (const f of e.target.files) {
      if (f.type.startsWith('video/') && f.size > 150 * 1024 * 1024) { toast(`${f.name || 'That video'} is too big (over 150 MB). Try a shorter clip.`); continue; }
      items.push({ file: f, blob: f, type: f.type || 'image/jpeg', name: f.name });
    }
    e.target.value = ''; paintMedia();
  };

  function paintTicket() {
    const cur = newTicket || (!ticketRemoved && ticketFile);
    $('#tf', app).innerHTML = cur ? `📄 ${esc(cur.name || 'Ticket attached')} <button type="button" class="btn" style="min-height:36px;margin-left:8px" id="rmTicket">Remove</button>` : '';
    $('#tfLabel', app).textContent = cur ? 'Replace ticket' : 'Attach ticket';
    const rm = $('#rmTicket', app); if (rm) rm.onclick = () => { newTicket = null; ticketRemoved = true; paintTicket(); };
  }
  paintTicket();
  $('#pickTicket', app).onchange = (e) => { if (e.target.files[0]) { newTicket = e.target.files[0]; ticketRemoved = true; } e.target.value = ''; paintTicket(); };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const artist = f.get('artist').trim(), date = f.get('date');
    if (!artist) { toast('Add the artist’s name'); form.artist.focus(); return; }
    if (!date) { toast('Pick the date of the show'); form.date.focus(); return; }
    const btn = $('#saveBtn'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const mediaIds = [];
      for (const m of items) {
        if (m.id) { mediaIds.push(m.id); continue; }
        const blob = m.type.startsWith('image/') ? await shrinkImage(m.file) : m.file;
        const mid = uid();
        await dbPut('media', { id: mid, blob, type: blob.type || m.type, name: m.name });
        mediaIds.push(mid);
      }
      for (const rid of removed) await dbDel('media', rid);
      let fileId = t.fileId || null;
      if (ticketRemoved && fileId) { await dbDel('media', fileId); fileId = null; }
      if (newTicket) {
        fileId = uid();
        const blob = newTicket.type.startsWith('image/') ? await shrinkImage(newTicket, 2200) : newTicket;
        await dbPut('media', { id: fileId, blob, type: blob.type || newTicket.type, name: newTicket.name });
      }
      const show = {
        id: existing ? existing.id : uid(),
        artist, date, time: f.get('time') || '', venue: f.get('venue').trim(), city: f.get('city').trim(),
        withWho: f.get('withWho').trim(), rating,
        setlist: f.get('setlist').split('\n').map((l) => l.trim()).filter(Boolean),
        notes: f.get('notes').trim(), media: mediaIds,
        ticket: { section: f.get('section').trim(), seat: f.get('seat').trim(), price: f.get('price') ? Number(f.get('price')) : '',
          order: f.get('order').trim(), fileId, givenTo: f.get('givenTo').trim(), transferred: !!f.get('transferred') },
        createdAt: existing ? existing.createdAt : Date.now(), updatedAt: Date.now(),
      };
      await dbPut('shows', show);
      askPersist();
      toast(existing ? 'Changes saved' : 'Show saved');
      location.hash = '#/show/' + show.id;
    } catch (err) {
      console.error(err);
      btn.disabled = false; btn.textContent = 'Try saving again';
      toast(/quota/i.test(err.name + err.message) ? 'Your phone is out of space for this app. Remove a video or two.' : 'Could not save: ' + err.message);
    }
  };
}

// ===================== Upcoming (concerts you want to see) =====================
function daysUntil(iso) {
  if (!iso) return null;
  const t = new Date(); t.setHours(12, 0, 0, 0);
  return Math.round((parseDate(iso) - t) / 86400000);
}
function countdownText(iso) {
  const n = daysUntil(iso);
  if (n === null) return 'Date not announced';
  if (n < 0) return n === -1 ? 'Was yesterday' : `Was ${-n} days ago`;
  if (n === 0) return 'Today!';
  if (n === 1) return 'Tomorrow';
  if (n < 60) return `In ${n} days`;
  const m = Math.round(n / 30.4);
  return `In about ${m} months`;
}
function statusPill(p) {
  return p.status === 'got' ? '<span class="pill got">🎟 Got tickets</span>' : '<span class="pill want">☆ Want to go</span>';
}
function safeLink(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch (e) { return ''; }
}
function fmtDateTime(dt) {
  if (!dt) return '';
  const d = new Date(dt);
  return isNaN(d) ? '' : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function viewUpcoming() {
  const plans = (await dbAll('shows')).filter(isPlan);
  const past = plans.filter((p) => p.date && daysUntil(p.date) < 0).sort((a, b) => a.date.localeCompare(b.date));
  const ahead = plans.filter((p) => !p.date || daysUntil(p.date) >= 0)
    .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.time || '').localeCompare(b.time || ''));

  if (!plans.length) {
    app.innerHTML = `<div class="empty">
      <div class="big">🗓</div>
      <h1>No upcoming concerts</h1>
      <p class="muted">Keep a list of shows you'd like to see, with a countdown, when tickets go on sale, and your budget.</p>
      <a class="btn primary block" href="#/plan">＋ Add a concert you want to see</a>
    </div>`;
    return;
  }
  const card = (p) => {
    const d = parseDate(p.date);
    return `<li><a class="card plan" href="#/show/${p.id}">
      <div class="datebox">${d ? `<div class="m">${d.toLocaleDateString(undefined, { month: 'short' })}</div>
        <div class="d">${d.getDate()}</div><div class="y">${d.getFullYear()}</div>` : '<div class="d">?</div><div class="y">TBA</div>'}</div>
      <div><div class="t">${esc(p.artist)}</div>
        <div class="s">${esc([p.venue, p.city].filter(Boolean).join(' · ')) || '&nbsp;'}</div>
        <div>${statusPill(p)} <span class="countdown">${countdownText(p.date)}</span></div></div>
    </a></li>`;
  };
  app.innerHTML = `
    <h1>Upcoming</h1>
    <p class="muted small">${ahead.length} concert${ahead.length === 1 ? '' : 's'} on your list</p>
    <a class="btn primary block" href="#/plan" style="margin-bottom:8px">＋ Add a concert you want to see</a>
    ${past.length ? `<div class="sectionlabel">Did you go?</div><ul class="list">${past.map(card).join('')}</ul>` : ''}
    ${ahead.length ? `${past.length ? '<div class="sectionlabel">Coming up</div>' : ''}<ul class="list" style="margin-top:8px">${ahead.map(card).join('')}</ul>` : ''}`;
}

async function viewPlan(p) {
  const link = safeLink(p.link);
  const n = daysUntil(p.date);
  const onSaleFuture = p.onSale && new Date(p.onSale) > new Date();
  app.innerHTML = `
    <a class="back" href="#/upcoming">‹ Upcoming</a>
    <h1>${esc(p.artist)}</h1>
    <div class="countdown" style="font-size:18px">${countdownText(p.date)}</div>
    <div class="meta">${p.date ? esc(fmtDate(p.date)) : 'Date not announced yet'}${p.time ? ' · ' + esc(fmtTime(p.time)) : ''}</div>
    <div class="meta">${esc([p.venue, p.city].filter(Boolean).join(', '))}</div>
    <div style="margin-top:8px">${statusPill(p)}</div>

    ${n !== null && n < 0 ? `<div class="ask"><p>This date has passed. Did you go?</p>
      <div class="btnrow" style="margin-top:0"><button class="btn primary" data-act="went">Yes, log it</button><button class="btn" data-act="del">No, remove it</button></div></div>`
    : `<button class="btn primary block" data-act="went" style="margin-top:14px">✓ I went! Move it to My Shows</button>`}

    <div class="btnrow">
      <a class="btn" href="#/plan/${p.id}">✎ Edit</a>
      ${p.date ? '<button class="btn" data-act="cal">🗓 Calendar</button>' : '<span></span>'}
    </div>

    <section class="panel"><h2>Tickets</h2>
      <dl class="kv">
        <dt>Status</dt><dd>${p.status === 'got' ? 'Bought' : 'Not bought yet'}</dd>
        ${p.onSale ? `<dt>On sale</dt><dd>${esc(fmtDateTime(p.onSale))}${onSaleFuture ? ' <span class="pill want">Soon</span>' : ''}</dd>` : ''}
        ${p.price ? `<dt>${p.status === 'got' ? 'Paid' : 'Budget'}</dt><dd>${money(p.price)}</dd>` : ''}
      </dl>
      ${link ? `<a class="btn block" href="${esc(link)}" target="_blank" rel="noopener noreferrer" style="margin-top:12px">Open ticket page ↗</a>` : ''}
      ${onSaleFuture ? '<button class="btn block" data-act="salecal" style="margin-top:10px">⏰ On-sale reminder</button>' : ''}
    </section>
    ${p.withWho ? `<section class="panel"><h2>Going with</h2><div>${esc(p.withWho)}</div></section>` : ''}
    ${p.notes ? `<section class="panel"><h2>Notes</h2><div class="notes">${esc(p.notes)}</div></section>` : ''}
    <div style="margin-top:24px"><button class="btn danger block" data-act="del">Remove from my list</button></div>`;

  app.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'went') {
      // Turn the plan into a diary entry, keeping what's already known, then open it to add the setlist and rating.
      const s = { ...p, ticket: { ...(p.ticket || {}), price: p.status === 'got' && p.price ? p.price : (p.ticket?.price || '') }, updatedAt: Date.now() };
      delete s.kind; delete s.status; delete s.onSale; delete s.link; delete s.price;
      if (!s.date) s.date = todayIso();
      await dbPut('shows', s);
      toast('Moved to My Shows. Add the setlist and your rating!');
      location.hash = '#/edit/' + s.id;
    }
    if (act === 'del') {
      if (!confirm(`Remove ${p.artist} from your upcoming list?`)) return;
      await dbDel('shows', p.id); toast('Removed'); location.hash = '#/upcoming';
    }
    if (act === 'cal') saveIcs(icsForShow(p), `setlist-${safeName(p.artist)}.ics`);
    if (act === 'salecal') saveIcs(icsForOnSale(p), `tickets-${safeName(p.artist)}.ics`);
  };
}

// Calendar files (.ics) open in the phone's own Calendar app. No account or server needed.
function icsText(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => '\\' + c); }
function icsStamp(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
function icsLocal(d) { const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`; }
function icsWrap(uid, lines) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Setlist//Concert diary//EN', 'BEGIN:VEVENT',
    `UID:${uid}@setlist`, `DTSTAMP:${icsStamp(new Date())}`, ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
function icsForShow(p) {
  const loc = [p.venue, p.city].filter(Boolean).join(', ');
  let when;
  if (p.time) {
    const start = new Date(`${p.date}T${p.time}:00`), end = new Date(start.getTime() + 3 * 3600000);
    when = [`DTSTART:${icsLocal(start)}`, `DTEND:${icsLocal(end)}`];
  } else {
    const next = parseDate(p.date); next.setDate(next.getDate() + 1);
    when = [`DTSTART;VALUE=DATE:${p.date.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${icsLocal(next).slice(0, 8)}`];
  }
  return icsWrap(p.id, [...when, `SUMMARY:${icsText(p.artist + ' concert')}`, loc ? `LOCATION:${icsText(loc)}` : '',
    safeLink(p.link) ? `URL:${safeLink(p.link)}` : ''].filter(Boolean));
}
function icsForOnSale(p) {
  const start = new Date(p.onSale), end = new Date(start.getTime() + 30 * 60000);
  return icsWrap(p.id + '-onsale', [`DTSTART:${icsLocal(start)}`, `DTEND:${icsLocal(end)}`,
    `SUMMARY:${icsText('Tickets on sale: ' + p.artist)}`, safeLink(p.link) ? `URL:${safeLink(p.link)}` : '',
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText('Tickets on sale: ' + p.artist)}`, 'TRIGGER:-PT15M', 'END:VALARM'].filter(Boolean));
}
function saveIcs(text, name) {
  download(new Blob([text], { type: 'text/calendar' }), name);
  toast('Open the file to add it to your calendar');
}

async function viewPlanForm(id) {
  const existing = id ? await dbGet('shows', id) : null;
  if (id && (!existing || !isPlan(existing))) { location.hash = '#/upcoming'; return; }
  const p = existing || { artist: '', date: '', time: '', venue: '', city: '', status: 'want', onSale: '', price: '', link: '', withWho: '', notes: '' };
  app.innerHTML = `
    ${existing ? `<a class="back" href="#/show/${existing.id}">‹ Back</a><h1>Edit concert</h1>` : `
    <h1>Add a show</h1>
    <div class="seg" role="tablist"><a href="#/add">A show I went to</a><a class="on" href="#/plan" aria-current="page">A show I want to see</a></div>`}
    <form novalidate>
      <label class="field"><span>Artist <b class="req">*</b></span>
        <input name="artist" required autocomplete="off" autocapitalize="words" value="${esc(p.artist)}" placeholder="Who do you want to see?"></label>
      <div class="grid2">
        <label class="field"><span>Date</span><input name="date" type="date" value="${esc(p.date)}"></label>
        <label class="field"><span>Time</span><input name="time" type="time" value="${esc(p.time)}"></label>
      </div>
      <p class="muted small" style="margin:-6px 0 14px">No date yet? Leave it blank. It'll show as "Date not announced".</p>
      <label class="field"><span>Venue</span><input name="venue" autocapitalize="words" value="${esc(p.venue)}"></label>
      <label class="field"><span>City</span><input name="city" autocapitalize="words" value="${esc(p.city)}"></label>

      <div class="field"><span>Tickets</span>
        <div class="seg" style="margin:0">
          <label><input type="radio" name="status" value="want" ${p.status !== 'got' ? 'checked' : ''}>☆ Want to go</label>
          <label><input type="radio" name="status" value="got" ${p.status === 'got' ? 'checked' : ''}>🎟 Got tickets</label>
        </div></div>
      <label class="field"><span>Tickets go on sale</span><input name="onSale" type="datetime-local" value="${esc(p.onSale)}"></label>
      <label class="field"><span id="priceLabel">${p.status === 'got' ? 'Price paid ($)' : 'Budget ($)'}</span>
        <input name="price" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(p.price)}"></label>
      <label class="field"><span>Ticket page link</span><input name="link" type="url" inputmode="url" value="${esc(p.link)}" placeholder="https://…"></label>
      <label class="field"><span>Going with</span><input name="withWho" value="${esc(p.withWho)}" placeholder="Optional"></label>
      <label class="field"><span>Notes</span><textarea name="notes" rows="3" placeholder="Presale code reminder, who to text, songs you hope they play…">${esc(p.notes)}</textarea></label>
      <div class="savebar"><button class="btn primary block" type="submit">${existing ? 'Save changes' : 'Add to Upcoming'}</button></div>
    </form>`;
  const form = $('form', app);
  form.addEventListener('change', (e) => {
    if (e.target.name === 'status') $('#priceLabel').textContent = e.target.value === 'got' ? 'Price paid ($)' : 'Budget ($)';
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const artist = f.get('artist').trim();
    if (!artist) { toast('Add the artist’s name'); form.artist.focus(); return; }
    const link = f.get('link').trim();
    if (link && !safeLink(link)) { toast('The ticket link should start with https://'); form.link.focus(); return; }
    const plan = {
      ...(existing || {}), id: existing ? existing.id : uid(), kind: 'plan',
      artist, date: f.get('date') || '', time: f.get('time') || '', venue: f.get('venue').trim(), city: f.get('city').trim(),
      status: f.get('status') === 'got' ? 'got' : 'want', onSale: f.get('onSale') || '',
      price: f.get('price') ? Number(f.get('price')) : '', link, withWho: f.get('withWho').trim(), notes: f.get('notes').trim(),
      rating: 0, setlist: [], media: [], ticket: existing?.ticket || {},
      createdAt: existing ? existing.createdAt : Date.now(), updatedAt: Date.now(),
    };
    await dbPut('shows', plan);
    askPersist();
    toast(existing ? 'Changes saved' : 'Added to Upcoming');
    location.hash = '#/show/' + plan.id;
  };
}

// ===================== Stats =====================
async function viewStats() {
  const shows = await attendedShows();
  const yearNow = new Date().getFullYear();
  const rated = shows.filter((s) => s.rating);
  const avg = rated.length ? rated.reduce((a, s) => a + s.rating, 0) / rated.length : 0;
  const spend = shows.reduce((a, s) => a + (Number(s.ticket?.price) || 0), 0);
  const thisYear = shows.filter((s) => (s.date || '').startsWith(String(yearNow))).length;

  const byYear = {};
  shows.forEach((s) => { const y = (s.date || '').slice(0, 4); if (y) byYear[y] = (byYear[y] || 0) + 1; });
  const years = Object.keys(byYear).sort();
  const maxY = Math.max(1, ...Object.values(byYear));

  const count = (arr) => { const m = new Map(); arr.forEach(([key, label]) => { const e = m.get(key) || { label, n: 0 }; e.n++; m.set(key, e); }); return [...m.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)); };
  const artists = count(shows.map((s) => [s.artist.trim().toLowerCase(), s.artist.trim()]));
  const songs = count(shows.flatMap((s) => [...new Set(songsOnly(s.setlist).map((x) => x.toLowerCase()))].map((k) => [k, songsOnly(s.setlist).find((x) => x.toLowerCase() === k)])));

  app.innerHTML = `
    <h1>Your stats</h1>
    ${!shows.length ? `<p class="muted">Add a show and your stats will appear here.</p><a class="btn primary block" href="#/add">＋ Add a show</a>` : `
    <div class="tiles">
      <div class="tile"><div class="n">${shows.length}</div><div class="l">shows total</div></div>
      <div class="tile"><div class="n">${thisYear}</div><div class="l">shows in ${yearNow}</div></div>
      <div class="tile"><div class="n">${avg ? avg.toFixed(1) + '★' : '—'}</div><div class="l">average rating</div></div>
      <div class="tile"><div class="n">${money(spend)}</div><div class="l">spent on tickets</div></div>
    </div>
    <section class="panel"><h2>Shows per year</h2><div class="bars">
      ${years.map((y) => `<div class="bar"><span>${y}</span><div class="track"><div class="fill" style="width:${(byYear[y] / maxY) * 100}%"></div></div><span class="v">${byYear[y]}</span></div>`).join('')}
    </div></section>
    <section class="panel"><h2>Most-seen artists</h2><ol class="toplist">
      ${artists.slice(0, 5).map((a) => `<li>${esc(a.label)} <span class="c">· ${a.n} show${a.n > 1 ? 's' : ''}</span></li>`).join('')}
    </ol></section>
    <section class="panel"><h2>Songs you've heard live most</h2>
      ${songs.length ? `<ol class="toplist">${songs.slice(0, 10).map((x) => `<li>${esc(x.label)} <span class="c">· ${x.n}×</span></li>`).join('')}</ol>`
        : '<p class="muted">Add setlists to see your most-heard songs.</p>'}
    </section>`}
    <section class="panel"><h2>Your data</h2>
      <p class="muted small">Your diary is stored only on this phone. Back it up now and then, so you don't lose it if you change phones or clear your browser.</p>
      <div class="btnrow">
        <button class="btn" id="backup">⬇ Back up</button>
        <label class="btn filebtn">⬆ Restore<input type="file" accept="application/json,.json" id="restore"></label>
      </div>
    </section>`;

  $('#backup').onclick = backup;
  $('#restore').onchange = (e) => e.target.files[0] && restore(e.target.files[0]);
}

const blobToDataUrl = (b) => new Promise((r, j) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = () => j(fr.error); fr.readAsDataURL(b); });
async function backup() {
  toast('Preparing backup…');
  const shows = await dbAll('shows');
  const media = await Promise.all((await dbAll('media')).map(async (m) => ({ id: m.id, type: m.type, name: m.name, data: await blobToDataUrl(m.blob) })));
  const file = new File([JSON.stringify({ app: 'setlist', version: 1, exported: new Date().toISOString(), shows, media })],
    `setlist-backup-${todayIso()}.json`, { type: 'application/json' });
  if (!(await shareFiles([file], 'Setlist backup'))) { download(file, file.name); toast('Backup saved to your downloads'); }
}
async function restore(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'setlist' || !Array.isArray(data.shows)) throw new Error('This is not a Setlist backup file.');
    if (!confirm(`Restore ${data.shows.length} show(s) from this backup? Shows already on this phone are kept; matching ones are replaced.`)) return;
    for (const m of data.media || []) {
      const blob = await (await fetch(m.data)).blob();
      await dbPut('media', { id: m.id, type: m.type, name: m.name, blob });
    }
    for (const s of data.shows) await dbPut('shows', s);
    askPersist();
    toast(`Restored ${data.shows.length} show(s)`);
    location.hash = '#/shows';
  } catch (e) { toast('Restore failed: ' + e.message); }
}

route();
