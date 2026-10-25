// レシートチェッ君: 画面の動き（撮影 → 読み取り → 結果の確認 → 送信）

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
  receipt: null,       // 読み取り結果
  readInfo: null,      // 読み取りのモデル・時間・トークン数
  recipients: [],      // 登録済みの送信先 [{email, enabled}]
  recipientsError: '', // 送信先の一覧を取れなかったときの理由
  selected: new Set(), // このレシートを送る宛先
  sending: false,
};

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ 画面の切り替え

const TITLES = { s0: '合言葉', s1: 'レシートチェッ君', s2: '撮影', s3: '読み取り', s4: '読み取り結果', s5: '送信完了' };

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
}

function onDiscard() {
  if ((state.photos.length || state.receipt) && !confirm('このレシートを破棄しますか？')) return;
  clearReceipt();
  show('s1');
}

// ------------------------------------------------------------------ 読み取り（S3）

async function onRead() {
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
    state.recipients = settings.status === 'fulfilled' ? settings.value.recipients : [];
    state.recipientsError = settings.status === 'rejected' ? settings.reason.message : '';
    state.selected = new Set(state.recipients.filter((r) => r.enabled).map((r) => r.email));
    renderResult();
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

// ------------------------------------------------------------------ 読み取り結果の確認（S4）

function renderResult() {
  const r = state.receipt;
  const check = checkTotal(r);

  const rows = r.items.map((it) => `
    <tr class="${it.kind === 'discount' ? 'discount' : ''}">
      <td>${esc(it.name)}${it.raw_name && it.raw_name !== it.name ? `<span class="raw">${esc(it.raw_name)}</span>` : ''}</td>
      <td class="num">${it.quantity}</td>
      <td class="num">${yen(it.amount)}</td>
      <td class="num">${it.tax_rate == null ? '-' : it.tax_rate + '%'}</td>
    </tr>`).join('');

  // AI からの注意は、レシートの内容の最後に載せる
  const warnings = r.warnings.length
    ? `<div class="card warnings"><b>⚠ AI からの注意</b><ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
    : '';

  $('result').innerHTML = `
    <div class="card">
      <dl class="kv">
        <dt>店名</dt><dd>${esc(r.store)} ${esc(r.branch)}</dd>
        <dt>日時</dt><dd>${esc(r.date ?? '（読めず）')} ${esc(r.time ?? '')}</dd>
        <dt>支払</dt><dd>${PAYMENT_LABELS[r.payment_method]}${r.card_last4 ? ` ****${esc(r.card_last4)}` : ''}</dd>
        <dt>税</dt><dd>${TAX_MODE_LABELS[r.tax_mode]}${r.tax_mode === 'exclusive' ? `（消費税 ${yen(r.outer_tax)}）` : ''}</dd>
        <dt>合計</dt><dd>${yen(r.total)}${r.points_used ? `（ポイント利用 ${yen(r.points_used)}）` : ''}</dd>
      </dl>
      <p class="check ${check.ok ? 'ok' : 'ng'}">${check.ok
        ? '✓ 合計チェック OK'
        : `⚠ 要確認: 品目から計算した合計 ${yen(check.expected)}（レシートの合計との差 ${yen(check.diff)}）`}</p>
    </div>
    <div class="card">
      <table class="items">
        <thead><tr><th>品名</th><th class="num">数</th><th class="num">金額</th><th class="num">税</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${warnings}`;

  renderRecipients();
  renderMeta();
  $('preview').open = false;
  $('s4-msg').textContent = '';
  updateSendButton();
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

function updateSendButton() {
  $('btn-send').disabled = state.sending || state.selected.size === 0;
}

/** メール本文のプレビュー（本文は Apps Script で作るので、送るものと同じになる） */
async function loadPreview() {
  $('preview-body').textContent = '作成しています…';
  try {
    const res = await callApi('preview', state.passphrase, { receiptId: state.receiptId, receipt: state.receipt });
    $('preview-body').textContent = `件名: ${res.subject}\n\n${res.body}`;
  } catch (err) {
    $('preview-body').textContent = err.message;
  }
}

async function onSend() {
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
  $('btn-send').addEventListener('click', onSend);
  $('btn-home').addEventListener('click', () => show('s1'));
  $('preview').addEventListener('toggle', () => { if ($('preview').open && state.receipt) loadPreview(); });
  $('camera').addEventListener('change', onPhotoTaken);

  if (state.passphrase) {
    show('s1');
  } else {
    openPassphrase();
  }
}

init();
