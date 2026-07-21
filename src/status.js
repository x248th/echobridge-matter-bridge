// status: 本体WebUIが読む契約ファイル data/status.json と data/qr.svg を書き出す。
// 契約（本体側で確定・本体が読むのはこの2ファイルのみ）:
//   必須 service / display_name / version（いずれか欠ける・versionが"unknown"だとカードが出ない）。
//   任意（汎用描画） paired_clients / pin。xhm_uri・bridge_name は本体が読まない＝書かない。
//   updated_at はデバッグ用（本体不読）。走査はリクエスト毎評価＝置けばリロードでカードが出る。
//   QRは稼働中のみ /api/addon/{id}/qr が data/qr.svg を配信する（無ければ404）。
// 移植元の流儀（hap_bridge/main.py）: tmp+rename のアトミック置換・chmod 600・差分時のみ書く。
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import QRCode from "qrcode";

// service は systemdユニット名かつ本体の ADDON_SERVICE_WHITELIST と一致必須（不一致＝トグル不能）。
const SERVICE = "matter-bridge";
// display_name は本体の走査ベース表示に使う種別名（HAP版アドオンの "HomeKit" と対の位置づけ）。
// ★これは本体WebUI上の「製品UIの表示名」専用。未認証状態で "Matter" ブランドを製品UIに
// 掲出しないため M10 で "スマートホーム連携（β版）" へ変更した。
// Matterプロトコル上の名前（basicInformation の vendorName/productName/nodeLabel）は
// src/identity.js が単一集約点で、ここと定数を共有しない＝連動しない。プロトコル名を
// 変えるとペアリング済みfabricへ影響し再ペアリングを要する恐れがあるため、意図的に不変。
const DISPLAY_NAME = "スマートホーム連携（β版）";
// Apple Keychain（CSA登録VID 0x1384）: iOSがペアリング資格情報の保管用に張る帳簿fabric。
// ホーム構成/ハブ/家族共有とは無関係で、1ホームのペアリングでも必ず1つ増える（M4でfabric#2=0x1384
// を実測・当時は正体不明だった）。「ペアリングシステム数」からは除外して数える。
// 同種の帳簿fabricが将来見つかれば KEYCHAIN_VENDOR_IDS に追記する（単一集約点）。
const KEYCHAIN_VENDOR_IDS = [0x1384];
// 本体W3で描画予定のラベル文言（status.json に載せて本体が読む）。
const PAIRED_LABEL = "ペアリングシステム数";

const ts = () => new Date().toISOString();
const log = (...a) => console.log(`[${ts()}]`, ...a);
// WARN相当は stderr へ（systemd の StandardError=append:data/error_addon.log に載る）。
const warn = (...a) => console.warn(`[${ts()}]`, ...a);

/** VERSIONファイル（リポジトリ直下・1行）を読む。不在/空は "unknown"（起動は止めない）。 */
export async function readVersion(repoRoot) {
  try {
    const val = (await readFile(join(repoRoot, "VERSION"), "utf8")).trim();
    return val || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * manualPairingCode を人が読み書きする表示形へ整形する。
 * Matterの標準手動コードは11桁＝Apple Homeの入力欄と同じ 4-3-4 区切りにする。
 * 長形式(21桁)や想定外桁は区切りを発明せずそのまま返す。
 */
export function formatPin(manualPairingCode) {
  const digits = String(manualPairingCode ?? "");
  if (!/^\d{11}$/.test(digits)) return digits;
  return `${digits.slice(0, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
}

/**
 * fabrics 配列から「ペアリングシステム数」を数える。
 * Keychain等の帳簿fabric（KEYCHAIN_VENDOR_IDS）を除外した数＝実際にこのブリッジを
 * 登録したエコシステム数（Apple Homeのみ=1・他エコシステムへ共有すると+1）。
 * vendorId は matter.js のブランド型なので Number() で素の数値に落として比較する。
 */
export function countPairedClients(fabrics) {
  return (fabrics ?? []).filter((f) => !KEYCHAIN_VENDOR_IDS.includes(Number(f.vendorId))).length;
}

/**
 * status.json の中身（updated_at を除く）。差分判定の対象でもある。
 * upstream_ok / upstream_last_ok_at は M11 で追加（S2-1候補④のmatter半分）。
 * 本体WebUI側の描画は別セッション(W12)の管轄で、ここは**フィールドを供給するのみ**。
 * 本体が読まなくても壊れない（本体は既知キーだけを見て未知キーは無視する契約）。
 */
export function buildStatus({ version, pairedClients, fabricsTotal, pin, upstream }) {
  return {
    service: SERVICE,
    display_name: DISPLAY_NAME,
    version,
    paired_clients: pairedClients,
    // paired_label は本体W3で数字の横に描画予定の文言。fabrics_total は生の総数（本体不読・デバッグ用）。
    paired_label: PAIRED_LABEL,
    fabrics_total: fabricsTotal,
    pin,
    // 本体API(:8099)への到達性。true=直近の全同期が成功 / false=不達。
    // アドオンだけ生きていて本体が落ちている状態を本体WebUIから見分けるための供給。
    upstream_ok: upstream?.ok ?? null,
    // 最後に本体APIへ到達できた時刻(ISO8601)。不達中も「いつまで生きていたか」を保つ。
    upstream_last_ok_at: upstream?.lastOkAt ?? null,
  };
}

/** tmp→rename でアトミック置換。読み手（本体WebUI）が半端なJSONを見ることはない。 */
async function writeStatus(dataDir, status) {
  const path = join(dataDir, "status.json");
  const tmp = `${path}.tmp`;
  const payload = { ...status, updated_at: new Date().toISOString() };
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  await chmod(tmp, 0o600); // renameの前に権限を立てる＝600でない瞬間を作らない
  await rename(tmp, path);
}

/** qrPairingCode(MT:…) から data/qr.svg を生成（起動時1回・冪等に上書き）。 */
export async function writeQr(dataDir, qrPairingCode) {
  const path = join(dataDir, "qr.svg");
  // 白地固定: 透過だとダークUI上でカメラが読めないことがある（HAP版の background="#fff" と同趣旨）。
  const svg = await QRCode.toString(qrPairingCode, {
    type: "svg",
    margin: 2,
    width: 256,
    color: { dark: "#000000", light: "#ffffff" },
  });
  await writeFile(path, svg);
  await chmod(path, 0o600);
  log(`QR書き出し: ${path}`);
}

/**
 * 状態ファイル群の書き出しを開始する。
 * 起動完了後（server.start・pairingCodes取得後）に1回書き、以後は fabric変化イベントと
 * 本体接続状態の反転（sync が refresh を呼ぶ）で更新する。
 * 差分が無ければ書かない（本体の書き込み抑制思想に合わせSD消耗を避ける）。
 * 返り値: { stop: 購読解除, refresh: 再評価して差分があれば書く }。
 */
export async function startStatusWriter({ server, repoRoot, dataDir, upstream = null }) {
  const version = await readVersion(repoRoot);
  if (version === "unknown") {
    warn("WARN VERSIONファイルを読めず version=unknown（本体はこのカードを描画しない）");
  }
  const pin = formatPin(server.state.commissioning.pairingCodes.manualPairingCode);

  let last = null;
  const update = async () => {
    // fabrics 生配列から算出: paired_clients=Keychain除外数 / fabrics_total=総数。
    // 件数の変化契機は fabricsChanged のみ（下で購読）＝定期ポーリング不要。
    const fabrics = server.state.operationalCredentials.fabrics ?? [];
    const current = buildStatus({
      version,
      pairedClients: countPairedClients(fabrics),
      fabricsTotal: fabrics.length,
      pin,
      upstream,
    });
    if (JSON.stringify(current) === JSON.stringify(last)) return;
    try {
      await writeStatus(dataDir, current);
      last = current; // 書けた時だけ更新＝失敗は次の変化で再試行される
      log(
        `status.json更新: paired_clients=${current.paired_clients} fabrics_total=${current.fabrics_total} version=${current.version}`,
      );
    } catch (e) {
      warn(`WARN status.json書き出しに失敗（継続）: ${e?.message ?? e}`);
    }
  };

  await update();

  // fabric変化（追加/削除/更新）＝ commissionedFabrics が動く唯一の契機。定期ポーリング不要。
  const onFabricsChanged = () => {
    update().catch((e) => warn(`WARN status更新に失敗（継続）: ${e?.message ?? e}`));
  };
  server.events.commissioning.fabricsChanged.on(onFabricsChanged);
  return {
    stop: () => server.events.commissioning.fabricsChanged.off(onFabricsChanged),
    // sync が本体接続状態の反転時に呼ぶ。失敗しても呼び出し元へ投げ返さない。
    refresh: () => {
      update().catch((e) => warn(`WARN status更新に失敗（継続）: ${e?.message ?? e}`));
    },
  };
}
