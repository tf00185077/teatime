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
let currentLat = null, currentLng = null; // 編輯中店家的位置
let currentGeo = { source: '', approx: false };
let viewMode = 'list';

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
function toast(msg, ms = 1800) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}
// 貼上失敗時，顯示剪貼簿裡實際的內容，方便排查捷徑設定
function clipDiag(text) {
  const t = String(text || '');
  if (!t.trim()) return '剪貼簿是空的，或放的是圖片不是文字。請確認捷徑「拷貝到剪貼板」拷貝的是「文字」';
  const head = t.slice(0, 40).replace(/\s+/g, ' ');
  return `剪貼簿裡沒有連結（${t.length} 字，開頭：「${head}…」）`;
}
function parseTags(s) {
  return [...new Set(String(s || '').split(/[\s,，、]+/).map(x => x.replace(/^#/, '').trim()).filter(Boolean))];
}
// 有地圖連結就直接開；否則用「店名 + 地址（沒有就用地區）」在 Google 地圖搜尋
function mapUrl(shop) {
  const a = (shop.address || '').trim();
  if (/^https?:\/\//i.test(a)) return a;
  const q = [shop.name, a || shop.area].filter(Boolean).join(' ');
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
}
function isMapUrl(u) {
  const h = safeHost(u);
  let p = '';
  try { p = new URL(u).pathname; } catch {}
  return /^maps\.app\.goo\.gl$/i.test(h) || /^maps\.apple\.com$/i.test(h) ||
    (/^goo\.gl$/i.test(h) && p.startsWith('/maps')) ||
    (/(^|\.)google\.[a-z.]+$/i.test(h) && (p.startsWith('/maps') || /^maps\./i.test(h)));
}

/* ---------- IG / 捷徑 解析 ---------- */
function isInstagram(u) {
  return /(^|\.)instagram\.com$/i.test(safeHost(u));
}
function safeHost(u) {
  try { return new URL(u).hostname; } catch { return ''; }
}
// 去掉 ?igsh= 之類的追蹤參數，方便判斷重複
function normalizeUrl(u) {
  if (!u) return '';
  try {
    const url = new URL(u.trim());
    if (isInstagram(url.href)) {
      url.search = ''; url.hash = '';
      url.pathname = url.pathname.replace(/\/embed(\/captioned)?\/?$/i, '/');
      url.hostname = 'www.instagram.com';
      if (!url.pathname.endsWith('/')) url.pathname += '/';
    }
    return url.href;
  } catch { return u.trim(); }
}
function extractUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s|<>"']+/i);
  return m ? m[0] : '';
}
function base64ToDataUrl(b64) {
  const clean = String(b64).replace(/\s+/g, '');
  const mime = clean.startsWith('/9j/') ? 'image/jpeg'
    : clean.startsWith('iVBOR') ? 'image/png'
    : clean.startsWith('R0lG') ? 'image/gif'
    : clean.startsWith('UklG') ? 'image/webp'
    : 'image/heic';
  return `data:${mime};base64,${clean}`;
}
// 清掉 AI 回應常見的雜訊：引號、括號、「無／未知／N/A」、換行
function cleanField(text) {
  let t = String(text || '').replace(/[`"“”「」『』]/g, '').replace(/\s+/g, ' ').trim();
  if (/^(無|没有|沒有|未知|不明|n\/?a|none|null|-|—|不確定)$/i.test(t)) t = '';
  return t.slice(0, 120);
}
function stripUrls(text) {
  return String(text || '').replace(/https?:\/\/\S+/gi, ' ').replace(/\s+/g, ' ').trim();
}
function extractUrls(text) {
  return String(text || '').match(/https?:\/\/[^\s|<>"']+/gi) || [];
}
// instagram.com/<帳號>/ 這種個人頁連結可以拿到帳號名稱
function igUsername(u) {
  try {
    const url = new URL(u);
    if (!isInstagram(url.href)) return '';
    const seg = url.pathname.split('/').filter(Boolean);
    if (seg.length === 1 && !['p', 'reel', 'reels', 'stories', 'explore', 's'].includes(seg[0])) return seg[0];
  } catch {}
  return '';
}
// 支援：「teatime|店名|地區|分享內容」或任何含有連結的文字。
// Google 地圖／Apple 地圖連結 → 放進「地址或地圖連結」；其他（IG 等）→ 放進「IG／來源連結」
function parseIncoming(text) {
  // 中文鍵盤常打出全形「｜」或其他直線符號，統一換成半形 |
  const raw = String(text || '').replace(/[｜│┃∣ǀ丨]/g, '|').trim();
  if (!raw) return null;
  let name = '', area = '', addrText = '', body = raw, strayUrls = [];
  if (/^teatime\|/i.test(raw)) {
    const parts = raw.split('|').map(x => x.trim());
    // 網址被放錯格（例如放進店名）時先記下來，後面當來源連結用
    strayUrls = [parts[1], parts[2]].flatMap(extractUrls);
    // 店名、地區裡如果混進網址就拿掉（避免卡片被長網址撐破）
    name = cleanField(stripUrls(parts[1]));
    area = cleanField(stripUrls(parts[2]));
    // 自動版捷徑：teatime|店名|地區|地址|分享網址|img:…
    // 第 4 格沒有網址、也不是圖片標記，就當成文字地址
    const p3 = parts[3] || '';
    if (parts.length >= 5 && !extractUrls(p3).length && !/^(img\s*[:：]|data:image)/i.test(p3) && p3.length < 200) {
      addrText = cleanField(p3);
      body = parts.slice(4).join('|');
    } else {
      body = parts.slice(3).join('|');
    }
  }
  // 捷徑可附 geo:緯度,經度
  let lat = null, lng = null;
  const gm = body.match(/(?:^|\|)\s*geo\s*[:：]\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)/i);
  if (gm) { lat = Number(gm[1]); lng = Number(gm[2]); body = body.replace(gm[0], ' '); }
  // 也接受 addr:地址 標記
  const am = body.match(/(?:^|\|)\s*addr\s*[:：]([^|]*)/i);
  if (am) { if (!addrText) addrText = cleanField(am[1]); body = body.replace(am[0], ' '); }
  // 捷徑附上的截圖：img:<base64> 或 data:image/...;base64,<base64>
  let photo = null;
  // 容錯：img 後面可接全形冒號；沒有 img 標記但有一大段 Base64 也當作截圖
  const im = body.match(/(?:img\s*[:：]|data:image\/[a-z0-9.+-]+;base64,)\s*([A-Za-z0-9+/=\s]{200,})/i)
    || body.match(/(?:^|\|)\s*((?:\/9j\/|iVBOR)[A-Za-z0-9+/=\s]{1000,})/);
  if (im) {
    photo = base64ToDataUrl(im[1]);
    body = body.replace(im[0], ' ');
  }
  body = body.replace(/(^|[\s|])img\s*[:：]?\s*(?=$|[\s|])/gi, ' '); // 沒找到截圖時留下的空標記
  let urls = extractUrls(body);
  if (!urls.length && strayUrls.length) urls = strayUrls;
  if (!urls.length && !photo && !name) return null;
  let address = addrText, sourceUrl = '';
  for (const u of urls) {
    if (isMapUrl(u)) { if (!address || address === addrText) address = u; }
    else if (!sourceUrl) sourceUrl = normalizeUrl(u);
  }
  // 從 Google 地圖分享時通常會附上店名，拿來當預設店名
  let leftover = body;
  urls.forEach(u => { leftover = leftover.replace(u, ' '); });
  leftover = leftover.replace(/[|\s]+/g, ' ').trim();
  if (!name && address && leftover) name = leftover.split(/[\n·,，]/)[0].trim().slice(0, 80);
  if (!name) name = igUsername(sourceUrl);
  const notes = !address && leftover && leftover !== name ? leftover.slice(0, 500) : '';
  if (lat == null && address) { const c = coordsFromUrl(address); if (c) ({ lat, lng } = c); }
  return { name, area, address, sourceUrl, notes, photo, lat, lng };
}
// 從 Google / Apple 地圖的長網址取出座標（短網址 maps.app.goo.gl 取不到）
function coordsFromUrl(u) {
  const s = String(u || '');
  const m = s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) ||
    s.match(/[?&](?:q|query|ll|center|destination)=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/i) ||
    s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return validCoord(lat, lng) ? { lat, lng } : null;
}
function validCoord(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}
function hasCoord(s) { return s && validCoord(s.lat, s.lng); }
function findBySource(u) {
  const n = normalizeUrl(u);
  return n ? shops.find(s => normalizeUrl(s.sourceUrl) === n) : null;
}
function findByAddress(u) {
  return u ? shops.find(s => (s.address || '').trim() === u.trim()) : null;
}
function findByName(name) {
  const n = String(name || '').trim().toLowerCase();
  return n ? shops.find(s => s.name.trim().toLowerCase() === n) : null;
}
// 找同一家店：同 IG 連結、同地圖連結，或同店名
function findMatch(d) {
  return (d.sourceUrl && findBySource(d.sourceUrl)) || (d.address && findByAddress(d.address)) || findByName(d.name);
}
async function readClipboard() {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

/* ---------- Render ---------- */
function render() {
  const q = $('#search').value.trim().toLowerCase();
  const sort = $('#sort').value;

  $('#cAll').textContent = shops.length || '';
  $('#cWant').textContent = shops.filter(s => s.status === 'want').length || '';
  $('#cVisited').textContent = shops.filter(s => s.status === 'visited').length || '';

  if (viewMode === 'map') { $('#empty').hidden = true; renderMap(); return; }
  let items = shops.filter(s => filter === 'all' || s.status === filter);
  if (q) {
    items = items.filter(s =>
      [s.name, s.area, s.address, s.notes, s.sourceUrl, ...(s.tags || [])].join(' ').toLowerCase().includes(q));
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
        <div class="card-actions">
          <a class="map-link" href="${esc(mapUrl(s))}" target="_blank" rel="noopener">📍 地圖</a>
          ${s.sourceUrl ? `<a class="map-link" href="${esc(s.sourceUrl)}" target="_blank" rel="noopener">${isInstagram(s.sourceUrl) ? '📷 IG' : '🔗 來源'}</a>` : ''}
        </div>
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
function openEditor(shop, prefill) {
  form.reset();
  editingId = shop ? shop.id : null;
  $('#editorTitle').textContent = shop ? '編輯店家' : '新增店家';
  $('#deleteBtn').hidden = !shop;
  if (!shop && prefill) {
    form.name.value = prefill.name || '';
    form.area.value = prefill.area || '';
    form.address.value = prefill.address || '';
    form.sourceUrl.value = prefill.sourceUrl || '';
    form.notes.value = prefill.notes || '';
  }
  if (shop) {
    form.name.value = shop.name || '';
    form.area.value = shop.area || '';
    form.address.value = shop.address || '';
    form.sourceUrl.value = shop.sourceUrl || '';
    form.status.value = shop.status || 'want';
    form.visitedAt.value = shop.visitedAt || '';
    form.price.value = shop.price || '';
    form.tags.value = (shop.tags || []).join(' ');
    form.notes.value = shop.notes || '';
  }
  currentRating = shop ? shop.rating || 0 : 0;
  const src = shop || prefill || {};
  setLoc(hasCoord(src) ? src.lat : null, hasCoord(src) ? src.lng : null,
    shop ? { source: shop.geoSource || '', approx: !!shop.geoApprox } : { source: 'exact', approx: false });
  setPhoto(shop ? shop.photo : (prefill && prefill.photo) || null);
  renderStars();
  syncStatus();
  editor.showModal();
  editor.scrollTop = 0;
}

async function resizeImage(file, max = 1200, quality = 0.82) {
  const url = URL.createObjectURL(file);
  try {
    return await resizeFromSrc(url, max, quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}
// 捷徑傳來的截圖再壓一次，避免資料庫太肥；失敗就回傳 null
async function shrinkDataUrl(dataUrl, max = 1200, quality = 0.8) {
  if (!dataUrl) return null;
  try { return await resizeFromSrc(dataUrl, max, quality); } catch { return null; }
}
async function resizeFromSrc(src, max, quality) {
  {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i); i.onerror = rej; i.src = src;
    });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
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
    sourceUrl: normalizeUrl(form.sourceUrl.value),
    status,
    rating: status === 'visited' ? currentRating : 0,
    visitedAt: status === 'visited' ? form.visitedAt.value : '',
    price: form.price.value.trim(),
    tags: parseTags(form.tags.value),
    notes: form.notes.value.trim(),
    photo: currentPhoto,
    lat: currentLat, lng: currentLng,
    geoSource: currentLat == null ? '' : currentGeo.source, geoApprox: currentLat != null && !!currentGeo.approx, geoV: 2,
    geoFailed: currentLat == null ? !!(prev && prev.geoFailed && prev.name === name && prev.address === form.address.value.trim()) : false,
    createdAt: prev ? prev.createdAt : Date.now(),
    updatedAt: Date.now(),
  };
  await put(shop);
  await load();
  editor.close();
  toast(prev ? '已更新' : '已新增');
  if (!hasCoord(shop) && !shop.geoFailed) queueGeocode([shop.id]);
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

/* 從剪貼簿新增（搭配 IG「複製連結」或「存到下午茶」捷徑） */
$('#pasteBtn').addEventListener('click', async () => {
  const text = await readClipboard();
  if (text == null) { toast('無法讀取剪貼簿，請在欄位裡長按貼上'); openEditor(null); return; }
  const data = parseIncoming(text);
  if (!data) { toast(clipDiag(text), 6000); return; }
  if (data.photo) data.photo = await shrinkDataUrl(data.photo);
  const existing = findMatch(data);
  if (existing) {
    // 同一家店：把新的連結補進去（按儲存才會寫入）
    openEditor(existing);
    let filled = false;
    if (data.address && !existing.address) { form.address.value = data.address; filled = true; }
    if (data.sourceUrl && !existing.sourceUrl) { form.sourceUrl.value = data.sourceUrl; filled = true; }
    if (data.photo && !existing.photo) { setPhoto(data.photo); filled = true; }
    if (hasCoord(data) && !hasCoord(existing)) { setLoc(data.lat, data.lng, { source: 'exact' }); filled = true; }
    toast(filled ? '已收藏過，補上新連結，按儲存即可' : '這家已經收藏過了');
    return;
  }
  openEditor(null, data);
  if (!data.name) setTimeout(() => form.name.focus(), 300);
});
async function pasteUrlInto(field, pick) {
  const text = await readClipboard();
  if (text == null) { toast('無法讀取剪貼簿，請長按欄位貼上'); return; }
  const urls = extractUrls(text);
  const url = urls.find(pick) || urls[0];
  if (!url) { toast('剪貼簿裡沒有連結'); return; }
  form[field].value = field === 'sourceUrl' ? normalizeUrl(url) : url;
}
$('#pasteSourceBtn').addEventListener('click', () => pasteUrlInto('sourceUrl', u => !isMapUrl(u)));
$('#pasteMapBtn').addEventListener('click', () => pasteUrlInto('address', isMapUrl));
$('#openMapBtn').addEventListener('click', () => {
  const s = { name: form.name.value.trim(), address: form.address.value.trim(), area: form.area.value.trim() };
  if (!s.name && !s.address) { toast('先填店名或地址'); return; }
  window.open(mapUrl(s), '_blank');
});

/* 匯入捷徑收件匣：每行一筆「teatime|店名|地區|連結」 */
$('#inboxInput').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  // 一筆可能跨多行（Google 地圖分享會有「店名⏎連結」），以 teatime| 開頭切分
  const lines = [];
  for (const l of (await f.text()).split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
    if (/^teatime\|/i.test(l) || !lines.length) lines.push(l);
    else lines[lines.length - 1] += '\n' + l;
  }
  let added = 0, skipped = 0, merged = 0;
  for (const line of lines) {
    const d = parseIncoming(line);
    if (!d) continue;
    if (d.photo) d.photo = await shrinkDataUrl(d.photo);
    const match = findMatch(d);
    if (match) {
      // 同一家店：只補空白的連結／地區，不覆蓋原本的資料
      const patch = {};
      if (d.address && !match.address) patch.address = d.address;
      if (d.sourceUrl && !match.sourceUrl) patch.sourceUrl = d.sourceUrl;
      if (d.area && !match.area) patch.area = d.area;
      if (d.photo && !match.photo) patch.photo = d.photo;
      if (hasCoord(d) && (!hasCoord(match) || match.geoApprox)) { Object.assign(patch, { lat: d.lat, lng: d.lng, geoFailed: false, geoApprox: false, geoSource: 'exact', geoV: 2 }); }
      if (Object.keys(patch).length) {
        Object.assign(match, patch, { updatedAt: Date.now() });
        await put(match);
        merged++;
      } else skipped++;
      continue;
    }
    const now = Date.now();
    const shop = {
      id: uid(), name: d.name || (d.address ? '未命名（地圖收藏）' : '未命名（IG 收藏）'),
      area: d.area || '', address: d.address || '',
      sourceUrl: d.sourceUrl, status: 'want', rating: 0, visitedAt: '', price: '',
      tags: [], notes: d.notes || '', photo: d.photo || null,
      lat: hasCoord(d) ? d.lat : null, lng: hasCoord(d) ? d.lng : null,
      geoSource: hasCoord(d) ? 'exact' : '', geoApprox: false, geoV: 2, createdAt: now, updatedAt: now + added,
    };
    await put(shop);
    shops.push(shop);
    added++;
  }
  await load();
  menu.close();
  queueGeocode(shops.filter(x => !hasCoord(x) && !x.geoFailed).map(x => x.id));
  toast([`新增 ${added} 筆`, merged ? `補上連結 ${merged} 筆` : '', skipped ? `略過重複 ${skipped} 筆` : ''].filter(Boolean).join('，'));
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


/* ---------- 位置：編輯畫面 ---------- */
function setLoc(lat, lng, meta) {
  currentLat = validCoord(lat, lng) ? Number(lat) : null;
  currentLng = currentLat == null ? null : Number(lng);
  currentGeo = { source: '', approx: false, ...(meta || {}) };
  const el = $('#locStatus');
  if (!el) return;
  el.classList.toggle('ok', currentLat != null && !currentGeo.approx);
  el.textContent = currentLat == null ? '位置：未設定（儲存後會自動定位）'
    : currentGeo.approx ? '位置：大概位置 ⚠︎（建議按「在地圖上選」確認）'
    : `位置：已設定 ✓（${currentLat.toFixed(4)}, ${currentLng.toFixed(4)}）`;
}

/* ---------- 地址 → 座標（OpenStreetMap Nominatim，免費、每秒最多 1 次） ---------- */
let lastGeoAt = 0;
// box = [西經, 北緯, 東經, 南緯]：只在這個範圍內找（避免同名店跑到別的城市）
async function geocodeQuery(q, box) {
  q = String(q || '').trim();
  if (!q) return null;
  const wait = Math.max(0, lastGeoAt + 1100 - Date.now());
  if (wait) await new Promise(r => setTimeout(r, wait));
  lastGeoAt = Date.now();
  try {
    let url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=tw&accept-language=zh-TW&q=' + encodeURIComponent(q);
    if (box) url += '&bounded=1&viewbox=' + box.map(n => n.toFixed(4)).join(',');
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j.length) return null;
    const lat = Number(j[0].lat), lng = Number(j[0].lon);
    return validCoord(lat, lng) ? { lat, lng } : null;
  } catch { return null; }
}
const areaCache = {};
async function geocodeArea(area) {
  const key = String(area || '').trim();
  if (!key) return null;
  if (!(key in areaCache)) areaCache[key] = await geocodeQuery(key);
  return areaCache[key];
}
function boxAround(c, d = 0.06) { // 約 ±6 公里
  return [c.lng - d, c.lat + d, c.lng + d, c.lat - d];
}
// 回傳 { lat, lng, approx }；approx = 只找到地區中心
async function geocodeShop(s) {
  const fromUrl = coordsFromUrl(s.address);
  if (fromUrl) return { ...fromUrl, approx: false };
  const addr = /^https?:\/\//i.test(s.address || '') ? '' : (s.address || '').trim();
  const area = (s.area || '').trim();
  const ac = area ? await geocodeArea(area) : null;
  // 1. 有地址：用地址（有地區就限制在地區附近，避免同名路跑掉）
  if (addr) {
    const c = (ac && await geocodeQuery(addr, boxAround(ac, 0.15))) || (!ac && await geocodeQuery(addr));
    if (c) return { ...c, approx: false };
  }
  // 2. 有地區：只在地區附近找店名；找不到就放在地區中心
  if (ac) {
    const c = await geocodeQuery(s.name, boxAround(ac));
    if (c) return { ...c, approx: false };
    return { ...ac, approx: true };
  }
  // 3. 只有店名：可能有同名店，標成大概位置請使用者確認
  if (!area) {
    const c = await geocodeQuery(s.name);
    if (c) return { ...c, approx: true };
  }
  return null;
}
const geoQueue = [];
let geoRunning = false, geoDone = 0, geoTotal = 0;
function queueGeocode(ids) {
  for (const id of ids) if (!geoQueue.includes(id)) { geoQueue.push(id); geoTotal++; }
  if (!geoRunning) runGeoQueue();
  updateGeoBar();
}
async function runGeoQueue() {
  geoRunning = true;
  while (geoQueue.length) {
    const id = geoQueue.shift();
    const s = shops.find(x => x.id === id);
    if (s && !hasCoord(s)) {
      const c = await geocodeShop(s);
      const cur = shops.find(x => x.id === id); // 期間可能被編輯過
      if (cur && !hasCoord(cur)) {
        if (c) { cur.lat = c.lat; cur.lng = c.lng; cur.geoFailed = false; cur.geoApprox = !!c.approx; cur.geoSource = 'auto'; }
        else cur.geoFailed = true;
        cur.geoV = 2;
        await put(cur);
      }
    }
    geoDone++;
    updateGeoBar();
    if (viewMode === 'map') renderMap();
  }
  geoRunning = false; geoDone = 0; geoTotal = 0;
  updateGeoBar();
}
$('#geocodeBtn').addEventListener('click', async () => {
  const s = { name: form.name.value.trim(), area: form.area.value.trim(), address: form.address.value.trim() };
  if (!s.name && !s.address) { toast('先填店名或地址'); return; }
  const btn = $('#geocodeBtn');
  btn.disabled = true; btn.textContent = '定位中…';
  const c = await geocodeShop(s);
  btn.disabled = false; btn.textContent = '自動定位';
  if (c) { setLoc(c.lat, c.lng, { source: 'auto', approx: c.approx }); toast(c.approx ? '只找到大概位置，請按「在地圖上選」確認' : '已找到位置，可按「在地圖上選」確認'); }
  else toast('找不到，請改用「在地圖上選」或補上地址');
});

/* ---------- 地圖 ---------- */
// OpenStreetMap 官方圖磚：免金鑰，需標示來源
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const TAIPEI = [25.0418, 121.5436];
let map = null, markerLayer = null, meMarker = null, fittedOnce = false;

function pinIcon(cls, emoji) {
  return L.divIcon({ className: '', html: `<div class="pin ${cls}"><span>${emoji}</span></div>`, iconSize: [26, 26], iconAnchor: [13, 26], popupAnchor: [0, -24] });
}
function ensureMap() {
  if (map || typeof L === 'undefined') return;
  map = L.map('map', { zoomControl: false }).setView(TAIPEI, 12);
  L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  map.on('popupopen', e => {
    const el = e.popup.getElement();
    const b = el && el.querySelector('[data-edit]');
    if (b) b.onclick = () => openEditor(shops.find(x => x.id === b.dataset.edit));
  });
}
function filteredForMap() {
  const q = $('#search').value.trim().toLowerCase();
  return shops.filter(s => (filter === 'all' || s.status === filter) &&
    (!q || [s.name, s.area, s.address, s.notes, s.sourceUrl, ...(s.tags || [])].join(' ').toLowerCase().includes(q)));
}
function renderMap() {
  ensureMap();
  if (!map) return;
  markerLayer.clearLayers();
  const items = filteredForMap();
  const pts = [];
  for (const s of items) {
    if (!hasCoord(s)) continue;
    const visited = s.status === 'visited';
    const stars = visited && s.rating ? `<div class="star-line">${'★'.repeat(s.rating)}${'☆'.repeat(5 - s.rating)}</div>` : '';
    const html = `<div class="pop">
      ${s.photo ? `<img src="${s.photo}" alt="">` : ''}
      <h3>${esc(s.name)}</h3>
      <div class="meta">${esc([s.area, visited ? '去過' : '想去', s.price ? `約 $${s.price}` : ''].filter(Boolean).join(' · '))}</div>
      ${stars}
      ${s.geoApprox ? '<div class="meta">⚠︎ 大概位置，點「編輯 →在地圖上選」修正</div>' : ''}
      <div class="pop-actions">
        <a href="${esc(mapUrl(s))}" target="_blank" rel="noopener">📍 Google 地圖</a>
        ${s.sourceUrl ? `<a href="${esc(s.sourceUrl)}" target="_blank" rel="noopener">${isInstagram(s.sourceUrl) ? '📷 IG' : '🔗 來源'}</a>` : ''}
        <button type="button" data-edit="${esc(s.id)}">✏️ 編輯</button>
      </div></div>`;
    L.marker([s.lat, s.lng], { icon: pinIcon((visited ? 'visited' : 'want') + (s.geoApprox ? ' approx' : ''), visited ? '☕' : '♡') })
      .bindPopup(html, { maxWidth: 240, minWidth: 180 }).addTo(markerLayer);
    pts.push([s.lat, s.lng]);
  }
  if (!fittedOnce && pts.length) {
    map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
    fittedOnce = true;
  }
  updateGeoBar();
}
function updateGeoBar() {
  const bar = $('#geoBar');
  if (!bar) return;
  if (viewMode !== 'map') { bar.hidden = true; return; }
  const items = filteredForMap();
  const missing = items.filter(s => !hasCoord(s));
  const failed = missing.filter(s => s.geoFailed).concat(items.filter(s => hasCoord(s) && s.geoApprox));
  if (geoRunning) {
    bar.hidden = false;
    bar.textContent = `正在定位店家… ${geoDone}/${geoTotal}`;
  } else if (failed.length) {
    bar.hidden = false;
    bar.innerHTML = `${failed.length} 家位置不確定或找不到，點店名修正：` +
      failed.slice(0, 8).map(s => `<button type="button" data-fix="${esc(s.id)}">${esc(s.name)}</button>`).join('、') +
      (failed.length > 8 ? '…' : '');
    bar.querySelectorAll('[data-fix]').forEach(b => (b.onclick = () => openEditor(shops.find(x => x.id === b.dataset.fix))));
  } else {
    bar.hidden = true;
  }
}
function setView(mode) {
  viewMode = mode;
  const isMap = mode === 'map';
  document.body.classList.toggle('map-mode', isMap);
  $('#mapView').hidden = !isMap;
  listEl.hidden = isMap;
  $('#empty').hidden = isMap || shops.length > 0;
  $('#sort').hidden = isMap;
  $('#viewBtn').textContent = isMap ? '📃 清單' : '🗺️ 地圖';
  if (isMap) {
    document.documentElement.style.setProperty('--header-h', $('.top').offsetHeight + 'px');
    ensureMap();
    setTimeout(() => { map && map.invalidateSize(); renderMap(); }, 0);
    const missing = shops.filter(s => !hasCoord(s) && !s.geoFailed).map(s => s.id);
    if (missing.length) queueGeocode(missing);
  } else {
    render();
  }
  updateGeoBar();
}
$('#viewBtn').addEventListener('click', () => setView(viewMode === 'map' ? 'list' : 'map'));
window.addEventListener('resize', () => {
  if (viewMode === 'map') {
    document.documentElement.style.setProperty('--header-h', $('.top').offsetHeight + 'px');
    map && map.invalidateSize();
  }
});
$('#locateBtn').addEventListener('click', () => {
  if (!navigator.geolocation) { toast('這台裝置不支援定位'); return; }
  navigator.geolocation.getCurrentPosition(pos => {
    const ll = [pos.coords.latitude, pos.coords.longitude];
    if (!meMarker) meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16] }) }).addTo(map);
    else meMarker.setLatLng(ll);
    map.setView(ll, 15);
  }, () => toast('無法取得位置，請到設定允許定位'), { enableHighAccuracy: true, timeout: 10000 });
});

/* ---------- 在地圖上選位置 ---------- */
const picker = $('#picker');
let pickMap = null, pickMarker = null, pickLL = null;
$('#pickLocBtn').addEventListener('click', () => {
  picker.showModal();
  if (!pickMap) {
    pickMap = L.map('pickMap').setView(TAIPEI, 13);
    L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(pickMap);
    pickMap.on('click', e => placePick(e.latlng.lat, e.latlng.lng));
  }
  setTimeout(() => {
    pickMap.invalidateSize();
    if (currentLat != null) { placePick(currentLat, currentLng); pickMap.setView([currentLat, currentLng], 16); }
    else {
      pickLL = null; if (pickMarker) { pickMarker.remove(); pickMarker = null; }
      const withLoc = shops.filter(hasCoord);
      if (withLoc.length) pickMap.setView([withLoc[0].lat, withLoc[0].lng], 13);
    }
  }, 50);
});
function placePick(lat, lng) {
  pickLL = { lat, lng };
  if (!pickMarker) pickMarker = L.marker([lat, lng], { icon: pinIcon('pick', '📍'), draggable: true }).addTo(pickMap);
  else pickMarker.setLatLng([lat, lng]);
  pickMarker.off('dragend').on('dragend', () => { const p = pickMarker.getLatLng(); pickLL = { lat: p.lat, lng: p.lng }; });
}
$('#pickCancel').addEventListener('click', () => picker.close());
$('#pickOk').addEventListener('click', () => {
  if (!pickLL) { toast('先點地圖放一個圖釘'); return; }
  setLoc(pickLL.lat, pickLL.lng, { source: 'manual', approx: false });
  picker.close();
});

/* ---------- Boot ---------- */
async function load() {
  shops = await getAll();
  // 修復舊資料：店名／地區裡混進的網址移除，網址補到來源連結
  for (const s of shops) {
    const urls = extractUrls([s.name, s.area].join(' '));
    if (!urls.length) continue;
    s.name = stripUrls(s.name).replace(/\|+$/, '').trim() || '未命名（IG 收藏）';
    s.area = stripUrls(s.area).replace(/\|+$/, '').trim();
    for (const u of urls) {
      if (isMapUrl(u)) { if (!s.address) s.address = u; }
      else if (!s.sourceUrl) s.sourceUrl = normalizeUrl(u);
    }
    await put(s);
  }
  // 舊版自動定位可能把同名店定到別的城市：清掉重新定位（手動選的、地圖連結帶的不動）
  const redo = [];
  for (const s of shops) {
    if (hasCoord(s) && !s.geoV && !s.geoSource && !coordsFromUrl(s.address)) {
      s.lat = null; s.lng = null; s.geoFailed = false; s.geoV = 2;
      await put(s);
      redo.push(s.id);
    } else if (s.geoFailed && !s.geoV) {
      s.geoFailed = false; s.geoV = 2; await put(s); redo.push(s.id);
    }
  }
  render();
  if (redo.length) queueGeocode(redo);
}
load();

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
