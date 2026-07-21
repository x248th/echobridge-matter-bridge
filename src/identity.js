// 識別情報の単一集約点。分散ハードコード禁止 —— Matter識別子の変更はここ一箇所で行う。
// M2時点はテスト用の値。商用時に見直す前提。

export const vendorId = 0xfff1; // テストVID（未認証。Apple Homeで「認定されていないアクセサリ」警告つきで追加される）
export const productId = 0x8000;
export const vendorName = "Hibel (Test)";
export const productName = "EchoBridge Matter Bridge";
export const deviceName = "EchoBridge Matter Bridge (Test)";
export const port = 5540;

// --- バージョン属性（M11・S2-1候補②-3）---
// 未指定または 0 のままだと matter.js の BasicInformationServer が起動ごとに
// 「Using development values for some BasicInformation attributes: hardwareVersion: 0
// softwareVersion: 0」を WARN で出し、error_addon.log（永続）に毎起動1行積もる。
// 発火条件は実体で確認済み（@matter/node BasicInformationServer.js:26-40 の setDefault が
// `state[name] === void 0 || state[name] === 0` で作動）＝**非0を与えることが要件**。
// 型制約（@matter/model basic-information.element.js:66-94）:
//   HardwareVersion=uint16 / SoftwareVersion=uint32 / 各String=1〜64文字。
// なお vendorName/productName/nodeLabel と違い、これらは fabric がキャッシュする識別名では
// なく「読み取り属性」であり、版が上がれば変わるのが仕様上の正常。M10でプロトコル名を
// 不変とした判断とは別物として扱う。
export const hardwareVersion = 1;
export const hardwareVersionString = "1";

/**
 * VERSION文字列（"1.0.2"）を Matter の softwareVersion(uint32) へ写す。
 * 規則: major*10000 + minor*100 + patch （1.0.2 → 10002）。
 * ★定数で直書きせず関数にしてあるのは、VERSION ファイルとの二重管理による
 *   食い違いを構造的に防ぐため（採番規則の単一集約点はここ・値の出所は VERSION）。
 * 解釈不能（"unknown" 等）や 0 になる場合は 1 へ落とす（0 は上記WARNの発火条件そのもの）。
 * 返り値の string 側は表示用でそのまま版文字列を使う（空なら "unknown"・64文字で切る）。
 */
export function softwareVersionFrom(versionString) {
  const raw = String(versionString ?? "").trim();
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(raw);
  let num = 1;
  if (m) {
    const v = Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
    if (v >= 1 && v <= 0xffffffff) num = v;
  }
  const str = (raw || "unknown").slice(0, 64);
  return { softwareVersion: num, softwareVersionString: str };
}

// passcode/discriminator はここでは持たない。matter.js の初回生成＋storage(data/)永続に任せる。
// 商用時は per-unit ランダム化を検討（checklist宿題）。
