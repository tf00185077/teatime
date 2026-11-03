'use strict';

/* ---------- IndexedDB ---------- */
const DB_NAME = 'tea-notes';
const STORE = 'shops';
let dbPromise;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const result = fn(store);
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
  });
}
const getAll = () => tx('readonly', s => s.getAll());
const put = item => tx('readwrite', s => s.put(item));
const remove = id => tx('readwrite', s => s.delete(id));

/* ---------- State ---------- */
let shops = [];
let filter = 'all';
let editingId = null;
let currentPhoto = null; // data URL
let currentRating = 0;

const $ = s => document.querySelector(s);
const listEl = $('#list');
const form = $('#form');
const editor = $('#editor');

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) || Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 1800);
}
function parseTags(s) {
  return [...new Set(String(s || '').split(/[\s,，、]+/).map(x => x.replace(/^#/, '').trim()).filter(Boolean))];
}
function mapUrl(shop) {
  const a = (shop.address || '').trim();
  if (/^https?:\/\//i.test(a)) return a;
  const q = [shop.name, a].filter(Boolean).join(' ');
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
}

/* ---------- Render ---------- */
function render() {
  const q = $('#search').value.trim().toLowerCase();
  const sort = $('#sort').value;

  $('#cAll').textContent = shops.length || '';
  $('#cWant').textContent = shops.filter(s => s.status === 'want').length || '';
  $('#cVisited').textContent = shops.filter(s => s.status === 'visited').length || '';

  let items = shops.filter(s => filter === 'all' || s.status === filter);
  if (q) {
    items = items.filter(s =>
      [s.name, s.area, s.address, s.notes, ...(s.tags || [])].join(' ').toLowerCase().includes(q));
  }
  items.sort((a, b) => {
    if (sort === 'rating') return (b.rating || 0) - (a.rating || 0) || b.updatedAt - a.updatedAt;
    if (sort === 'name') return a.name.localeCompare(b.name, 'zh-Hant');
    return b.updatedAt - a.updatedAt;
  });

  $('#empty').hidden = shops.length > 0;
  if (shops.length && !items.length) {
    listEl.innerHTML = '<p class="empty">沒有符合的店家</p>';
    return;
  }
  listEl.innerHTML = items.map(s => {
    const stars = s.status === 'visited' && s.rating
      ? `<div class="star-line">${'★'.repeat(s.rating)}${'☆'.repeat(5 - s.rating)}</div>` : '';
    const meta = [s.area, s.price ? `約 $${esc(s.price)}` : '', s.status === 'visited' && s.visitedAt ? s.visitedAt : '']
      .filter(Boolean).map(esc).join(' · ');
    const tags = (s.tags || []).length
      ? `<div class="tags">${s.tags.map(t => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : '';
    const thumb = s.photo
      ? `<img class="thumb" src="${s.photo}" alt="">`
      : `<div class="thumb">☕</div>`;
    return `<article class="card" data-id="${esc(s.id)}">
      ${thumb}
      <div class="card-main">
        <div class="card-top">
          <h2>${esc(s.name)}</h2>
          <span class="badge ${s.status}">${s.status === 'visited' ? '去過' : '想去'}</span>
        </div>
        ${meta ? `<div class="meta">${meta}</div>` : ''}
        ${stars}
        ${tags}
        <div class="card-actions"><a class="map-link" href="${esc(mapUrl(s))}" target="_blank" rel="noopener">📍 地圖</a></div>
      </div>
    </article>`;
  }).join('');
}

/* ---------- Editor ---------- */
function renderStars() {
  $('#stars').innerHTML = [1, 2, 3, 4, 5]
    .map(n => `<button type="button" data-n="${n}" class="${n <= currentRating ? 'on' : ''}" aria-label="${n} 星">★</button>`)
    .join('');
}
function syncStatus() {
  const visited = form.status.value === 'visited';
  $('.visited-only').hidden = !visited;
}
function setPhoto(dataUrl) {
  currentPhoto = dataUrl || null;
  const img = $('#photoPreview');
  img.hidden = !currentPhoto;
  if (currentPhoto) img.src = currentPhoto; else img.removeAttribute('src');
  $('#photoHint').hidden = !!currentPhoto;
  $('#photoRemove').hidden = !currentPhoto;
}
function openEditor(shop) {
  form.reset();
  editingId = shop ? shop.id : null;
  $('#editorTitle').textContent = shop ? '編輯店家' : '新增店家';
  $('#deleteBtn').hidden = !shop;
  if (shop) {
    form.name.value = shop.name || '';
    form.area.value = shop.area || '';
    form.address.value = shop.address || '';
    form.status.value = shop.status || 'want';
    form.visitedAt.value = shop.visitedAt || '';
    form.price.value = shop.price || '';
    form.tags.value = (shop.tags || []).join(' ');
    form.notes.value = shop.notes || '';
  }
  currentRating = shop ? shop.rating || 0 : 0;
  setPhoto(shop ? shop.photo : null);
  renderStars();
  syncStatus();
  editor.showModal();
  editor.scrollTop = 0;
}

async function resizeImage(file, max = 1200, quality = 0.82) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i); i.onerror = rej; i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ---------- Events ---------- */
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === b));
  filter = b.dataset.filter;
  render();
}));
$('#search').addEventListener('input', render);
$('#sort').addEventListener('change', render);
$('#addBtn').addEventListener('click', () => openEditor(null));

listEl.addEventListener('click', e => {
  if (e.target.closest('a')) return;
  const card = e.target.closest('.card');
  if (card) openEditor(shops.find(s => s.id === card.dataset.id));
});

$('#cancelBtn').addEventListener('click', () => editor.close());
form.addEventListener('change', e => { if (e.target.name === 'status') syncStatus(); });
$('#stars').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  const n = Number(b.dataset.n);
  currentRating = currentRating === n ? 0 : n;
  renderStars();
});
$('#photoInput').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try { setPhoto(await resizeImage(f)); } catch { toast('照片讀取失敗'); }
  e.target.value = '';
});
$('#photoRemove').addEventListener('click', () => setPhoto(null));

form.addEventListener('submit', async e => {
  e.preventDefault();
  const name = form.name.value.trim();
  if (!name) { form.name.focus(); return; }
  const prev = shops.find(s => s.id === editingId);
  const status = form.status.value;
  const shop = {
    id: editingId || uid(),
    name,
    area: form.area.value.trim(),
    address: form.address.value.trim(),
    status,
    rating: status === 'visited' ? currentRating : 0,
    visitedAt: status === 'visited' ? form.visitedAt.value : '',
    price: form.price.value.trim(),
    tags: parseTags(form.tags.value),
    notes: form.notes.value.trim(),
    photo: currentPhoto,
    createdAt: prev ? prev.createdAt : Date.now(),
    updatedAt: Date.now(),
  };
  await put(shop);
  await load();
  editor.close();
  toast(prev ? '已更新' : '已新增');
});

$('#deleteBtn').addEventListener('click', async () => {
  if (!editingId) return;
  const s = shops.find(x => x.id === editingId);
  if (!confirm(`確定刪除「${s ? s.name : ''}」？`)) return;
  await remove(editingId);
  await load();
  editor.close();
  toast('已刪除');
});

/* Menu, export, import */
const menu = $('#menu');
$('#menuBtn').addEventListener('click', () => menu.showModal());
menu.querySelector('[data-close]').addEventListener('click', () => menu.close());
[menu, editor].forEach(d => d.addEventListener('click', e => { if (e.target === d && d === menu) d.close(); }));

$('#exportBtn').addEventListener('click', async () => {
  const data = JSON.stringify({ app: 'tea-notes', version: 1, exportedAt: new Date().toISOString(), shops }, null, 2);
  const filename = `tea-notes-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([data], filename, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: '下午茶筆記備份' }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

$('#importInput').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const parsed = JSON.parse(await f.text());
    const list = Array.isArray(parsed) ? parsed : parsed.shops;
    if (!Array.isArray(list)) throw new Error('bad');
    let n = 0;
    for (const s of list) {
      if (!s || !s.name) continue;
      await put({ ...s, id: s.id || uid(), updatedAt: s.updatedAt || Date.now(), createdAt: s.createdAt || Date.now() });
      n++;
    }
    await load();
    menu.close();
    toast(`已匯入 ${n} 筆`);
  } catch {
    toast('匯入失敗：檔案格式不對');
  }
});

/* ---------- Boot ---------- */
async function load() {
  shops = await getAll();
  render();
}
load();

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
