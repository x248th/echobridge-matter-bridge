// M4: 実照明10灯＋シーン16を Matter に露出し、本体WebUI契約(status.json/qr.svg)を書く。配線のみ。
import { Environment, ServerNode, Endpoint, VendorId } from "@matter/main";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";

import { EchoBridgeClient } from "./client.js";
import { buildBridge } from "./devices.js";
import { StateSync } from "./sync.js";
import { pairingLogLines, readVersion, startStatusWriter } from "./status.js";
import { DATA_DIR, ERROR_LOG, ERROR_LOG_OLD, NODE_ID, STORAGE_DIR, repoRoot } from "./paths.js";
import { LegacyStorageError, prepareStorage } from "./storage.js";
import { installErrorLogCap } from "./errlog.js";
import { waitForUpstream } from "./startup.js";
import {
  vendorId,
  productId,
  vendorName,
  productName,
  deviceName,
  port,
  hardwareVersion,
  hardwareVersionString,
  softwareVersionFrom,
} from "./identity.js";

const ts = () => new Date().toISOString();
const log = (...a) => console.log(`[${ts()}]`, ...a);
// WARN相当は stderr へ（systemd の StandardError=append:data/error_addon.log に載る）。
const warn = (...a) => console.warn(`[${ts()}]`, ...a);

// ★最初に: error_addon.log に稼働中も上限（1MB→.old）を掛ける（M12・§6-2。仕組みは errlog.js）。
// stderr が data/error_addon.log でない（手動起動で端末に出している等）ときは何もしない。
const errlogCap = installErrorLogCap({
  logPath: ERROR_LOG,
  oldPath: ERROR_LOG_OLD,
  onRotate: (size) => log(`error_addon.log が上限を超えたので .old へ回した（回す前 ${size}B）`),
});
log(errlogCap.active ? `error_addon.log の稼働中上限: 有効（${ERROR_LOG}）` : `error_addon.log の稼働中上限: 無効（${errlogCap.reason}）`);

// --- 停止経路（M15・F1）---
// ★ハンドラは ServerNode.create より**前**に登録する。以前は server.start() の後ろにあり、
// create〜登録の約1.4秒（M14 実測）はどちらのハンドラも無く、既定動作で即死＝ストレージを
// 閉じずに終わる窓だった（M3 の storage lock orphan WARN と同じ形）。
// server/sync がまだ無い間に来ても、あるものだけ閉じて終われるようにしてある。
// 工場出荷リセット後の再起動（M15・S1）もこの一本の経路を通す＝必ず close してから終える。
const EXIT_RESTART_AFTER_RESET = 75; // 78 以外の非0（unit の RestartPreventExitStatus=78 に当てない）
// close が返らないときの保険。SIGTERM 経由なら systemd の停止タイムアウトが最後に効くが、
// リセット後の自己終了（S1）には効かない＝終われないまま広告も止まった状態で残りうるため。
const SHUTDOWN_TIMEOUT_MS = 15_000;
let server = null;
let sync = null;
let stopStatusWriter = () => {};
let closing = false;
const shutdown = async (reason, code = 0) => {
  if (closing) return;
  closing = true;
  log(`${reason} により終了処理を始める（終了コード ${code}）`);
  const forced = setTimeout(() => {
    warn(`WARN 終了処理が ${SHUTDOWN_TIMEOUT_MS / 1000}秒で終わらないので待たずに終える（終了コード ${code}）`);
    process.exit(code);
  }, SHUTDOWN_TIMEOUT_MS);
  try {
    stopStatusWriter();
    if (sync) await sync.stop();
    if (server) {
      await server.close(); // runtime.signals=false のため、この close が実体（並行closeと競合しない）
      log("server closed cleanly");
    }
  } catch (e) {
    warn(`WARN error during close: ${e?.message ?? e}`);
  }
  clearTimeout(forced);
  process.exit(code);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// storage（ペアリング/fabric）は ~/addon-data/matter-bridge/ へ外置き（M12・§6-1）。
// アンインストールしても残る＝再インストール後もホームアプリの登録がそのまま使える。
// 置き場所は paths.js が単一集約点（テストは環境変数で一時ディレクトリへ逃がす）。
const environment = Environment.default;
environment.vars.set("storage.path", STORAGE_DIR);
// ★停止順序を当方で独占する（M3の storage lock orphan WARN の根治）。
// matter.js の ProcessManager は runtime起動時に自前の SIGINT/SIGTERM ハンドラを install し
// runtime.interrupt() で並行に close を始める。Node.close() は「close進行中なら即return」する実装
// （@matter/node の Node.js）のため、下の shutdown が await sync.stop() で出遅れると server.close()
// が実際の close を待たずに解決し、process.exit がストレージ close 前に走ってロックが orphan 化する。
// signals を切れば停止経路は下の shutdown 一本になり、close完了→exit の順序が保証される。
environment.vars.set("runtime.signals", false);

// ★ログ衛生（M11・S2-1候補②-2＋③）。matter.js の既定は level=DEBUG / format=ANSI で、
// 既定のままだと (a) journal(Storage=volatile・RuntimeMaxUse=32M の全ユニット共用リング)を
// DEBUGが占有して本体のログ保持窓を圧縮し（S2-1実測: matter-bridgeが93.4%・うち72%がDEBUG）、
// (b) 永続ログ data/error_addon.log にも色コードが混入する（同実測: 1行160Bのうち約43%）。
// キー名は @matter/general Environment.js:325-326 の実体で確認（"log.level"/"log.format"）。
// ※@matter/nodejs NodeJsEnvironment.js:47-48 は "logger.format" を書いており上流で不整合だが、
//   configurator が読むのは "log.format" 側なので当方はそちらに合わせる。
// ★障害調査時に戻せるよう data/env で上書き可能にする。@matter は MATTER_ 接頭辞の環境変数を
//   同じキーへ写す（VariableService.js:233-244）ため、data/env に
//   MATTER_LOG_LEVEL=debug / MATTER_LOG_FORMAT=ansi を書けば下の has() が真になり当方は譲る。
if (!environment.vars.has("log.level")) environment.vars.set("log.level", "info");
if (!environment.vars.has("log.format")) environment.vars.set("log.format", "plain");

// ★matter.js がストレージを作る（ServerNode.create）より前に置き場所を確かめる。
// 移行前の新コード起動（旧 data/ にだけペアリング情報がある）では起動しない。そのまま起動すると
// 空のストレージが新しく作られ、ホームアプリの登録が応答しなくなるため（storage.js）。
// 終了コード 78 は unit の RestartPreventExitStatus で再起動ループを止める（人が移行するまで待つ）。
try {
  const prepared = await prepareStorage({ vendorId, productId, log, warn });
  log(`ストレージ: ${STORAGE_DIR}/${NODE_ID}（起動時点で${prepared.storageExisted ? "在った" : "無かった"}・VID記録=${prepared.identity}）`);
} catch (e) {
  if (e instanceof LegacyStorageError) {
    log(`起動しない: ${e.message}`); // journal 側にも残す（install.sh の案内は journalctl を指す）
    warn(`WARN 起動しない: ${e.message}`);
    process.exit(78);
  }
  throw e;
}

const client = new EchoBridgeClient();
log(`本体API: ${client.baseUrl}`);

// 起動時に本体構成を取得（読み取り系のみ）。
// ★本体不達でも終了せず、繋がるまでプロセスの中で待つ（M13・§6-2 の間引き。仕組みは startup.js）。
// M11 までは exit 1 → Restart=on-failure（RestartSec=5）で約5秒ごとに再起動し、プロセスごとに
// WARN が1行 data/error_addon.log へ積もっていた（プロセスの中の間引きでは減らない）。
// 待っている間は ServerNode を作らない＝ストレージにもポートにも触れない。起動順（本体より先に
// 上がった場合）は、この待ちが担保する（Restart=on-failure は想定外の異常終了の受け皿として残る）。
const { lights, scenes } = await waitForUpstream({
  fetchConfig: async () => ({ lights: await client.getLights(), scenes: await client.getScenes() }),
  baseUrl: client.baseUrl,
  log,
  warn,
});
log(`本体構成取得: lights=${lights.length} scenes=${scenes.length}`);

// 本体接続状態の共有ホルダ（M11・S2-1候補④のmatter半分）。
// sync が全同期の成否で書き換え、status.js が status.json へ載せる。
// ここに来た時点で getLights/getScenes が成功しているので初期値は ok:true が事実に即する
// （false から始めると起動直後に必ず false→true の遷移が起きて status.json を二度書く）。
const upstream = { ok: true, lastOkAt: new Date().toISOString() };

// 版数は VERSION ファイルを出所とし、採番規則は identity.js に集約する（二重管理の回避）。
const { softwareVersion, softwareVersionString } = softwareVersionFrom(await readVersion(repoRoot));

server = await ServerNode.create({
  environment,
  id: NODE_ID,
  network: { port },
  productDescription: { name: deviceName, deviceType: AggregatorEndpoint.deviceType },
  basicInformation: {
    vendorId: VendorId(vendorId),
    vendorName,
    productId,
    productName,
    nodeLabel: deviceName,
    // 非0を与えて「開発値WARN」の毎起動1行を止める（M11・S2-1候補②-3）。
    hardwareVersion,
    hardwareVersionString,
    softwareVersion,
    softwareVersionString,
  },
});

const aggregator = new Endpoint(AggregatorEndpoint, { id: "aggregator" });
await server.add(aggregator);

const { lightsByInstance } = await buildBridge({ client, aggregator, lights, scenes });
log(`エンドポイント生成: light×${lights.length} + scene×${scenes.length} = ${lights.length + scenes.length}`);

await server.start();

// 本体WebUI向けの契約ファイル群（status.json と、未登録のときだけ qr.svg。契機は status.js）。
// いずれもUX付加物なので、失敗してもブリッジ本体の機能は止めない。
let refreshStatus = () => {}; // 状態ファイルが書けなかった場合も sync 側を壊さない no-op 既定
try {
  // ★登録済みのときはペアリングコードと QR 文字列を出さない（M15・C1。組み立ては status.js）。
  for (const line of pairingLogLines(server)) log(line);
  const writer = await startStatusWriter({
    server,
    repoRoot,
    dataDir: DATA_DIR,
    upstream,
    // ★工場出荷リセット（ホームアプリからの削除）の後は、プロセスを終えて systemd に
    //   起動し直させる（M15・S1）。matter.js の reset はエンドポイントの Events を作り直すため、
    //   起動時に張った onOff$Changed 等の購読が外れ、タイルを押しても本体へ届かなくなる
    //   （M14 で実測: erase 後の set でハンドラの発火が0回）。新しいプロセスなら全部貼り直る＝
    //   matter.js の内部（どのオブジェクトが作り直されるか）に依存しない。
    //   ここに来る時点で新しい PIN/QR の status.json・qr.svg への書き出しは済んでおり、
    //   下の shutdown が server.close() を通るのでストレージにも書き終えてから終わる。
    onResetComplete: () => {
      log("工場出荷リセット後にオンラインへ戻った。購読を貼り直すためプロセスを終える（systemd が起動し直す）");
      setImmediate(() => shutdown("工場出荷リセット", EXIT_RESTART_AFTER_RESET));
    },
  });
  stopStatusWriter = writer.stop;
  refreshStatus = writer.refresh;
} catch (e) {
  warn(`WARN 状態ファイルの書き出しに失敗（ブリッジは継続）: ${e?.message ?? e}`);
}

// 状態同期ワーカー起動（初期全同期→SSE購読→再接続→保険ポーリング）。
// upstream を渡して本体接続状態を記録させ、真偽が反転した時だけ status.json を書き直す
// （毎回書くと5分ごとにSD書込が発生するため。詳細は sync.js の _setUpstream）。
sync = new StateSync(client, lightsByInstance, { upstream, onUpstreamChange: () => refreshStatus() });
sync.start();
