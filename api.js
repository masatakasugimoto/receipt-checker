// Apps Script の呼び出し

// Apps Script をウェブアプリとしてデプロイしたときの URL（基本設計書 11-1）
export const GAS_URL = 'https://script.google.com/macros/s/AKfycbzkXOvh_d7Lllww0rD2NOgsjZOImlOqmrhg4-UkXyQYc41PVPHoA5-Eskf0z5njvZMH/exec';

export class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * action を呼び出し、成功なら応答（ok: true の JSON）を返す。失敗なら ApiError を投げる。
 * Content-Type を text/plain にするのは、ブラウザの事前確認（CORS のプリフライト）を避けるため。
 */
export async function callApi(action, passphrase, params = {}) {
  let res;
  try {
    res = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, passphrase, ...params }),
    });
  } catch (err) {
    throw new ApiError('NETWORK', '通信できませんでした。電波の状態を確認してください');
  }
  if (!res.ok) {
    throw new ApiError('NETWORK', `Apps Script の応答がエラーでした（${res.status}）`);
  }
  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new ApiError('NETWORK', 'Apps Script の応答を読めませんでした。URL とデプロイの設定を確認してください');
  }
  if (!data.ok) {
    throw new ApiError(data.error.code, data.error.message);
  }
  return data;
}
