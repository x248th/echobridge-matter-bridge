// storage: matter.js のストレージの置き場所（~/addon-data/matter-bridge/）を用意し、
// それをどの vendorId / productId で作ったかを記録・照合する（M12・API_CONTRACT.md §6-1）。
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { IDENTITY_FILE, LEGACY_NODE_STORAGE, NODE_STORAGE, STORAGE_DIR, repoRoot } from "./paths.js";

// 2 で matter_version を足した（M15・T1）。1 の記録も読めるまま（読めたら 2 へ書き直す）。
export const IDENTITY_SCHEMA_VERSION = 2;
const READABLE_SCHEMA_VERSIONS = new Set([1, 2]);

const ts = () => new Date().toISOString();
const defaultLog = (...a) => console.log(`[${ts()}]`, ...a);
const defaultWarn = (...a) => console.warn(`[${ts()}]`, ...a);
const hex = (n) => `0x${Number(n).toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * いま入っている matter.js（@matter/main）の版を読む（M15・T1）。
 * ★記録するだけで照合はしない。matter.js はストレージの driver が変われば起動時に
 *   その場で自動移行する（@matter/general StorageService の #migrate）。控えは取られず、
 *   記録にも版が無かったため「このストレージをどの版が書いたか」を後から辿れなかった。
 * 読めなければ null（記録にキーを載せない）。ここで起動は止めない。
 */
async function readMatterVersion() {
  try {
    const raw = await readFile(join(repoRoot, "node_modules", "@matter", "main", "package.json"), "utf8");
    const v = JSON.parse(raw).version;
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

/** 旧置き場所にだけストレージがある（移行前の新コード起動）。起動を止める理由として投げる。 */
export class LegacyStorageError extends Error {}

/**
 * 起動時に1回呼ぶ。ServerNode.create より前（＝matter.js がストレージを作る前）に呼ぶこと。
 *
 * 1. 移行漏れの検出: 旧版の data/<NODE_ID>/ が在り、新しい置き場所に無ければ LegacyStorageError。
 *    ★そのまま起動すると matter.js は空のストレージを新しく作り、別の PIN の「未登録の機器」として
 *      立ち上がる＝ホームアプリの登録が応答しなくなる。旧ストレージを自動で動かすことはせず
 *      （移行は人間の手順）、起動しないことで登録を守る。
 * 2. ~/addon-data/matter-bridge/ が無ければ作る（§6-1: echobridge 権限で動くアドオンが作り直せること）。
 * 3. VID/PID の記録（storage_identity.json）: 無ければ現在の値で書く。在れば照合し、食い違えば
 *    WARNING を1回出すだけ（自動では消さない。本番 VID へ移るときの扱いは将来決める）。
 *
 * 記録・照合の失敗ではブリッジを止めない（WARN のみ）。返り値は起動ログ用の事実の要約。
 */
export async function prepareStorage({ vendorId, productId, log = defaultLog, warn = defaultWarn }) {
  const legacy = existsSync(LEGACY_NODE_STORAGE);
  const current = existsSync(NODE_STORAGE);
  if (legacy && !current) {
    throw new LegacyStorageError(
      `旧置き場所にだけペアリング情報がある: ${LEGACY_NODE_STORAGE}（移行先 ${NODE_STORAGE} が無い）。` +
        "このまま起動するとホームアプリの登録が応答しなくなるため起動しない。移行手順に従って移動すること",
    );
  }
  if (legacy && current) {
    warn(`WARN 旧置き場所にもペアリング情報が残っている（使っていない）: ${LEGACY_NODE_STORAGE}`);
  }

  await mkdir(STORAGE_DIR, { recursive: true, mode: 0o700 });

  const identity = await checkIdentity({ vendorId, productId, storageExisted: current, log, warn });
  return { storageDir: STORAGE_DIR, storageExisted: current, identity };
}

async function checkIdentity({ vendorId, productId, storageExisted, log, warn }) {
  let raw;
  try {
    raw = await readFile(IDENTITY_FILE, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") {
      warn(`WARN VID記録を読めない（照合せず・ファイルには触れない）: ${IDENTITY_FILE} — ${e?.message ?? e}`);
      return "unreadable";
    }
    raw = null;
  }

  if (raw === null) {
    const record = {
      schema_version: IDENTITY_SCHEMA_VERSION,
      vendor_id: vendorId,
      product_id: productId,
      // このストレージを書いた matter.js の版（M15・T1。記録するだけで照合はしない）。
      matter_version: await readMatterVersion(),
      recorded_at: new Date().toISOString(),
      // 記録した時点でストレージが既に在ったか。true なら「作成時の値」ではなく
      // 「記録時の値」（旧版からの移行など。作成時の値はこの記録からは分からない）。
      storage_existed_at_record: storageExisted,
    };
    try {
      await writeAtomic(IDENTITY_FILE, `${JSON.stringify(record, null, 2)}\n`);
    } catch (e) {
      warn(`WARN VID記録を書けない（継続）: ${IDENTITY_FILE} — ${e?.message ?? e}`);
      return "write-failed";
    }
    log(`VID記録を書いた: ${IDENTITY_FILE}（vendorId=${hex(vendorId)} productId=${hex(productId)}）`);
    return "recorded";
  }

  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    rec = null;
  }
  if (!rec || typeof rec !== "object" || !READABLE_SCHEMA_VERSIONS.has(rec.schema_version)) {
    warn(`WARN VID記録の形が分からない（照合せず・ファイルには触れない）: ${IDENTITY_FILE}`);
    return "unknown-schema";
  }
  // ★記録した時点ではストレージが在ったのに、今は無い＝ペアリング情報が消えている
  //   （人が中だけ消した等）。そのまま起動すると別の PIN の「未登録の機器」として立ち上がり、
  //   ホームアプリの登録はやり直しになる。止めはしないが、黙って進まない（M15・N1）。
  // ★storage_existed_at_record が false のときは何も言わない。初回導入では「記録を書いた時点では
  //   まだ matter.js がストレージを作っていない」のが正常で、そこで警告すると誤報になるため
  //   （その代わり、初回導入のあとに消された場合は検出できない。既知の取りこぼし）。
  if (!storageExisted && rec.storage_existed_at_record === true) {
    warn(`WARN VID記録は在るのに matter.js のストレージが無い（ホームアプリの登録はやり直しになる）: ${NODE_STORAGE}`);
  }
  if (rec.vendor_id !== vendorId || rec.product_id !== productId) {
    warn(
      `WARN ストレージを作った VID/PID と現在の値が違う（ストレージはそのまま使う・自動では消さない）: ` +
        `記録 vendorId=${hex(rec.vendor_id)} productId=${hex(rec.product_id)} / ` +
        `現在 vendorId=${hex(vendorId)} productId=${hex(productId)}（${IDENTITY_FILE}）`,
    );
    return "mismatch";
  }
  // ★schema 1（matter_version が無い）は、VID/PID が一致したときだけ 2 へ書き直す（M15・T1）。
  //   いま入っている版を「この時点で在った版」として記録する（作成時の版は分からないので、
  //   それが分かるフィールド名にする）。書けなくても起動は止めない。
  if (rec.schema_version !== IDENTITY_SCHEMA_VERSION) {
    const upgraded = {
      ...rec,
      schema_version: IDENTITY_SCHEMA_VERSION,
      matter_version_at_upgrade: await readMatterVersion(),
      schema_upgraded_at: new Date().toISOString(),
    };
    try {
      await writeAtomic(IDENTITY_FILE, `${JSON.stringify(upgraded, null, 2)}\n`);
    } catch (e) {
      warn(`WARN VID記録を schema ${IDENTITY_SCHEMA_VERSION} へ更新できない（継続）: ${IDENTITY_FILE} — ${e?.message ?? e}`);
      return "match";
    }
    log(`VID記録を schema ${rec.schema_version} → ${IDENTITY_SCHEMA_VERSION} へ更新した（matter.js の版を記録）: ${IDENTITY_FILE}`);
    return "upgraded";
  }
  return "match";
}

async function writeAtomic(path, text) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}
