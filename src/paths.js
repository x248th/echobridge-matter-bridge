// paths: 書き込み先の単一集約点（M12）。書き込み先を増やすときは必ずここに足し、
// tests/isolation.js の WRITE_TARGETS にも足す（テストの隔離は「書き込み先ごと」に数えるため）。
//
// ■ 置き場所は2つ（API_CONTRACT.md §6）
//   data/                        … status.json・qr.svg（§6-3）と error_addon.log（§6-2）。
//                                   アンインストールで消える。本体が読むのはここ。
//   ~/addon-data/matter-bridge/  … matter.js のストレージ（ペアリング/fabric）と、それを
//                                   どの VID/PID で作ったかの記録（§6-1）。アンインストールしても残る
//                                   ＝再インストール後もホームアプリの登録がそのまま使える。
// ★ホームは os.homedir() から組む（ユーザー名を固定で書かない）。
// ★テストは下の環境変数で両方を一時ディレクトリへ逃がす（本物の data/ と ~/addon-data/ に触れない）。
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// §6-1/§6-3: id はディレクトリ名＝status.json の service。
export const ADDON_ID = "matter-bridge";
// ServerNode の id。matter.js は <storage.path>/<id>/ にストレージを置く（NodeJsEnvironment.js:169）。
// 旧版（〜1.0.2）が data/ の下に作った名前と同じにして、移行を「ディレクトリの移動」だけで済ませる。
export const NODE_ID = "echobridge-matter-bridge";

export const DATA_DIR_ENV = "MATTER_BRIDGE_DATA_DIR";
export const STORAGE_DIR_ENV = "MATTER_BRIDGE_STORAGE_DIR";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const DATA_DIR = process.env[DATA_DIR_ENV] || join(repoRoot, "data");
export const STATUS_FILE = join(DATA_DIR, "status.json");
export const QR_FILE = join(DATA_DIR, "qr.svg");
export const ERROR_LOG = join(DATA_DIR, "error_addon.log");
export const ERROR_LOG_OLD = `${ERROR_LOG}.old`;

export const STORAGE_DIR = process.env[STORAGE_DIR_ENV] || join(homedir(), "addon-data", ADDON_ID);
export const NODE_STORAGE = join(STORAGE_DIR, NODE_ID);
export const IDENTITY_FILE = join(STORAGE_DIR, "storage_identity.json");

// 旧版（〜1.0.2）のストレージ。読みも書きもしない。在るかどうかだけを見る（移行漏れの検出）。
export const LEGACY_NODE_STORAGE = join(DATA_DIR, NODE_ID);
