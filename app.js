'use strict';
/* Setlist Diary: a private concert diary.
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
const handDate = (iso) => fmtDate(iso, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).toLowerCase();
const shortDate = (iso) => fmtDate(iso, { month: 'short', day: 'numeric', year: 'numeric' });
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
function isEncoreLine(line) { return /^(-+\s*)?encore\b.*$/i.test(line.trim()); }
function songsOnly(setlist) { return (setlist || []).filter((l) => l.trim() && !isEncoreLine(l)); }

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
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
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};

// ===================== Visual building blocks =====================
// Hand-drawn ink marks live as <symbol>s in index.html.
const ink = (id, cls = 'ink-svg') => `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#i-${id}"/></svg>`;
// Stable pseudo-random number per show, so each ticket keeps its look between visits.
function hash(str) { let h = 2166136261; for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

function starsInk(n) {
  n = Number(n) || 0;
  if (!n) return '<span class="unrated">not rated yet</span>';
  let s = '';
  for (let i = 1; i <= 5; i++) s += i <= n ? `<svg aria-hidden="true"><use href="#i-star"/></svg>` : `<svg class="off" aria-hidden="true"><use href="#i-star-o"/></svg>`;
  return `<span class="stars-ink" role="img" aria-label="${n} out of 5 stars">${s}</span>`;
}

// The ticket designs. Labels are decorative print, the same on every ticket
// of that design; everything in typewriter type is the user's own data.
const TICKET_DESIGNS = [
  { k: 'arena', label: 'Admit one' },
  { k: 'ga', label: 'General admission' },
  { k: 'indie', label: 'one night only' },
  { k: 'theater', label: 'Theatre · admit one' },
  { k: 'minimal', label: 'Admit one' },
  { k: 'festival', label: 'Live in concert' },
  { k: 'denim', label: 'Live on stage' },
  { k: 'sage', label: 'Keep this stub' },
];
function ticketHtml(s, o = {}) {
  const h = hash(s.id || s.artist);
  const v = TICKET_DESIGNS[h % TICKET_DESIGNS.length];
  const tilt = o.flat ? 0 : (((h >>> 5) % 25) - 12) / 10; // -1.2deg … 1.2deg
  const d = parseDate(s.date);
  const t = s.ticket || {};
  const seat = [
    t.section && `<span><b>Sec</b>${esc(t.section)}</span>`,
    t.seat && `<span><b>Row/Seat</b>${esc(t.seat)}</span>`,
    t.price && `<span><b>Paid</b>${money(t.price)}</span>`,
  ].filter(Boolean).join('');
  const isLink = o.link !== false;
  const tag = isLink ? 'a' : 'div';
  const label = `${s.artist}, ${shortDate(s.date)}${s.venue ? ', ' + s.venue : ''}${s.city ? ', ' + s.city : ''}${s.rating ? `, rated ${s.rating} of 5` : ''}`;
  const attrs = isLink ? ` href="#/show/${esc(s.id)}" aria-label="${esc(label)}"` : '';
  return `<${tag} class="tix v-${v.k}"${attrs} style="--tilt:${tilt}deg">
    <div class="tix-shape">
      <div class="tix-main">
        <span class="tix-label" aria-hidden="true">${v.label}</span>
        <span class="tix-artist">${esc(s.artist)}</span>
        <span class="tix-meta">${esc(s.venue || '')}${s.venue && s.city ? '<br>' : ''}${esc(s.city || '')}${s.time ? `<br>Doors ${esc(fmtTime(s.time))}` : ''}</span>
        ${seat ? `<span class="tix-seat">${seat}</span>` : ''}
        <span class="tix-foot">${starsInk(s.rating)}</span>
      </div>
      <div class="tix-stub">
        ${d ? `<span class="tix-mon">${d.toLocaleDateString(undefined, { month: 'short' })}</span>
        <span class="tix-day">${d.getDate()}</span><span class="tix-yr">${d.getFullYear()}</span>` : '<span class="tix-mon">TBA</span>'}
        ${o.num ? `<span class="tix-no" title="Diary entry ${o.num}">${String(o.num).padStart(3, '0')}</span>` : ''}
      </div>
    </div>
  </${tag}>`;
}

function polaroidHtml(url, o = {}) {
  return `<figure class="polaroid ${o.cls || ''}" style="${o.r !== undefined ? `--r:${o.r}deg` : ''}">
    ${o.tape === false ? '' : '<span class="tape tc"></span>'}
    <img src="${url}" alt="${esc(o.alt || 'Photo from the show')}" loading="lazy">
    ${o.caption ? `<figcaption>${esc(o.caption)}</figcaption>` : ''}
  </figure>`;
}

// The setlist, as a sheet taped to the stage floor. Tap a song to circle it.
function setlistHtml(s, o = {}) {
  const lines = (s.setlist || []).filter((l) => l.trim());
  const favs = new Set((s.favs || []).map((x) => x.toLowerCase()));
  let n = 0;
  const items = lines.map((l) => {
    if (isEncoreLine(l)) return `<li class="enc">encore${ink('under', 'u')}</li>`;
    n++;
    const fav = favs.has(l.toLowerCase());
    const inner = `<span class="n">${n}</span><span class="t">${esc(l)}${ink('circle', 'ring')}</span>${ink('star', 'fav-star')}`;
    return o.interactive
      ? `<li><button type="button" class="song" data-song="${esc(l)}" aria-pressed="${fav}" aria-describedby="sl-hint">${inner}</button></li>`
      : `<li><span class="song" ${fav ? 'aria-pressed="true"' : ''}>${inner}</span></li>`;
  });
  const count = songsOnly(s.setlist).length;
  return `<section class="setlist-wrap" aria-labelledby="sl-h">
    <span class="tape tl"></span><span class="tape tr"></span>
    <div class="setlist-sheet">
      <div class="sl-head"><h2 class="sl-title" id="sl-h">Setlist</h2>
        <span class="sl-sub">${esc(shortDate(s.date))}${s.venue ? `<br>${esc(s.venue)}` : ''}<br>${count} song${count === 1 ? '' : 's'}</span></div>
      ${lines.length ? `<ol class="sl">${items.join('')}</ol>` : `<p class="sl-empty">no songs written down yet${o.editHref ? ` · <a href="${o.editHref}">add the setlist</a>` : ''}</p>`}
      ${o.interactive && count ? `<p class="sl-hint" id="sl-hint">${ink('star')} tap a song to circle it as a favourite</p>` : ''}
    </div>
  </section>`;
}

// ===================== Router =====================
function setTab(name) {
  document.querySelectorAll('.tabbar a').forEach((a) => {
    const on = a.dataset.tab === name;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}
async function route() {
  releaseUrls();
  app.onclick = null;
  const h = location.hash || '#/shows';
  window.scrollTo(0, 0);
  const [, view, id] = h.split('/');
  document.body.dataset.view = h.startsWith('#share=') ? 'shared' : h.startsWith('#xfer=') ? 'xfer' : (!view || view === 'shows') ? 'home' : view;
  try {
    if (h.startsWith('#share=')) { setTab(''); return await viewShared(h.slice(7)); }
    if (h.startsWith('#xfer=')) { setTab(''); return await viewXfer(h.slice(6)); }
    if (view === 'add') { setTab('add'); return await viewForm(null); }
    if (view === 'plan') { setTab(id ? '' : 'add'); return await viewPlanForm(id || null); }
    if (view === 'upcoming') { setTab('upcoming'); return await viewUpcoming(); }
    if (view === 'edit' && id) { setTab(''); return await viewForm(id); }
    if (view === 'show' && id) { setTab('shows'); return await viewShow(id); }
    if (view === 'stats') { setTab('stats'); return await viewStats(); }
    setTab('shows'); return await viewList();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="empty-page"><span class="tape tc"></span>
      <p class="big-hand">well, that didn't work.</p>
      <p>Something went wrong: ${esc(e.message)}</p>
      <a class="btn" href="#/shows">Back to my diary</a></div>`;
  }
}
window.addEventListener('hashchange', route);

// ===================== Home: the diary & the collection =====================
// Diary entries are shows you went to. Future concerts are stored alongside them with kind: 'plan'.
const isPlan = (s) => s.kind === 'plan';
async function attendedShows() { return (await dbAll('shows')).filter((s) => !isPlan(s)); }
const byDateDesc = (a, b) => (b.date || '').localeCompare(a.date || '') || (b.time || '').localeCompare(a.time || '');

async function viewList() {
  const all = await dbAll('shows');
  const shows = all.filter((s) => !isPlan(s)).sort(byDateDesc);
  const plans = all.filter(isPlan);
  const nextPlan = plans.filter((p) => p.date && daysUntil(p.date) >= 0).sort((a, b) => a.date.localeCompare(b.date))[0]
    || plans.find((p) => !p.date);
  const media = new Map((await dbAll('media')).map((m) => [m.id, m]));
  const photoOf = new Map();
  for (const s of shows) {
    const m = (s.media || []).map((id) => media.get(id)).find((x) => x && x.type.startsWith('image/'));
    if (m) photoOf.set(s.id, blobUrl(m.blob));
  }
  // Entry numbers: the 1st show you ever logged is No. 001.
  const numOf = new Map([...shows].reverse().map((s, i) => [s.id, i + 1]));

  const yearNow = String(new Date().getFullYear());
  const rated = shows.filter((s) => s.rating);
  const avg = rated.length ? rated.reduce((a, s) => a + s.rating, 0) / rated.length : 0;

  const hero = `<section class="hero">
    <div>
      <h1 class="wordmark">Setlist Diary${ink('under', 'u')}</h1>
      <p class="hero-sub">a little record of the nights worth remembering</p>
    </div>
    <span class="stamp" aria-hidden="true">Private · this phone only</span>
  </section>`;

  const nextUp = nextPlan ? `<section class="nextup" aria-label="Next up">
      <p class="kicker">next up ${ink('arrow')}</p>
      <ul class="flyer-grid" style="grid-template-columns:1fr">${flyerHtml(nextPlan)}</ul>
    </section>` : '';

  if (!shows.length) {
    app.innerHTML = `${hero}
      <div class="home-grid">
        <div class="empty-page"><span class="tape tl"></span><span class="tape tr"></span>
          <p class="big-hand">nothing here yet.</p>
          <p>Every show you go to becomes a ticket stub in this book: the setlist, your rating, the photos and the ticket itself.</p>
          <div class="tix-ghost">your first ticket goes here</div>
          <a class="btn stamp-btn block" href="#/add">${ink('plus')} Add your first show</a>
          <p class="lock-note">${ink('ast')} your diary stays private, on this phone.</p>
        </div>
        ${nextUp || `<section class="nextup"><p class="kicker">on the horizon ${ink('arrow')}</p>
          <a class="btn block" href="#/plan">Add a show you want to see</a></section>`}
      </div>`;
    return;
  }

  const latest = shows[0];
  const latestPhoto = photoOf.get(latest.id);
  app.innerHTML = `${hero}
    <p class="hero-stats">
      <span><b>${shows.length}</b> show${shows.length === 1 ? '' : 's'}</span>
      <span>·</span><span><b>${shows.filter((s) => (s.date || '').startsWith(yearNow)).length}</b> in ${yearNow}</span>
      ${avg ? `<span>·</span><span>avg <b>${avg.toFixed(1)}</b> ★</span>` : ''}
      <a href="#/stats">the numbers ${ink('arrow')}</a>
    </p>

    <div class="home-grid">
      <section class="latest" aria-label="Latest show">
        <p class="kicker">the latest one ${ink('arrow')}</p>
        ${latestPhoto ? polaroidHtml(latestPhoto, { r: 7, alt: '' }) : ''}
        ${ticketHtml(latest, { num: numOf.get(latest.id) })}
      </section>
      ${nextUp || `<section class="nextup" aria-label="Next up"><p class="kicker">on the horizon ${ink('arrow')}</p>
        <div class="empty-page" style="margin-top:0"><p>Nothing planned. Keep a list of shows you'd love to see.</p>
        <a class="btn block" href="#/plan">Add a show you want to see</a></div></section>`}
    </div>

    <div class="log-cta"><a class="btn stamp-btn" href="#/add">${ink('plus')} Log a show</a><span class="annot" aria-hidden="true">${ink('arrow')} got a new stub?</span></div>

    <section aria-labelledby="coll-h">
      <div class="section-head"><h2 id="coll-h">the collection</h2><span class="aside">${shows.length} stub${shows.length === 1 ? '' : 's'} &amp; counting</span></div>
      <div class="archive-tools">
        <div class="search-wrap">${ink('note')}<input class="search" type="search" placeholder="search artist, venue, city or song" aria-label="Search shows"></div>
        <div class="tool-row">
          <div class="viewtabs" role="group" aria-label="View the collection as">
            <button type="button" data-v="tickets">tickets</button><button type="button" data-v="diary">diary</button><button type="button" data-v="list">list</button>
          </div>
          <label class="sortpick">sort <select aria-label="Sort shows">
            <option value="new">newest first</option><option value="old">oldest first</option><option value="rating">best rated</option></select></label>
        </div>
      </div>
      <div id="archive"></div>
      <p class="no-match" hidden>nothing in the diary matches that…</p>
    </section>`;

  for (const s of shows) s._search = [s.artist, s.venue, s.city, ...(s.setlist || [])].join(' ').toLowerCase();
  let mode = store.get('sd-view', 'tickets'); if (!['tickets', 'diary', 'list'].includes(mode)) mode = 'tickets';
  let sort = store.get('sd-sort', 'new'); if (!['new', 'old', 'rating'].includes(sort)) sort = 'new';
  const sel = $('.sortpick select', app); sel.value = sort;
  const box = $('#archive', app);

  function render() {
    const q = $('.search', app).value.trim().toLowerCase();
    let list = shows.filter((s) => !q || s._search.includes(q));
    if (sort === 'old') list = [...list].reverse();
    if (sort === 'rating') list = [...list].sort((a, b) => (b.rating || 0) - (a.rating || 0) || byDateDesc(a, b));
    app.querySelectorAll('.viewtabs button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === mode));
    $('.no-match', app).hidden = list.length > 0;
    const groups = [];
    if (sort === 'rating') groups.push({ label: 'best first', items: list });
    else for (const s of list) {
      const y = (s.date || '').slice(0, 4) || 'undated';
      if (!groups.length || groups[groups.length - 1].label !== y) groups.push({ label: y, items: [] });
      groups[groups.length - 1].items.push(s);
    }
    box.innerHTML = groups.map((g) => `<section class="year-group" aria-label="${esc(g.label)}">
      <div class="year-head"><h3>${esc(g.label)}${ink('under', 'u')}</h3><span class="count">${g.items.length} show${g.items.length === 1 ? '' : 's'}</span></div>
      ${renderItems(g.items)}</section>`).join('');
  }
  function renderItems(items) {
    if (mode === 'diary') return `<ul class="diary-list">${items.map((s) => `<li><a class="diary-entry" href="#/show/${esc(s.id)}">
        <span class="de-date">${esc(handDate(s.date))}</span>
        <span class="de-body"><span class="de-artist">${esc(s.artist)}</span>
          <span class="de-venue">${esc([s.venue, s.city].filter(Boolean).join(' · '))}</span>
          <span class="de-stars">${starsInk(s.rating)}</span>
          ${s.notes ? `<span class="de-note">${esc(s.notes.length > 170 ? s.notes.slice(0, 170).trim() + '…' : s.notes)}</span>` : ''}</span>
        ${photoOf.get(s.id) ? `<span class="de-photo polaroid" aria-hidden="true"><img src="${photoOf.get(s.id)}" alt=""></span>` : ''}
      </a></li>`).join('')}</ul>`;
    if (mode === 'list') return `<ul class="compact-list">${items.map((s) => { const d = parseDate(s.date); return `<li><a href="#/show/${esc(s.id)}">
        <span class="cl-date">${d ? `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}.${String(d.getFullYear()).slice(2)}` : '--'}</span>
        <span><span class="cl-artist">${esc(s.artist)}</span><span class="cl-venue">${esc([s.venue, s.city].filter(Boolean).join(' · '))}</span></span>
        <span class="cl-stars">${s.rating ? starsInk(s.rating) : ''}</span></a></li>`; }).join('')}</ul>`;
    return `<ul class="ticket-grid">${items.map((s) => `<li>${ticketHtml(s, { num: numOf.get(s.id) })}</li>`).join('')}</ul>`;
  }
  $('.search', app).addEventListener('input', render);
  sel.addEventListener('change', () => { sort = sel.value; store.set('sd-sort', sort); render(); });
  $('.viewtabs', app).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    mode = b.dataset.v; store.set('sd-view', mode); render();
  });
  render();
}

// ===================== Concert page: a scrapbook spread =====================
async function viewShow(id) {
  const s = await dbGet('shows', id);
  if (!s) { location.hash = '#/shows'; return; }
  if (isPlan(s)) { setTab('upcoming'); document.body.dataset.view = 'plan-detail'; return viewPlan(s); }
  const media = (await Promise.all((s.media || []).map((m) => dbGet('media', m)))).filter(Boolean);
  const t = s.ticket || {};
  const ticketFile = t.fileId ? await dbGet('media', t.fileId) : null;
  const hasTicket = t.seat || t.section || t.price || t.order || ticketFile || t.givenTo;
  const attended = (await attendedShows()).sort(byDateDesc).reverse();
  const num = attended.findIndex((x) => x.id === s.id) + 1;

  const photos = media.map((m, i) => m.type.startsWith('video/')
    ? `<figure class="polaroid video"><span class="tape tc"></span><video src="${blobUrl(m.blob)}" controls playsinline preload="metadata"></video><figcaption>▶ ${esc(m.name || 'video')}</figcaption></figure>`
    : polaroidHtml(blobUrl(m.blob), { caption: i === 0 ? shortDate(s.date).toLowerCase() : '' })).join('');

  app.innerHTML = `
    <a class="back" href="#/shows">${ink('back')} back to the diary</a>
    <article class="spread journal">
      <div class="page">
        <p class="entry-date">${esc(handDate(s.date))}${s.time ? ` <span style="white-space:nowrap">· ${esc(fmtTime(s.time).toLowerCase())}</span>` : ''}</p>
        <h1 class="entry-artist worn">${esc(s.artist)}</h1>
        ${s.venue || s.city ? `<p class="entry-venue">${esc([s.venue, s.city].filter(Boolean).join(', '))}</p>` : ''}
        ${s.withWho ? `<p class="entry-with">with ${esc(s.withWho)}</p>` : ''}
        <div class="entry-rating">${starsInk(s.rating)}${s.rating ? `<span class="annot">${s.rating} out of 5</span>` : ''}</div>
        ${photos ? `<div class="photos" aria-label="Photos and videos">${photos}</div>` : ''}
        <div class="entry-ticket">${ticketHtml(s, { link: false, num, flat: true })}</div>
        <div class="entry-actions">
          <button class="btn stamp-btn" id="shareBtn">Share</button>
          <a class="btn" href="#/edit/${esc(s.id)}">Edit</a>
        </div>
      </div>
      <div class="page">
        ${setlistHtml(s, { interactive: true, editHref: `#/edit/${s.id}` })}
        <section class="lined-note" aria-labelledby="notes-h"><span class="tape tc"></span>
          <h2 id="notes-h">notes from the night</h2>
          ${s.notes ? `<p class="notes">${esc(s.notes)}</p>` : `<p class="notes faint">nothing written yet… <a href="#/edit/${esc(s.id)}">add a few lines</a></p>`}
        </section>
        ${hasTicket ? `<section class="wallet" aria-labelledby="w-h">
          <h2 id="w-h">Ticket</h2>
          <dl>
            ${t.section ? `<dt>Section</dt><dd>${esc(t.section)}</dd>` : ''}
            ${t.seat ? `<dt>Row / seat</dt><dd>${esc(t.seat)}</dd>` : ''}
            ${t.price ? `<dt>Paid</dt><dd>${money(t.price)}</dd>` : ''}
            ${t.order ? `<dt>Order #</dt><dd>${esc(t.order)}</dd>` : ''}
            ${t.givenTo ? `<dt>For</dt><dd>${esc(t.givenTo)}</dd>` : ''}
          </dl>
          ${t.givenTo ? (t.transferred ? '<span class="stamp ok">✓ Transferred</span>' : '<span class="stamp no">Not transferred yet</span>') : ''}
          ${ticketFile ? (ticketFile.type.startsWith('image/')
            ? `<figure class="ticket-photo"><span class="tape tc"></span><img src="${blobUrl(ticketFile.blob)}" alt="Ticket"></figure>`
            : `<span class="file-chip">📄 ${esc(ticketFile.name || 'Ticket file')}</span>`) : ''}
          ${ticketFile ? `<div class="btnrow">
            <a class="btn small" href="${blobUrl(ticketFile.blob)}" target="_blank" rel="noopener">Open ticket</a>
            <button class="btn small" id="sendTicket">Send to a friend</button></div>
            <p class="fine">Only works for print-at-home or PDF tickets. Mobile tickets with a moving barcode must be transferred in the ticket seller's app.</p>` : ''}
        </section>` : ''}
        <div class="danger-zone"><button class="link-red" id="delBtn">Delete this show</button></div>
      </div>
    </article>`;

  $('#shareBtn').onclick = () => openShareDialog(s, media);
  $('#delBtn').onclick = async () => {
    if (!confirm(`Delete ${s.artist} (${shortDate(s.date)})? Its photos and videos will be deleted too. This can't be undone.`)) return;
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
  // Circle favourite songs on the setlist.
  app.querySelector('.sl')?.addEventListener('click', async (e) => {
    const b = e.target.closest('button.song'); if (!b) return;
    const song = b.dataset.song, key = song.toLowerCase();
    const favs = (s.favs || []).filter((x) => x.toLowerCase() !== key);
    const on = b.getAttribute('aria-pressed') !== 'true';
    if (on) favs.push(song);
    s.favs = favs;
    b.setAttribute('aria-pressed', on);
    try { await dbPut('shows', { ...s, updatedAt: Date.now() }); } catch (err) { toast('Could not save that: ' + err.message); }
  });
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
  dlg.setAttribute('aria-labelledby', 'share-h');
  dlg.innerHTML = `<span class="tape tc"></span>
    <h2 id="share-h">pass it on</h2>
    <p class="sub">Your diary stays private. You choose what to send.</p>
    <div class="opt">
      <button class="btn stamp-btn block" data-act="link">Share a link</button>
      <p>Sends the artist, date, venue, rating and setlist. Photos, your ticket and who you went with are never included.</p>
      <label class="check"><input type="checkbox" data-notes> Include my notes in the link</label>
    </div>
    <div class="opt">
      <button class="btn block" data-act="card">Share as a picture</button>
      <p>Makes an image with ${media.some((m) => m.type.startsWith('image/')) ? 'your first photo, ' : ''}the details and the setlist, ready for Messages or Instagram.</p>
    </div>
    <button class="link-red" data-act="close" style="width:100%">cancel</button>`;
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
      const text = `${s.artist} · ${shortDate(s.date)}${s.venue ? ' · ' + s.venue : ''}`;
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

// The shareable picture: a diary page with a taped polaroid and the setlist.
async function makeCard(s, photo) {
  const W = 1080, H = 1350, P = 80;
  try { await Promise.all(['40px "SD Poster"', '40px "SD Typewriter"', '40px "SD Marker"', '40px "SD Diary"', '700 40px "SD Pen"'].map((f) => document.fonts.load(f))); } catch (e) {}
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const INK = '#25231F', SOFT = '#574F43', RED = '#B52E3D', PAPER = '#F5EFE2';
  g.fillStyle = PAPER; g.fillRect(0, 0, W, H);
  // paper grain
  for (let i = 0; i < 9000; i++) { g.fillStyle = `rgba(80,60,30,${Math.random() * 0.06})`; g.fillRect(Math.random() * W, Math.random() * H, 1.6, 1.6); }
  const fit = (text, maxW) => { let t = text; while (g.measureText(t).width > maxW && t.length > 1) t = t.slice(0, -2) + '…'; return t; };
  const tape = (x, y, w, h, rot) => { g.save(); g.translate(x, y); g.rotate(rot); g.fillStyle = 'rgba(226,206,155,.85)'; g.fillRect(-w / 2, -h / 2, w, h); g.restore(); };
  let y = 70;
  if (photo) {
    try {
      const url = URL.createObjectURL(photo.blob);
      const img = new Image(); img.src = url; await img.decode();
      const fw = 600, ph = 540, fh = ph + 96;
      g.save(); g.translate(W / 2 + 40, y + fh / 2); g.rotate(-0.045);
      g.shadowColor = 'rgba(37,35,31,.35)'; g.shadowBlur = 24; g.shadowOffsetY = 10;
      g.fillStyle = '#FBF8F1'; g.fillRect(-fw / 2, -fh / 2, fw, fh);
      g.shadowColor = 'transparent';
      const iw = fw - 40, r = Math.max(iw / img.naturalWidth, ph / img.naturalHeight), sw = iw / r, sh = ph / r;
      g.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, -fw / 2 + 20, -fh / 2 + 20, iw, ph);
      g.fillStyle = SOFT; g.font = '700 38px "SD Pen", cursive'; g.textBaseline = 'middle';
      g.fillText(shortDate(s.date).toLowerCase(), -fw / 2 + 28, fh / 2 - 38);
      g.restore();
      tape(W / 2 + 40, y + 4, 170, 46, -0.08);
      URL.revokeObjectURL(url);
      y += fh + 50;
    } catch (e) {}
  }
  g.textBaseline = 'top';
  g.fillStyle = SOFT; g.font = '36px "SD Diary", cursive';
  g.fillText(fit(handDate(s.date), W - 2 * P), P, y); y += 62;
  g.fillStyle = INK; g.font = '104px "SD Poster", Impact, sans-serif';
  g.fillText(fit(s.artist.toUpperCase(), W - 2 * P), P, y); y += 118;
  g.font = '32px "SD Typewriter", monospace'; g.fillStyle = INK;
  const where = [s.venue, s.city].filter(Boolean).join(', ').toUpperCase();
  if (where) { g.fillText(fit(where, W - 2 * P), P, y); y += 50; }
  if (s.rating) {
    const star = new Path2D('M12.3 1.9l2.5 6.7 7.2.2-5.6 4.7 2 7.1-6.3-4.1-5.8 4.2 1.5-7.2L2.1 9l7.3-.5z');
    for (let i = 0; i < 5; i++) {
      g.save(); g.translate(P + i * 52, y + 4); g.rotate(((i % 2) ? 1 : -1) * 0.12); g.scale(2, 2);
      if (i < s.rating) { g.fillStyle = RED; g.fill(star); } else { g.strokeStyle = 'rgba(37,35,31,.3)'; g.lineWidth = 1.2; g.stroke(star); }
      g.restore();
    }
    y += 70;
  }
  const lines = (s.setlist || []).filter((l) => l.trim());
  if (lines.length) {
    y += 16;
    g.fillStyle = INK; g.font = '52px "SD Marker", cursive'; g.fillText('SETLIST', P, y);
    g.fillRect(P, y + 62, W - 2 * P, 4); y += 82;
    const room = Math.max(1, Math.floor((H - y - 120) / 50));
    let n = 0;
    for (let i = 0; i < lines.length && i < room; i++) {
      const l = lines[i];
      if (i === room - 1 && lines.length > room) { g.fillStyle = SOFT; g.font = '700 36px "SD Pen", cursive'; g.fillText(`+ ${lines.length - i} more…`, P + 60, y); break; }
      if (isEncoreLine(l)) { g.fillStyle = RED; g.font = '700 38px "SD Pen", cursive'; g.fillText('encore', P + 60, y); }
      else { n++; g.fillStyle = SOFT; g.font = '26px "SD Typewriter", monospace'; g.fillText(String(n), P, y + 8); g.fillStyle = INK; g.font = '38px "SD Marker", cursive'; g.fillText(fit(l, W - 2 * P - 60), P + 60, y); }
      y += 50;
    }
  }
  g.save(); g.translate(W - P, H - 60); g.rotate(-0.05); g.textAlign = 'right'; g.textBaseline = 'alphabetic';
  g.fillStyle = RED; g.font = '54px "SD Diary", cursive'; g.fillText('setlist diary', 0, 0); g.restore();
  return new Promise((r) => c.toBlob(r, 'image/png'));
}

async function viewShared(code) {
  let s;
  try { s = await decodeShare(code); } catch (e) {
    app.innerHTML = `<div class="empty-page"><span class="tape tc"></span><p class="big-hand">this page got torn.</p>
      <p>The link may have been cut off when it was copied. Ask for the link again.</p>
      <a class="btn" href="#/shows">Go to my diary</a></div>`;
    return;
  }
  const show = { artist: s.a || 'Unknown artist', date: s.d || '', time: s.t || '', venue: s.ve || '', city: s.c || '',
    rating: Number(s.r) || 0, setlist: Array.isArray(s.sl) ? s.sl.map(String) : [], notes: s.n || '' };
  app.innerHTML = `
    <p class="shared-note"><span class="tape tc"></span>Someone tore this page out of their Setlist Diary for you.</p>
    <article class="spread journal">
      <div class="page">
        <p class="entry-date">${esc(handDate(show.date))}${show.time ? ` · ${esc(fmtTime(show.time).toLowerCase())}` : ''}</p>
        <h1 class="entry-artist worn">${esc(show.artist)}</h1>
        ${show.venue || show.city ? `<p class="entry-venue">${esc([show.venue, show.city].filter(Boolean).join(', '))}</p>` : ''}
        <div class="entry-rating">${starsInk(show.rating)}${show.rating ? `<span class="annot">${show.rating} out of 5</span>` : ''}</div>
        <div class="entry-actions">
          <button class="btn stamp-btn" id="saveCopy">I was there too: add to my diary</button>
          <a class="btn" href="#/shows">Go to my diary</a>
        </div>
      </div>
      <div class="page">
        ${setlistHtml(show, { interactive: false })}
        ${show.notes ? `<section class="lined-note" aria-labelledby="notes-h"><h2 id="notes-h">their notes</h2><p class="notes">${esc(show.notes)}</p></section>` : ''}
      </div>
    </article>`;
  $('#saveCopy').onclick = async () => {
    const id = uid();
    await dbPut('shows', { ...show, notes: '', rating: 0, id, media: [], ticket: {}, withWho: '', createdAt: Date.now(), updatedAt: Date.now() });
    askPersist();
    toast('Added. Now add your own rating and photos.');
    location.hash = '#/edit/' + id;
  };
}

// ===================== Add / Edit: a notebook page =====================
function chooseTabs(which) {
  return `<nav class="choose" aria-label="What are you adding?">
    <a href="#/add" class="${which === 'went' ? 'on' : ''}" ${which === 'went' ? 'aria-current="page"' : ''}>A show I went to</a>
    <a href="#/plan" class="${which === 'plan' ? 'on' : ''}" ${which === 'plan' ? 'aria-current="page"' : ''}>A show I want to see</a>
  </nav>`;
}

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
    ${existing ? `<a class="back" href="#/show/${esc(existing.id)}">${ink('back')} back to the page</a>` : ''}
    <div class="form-wrap">
    <h1 class="page-title">${existing ? 'edit this page' : 'log a show'}</h1>
    ${existing ? '' : chooseTabs('went')}
    <form class="notebook" novalidate>
      <label class="field"><span class="lab">Artist <span class="req">*</span></span>
        <input name="artist" required autocomplete="off" autocapitalize="words" value="${esc(s.artist)}" placeholder="who did you see?"></label>
      <div class="grid2">
        <label class="field"><span class="lab">Date <span class="req">*</span></span><input name="date" type="date" required value="${esc(s.date)}"></label>
        <label class="field"><span class="lab">Time</span><input name="time" type="time" value="${esc(s.time)}"></label>
      </div>
      <label class="field"><span class="lab">Venue</span><input name="venue" autocapitalize="words" value="${esc(s.venue)}" placeholder="e.g. Madison Square Garden"></label>
      <label class="field"><span class="lab">City</span><input name="city" autocapitalize="words" value="${esc(s.city)}" placeholder="e.g. New York"></label>

      <div class="field"><span class="lab" id="rate-l">Your rating</span>
        <div class="starpick" role="group" aria-labelledby="rate-l">
          ${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">${ink('star', '')}</button>`).join('')}
        </div></div>

      <label class="field"><span class="lab">Setlist <span class="opt">one song per line</span></span>
        <textarea class="setlist-input" name="setlist" rows="8" placeholder="Opening song&#10;Second song&#10;…&#10;Encore&#10;Last song">${esc((s.setlist || []).join('\n'))}</textarea>
        <span class="help">Type <b>Encore</b> on its own line to mark the encore.</span></label>

      <div class="field"><span class="lab">Photos &amp; videos</span>
        <div class="mediagrid" id="mg"></div>
        <label class="btn block filebtn">${ink('plus')} Add photos or videos
          <input type="file" accept="image/*,video/*" multiple id="pickMedia"></label>
      </div>

      <label class="field"><span class="lab">Who you went with</span><input name="withWho" value="${esc(s.withWho)}" placeholder="optional, never shared"></label>
      <label class="field"><span class="lab">Notes</span><textarea class="notes-input" name="notes" rows="4" placeholder="best moment, the opener, what you'll remember…">${esc(s.notes)}</textarea></label>

      <details class="envelope" ${t.seat || t.section || t.price || t.order || t.fileId || t.givenTo ? 'open' : ''}>
        <summary>Ticket <span class="hand">optional · tuck it in here</span></summary>
        <div class="inner">
          <div class="grid2">
            <label class="field"><span class="lab">Section</span><input name="section" value="${esc(t.section)}"></label>
            <label class="field"><span class="lab">Row / seat</span><input name="seat" value="${esc(t.seat)}"></label>
          </div>
          <div class="grid2">
            <label class="field"><span class="lab">Price paid ($)</span><input name="price" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(t.price)}"></label>
            <label class="field"><span class="lab">Order #</span><input name="order" value="${esc(t.order)}"></label>
          </div>
          <div class="field"><span class="lab">Ticket picture or PDF</span>
            <div id="tf" class="file-row"></div>
            <label class="btn block filebtn"><span id="tfLabel">Attach ticket</span>
              <input type="file" accept="image/*,application/pdf" id="pickTicket"></label></div>
          <label class="field"><span class="lab">Ticket is for <span class="opt">if not you</span></span><input name="givenTo" value="${esc(t.givenTo)}" placeholder="e.g. Sam"></label>
          <label class="check"><input type="checkbox" name="transferred" ${t.transferred ? 'checked' : ''}> I've transferred it to them</label>
        </div>
      </details>

      <div class="savebar"><button class="btn stamp-btn block" type="submit" id="saveBtn">${existing ? 'Save changes' : 'Save to diary'}</button></div>
    </form>
    </div>`;

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
      d.innerHTML = (m.type.startsWith('video/') ? `<video src="${url}" muted playsinline preload="metadata"></video><span class="vtag">▶ video</span>`
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
    $('#tf', app).innerHTML = cur ? `📄 ${esc(cur.name || 'Ticket attached')} <button type="button" class="btn small" id="rmTicket">Remove</button>` : '';
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
        ...(existing || {}), // keeps anything else saved on the show, e.g. circled favourite songs
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

// ===================== Upcoming: gig flyers =====================
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
function safeLink(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch (e) { return ''; }
}
function fmtDateTime(dt) {
  if (!dt) return '';
  const d = new Date(dt);
  return isNaN(d) ? '' : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
const FLYER_BG = ['#EDE5D2', '#E3C98C', '#E9CDD1', '#BCD4CF', '#E7BE9E', '#C9D1BC'];

function flyerHtml(p) {
  const f = hash(p.id) % 6;
  const d = parseDate(p.date);
  const label = `${p.artist}, ${p.date ? shortDate(p.date) : 'date not announced'}${p.venue ? ', ' + p.venue : ''}. ${countdownText(p.date)}. ${p.status === 'got' ? 'Got tickets' : 'Want to go'}`;
  return `<li><a class="flyer f-${f}" href="#/show/${esc(p.id)}" aria-label="${esc(label)}">
    <span class="tape tc"></span>
    <span class="fl-live" aria-hidden="true">Live</span>
    <span class="fl-artist">${esc(p.artist)}</span>
    <span class="fl-date">${d ? `<span class="m">${d.toLocaleDateString(undefined, { month: 'short' })}</span><span class="d">${d.getDate()}</span><span class="y">${d.getFullYear()}</span>`
      : '<span class="m">Date</span><span class="d">?</span><span class="y">TBA</span>'}</span>
    <span class="fl-meta">${esc(p.venue || '')}${p.venue && p.city ? '<br>' : ''}${esc(p.city || '')}</span>
    <span class="fl-foot"><span class="countdown-ink">${esc(countdownText(p.date).toLowerCase())}${ink('circle', 'ring')}</span>
      <span class="stamp" style="--stamp:${p.status === 'got' ? '#2f5e3a' : 'var(--burgundy)'}">${p.status === 'got' ? 'Got tickets' : 'Want to go'}</span></span>
  </a></li>`;
}

async function viewUpcoming() {
  const plans = (await dbAll('shows')).filter(isPlan);
  const past = plans.filter((p) => p.date && daysUntil(p.date) < 0).sort((a, b) => a.date.localeCompare(b.date));
  const ahead = plans.filter((p) => !p.date || daysUntil(p.date) >= 0)
    .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.time || '').localeCompare(b.time || ''));

  if (!plans.length) {
    app.innerHTML = `<h1 class="page-title">upcoming</h1>
      <div class="empty-page"><span class="tape tl"></span><span class="tape tr"></span>
      <p class="big-hand">no flyers on the wall yet.</p>
      <p>Pin up the shows you'd like to see, with a countdown, when tickets go on sale, and your budget.</p>
      <a class="btn stamp-btn block" href="#/plan">${ink('plus')} Add a concert you want to see</a></div>`;
    return;
  }
  app.innerHTML = `
    <h1 class="page-title">upcoming</h1>
    <p class="page-sub">${ahead.length} concert${ahead.length === 1 ? '' : 's'} on your list · flyers on the bedroom wall</p>
    <a class="btn stamp-btn block" href="#/plan" style="max-width:420px">${ink('plus')} Add a concert you want to see</a>
    ${past.length ? `<section class="did-you-go" aria-labelledby="dyg-h"><div class="section-head"><h2 id="dyg-h">did you go?</h2><span class="aside">these dates have passed</span></div>
      <ul class="flyer-grid">${past.map(flyerHtml).join('')}</ul></section>` : ''}
    ${ahead.length ? `<section aria-labelledby="cu-h"><div class="section-head"><h2 id="cu-h">coming up</h2></div>
      <ul class="flyer-grid">${ahead.map(flyerHtml).join('')}</ul></section>` : ''}`;
}

async function viewPlan(p) {
  const link = safeLink(p.link);
  const n = daysUntil(p.date);
  const onSaleFuture = p.onSale && new Date(p.onSale) > new Date();
  const d = parseDate(p.date);
  app.innerHTML = `
    <a class="back" href="#/upcoming">${ink('back')} back to upcoming</a>
    <div class="poster-wrap">
      <article class="gigposter" style="--pst-bg:${FLYER_BG[hash(p.id) % 6]}">
        <span class="stamp ${p.status === 'got' ? 'got' : 'want'}">${p.status === 'got' ? 'Got tickets' : 'Want to go'}</span>
        <span class="pst-live" aria-hidden="true">live!</span>
        <h1 class="pst-artist worn">${esc(p.artist)}</h1>
        <div class="pst-when">
          ${d ? `<div><div class="pst-small">${esc(d.toLocaleDateString(undefined, { weekday: 'long' }))}</div><div class="pst-big">${esc(d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</div></div>
                 <div><div class="pst-small">Year</div><div class="pst-big">${d.getFullYear()}</div></div>`
            : '<div><div class="pst-small">Date</div><div class="pst-big">TBA</div></div>'}
          ${p.time ? `<div><div class="pst-small">Time</div><div class="pst-big">${esc(fmtTime(p.time))}</div></div>` : ''}
        </div>
        ${p.venue || p.city ? `<p class="pst-venue">${esc([p.venue, p.city].filter(Boolean).join(' · '))}</p>` : ''}
        <span class="countdown-ink">${esc(countdownText(p.date).toLowerCase())}${ink('circle', 'ring')}</span>
      </article>

      <div>
        ${n !== null && n < 0 ? `<div class="ask-note"><span class="tape tc"></span><p>This date has passed. Did you go?</p>
          <div class="btnrow" style="margin-top:0"><button class="btn stamp-btn" data-act="went">Yes, log it</button><button class="btn" data-act="del">No, remove it</button></div></div>`
        : `<button class="btn stamp-btn block" data-act="went" style="margin-top:24px">✓ I went! Move it to My Shows</button>`}
        <div class="btnrow">
          <a class="btn" href="#/plan/${esc(p.id)}">Edit</a>
          ${p.date ? `<button class="btn" data-act="cal">Calendar</button>` : ''}
        </div>

        <section class="ticket-facts wallet" aria-labelledby="tk-h"><h2 id="tk-h">Tickets</h2>
          <dl>
            <dt>Status</dt><dd>${p.status === 'got' ? 'Bought' : 'Not bought yet'}</dd>
            ${p.onSale ? `<dt>On sale</dt><dd>${esc(fmtDateTime(p.onSale))}${onSaleFuture ? ' (soon)' : ''}</dd>` : ''}
            ${p.price ? `<dt>${p.status === 'got' ? 'Paid' : 'Budget'}</dt><dd>${money(p.price)}</dd>` : ''}
          </dl>
          ${link ? `<a class="btn block" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open ticket page ↗</a>` : ''}
          ${onSaleFuture ? '<button class="btn block" data-act="salecal">On-sale reminder</button>' : ''}
        </section>
        ${p.withWho || p.notes ? `<section class="lined-note" aria-labelledby="pn-h"><span class="tape tc"></span><h2 id="pn-h">notes</h2>
          <p class="notes">${p.withWho ? `going with ${esc(p.withWho)}${p.notes ? '\n' : ''}` : ''}${esc(p.notes || '')}</p></section>` : ''}
        <div class="danger-zone"><button class="link-red" data-act="del">Remove from my list</button></div>
      </div>
    </div>`;

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
    ${existing ? `<a class="back" href="#/show/${esc(existing.id)}">${ink('back')} back to the flyer</a>` : ''}
    <div class="form-wrap">
    <h1 class="page-title">${existing ? 'edit this flyer' : 'log a show'}</h1>
    ${existing ? '' : chooseTabs('plan')}
    <form class="notebook" novalidate>
      <label class="field"><span class="lab">Artist <span class="req">*</span></span>
        <input name="artist" required autocomplete="off" autocapitalize="words" value="${esc(p.artist)}" placeholder="who do you want to see?"></label>
      <div class="grid2">
        <label class="field"><span class="lab">Date</span><input name="date" type="date" value="${esc(p.date)}"></label>
        <label class="field"><span class="lab">Time</span><input name="time" type="time" value="${esc(p.time)}"></label>
      </div>
      <p class="help field" style="margin-top:-12px;font-family:var(--font-pen);font-size:18px;color:var(--text-soft)">No date yet? Leave it blank. It'll show as "Date not announced".</p>
      <label class="field"><span class="lab">Venue</span><input name="venue" autocapitalize="words" value="${esc(p.venue)}"></label>
      <label class="field"><span class="lab">City</span><input name="city" autocapitalize="words" value="${esc(p.city)}"></label>

      <fieldset class="field" style="border:0;padding:0;margin:0 0 22px"><legend class="lab" style="padding:0;font-family:var(--font-pen);font-weight:700;font-size:22px;margin-bottom:8px">Tickets</legend>
        <div class="seg">
          <label><input type="radio" name="status" value="want" ${p.status !== 'got' ? 'checked' : ''}>Want to go</label>
          <label><input type="radio" name="status" value="got" ${p.status === 'got' ? 'checked' : ''}>Got tickets</label>
        </div></fieldset>
      <label class="field"><span class="lab">Tickets go on sale</span><input name="onSale" type="datetime-local" value="${esc(p.onSale)}"></label>
      <label class="field"><span class="lab" id="priceLabel">${p.status === 'got' ? 'Price paid ($)' : 'Budget ($)'}</span>
        <input name="price" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(p.price)}"></label>
      <label class="field"><span class="lab">Ticket page link</span><input name="link" type="url" inputmode="url" value="${esc(p.link)}" placeholder="https://…"></label>
      <label class="field"><span class="lab">Going with</span><input name="withWho" value="${esc(p.withWho)}" placeholder="optional"></label>
      <label class="field"><span class="lab">Notes</span><textarea class="notes-input" name="notes" rows="3" placeholder="presale code reminder, who to text, songs you hope they play…">${esc(p.notes)}</textarea></label>
      <div class="savebar"><button class="btn stamp-btn block" type="submit">${existing ? 'Save changes' : 'Pin it to Upcoming'}</button></div>
    </form>
    </div>`;
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

// ===================== Stats: the numbers =====================
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
    <h1 class="page-title">the numbers</h1>
    <p class="page-sub">tallied up in the back of the diary</p>
    ${!shows.length ? `<div class="empty-page"><span class="tape tc"></span><p class="big-hand">no tally marks yet.</p>
      <p>Log a show and your numbers will start adding up here.</p><a class="btn stamp-btn block" href="#/add">${ink('plus')} Log a show</a></div>` : `
    <div class="tally">
      <div><div class="n">${shows.length}</div><div class="l">shows total</div></div>
      <div><div class="n">${thisYear}</div><div class="l">shows in ${yearNow}</div></div>
      <div><div class="n">${avg ? avg.toFixed(1) + '★' : '—'}</div><div class="l">average rating</div></div>
      <div><div class="n money">${money(spend)}</div><div class="l">spent on tickets</div></div>
    </div>
    <section class="chart-sheet" aria-labelledby="py-h"><span class="tape tl"></span><span class="tape tr"></span>
      <h2 id="py-h">shows per year</h2>
      <div class="bars">
      ${years.map((y) => `<div class="bar"><span class="yr">${y}</span><div class="track"><div class="fill" style="width:${(byYear[y] / maxY) * 100}%"></div></div><span class="v">${byYear[y]}</span></div>`).join('')}
      </div></section>
    <div class="stats-cols">
      <section class="clip rotl" aria-labelledby="ar-h"><h2 id="ar-h">most-seen artists</h2><ol class="rank">
        ${artists.slice(0, 5).map((a) => `<li><span class="nm">${esc(a.label)}</span><span class="ct">${a.n} show${a.n > 1 ? 's' : ''}</span></li>`).join('')}
      </ol></section>
      <section class="clip rotr" aria-labelledby="so-h"><h2 id="so-h">songs you've heard live most</h2>
        ${songs.length ? `<ol class="rank songs">${songs.slice(0, 10).map((x) => `<li><span class="nm">${esc(x.label)}</span><span class="ct">${x.n}×</span></li>`).join('')}</ol>`
          : '<p class="sl-empty">Add setlists to see your most-heard songs.</p>'}
      </section>
    </div>`}
    <section class="housekeeping" aria-labelledby="hk-h"><h2 id="hk-h">Your data</h2>
      <p>Your diary is stored only on this device. Moving between your computer and your phone? Send it with a QR code. Nothing goes through the internet.</p>
      <div class="btnrow">
        <button class="btn" id="sendPhone">Send to my phone</button>
        <button class="btn" id="receivePhone">Receive on this phone</button>
      </div>
      <p>Photos and videos don't fit in a QR code. To move everything, or to keep a safe copy, use Back up and Restore.</p>
      <div class="btnrow">
        <button class="btn" id="backup">Back up</button>
        <label class="btn filebtn">Restore<input type="file" accept="application/json,.json" id="restore"></label>
      </div>
    </section>`;

  $('#sendPhone').onclick = openSendDialog;
  $('#receivePhone').onclick = openReceiveDialog;
  $('#backup').onclick = backup;
  $('#restore').onchange = (e) => e.target.files[0] && restore(e.target.files[0]);
}

// ===================== Send to my phone (QR transfer, no server) =====================
// The computer shows QR code(s) holding the diary's words. The phone's Receive button
// scans them with its own camera, so shows land straight in the home-screen app.
// Photos, videos and ticket files are too big for QR codes; Back up / Restore moves those.
const scriptLoads = {};
function loadScript(src) {
  if (!scriptLoads[src]) scriptLoads[src] = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = res;
    s.onerror = () => { delete scriptLoads[src]; s.remove(); rej(new Error('Could not load the QR tools. Are you offline?')); };
    document.head.appendChild(s);
  });
  return scriptLoads[src];
}
const XFER_CHUNK = 420; // characters per QR code: kept small so each code has big squares a phone camera reads easily
async function makeXferCodes() {
  const all = await dbAll('shows');
  const shows = all.map((s) => {
    const c = { ...s, media: [] };
    if (c.ticket) { c.ticket = { ...c.ticket }; delete c.ticket.fileId; }
    return c;
  });
  const code = await encodeShare({ app: 'setlist', t: 'xfer', v: 1, shows });
  const sid = Math.random().toString(36).slice(2, 6);
  const n = Math.max(1, Math.ceil(code.length / XFER_CHUNK));
  const base = location.origin + location.pathname + '#xfer=';
  const parts = Array.from({ length: n }, (_, i) => `${base}${i + 1}.${n}.${sid}.${code.slice(i * XFER_CHUNK, (i + 1) * XFER_CHUNK)}`);
  return { count: all.length, parts };
}
function parseXfer(text) {
  const m = /#xfer=(\d+)\.(\d+)\.([a-z0-9]+)\.([A-Za-z0-9_-]+)\s*$/.exec(String(text).trim());
  return m ? { i: +m[1], n: +m[2], sid: m[3], data: m[4] } : null;
}
// Collects parts (in any order, repeats ignored) until a full set from one send has arrived.
function xferCollector() {
  let sid = null, n = 0; const got = new Map();
  return {
    add(part) {
      if (!part || part.i < 1 || part.i > part.n) return null;
      if (part.sid !== sid) { sid = part.sid; n = part.n; got.clear(); }
      got.set(part.i, part.data);
      return got.size === n ? Array.from({ length: n }, (_, i) => got.get(i + 1)).join('') : null;
    },
    get progress() { return { have: got.size, of: n }; },
  };
}
async function importXfer(code) {
  const data = await decodeShare(code);
  if (data.app !== 'setlist' || data.t !== 'xfer' || !Array.isArray(data.shows)) throw new Error("That code isn't from Setlist.");
  let added = 0, updated = 0, kept = 0;
  for (const s of data.shows) {
    if (!s || !s.id || !s.artist) continue;
    const local = await dbGet('shows', s.id);
    if (!local) { await dbPut('shows', { ...s, media: [], ticket: { ...(s.ticket || {}), fileId: null } }); added++; continue; }
    if ((local.updatedAt || 0) > (s.updatedAt || 0)) { kept++; continue; } // this phone has the newer version
    // Keep this phone's photos and ticket file; take the newer words.
    await dbPut('shows', { ...local, ...s, media: local.media || [], ticket: { ...(s.ticket || {}), fileId: local.ticket?.fileId || null } });
    updated++;
  }
  askPersist();
  return { added, updated, kept };
}
function xferSummary(r) {
  const bits = [];
  if (r.added) bits.push(`${r.added} new show${r.added === 1 ? '' : 's'} added`);
  if (r.updated) bits.push(`${r.updated} updated`);
  if (r.kept) bits.push(`${r.kept} already newer here`);
  return bits.join(' · ') || 'Everything was already here';
}

async function openSendDialog() {
  let x;
  try { await loadScript('vendor/qrcode-generator.min.js'); x = await makeXferCodes(); } catch (e) { toast(e.message); return; }
  if (!x.count) { toast('Nothing to send yet. Log a show first.'); return; }
  const dlg = document.createElement('dialog');
  dlg.setAttribute('aria-labelledby', 'send-h');
  dlg.innerHTML = `<span class="tape tc"></span>
    <h2 id="send-h">send to my phone</h2>
    <p class="sub">On your phone, open Setlist <b>from its home-screen icon</b>, go to Stats and tap <b>Receive on this phone</b>. Then point it at this code.</p>
    <div class="qrbox" role="img" aria-label="QR code holding your ${x.count} shows"></div>
    <p class="qr-part" aria-live="polite"></p>
    <div class="btnrow" ${x.parts.length > 1 ? '' : 'hidden'}><button class="btn small" data-act="pause">Pause</button><button class="btn small" data-act="next">Next code</button></div>
    <p class="qr-note">Sends the words for all ${x.count} show${x.count === 1 ? '' : 's'}: artists, dates, setlists, ratings, notes and ticket details. Photos, videos and ticket files stay here. Use Back up for those.</p>
    <button class="link-red" data-act="close" style="width:100%">done</button>`;
  document.body.appendChild(dlg);
  const box = $('.qrbox', dlg), label = $('.qr-part', dlg);
  let i = 0, timer = null, paused = false;
  const draw = () => {
    const qr = qrcode(0, 'L'); qr.addData(x.parts[i]); qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true });
    label.textContent = x.parts.length > 1 ? `code ${i + 1} of ${x.parts.length}: they flip on their own, keep the camera on them` : 'one code holds everything';
  };
  const tick = () => { i = (i + 1) % x.parts.length; draw(); };
  const play = () => { clearInterval(timer); if (x.parts.length > 1 && !paused) timer = setInterval(tick, 1100); };
  dlg.addEventListener('close', () => { clearInterval(timer); dlg.remove(); });
  dlg.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') dlg.close();
    if (act === 'next') { tick(); play(); }
    if (act === 'pause') { paused = !paused; e.target.textContent = paused ? 'Play' : 'Pause'; play(); }
  });
  draw(); play();
  dlg.showModal();
}

async function openReceiveDialog() {
  const dlg = document.createElement('dialog');
  dlg.setAttribute('aria-labelledby', 'recv-h');
  dlg.innerHTML = `<span class="tape tc"></span>
    <h2 id="recv-h">receive on this phone</h2>
    <p class="sub">On your computer, open Setlist, go to Stats and click <b>Send to my phone</b>. Point this camera at the code.</p>
    <div class="scanbox"><video playsinline muted></video><span class="scan-frame" aria-hidden="true"></span></div>
    <p class="qr-part" aria-live="polite">starting the camera…</p>
    <details class="paste"><summary>No camera? Paste the link instead</summary>
      <label class="field"><span class="lab">Link(s) from the other device</span><textarea rows="3" placeholder="https://…#xfer=…"></textarea></label>
      <button class="btn small block" data-act="paste">Add these shows</button></details>
    <button class="link-red" data-act="close" style="width:100%">cancel</button>`;
  document.body.appendChild(dlg);
  const video = $('video', dlg), status = $('.qr-part', dlg);
  const col = xferCollector();
  let stream = null, raf = 0, done = false, last = 0;
  const canvas = document.createElement('canvas'), g = canvas.getContext('2d', { willReadFrequently: true });
  const stop = () => { cancelAnimationFrame(raf); if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; };
  const finish = async (code) => {
    if (done) return; done = true; stop();
    status.textContent = 'got it, adding your shows…';
    try { const r = await importXfer(code); dlg.close(); toast(xferSummary(r)); route(); }
    catch (e) { done = false; status.textContent = 'That didn’t work: ' + e.message; }
  };
  const feed = (text) => {
    const part = parseXfer(text); if (!part) return false;
    const code = col.add(part);
    const p = col.progress;
    status.textContent = p.of > 1 ? `caught ${p.have} of ${p.of} codes…` : 'caught it…';
    if (code) finish(code);
    return true;
  };
  const scan = (t) => {
    raf = requestAnimationFrame(scan);
    if (t - last < 180 || video.readyState < 2) return; last = t;
    const s = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * s); canvas.height = Math.round(video.videoHeight * s);
    g.drawImage(video, 0, 0, canvas.width, canvas.height);
    const hit = jsQR(g.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
    if (hit && hit.data) feed(hit.data);
  };
  dlg.addEventListener('close', () => { stop(); dlg.remove(); });
  dlg.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') dlg.close();
    if (act === 'paste') {
      const lines = $('textarea', dlg).value.split(/\s+/).filter(Boolean);
      let anyPart = false; for (const l of lines) anyPart = feed(l) || anyPart; // read every pasted link
      if (!anyPart) status.textContent = 'That doesn’t look like a Setlist link.';
      else if (!done) { const p = col.progress; status.textContent = `got ${p.have} of ${p.of} parts. Paste the rest too.`; }
    }
  });
  dlg.showModal();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser can’t use the camera here.');
    await loadScript('vendor/jsqr.min.js');
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    if (!dlg.open) { stop(); return; }
    video.srcObject = stream; await video.play();
    status.textContent = 'looking for the code…';
    raf = requestAnimationFrame(scan);
  } catch (e) {
    status.textContent = (e.name === 'NotAllowedError' ? 'Camera access was blocked. Allow it in Settings, or paste the link below.' : e.message + ' You can paste the link below.');
    $('.paste', dlg).open = true; $('.scanbox', dlg).hidden = true;
  }
}

// When a transfer code is opened as a normal link (e.g. from the phone's Camera app).
async function viewXfer(hashData) {
  const part = parseXfer('#xfer=' + hashData);
  const iphoneNote = `<p>On an iPhone, the Camera app opens links in Safari, which keeps a <b>separate</b> diary from your home-screen app. To fill the home-screen app, open Setlist from its icon, go to Stats, tap <b>Receive on this phone</b> and scan the code there.</p>`;
  if (!part) { app.innerHTML = `<div class="empty-page"><span class="tape tc"></span><p class="big-hand">this code got smudged.</p><p>Try sending again.</p><a class="btn" href="#/shows">Go to my diary</a></div>`; return; }
  if (part.n > 1) {
    app.innerHTML = `<div class="empty-page"><span class="tape tc"></span><p class="big-hand">that's part ${part.i} of ${part.n}.</p>
      <p>Your diary was too big for one code, so it's split into ${part.n}. A normal camera can only read one at a time. Use the <b>Receive on this phone</b> button in Setlist (Stats tab), which collects them all.</p>
      ${iphoneNote}<a class="btn stamp-btn block" href="#/stats">Go to Stats</a></div>`;
    return;
  }
  let count = '?';
  try { count = (await decodeShare(part.data)).shows.length; } catch (e) {}
  app.innerHTML = `<div class="empty-page"><span class="tape tl"></span><span class="tape tr"></span>
    <p class="big-hand">${count} show${count === 1 ? '' : 's'} from your other device</p>
    <p>Add them to the diary in this browser? Shows already here are kept, and newer edits win.</p>
    <button class="btn stamp-btn block" id="xferAdd">Add them to this diary</button>
    ${iphoneNote}</div>`;
  $('#xferAdd').onclick = async () => {
    try { const r = await importXfer(part.data); toast(xferSummary(r)); location.hash = '#/shows'; }
    catch (e) { toast('That didn’t work: ' + e.message); }
  };
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
