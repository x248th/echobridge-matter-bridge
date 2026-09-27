// status: 本体WebUIが読む契約ファイル data/status.json と data/qr.svg を書き出す。
// 契約（本体側で確定・本体が読むのはこの2ファイルのみ）:
//   必須 service / display_name / version（いずれか欠ける・versionが"unknown"だとカードが出ない）。
//   任意（汎用描画） paired_clients / pin / pairing_window_open。xhm_uri・bridge_name は本体が読まない＝書かない。
//   ★pin は登録を受け付けるとき（未登録）だけ書く（M13）。§6-3 では pin が無ければ本体は
//   ペアリングコードも QR も出さない。登録済みのときの元のコードは使えないので出さない。
//   updated_at はデバッグ用（本体不読）。走査はリクエスト毎評価＝置けばリロードでカードが出る。
//   QRは稼働中のみ /api/addon/{id}/qr が data/qr.svg を配信する（無ければ404）。
// 移植元の流儀（hap_bridge/main.py）: tmp+rename のアトミック置換・chmod 600・差分時のみ書く。
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
// AdministratorCommissioning クラスタの windowStatus の「閉じている」値
// （@matter/types clusters/administrator-commissioning.d.ts の CommissioningWindowStatus:
//   WindowNotOpen=0 / EnhancedWindowOpen=1 / BasicWindowOpen=2）。
// status.js は @matter/* を import しない（テストで ServerNode を作らずに済ませるため）ので数値で持つ。
const WINDOW_NOT_OPEN = 0;

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
export function buildStatus({ version, pairedClients, fabricsTotal, pin, upstream, pairingWindowOpen = false }) {
  const status = {
    service: SERVICE,
    display_name: DISPLAY_NAME,
    version,
    paired_clients: pairedClients,
    // paired_label は本体W3で数字の横に描画予定の文言。fabrics_total は生の総数（本体不読・デバッグ用）。
    paired_label: PAIRED_LABEL,
    fabrics_total: fabricsTotal,
    // 外から開けられた登録受付の窓が開いているか（§6-3・M17）。★常に bool で書く＝閉じたら false に
    //   書き直す（キー無しと同じく本体は何も出さない）。起動時は新しいプロセスの実態（窓は閉じている）
    //   で上書きされるので、前のプロセスの true は残らない。
    pairing_window_open: pairingWindowOpen === true,
  };
  // ★値が無ければキーごと書かない（M15・I1）。§6-3 の型は upstream_ok=bool・
  //   upstream_last_ok_at=非空str で、null は型違い（本体が「取得できません」を出す余地がある）。
  //   pin と同じ流儀に揃える。
  // 本体API(:8099)への到達性。true=直近の全同期が成功 / false=不達。
  // アドオンだけ生きていて本体が落ちている状態を本体WebUIから見分けるための供給。
  if (upstream?.ok != null) status.upstream_ok = upstream.ok;
  // 最後に本体APIへ到達できた時刻(ISO8601)。不達中も「いつまで生きていたか」を保つ。
  if (upstream?.lastOkAt != null) status.upstream_last_ok_at = upstream.lastOkAt;
  // pin は登録を受け付けるときだけ（null/undefined ならキーごと書かない＝本体はコードも QR も出さない）。
  if (pin != null) status.pin = pin;
  return status;
}

/**
 * 外から開けられた登録受付の窓（AdministratorCommissioning の windowStatus）が開いているか（M17）。
 * windowStatus が変わるのは、登録済みのコントローラ（ホームアプリの「ほかのアプリに追加」等）が
 * クラスタのコマンドで窓を開けたとき（AdministratorCommissioningServer.js:183）と、閉じたとき
 * （時間切れ・登録完了・取り消し・PASE失敗の上限のいずれも同 :218-229 の #endCommissioning へ来る）だけ。
 * ★未登録時に matter.js が自動で開く最初の窓（CommissioningServer.enterCommissionableMode）は
 *   クラスタを通らないので、ここでは false のまま（そのときは pin の側で案内する）。
 * windowStatus は非永続（書込不可・N 品質なし）で、プロセスごとに WindowNotOpen から始まる。
 */
export function isPairingWindowOpen(server) {
  const status = server.state.administratorCommissioning?.windowStatus;
  return status != null && Number(status) !== WINDOW_NOT_OPEN;
}

/**
 * 起動時に journal へ出すペアリング関連の行を組み立てる（M15・C1）。
 * ★登録済みのときはコードを出さない。status.json に pin を書かない M13 の方針と揃える
 *   （journal は揮発だが、出さないと決めたものを別の口から出さない）。
 *   M14 の実測では、登録済みでも起動のたびに実コードが journal に出ていた。
 */
export function pairingLogLines(server) {
  if (server.lifecycle.isCommissioned) {
    return ["commissioned = true（登録済みのためペアリングコードと QR 文字列は出さない）"];
  }
  const { manualPairingCode, qrPairingCode } = server.state.commissioning.pairingCodes;
  return ["commissioned = false", `manual pairing code: ${manualPairingCode}`, `QR pairing code string: ${qrPairingCode}`];
}

/**
 * tmp→rename でアトミック置換。読み手（本体WebUI）が半端な中身を見ることはない。
 * ★tmp は最初から mode 600 で作る（M15・B2）。以前は mode 無しで作ってから chmod して
 *   いたため、tmp に 644 の瞬間があった（data/ は 0755・tmp には pin が入りうる）。
 *   残っていた tmp を開き直す場合は open(w) が mode を変えないので chmod も残す。
 */
async function writeFileAtomic(path, data) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

async function writeStatus(dataDir, status) {
  const payload = { ...status, updated_at: new Date().toISOString() };
  await writeFileAtomic(join(dataDir, "status.json"), `${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * qrPairingCode(MT:…) から data/qr.svg を生成（未登録のときだけ・冪等に上書き）。
 * ★status.json と同じく tmp→rename にする（M15・B1）。以前は最終パスへ直接書いており、
 *   ファイル先頭のコメントが言う「移植元の流儀: tmp+rename のアトミック置換」と食い違って
 *   いた（新規作成時は 600 が立つまで 644 の瞬間があり、読み手が途中のSVGを読む余地もあった）。
 */
export async function writeQr(dataDir, qrPairingCode) {
  const path = join(dataDir, "qr.svg");
  // 白地固定: 透過だとダークUI上でカメラが読めないことがある（HAP版の background="#fff" と同趣旨）。
  const svg = await QRCode.toString(qrPairingCode, {
    type: "svg",
    margin: 2,
    width: 256,
    color: { dark: "#000000", light: "#ffffff" },
  });
  await writeFileAtomic(path, svg);
  log(`QR書き出し: ${path}`);
}

/**
 * 登録を受け付けない状態（登録済み／リセット待ち）へ移ったら、古い qr.svg を消す（M15・C4）。
 * 本体はカードには出さない（pin が無いため）が、稼働中は /api/addon/{id}/qr が
 * ファイルそのものを配る設計なので、出さないと決めたコードのQRを残さない。
 * 消したら true、元から無ければ false。
 */
export async function removeQr(dataDir) {
  try {
    await unlink(join(dataDir, "qr.svg"));
    return true;
  } catch (e) {
    if (e?.code === "ENOENT") return false;
    throw e;
  }
}

/**
 * 状態ファイル群（status.json・qr.svg）の書き出しを開始する。
 * 起動完了後（server.start 後）に1回評価し、以後は次の契機で評価し直す（定期的には書かない）:
 *   fabric の変化 / 登録済み⇔未登録の変化 / オンラインになった（工場出荷リセット後の再始動を含む）/
 *   本体接続状態の反転（sync が refresh を呼ぶ）/ 外から開けられた窓の開閉（windowStatus の変化・M17）。
 * 差分が無ければ書かない（本体の書き込み抑制思想に合わせSD消耗を避ける）。
 *
 * ★pin（と QR）は未登録のときだけ出す（M13）。登録済みの間は元のコードでは登録できない
 *   （fabric が残っていると commissioning window を開かない・DEV_LOG M12 第1段3.）。
 * ★ホームアプリから削除されて fabric が0件になると、matter.js は工場出荷リセットでストレージを消し、
 *   PIN と QR を作り直す（@matter/node CommissioningServer.js の handleFabricChange →
 *   #triggerFactoryReset → ServerNode.erase。作り直しは M13 で実測）。decommissioned の時点の
 *   コードはリセットで捨てられる古いものなので、リセット後にオンラインへ戻るまで pin を出さない。
 * ★onResetComplete: 工場出荷リセットのあと再びオンラインになり、新しい PIN/QR を
 *   status.json・qr.svg へ書き終えてから1回だけ呼ぶ（M15・S1）。呼び出し側（index.js）は
 *   ここでプロセスを終えて systemd に起動し直させ、エンドポイントの購読を貼り直す。
 * 返り値: { stop: 購読解除, refresh: 再評価して差分があれば書く }。
 */
export async function startStatusWriter({ server, repoRoot, dataDir, upstream = null, onResetComplete = null }) {
  const version = await readVersion(repoRoot);
  if (version === "unknown") {
    warn("WARN VERSIONファイルを読めず version=unknown（本体はこのカードを描画しない）");
  }

  let last = null;
  let lastQr = null; // このプロセスで書いた QR の中身（同じなら書き直さない）
  let resetPending = false; // decommissioned 〜 リセット後にオンラインへ戻るまで
  const update = async () => {
    // fabrics 生配列から算出: paired_clients=Keychain除外数 / fabrics_total=総数。
    const fabrics = server.state.operationalCredentials.fabrics ?? [];
    const acceptsCommissioning = !server.lifecycle.isCommissioned && !resetPending;
    let pin = null;
    if (acceptsCommissioning) {
      const { manualPairingCode, qrPairingCode } = server.state.commissioning.pairingCodes;
      pin = formatPin(manualPairingCode);
      if (qrPairingCode !== lastQr) {
        try {
          await writeQr(dataDir, qrPairingCode);
          lastQr = qrPairingCode;
        } catch (e) {
          warn(`WARN qr.svg書き出しに失敗（継続）: ${e?.message ?? e}`);
        }
      }
    } else {
      // 登録済み／リセット待ち: 古い qr.svg を残さない（M15・C4）。
      try {
        if (await removeQr(dataDir)) log("登録を受け付けない状態になったので qr.svg を消した");
        lastQr = null;
      } catch (e) {
        warn(`WARN qr.svg の削除に失敗（継続）: ${e?.message ?? e}`);
      }
    }
    const current = buildStatus({
      version,
      pairedClients: countPairedClients(fabrics),
      fabricsTotal: fabrics.length,
      pin,
      upstream,
      pairingWindowOpen: isPairingWindowOpen(server),
    });
    if (JSON.stringify(current) === JSON.stringify(last)) return;
    try {
      await writeStatus(dataDir, current);
      last = current; // 書けた時だけ更新＝失敗は次の変化で再試行される
      log(
        `status.json更新: paired_clients=${current.paired_clients} fabrics_total=${current.fabrics_total} version=${current.version} pin=${"pin" in current ? "出す（未登録）" : "出さない（登録済み）"} pairing_window_open=${current.pairing_window_open}`,
      );
    } catch (e) {
      warn(`WARN status.json書き出しに失敗（継続）: ${e?.message ?? e}`);
    }
  };
  // ★評価は1本の列で順に行う（M13）。decommissioned と fabricsChanged は同期で続けて来るため、
  // 並行に走らせると同じ status.json.tmp を2者が書いて片方の rename が ENOENT で失敗する
  // （M13 のテストで再現）。順に行えば後の評価は差分無しで書かない。
  let queue = Promise.resolve();
  const run = () => {
    queue = queue.then(update).catch((e) => warn(`WARN status更新に失敗（継続）: ${e?.message ?? e}`));
    return queue;
  };

  await run();

  // fabric変化（追加/削除/更新）。定期ポーリング不要。
  const onFabricsChanged = () => run();
  const onCommissioned = () => run();
  const onDecommissioned = () => {
    resetPending = true; // この時点のコードはリセットで捨てられる
    run();
  };
  const onOnline = () => {
    const afterReset = resetPending; // リセット後の再始動（新しいコードが読める）
    resetPending = false;
    const done = run();
    // ★新しい PIN/QR を書き終えてから知らせる（M15・S1）。
    if (afterReset && onResetComplete) {
      done.then(() => onResetComplete()).catch((e) => warn(`WARN リセット後の通知に失敗（継続）: ${e?.message ?? e}`));
    }
  };
  server.events.commissioning.fabricsChanged.on(onFabricsChanged);
  server.lifecycle.commissioned.on(onCommissioned);
  server.lifecycle.decommissioned.on(onDecommissioned);
  server.lifecycle.online.on(onOnline);
  // 外から開けられた窓の開閉（時間切れで閉じた場合を含む）。★停止時は stop() で先に外すので、
  //   server.close() が窓を閉じても status.json は書き直さない（install.sh の起動確認は mtime を見る）。
  const onWindowStatus = () => run();
  server.events.administratorCommissioning.windowStatus$Changed.on(onWindowStatus);
  return {
    stop: () => {
      server.events.commissioning.fabricsChanged.off(onFabricsChanged);
      server.lifecycle.commissioned.off(onCommissioned);
      server.lifecycle.decommissioned.off(onDecommissioned);
      server.lifecycle.online.off(onOnline);
      server.events.administratorCommissioning.windowStatus$Changed.off(onWindowStatus);
    },
    // sync が本体接続状態の反転時に呼ぶ。失敗しても呼び出し元へ投げ返さない。
    refresh: run,
  };
}
