// レシートチェッ君: 画面の動き（段階2: 撮影 → 読み取り → 確認・修正 → 送信）

import { callApi, ApiError } from './api.js';
import { resizePhoto, blobToBase64 } from './image.js';
import { checkTotal, estimateYen, yen, PAYMENT_LABELS, TAX_MODE_LABELS } from './receipt.js';

const MAX_PHOTOS = 10;

const state = {
  passphrase: loadPassphrase(),
  receiptId: null,     // レシートごとの番号（UUID）。メールに載せ、二重送信・二重取り込みを防ぐ
  photos: [],          // [{blob, url}]（撮影順）
  replaceIndex: null,  // 撮り直し中の写真の番号（null なら追加）
  preparing: false,    // 撮った写真を縮小している間 true
  receipt: null,       // 読み取り結果（画面で修正した内容を反映していく）
  readInfo: null,      // 読み取りのモデル・時間・トークン数
  edited: false,       // 読み取り後に手で修正したら true
  recipients: [],      // 登録済みの送信先 [{email, enabled}]
  recipientsError: '', // 送信先の一覧を取れなかったときの理由
  selected: new Set(), // このレシートを送る宛先
  sending: false,
};

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ 画面の切り替え

const TITLES = { s0: '合言葉', s1: 'レシートチェッ君', s2: '撮影', s3: '読み取り', s4: '確認・修正', s5: '送信完了' };

function show(id) {
  document.querySelectorAll('.screen').forEach((el) => { el.hidden = el.id !== id; });
  $('title').textContent = TITLES[id];
  $('btn-settings').hidden = id !== 's1';
  window.scrollTo(0, 0);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function newReceiptId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ------------------------------------------------------------------ 合言葉（S0）

function loadPassphrase() {
  try {
    return localStorage.getItem('passphrase') || '';
  } catch (err) {
    return '';
  }
}

function savePassphrase(value) {
  try {
    localStorage.setItem('passphrase', value);
  } catch (err) {
    // 保存できない環境（プライベートブラウズなど）では、開いている間だけ使う
  }
}

function openPassphrase() {
  $('passphrase').value = state.passphrase;
  $('s0-msg').textContent = '';
  $('btn-cancel-pass').hidden = !state.passphrase;
  show('s0');
}

async function onSavePassphrase() {
  const value = $('passphrase').value.trim();
  if (!value) {
    $('s0-msg').textContent = '合言葉を入力してください';
    return;
  }
  const btn = $('btn-save-pass');
  btn.disabled = true;
  $('s0-msg').textContent = '確認しています…';
  try {
    const res = await callApi('ping', value);
    state.passphrase = value;
    savePassphrase(value);
    $('s1-info').textContent = `接続先: Apps Script v${res.version}（${res.model}）`;
    show('s1');
  } catch (err) {
    $('s0-msg').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ 撮影（S2）

function startReceipt() {
  clearReceipt();
  state.receiptId = newReceiptId();
  renderPhotos();
  show('s2');
  openCamera(null);
}

function openCamera(replaceIndex) {
  if (replaceIndex === null && state.photos.length >= MAX_PHOTOS) {
    alert(`写真は ${MAX_PHOTOS}枚までです`);
    return;
  }
  state.replaceIndex = replaceIndex;
  const input = $('camera');
  input.value = '';
  input.click();
}

async function onPhotoTaken() {
  const file = $('camera').files[0];
  if (!file) return;
  // 縮小には 1秒ほどかかるので、その間は読み取り・追加を押せないようにする
  state.preparing = true;
  renderPhotos();
  let photo;
  try {
    const { blob } = await resizePhoto(file);
    photo = { blob, url: URL.createObjectURL(blob) };
  } catch (err) {
    alert(err.message);
    return;
  } finally {
    state.preparing = false;
    renderPhotos();
  }
  if (state.replaceIndex === null) {
    state.photos.push(photo);
  } else {
    URL.revokeObjectURL(state.photos[state.replaceIndex].url);
    state.photos[state.replaceIndex] = photo;
  }
  state.replaceIndex = null;
  renderPhotos();
}

function renderPhotos() {
  const list = $('photos');
  list.innerHTML = '';
  state.photos.forEach((p, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="no">${i + 1}</span>
      <img alt="${i + 1}枚目">
      <span class="ops">
        <button class="small sub" data-op="up" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button class="small sub" data-op="down" ${i === state.photos.length - 1 ? 'disabled' : ''}>▼</button>
        <button class="small sub" data-op="retake">撮り直し</button>
        <button class="small sub" data-op="delete">削除</button>
      </span>`;
    li.querySelector('img').src = p.url;
    li.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => onPhotoOp(b.dataset.op, i)));
    list.appendChild(li);
  });

  const n = state.photos.length;
  list.querySelectorAll('button').forEach((b) => { if (state.preparing) b.disabled = true; });
  $('btn-read').disabled = n === 0 || state.preparing;
  $('btn-add').disabled = state.preparing;
  $('btn-add').textContent = n === 0 ? '撮る' : '続きを撮る';
  $('s2-hint').textContent = state.preparing ? '写真を準備しています…' : n === 0
    ? 'レシートの上の端から撮ってください。長いレシートは、上から順に分けて撮れます。'
    : '続きがあれば「続きを撮る」で、前の写真と少し重ねて撮ってください。';
}

function onPhotoOp(op, i) {
  const photos = state.photos;
  if (op === 'up' && i > 0) {
    [photos[i - 1], photos[i]] = [photos[i], photos[i - 1]];
  } else if (op === 'down' && i < photos.length - 1) {
    [photos[i + 1], photos[i]] = [photos[i], photos[i + 1]];
  } else if (op === 'retake') {
    openCamera(i);
    return;
  } else if (op === 'delete') {
    if (!confirm(`${i + 1}枚目の写真を削除しますか？`)) return;
    URL.revokeObjectURL(photos[i].url);
    photos.splice(i, 1);
  }
  renderPhotos();
}

function clearReceipt() {
  state.photos.forEach((p) => URL.revokeObjectURL(p.url));
  state.photos = [];
  state.receiptId = null;
  state.receipt = null;
  state.readInfo = null;
  state.edited = false;
}

function onDiscard() {
  if ((state.photos.length || state.receipt) && !confirm('このレシートを破棄しますか？')) return;
  clearReceipt();
  show('s1');
}

// ------------------------------------------------------------------ 読み取り（S3）

async function onRead() {
  if (state.edited && !confirm('読み取り直すと、手で修正した内容は失われます。よろしいですか？')) return;
  show('s3');
  $('s3-spinner').hidden = false;
  $('s3-actions').hidden = true;
  $('s3-msg').textContent = `読み取っています…（写真 ${state.photos.length}枚）`;

  const started = Date.now();
  const timer = setInterval(() => {
    $('s3-elapsed').textContent = `${Math.floor((Date.now() - started) / 1000)}秒経過（数十秒かかることがあります）`;
  }, 1000);

  try {
    const images = await Promise.all(state.photos.map(async (p) => ({
      mediaType: 'image/jpeg',
      data: await blobToBase64(p.blob),
    })));
    // 送信先の一覧も同時に取りに行く（取れなくても読み取り結果は表示する）
    const [read, settings] = await Promise.allSettled([
      callApi('read', state.passphrase, { images }),
      callApi('getSettings', state.passphrase),
    ]);
    if (read.status === 'rejected') throw read.reason;
    const res = read.value;
    state.receipt = res.receipt;
    state.readInfo = { model: res.model, usage: res.usage, elapsedMs: res.elapsedMs, totalMs: Date.now() - started };
    state.edited = false;
    state.recipients = settings.status === 'fulfilled' ? settings.value.recipients : [];
    state.recipientsError = settings.status === 'rejected' ? settings.reason.message : '';
    state.selected = new Set(state.recipients.filter((r) => r.enabled).map((r) => r.email));
    renderEdit();
    show('s4');
  } catch (err) {
    $('s3-spinner').hidden = true;
    $('s3-msg').textContent = err.message;
    $('s3-actions').hidden = false;
    if (err instanceof ApiError && err.code === 'UNAUTHORIZED') {
      openPassphrase();
    }
  } finally {
    clearInterval(timer);
    $('s3-elapsed').textContent = '';
  }
}

// ------------------------------------------------------------------ 確認・修正（S4）

const NUMBER_FIELDS = ['outer_tax', 'total', 'points_used'];

function toInt(value) {
  const n = parseInt(String(value).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function fillOptions(select, labels) {
  select.innerHTML = Object.entries(labels).map(([v, label]) => `<option value="${v}">${esc(label)}</option>`).join('');
}

function renderEdit() {
  const r = state.receipt;
  document.querySelectorAll('#s4 [data-field]').forEach((el) => {
    const v = r[el.dataset.field];
    el.value = v ?? '';
  });
  $('outer-tax-row').hidden = r.tax_mode !== 'exclusive';
  renderItems();
  renderWarnings();
  renderRecipients();
  renderMeta();
  $('preview').open = false;
  $('s4-msg').textContent = '';
  updateCheck();
}

/** ヘッダー部分（店名・日付・合計など）の入力 */
function onFieldInput(e) {
  const el = e.target;
  const field = el.dataset.field;
  if (!field) return;
  let value = el.value;
  if (NUMBER_FIELDS.includes(field)) value = toInt(value);
  if (field === 'card_last4') value = value.replace(/\D/g, '').slice(0, 4);
  if ((field === 'date' || field === 'time') && !value) value = null;
  state.receipt[field] = value;
  state.edited = true;
  if (field === 'tax_mode') $('outer-tax-row').hidden = value !== 'exclusive';
  updateCheck();
}

function renderItems(openIndex = null) {
  const list = $('items');
  list.innerHTML = '';
  state.receipt.items.forEach((it, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="item-row"></div>
      <div class="item-editor" hidden>
        <label>種類
          <select data-k="kind"><option value="item">品目</option><option value="discount">値引き</option></select>
        </label>
        <label>税率
          <select data-k="tax_rate"><option value="8">8%</option><option value="10">10%</option><option value="">不明</option></select>
        </label>
        <label class="wide">品名<input data-k="name" type="text"></label>
        <label class="wide">レシート表記<input data-k="raw_name" type="text"></label>
        <label>数量<input data-k="quantity" type="number" inputmode="numeric" min="1"></label>
        <label>金額（円）<input data-k="amount" type="number" inputmode="numeric" min="0"></label>
        <div class="ops">
          <button class="small danger" data-op="delete">この行を削除</button>
          <button class="small sub" data-op="close">閉じる</button>
        </div>
      </div>`;
    const editor = li.querySelector('.item-editor');
    editor.querySelector('[data-k=kind]').value = it.kind;
    editor.querySelector('[data-k=tax_rate]').value = it.tax_rate == null ? '' : String(it.tax_rate);
    editor.querySelector('[data-k=name]').value = it.name;
    editor.querySelector('[data-k=raw_name]').value = it.raw_name;
    editor.querySelector('[data-k=quantity]').value = it.quantity;
    // 金額は正の数で入力し、符号は「種類」で決める（iPhone の数字キーにはマイナスがないため）
    editor.querySelector('[data-k=amount]').value = Math.abs(it.amount);

    li.querySelector('.item-row').addEventListener('click', () => { editor.hidden = !editor.hidden; });
    editor.addEventListener('input', () => onItemInput(i, li));
    editor.addEventListener('change', () => onItemInput(i, li));
    editor.querySelector('[data-op=delete]').addEventListener('click', () => {
      if (!confirm('この行を削除しますか？')) return;
      state.receipt.items.splice(i, 1);
      state.edited = true;
      renderItems();
      updateCheck();
    });
    editor.querySelector('[data-op=close]').addEventListener('click', () => { editor.hidden = true; });
    if (i === openIndex) editor.hidden = false;
    renderItemRow(li, it);
    list.appendChild(li);
  });
}

function renderItemRow(li, it) {
  li.className = (it.kind === 'discount' ? 'discount' : '') + (it.name ? '' : ' empty');
  li.querySelector('.item-row').innerHTML = `
    <span class="name">${esc(it.name)}${it.raw_name && it.raw_name !== it.name ? `<span class="raw">${esc(it.raw_name)}</span>` : ''}</span>
    <span class="num">×${it.quantity}</span>
    <span class="num">${yen(it.amount)}</span>
    <span class="num">${it.tax_rate == null ? '-' : it.tax_rate + '%'}</span>`;
}

function onItemInput(i, li) {
  const it = state.receipt.items[i];
  const get = (k) => li.querySelector(`[data-k=${k}]`).value;
  it.kind = get('kind');
  it.tax_rate = get('tax_rate') === '' ? null : Number(get('tax_rate'));
  it.name = get('name');
  it.raw_name = get('raw_name');
  it.quantity = Math.max(1, toInt(get('quantity')) || 1);
  const amount = Math.abs(toInt(get('amount')));
  it.amount = it.kind === 'discount' ? -amount : amount;
  state.edited = true;
  renderItemRow(li, it);
  updateCheck();
}

function onAddItem() {
  state.receipt.items.push({ kind: 'item', name: '', raw_name: '', quantity: 1, amount: 0, tax_rate: 8 });
  state.edited = true;
  const last = state.receipt.items.length - 1;
  renderItems(last);
  updateCheck();
  $('items').lastElementChild.querySelector('[data-k=name]').focus();
}

function renderWarnings() {
  const w = state.receipt.warnings || [];
  $('warnings').innerHTML = w.length
    ? `<div class="card warnings"><b>⚠ AI からの注意</b><ul>${w.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`
    : '';
}

function renderRecipients() {
  const box = $('recipients');
  if (state.recipientsError) {
    box.innerHTML = `<p class="msg">${esc(state.recipientsError)}</p>`;
    return;
  }
  if (!state.recipients.length) {
    box.innerHTML = '<p class="msg">送信先が登録されていません（Apps Script のスクリプト プロパティ RECIPIENTS に登録してください）</p>';
    return;
  }
  box.innerHTML = '';
  state.recipients.forEach((r) => {
    const label = document.createElement('label');
    label.className = 'recipient';
    label.innerHTML = `<input type="checkbox"><span>${esc(r.email)}</span>`;
    const cb = label.querySelector('input');
    cb.checked = state.selected.has(r.email);
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(r.email); else state.selected.delete(r.email);
      updateSendButton();
    });
    box.appendChild(label);
  });
}

function renderMeta() {
  const info = state.readInfo;
  const cost = estimateYen(info.model, info.usage);
  $('meta').innerHTML = `
    <dt>モデル</dt><dd>${esc(info.model)}</dd>
    <dt>時間</dt><dd>AI ${(info.elapsedMs / 1000).toFixed(1)}秒 ／ 全体 ${(info.totalMs / 1000).toFixed(1)}秒</dd>
    <dt>トークン</dt><dd>入力 ${info.usage.input_tokens.toLocaleString()} ／ 出力 ${info.usage.output_tokens.toLocaleString()}</dd>
    <dt>費用目安</dt><dd>${cost == null ? '-' : `約 ${cost.toFixed(1)}円`}</dd>`;
}

/** 合計チェックの表示を更新する（修正のたびに呼ぶ） */
function updateCheck() {
  const c = checkTotal(state.receipt);
  const r = state.receipt;
  $('check').innerHTML = c.ok
    ? '<p class="check ok">✓ 合計チェック OK</p>'
    : `<p class="check ng">⚠ 要確認: 品目から計算した合計 ${yen(c.expected)}、レシートの合計 ${yen(r.total)}（差 ${yen(c.diff)}）</p>
       <p class="note">合わないまま送信すると、メールに「要確認」と載ります。</p>`;
  if ($('preview').open) loadPreview();
  updateSendButton();
}

function updateSendButton() {
  $('btn-send').disabled = state.sending || state.selected.size === 0;
}

/** メール本文のプレビュー（本文は Apps Script で作るので、送るものと同じになる） */
let previewTimer = null;
function loadPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    if (!state.receipt) return;  // 待っている間に送信・破棄された
    $('preview-body').textContent = '作成しています…';
    try {
      const res = await callApi('preview', state.passphrase, { receiptId: state.receiptId, receipt: state.receipt });
      $('preview-body').textContent = `件名: ${res.subject}\n\n${res.body}`;
    } catch (err) {
      $('preview-body').textContent = err.message;
    }
  }, 600);
}

/** 送る前の確認（画面で直せる間違い） */
function validateForSend() {
  const r = state.receipt;
  if (!r.store.trim()) return '店名を入力してください';
  if (!r.date) return '日付を入力してください';
  if (!r.items.length) return '品目がありません';
  const noName = r.items.findIndex((it) => !it.name.trim());
  if (noName >= 0) return `${noName + 1}行目の品名を入力してください`;
  return '';
}

async function onSend() {
  const problem = validateForSend();
  if (problem) {
    $('s4-msg').textContent = problem;
    return;
  }
  const to = state.recipients.map((r) => r.email).filter((e) => state.selected.has(e));
  state.sending = true;
  updateSendButton();
  $('btn-send').textContent = '送信中…';
  $('s4-msg').textContent = '';
  try {
    const res = await callApi('send', state.passphrase, { receiptId: state.receiptId, receipt: state.receipt, to });
    $('s5-msg').innerHTML = `送信しました（宛先 ${res.sentTo.length}件）<br><span class="note">${res.sentTo.map(esc).join('<br>')}</span>`;
    clearReceipt();
    show('s5');
  } catch (err) {
    if (err instanceof ApiError && err.code === 'ALREADY_SENT') {
      $('s5-msg').textContent = 'このレシートは送信済みです';
      clearReceipt();
      show('s5');
    } else if (err instanceof ApiError && err.code === 'UNAUTHORIZED') {
      openPassphrase();
    } else {
      $('s4-msg').textContent = err.message;
    }
  } finally {
    state.sending = false;
    $('btn-send').textContent = '送信';
    updateSendButton();
  }
}

// ------------------------------------------------------------------ 起動

function init() {
  fillOptions(document.querySelector('[data-field=payment_method]'), PAYMENT_LABELS);
  fillOptions(document.querySelector('[data-field=tax_mode]'), TAX_MODE_LABELS);

  $('btn-save-pass').addEventListener('click', onSavePassphrase);
  $('btn-cancel-pass').addEventListener('click', () => show('s1'));
  $('btn-settings').addEventListener('click', openPassphrase);
  $('btn-start').addEventListener('click', startReceipt);
  $('btn-add').addEventListener('click', () => openCamera(null));
  $('btn-discard').addEventListener('click', onDiscard);
  $('btn-read').addEventListener('click', onRead);
  $('btn-retry').addEventListener('click', onRead);
  $('btn-back-photos').addEventListener('click', () => show('s2'));
  $('btn-back-photos2').addEventListener('click', () => show('s2'));
  $('btn-add-item').addEventListener('click', onAddItem);
  $('btn-send').addEventListener('click', onSend);
  $('btn-home').addEventListener('click', () => show('s1'));
  $('preview').addEventListener('toggle', () => { if ($('preview').open) loadPreview(); });
  $('camera').addEventListener('change', onPhotoTaken);
  const s4 = $('s4');
  s4.addEventListener('input', onFieldInput);
  s4.addEventListener('change', onFieldInput);

  if (state.passphrase) {
    show('s1');
  } else {
    openPassphrase();
  }
}

init();
