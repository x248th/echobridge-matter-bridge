// M4: 実照明10灯＋シーン16を Matter に露出し、本体WebUI契約(status.json/qr.svg)を書く。配線のみ。
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Environment, ServerNode, Endpoint, VendorId } from "@matter/main";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";

import { EchoBridgeClient } from "./client.js";
import { buildBridge } from "./devices.js";
import { StateSync } from "./sync.js";
import { startStatusWriter, writeQr } from "./status.js";
import { vendorId, productId, vendorName, productName, deviceName, port } from "./identity.js";

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

const client = new EchoBridgeClient();
log(`本体API: ${client.baseUrl}`);

// 起動時に本体構成を取得（読み取り系のみ）。
const lights = await client.getLights();
const scenes = await client.getScenes();
log(`本体構成取得: lights=${lights.length} scenes=${scenes.length}`);

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
try {
  const { manualPairingCode, qrPairingCode } = server.state.commissioning.pairingCodes;
  log("commissioned =", server.lifecycle.isCommissioned);
  log("manual pairing code:", manualPairingCode);
  log("QR pairing code string:", qrPairingCode);
  await writeQr(dataDir, qrPairingCode);
  stopStatusWriter = await startStatusWriter({ server, repoRoot, dataDir });
} catch (e) {
  warn(`WARN 状態ファイルの書き出しに失敗（ブリッジは継続）: ${e?.message ?? e}`);
}

// 状態同期ワーカー起動（初期全同期→SSE購読→再接続→保険ポーリング）。
const sync = new StateSync(client, lightsByInstance);
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
