// M4: 実照明10灯＋シーン16を Matter に露出し、本体WebUI契約(status.json/qr.svg)を書く。配線のみ。
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Environment, ServerNode, Endpoint, VendorId } from "@matter/main";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";

import { EchoBridgeClient } from "./client.js";
import { buildBridge } from "./devices.js";
import { StateSync } from "./sync.js";
import { readVersion, startStatusWriter, writeQr } from "./status.js";
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

// storage を <リポジトリ>/data 配下へ（import.meta.url 基準・CWD非依存）。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(repoRoot, "data");
const environment = Environment.default;
environment.vars.set("storage.path", dataDir);
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

const client = new EchoBridgeClient();
log(`本体API: ${client.baseUrl}`);

// 起動時に本体構成を取得（読み取り系のみ）。
// ★本体不達時に未捕捉例外の全文Traceback(651B)を垂れ流さない（M11・S2-1候補①）。
// 本体が落ちている間 Restart=on-failure が5秒ごとに再起動を繰り返し（RestartSec=5s に対し
// StartLimitBurst=5/10s なのでレート制限に掛からない＝無限に再試行する）、そのたびに
// Traceback が data/error_addon.log へ永続追記されて 469KB/時で伸び、1MB枠を約2時間で
// 使い切る。世代1ローテ（.service の ExecStartPre）と相まって、約4.2時間で真の診断履歴が
// 追い出される。ここで握って1行のWARNに畳むことでその肥大を止める。
// ★exit 1 は維持する: クラッシュ→Restart=on-failure で起動順を担保する既存設計
//   （.service:5-6 の「本体不達で起動した場合は index.js が異常終了 → Restart=on-failure が
//   起動順を担保する」）を変えないため。Traceback全文を出さないことだけが本改修の目的。
let lights;
let scenes;
try {
  lights = await client.getLights();
  scenes = await client.getScenes();
} catch (e) {
  warn(`WARN 本体API不達のため起動を中止（Restart=on-failureで再試行）: ${client.baseUrl} — ${e?.message ?? e}`);
  process.exit(1);
}
log(`本体構成取得: lights=${lights.length} scenes=${scenes.length}`);

// 本体接続状態の共有ホルダ（M11・S2-1候補④のmatter半分）。
// sync が全同期の成否で書き換え、status.js が status.json へ載せる。
// ここに来た時点で getLights/getScenes が成功しているので初期値は ok:true が事実に即する
// （false から始めると起動直後に必ず false→true の遷移が起きて status.json を二度書く）。
const upstream = { ok: true, lastOkAt: new Date().toISOString() };

// 版数は VERSION ファイルを出所とし、採番規則は identity.js に集約する（二重管理の回避）。
const { softwareVersion, softwareVersionString } = softwareVersionFrom(await readVersion(repoRoot));

const server = await ServerNode.create({
  environment,
  id: "echobridge-matter-bridge",
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

// 本体WebUI向けの契約ファイル群（QRは起動時1回・statusは起動時＋fabric変化で更新）。
// いずれもUX付加物なので、失敗してもブリッジ本体の機能は止めない。
let stopStatusWriter = () => {};
let refreshStatus = () => {}; // 状態ファイルが書けなかった場合も sync 側を壊さない no-op 既定
try {
  const { manualPairingCode, qrPairingCode } = server.state.commissioning.pairingCodes;
  log("commissioned =", server.lifecycle.isCommissioned);
  log("manual pairing code:", manualPairingCode);
  log("QR pairing code string:", qrPairingCode);
  await writeQr(dataDir, qrPairingCode);
  const writer = await startStatusWriter({ server, repoRoot, dataDir, upstream });
  stopStatusWriter = writer.stop;
  refreshStatus = writer.refresh;
} catch (e) {
  warn(`WARN 状態ファイルの書き出しに失敗（ブリッジは継続）: ${e?.message ?? e}`);
}

// 状態同期ワーカー起動（初期全同期→SSE購読→再接続→保険ポーリング）。
// upstream を渡して本体接続状態を記録させ、真偽が反転した時だけ status.json を書き直す
// （毎回書くと5分ごとにSD書込が発生するため。詳細は sync.js の _setUpstream）。
const sync = new StateSync(client, lightsByInstance, { upstream, onUpstreamChange: () => refreshStatus() });
sync.start();

// graceful shutdown。
let closing = false;
const shutdown = async (sig) => {
  if (closing) return;
  closing = true;
  log(`received ${sig}, closing...`);
  try {
    stopStatusWriter();
    await sync.stop();
    await server.close(); // runtime.signals=false のため、この close が実体（並行closeと競合しない）
    log("server closed cleanly");
  } catch (e) {
    warn(`WARN error during close: ${e?.message ?? e}`);
  }
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
