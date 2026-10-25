// 途中のレシートの一時保存（IndexedDB）
//
// 送信するまで、撮った写真と読み取り結果を 1件だけ保存しておき、アプリを閉じても続きから再開できるようにする。
// 保存できない環境（プライベートブラウズなど）でもアプリは使えるよう、失敗しても例外は外に出さない。

const DB_NAME = 'receipt-checker';
const STORE = 'draft';
const KEY = 'current';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/**
 * 途中のレシートを保存する。
 * draft: {receiptId, photos: [Blob], receipt, readInfo}
 * 写真は ArrayBuffer にして保存する（Blob のまま保存できない古いブラウザがあるため）
 */
export async function saveDraft(draft) {
  try {
    const photos = await Promise.all(draft.photos.map(async (b) => ({ type: b.type, data: await b.arrayBuffer() })));
    const value = {
      receiptId: draft.receiptId,
      photos,
      receipt: draft.receipt,
      readInfo: draft.readInfo,
      updatedAt: new Date().toISOString(),
    };
    await run('readwrite', (s) => s.put(value, KEY));
  } catch (err) {
    console.warn('途中のレシートを保存できませんでした', err);
  }
}

/** 保存してある途中のレシートを返す（なければ null）。写真は Blob に戻す */
export async function loadDraft() {
  try {
    const value = await run('readonly', (s) => s.get(KEY));
    if (!value || !value.receiptId) return null;
    return { ...value, photos: value.photos.map((p) => new Blob([p.data], { type: p.type })) };
  } catch (err) {
    console.warn('途中のレシートを読み込めませんでした', err);
    return null;
  }
}

export async function clearDraft() {
  try {
    await run('readwrite', (s) => s.delete(KEY));
  } catch (err) {
    console.warn('途中のレシートを消せませんでした', err);
  }
}
