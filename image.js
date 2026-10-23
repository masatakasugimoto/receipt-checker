// 写真の縮小

// Claude が読める最大の大きさ（長辺）。これより大きい写真は縮小し、小さい写真は拡大しない
const MAX_EDGE = 2576;
const JPEG_QUALITY = 0.85;

/**
 * 撮った写真（File）を長辺 MAX_EDGE 以下の JPEG（Blob）にする。
 * <img> で読み込むと、ブラウザが写真の回転情報（EXIF）を反映した向きで描かれる。
 */
export async function resizePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (!blob) throw new Error('写真を変換できませんでした');
    return { blob, width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('写真を読み込めませんでした'));
    img.src = url;
  });
}

/** Blob を base64 文字列（data: の前置きなし）にする */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
