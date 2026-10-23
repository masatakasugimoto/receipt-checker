// 読み取り結果の計算・表示用の変換

export const PAYMENT_LABELS = {
  cash: '現金',
  credit: 'クレジット',
  emoney: '電子マネー',
  qr: 'QR 決済',
  other: 'その他',
  unknown: '不明',
};

export const TAX_MODE_LABELS = {
  inclusive: '内税',
  exclusive: '外税',
  unknown: '不明',
};

/**
 * 合計チェック（基本設計書 6.）: 品目の合計（値引きを含む）に外税を足し、レシートの合計と比べる。
 * 戻り値: {itemsTotal, expected, diff, ok}
 */
export function checkTotal(receipt) {
  const itemsTotal = receipt.items.reduce((sum, it) => sum + (Number(it.amount) || 0), 0);
  const expected = receipt.tax_mode === 'exclusive' ? itemsTotal + (Number(receipt.outer_tax) || 0) : itemsTotal;
  const diff = (Number(receipt.total) || 0) - expected;
  return { itemsTotal, expected, diff, ok: diff === 0 };
}

// 1M トークンあたりのドル（入力, 出力）。費用の目安の表示にだけ使う
const PRICES = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};
const YEN_PER_DOLLAR = 150;

/** usage から費用の目安（円）を出す。料金の分からないモデルは null */
export function estimateYen(model, usage) {
  const key = Object.keys(PRICES).find((k) => model && model.startsWith(k));
  if (!key || !usage) return null;
  const [inPrice, outPrice] = PRICES[key];
  const dollars = (usage.input_tokens * inPrice + usage.output_tokens * outPrice) / 1e6;
  return dollars * YEN_PER_DOLLAR;
}

export function yen(n) {
  return Number(n).toLocaleString('ja-JP') + '円';
}
