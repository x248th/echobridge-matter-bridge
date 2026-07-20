// 識別情報の単一集約点。分散ハードコード禁止 —— Matter識別子の変更はここ一箇所で行う。
// M2時点はテスト用の値。商用時に見直す前提。

export const vendorId = 0xfff1; // テストVID（未認証。Apple Homeで「認定されていないアクセサリ」警告つきで追加される）
export const productId = 0x8000;
export const vendorName = "Hibel (Test)";
export const productName = "EchoBridge Matter Bridge";
export const deviceName = "EchoBridge Matter Bridge (Test)";
export const port = 5540;

// passcode/discriminator はここでは持たない。matter.js の初回生成＋storage(data/)永続に任せる。
// 商用時は per-unit ランダム化を検討（checklist宿題）。
