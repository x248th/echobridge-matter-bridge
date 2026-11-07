// keychain_cleanup: ホームアプリから削除されたあと、Apple Keychain の登録だけが残ったら消す（M-1）。
//
// ■ なぜ要るか
// Apple Home はブリッジを削除しても Keychain の fabric（vendorId 0x1384）を残す（⑦機で実測・2026-11-06）。
// matter.js が工場出荷リセットをするのは fabric が0件になったときだけ（@matter/node 0.17.6
// CommissioningServer.js:95 `const commissioned = !!this.env.get(FabricManager).fabrics.length;`）なので、
// Keychain が残るとリセットが走らず、カードに新しいコードが出ない（顧客はここで詰む）。
// そこで残りが Keychain だけになったら、それを消して0件にし、以後はライブラリの既存の経路
// （decommissioned → 工場出荷リセット → online → status.js の onResetComplete → 終了コード 75）に任せる。
// ★server.erase() を直接呼ばない。decommissioned が出ず、status.js の resetPending が立たないので、
//   リセット後の自己終了（M15・S1）が起きず、照明の操作が届かなくなる。
//
// ■ 動く条件（すべて満たすときだけ。2026-11-06 の判断）
//   1. 削除の出来事のときだけ（fabricsChanged の action が "deleted"）。起動時・追加・更新では動かない
//      ＝すでに詰んでいる機体（起動時に Keychain だけ）は救わない。
//   2. 残りが1件以上あり、かつ登録あり（Keychain 以外）が0のときだけ。
//   3. 登録手続き中（FailsafeContext が生きている＝巻き戻しを含む）は判定しない。
//   4. 削除の処理の途中では動かない。消された fabric の後始末が終わった合図
//      （FabricManager.events.deleted・FabricManager.js:213）を待ち、さらに setImmediate で外へ出てから動く。
//   5. ログは消したあとに、起きた事だけを書く（CLAUDE.md §10）。
// ★このファイルは @matter/* を import しない（試験で ServerNode を作らずに済ませるため）。
//   matter.js への接続は matterAccessors() が、index.js から渡されたクラスで組み立てる。
import { countPairedClients } from "./status.js";

const hex = (n) => `0x${Number(n).toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * @param fabricsChanged  .on/.off を持つ。引数は (fabricIndex, action)（CommissioningServer.js:108）
 * @param fabricDeleted   .on/.off を持つ。引数は消し終えた fabric（{ fabricIndex }）
 * @param listFabrics     いまの fabric の一覧 [{ fabricIndex, vendorId }]（削除中のものは含まない）
 * @param inCommissioning 登録手続き中（巻き戻しを含む）なら true
 * @param leaveFabric     その番号の fabric を消す（Promise）
 * 返り値: { stop }
 */
export function installKeychainCleanup({
  fabricsChanged,
  fabricDeleted,
  listFabrics,
  inCommissioning,
  leaveFabric,
  log,
  warn,
  defer = (fn) => setImmediate(fn),
}) {
  const pending = new Set(); // 削除の出来事を見た番号（後始末が終わるのを待っている）
  let running = false;

  const cleanup = async () => {
    if (running) return;
    const fabrics = listFabrics();
    if (fabrics.length === 0 || countPairedClients(fabrics) !== 0) return; // 条件2
    if (inCommissioning()) return; // 条件3（待っている間に手続きが始まった場合）
    running = true;
    try {
      for (const f of fabrics) {
        try {
          await leaveFabric(f.fabricIndex);
        } catch (e) {
          warn(`WARN Apple Keychain の登録を消せなかった（fabric ${f.fabricIndex}）: ${e?.message ?? e}`);
          return;
        }
        log(`ホームアプリでの削除のあと Apple Keychain の登録だけが残っていたので消した（fabric ${f.fabricIndex}・vendorId ${hex(f.vendorId)}）`);
      }
    } finally {
      running = false;
    }
  };

  const onChanged = (fabricIndex, action) => {
    if (action !== "deleted") return; // 条件1
    if (inCommissioning()) return; // 条件3（巻き戻しの削除は数えない）
    pending.add(Number(fabricIndex));
  };
  const onDeleted = (fabric) => {
    if (!pending.delete(Number(fabric?.fabricIndex))) return;
    defer(() => {
      cleanup().catch((e) => warn(`WARN Keychain の後始末に失敗（継続）: ${e?.message ?? e}`));
    }); // 条件4
  };

  fabricsChanged.on(onChanged);
  fabricDeleted.on(onDeleted);
  return {
    stop: () => {
      fabricsChanged.off(onChanged);
      fabricDeleted.off(onDeleted);
    },
  };
}

/**
 * installKeychainCleanup に渡す口を、起動済みの ServerNode から組み立てる。
 * クラスは index.js が import して渡す（FabricManager・FailsafeContext は @matter/main/protocol、
 * Lifecycle は @matter/main）。
 */
export function matterAccessors(server, { FabricManager, FailsafeContext, Lifecycle }) {
  const fabricManager = server.env.get(FabricManager);
  return {
    fabricsChanged: server.events.commissioning.fabricsChanged,
    fabricDeleted: fabricManager.events.deleted,
    // vendorId は status.json の数え方と同じもの（OperationalCredentialsServer.js:395 が rootVendorId を載せる）。
    listFabrics: () => fabricManager.fabrics.map((f) => ({ fabricIndex: f.fabricIndex, vendorId: f.rootVendorId })),
    // CommissioningServer.js:74-77 と同じ見方（環境に在って、まだ壊されていない）。
    // 巻き戻しは FailsafeContext.close の中で fabric を消す（FailsafeContext.js:137-143・:199-221）ので、その間も真。
    inCommissioning: () => {
      if (!server.env.has(FailsafeContext)) return false;
      return server.env.get(FailsafeContext).construction.status !== Lifecycle.Status.Destroyed;
    },
    // リモートの removeFabric と同じ入口（OperationalCredentialsServer.js:310 `await fabric.leave(...)`）。
    leaveFabric: async (fabricIndex) => {
      const fabric = fabricManager.fabrics.find((f) => f.fabricIndex === fabricIndex);
      if (fabric !== undefined) await fabric.leave();
    },
  };
}
