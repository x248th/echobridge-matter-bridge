// errlog: data/error_addon.log に稼働中も上限を持たせる（M12・API_CONTRACT.md §6-2）。
//
// ■ なぜ Node の中で回すか
// unit の ExecStartPre（起動時に1MB超なら .old へ mv）だけでは、再起動しないプロセスでは上限が効かない。
// ■ なぜ改名ではなく「写して切り詰める」か
// fd 2 は systemd が StandardError=append: で O_APPEND に開いたもの。稼働中に mv で回すと、fd 2 は
// 改名後の .old（同じ inode）を指したまま書き続けてしまう。そこで fd 2 は動かさず、
//   今の中身を .old へ写す（tmp→rename・600）→ ftruncate(fd 2, 0)
// とする。O_APPEND なので切り詰め後の書き込みは先頭から続く（穴は空かない）。fd 2 は同じ
// error_addon.log のままなので、Node の C++ 層が直接書く致命的エラー（未捕捉例外のトレース・
// heap 枯渇）も従来どおり error_addon.log に残る（StandardError=append の利点を失わない）。
// ■ 割り込まれないこと
// 書き手はこのプロセスだけで、ファイルへの process.stderr 書き込みは同期。写す→切るは1回の
// 呼び出しの中で完結するので、その間に他の行が書かれて失われることは無い。
// ■ 判定の契機
// process.stderr.write のたび（WARN 以上しか来ないので頻度は低い）。上限は「上限＋最後の1回分」。
// C++ 層の致命的エラーはこの判定を通らないが、そのときプロセスは終わり、再起動時に ExecStartPre が回す。
import { chmodSync, fstatSync, ftruncateSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

export const ERROR_LOG_MAX_BYTES = 1024 * 1024; // §6-2 の目安（1MB）。ExecStartPre の 1048576 と同じ

/**
 * fd が logPath そのもの（同じ dev/inode の通常ファイル）のときだけ上限を掛ける。
 * 手動起動などで stderr が端末・journal・別ファイルのときは何もしない（active:false）。
 * 返り値: { active, reason? }
 */
export function installErrorLogCap({
  logPath,
  oldPath = `${logPath}.old`,
  maxBytes = ERROR_LOG_MAX_BYTES,
  stream = process.stderr,
  fd = 2,
  onRotate = () => {},
}) {
  let st;
  try {
    st = fstatSync(fd);
  } catch (e) {
    return { active: false, reason: `fstat(fd ${fd}) 失敗: ${e?.message ?? e}` };
  }
  if (!st.isFile()) return { active: false, reason: `fd ${fd} は通常ファイルではない` };
  if (!sameFile(st, logPath)) return { active: false, reason: `fd ${fd} は ${logPath} ではない` };

  const original = stream.write.bind(stream);
  let busy = false;
  stream.write = (...args) => {
    const r = original(...args);
    if (!busy) {
      busy = true;
      try {
        const size = rotateIfOver({ logPath, oldPath, maxBytes, fd });
        if (size !== null) onRotate(size);
      } catch {
        // 回せなくても書き込み自体は止めない（次の書き込みで再試行される）。
      } finally {
        busy = false;
      }
    }
    return r;
  };
  return { active: true };
}

/** 上限を超えていれば回す。回したら回す前の大きさを、回さなければ null を返す。 */
export function rotateIfOver({ logPath, oldPath, maxBytes, fd }) {
  const st = fstatSync(fd);
  if (st.size <= maxBytes) return null;
  // 誰かが外から改名していたら、fd と logPath は別物＝写す対象を取り違えるので回さない。
  if (!sameFile(st, logPath)) return null;
  const buf = readFileSync(logPath);
  const tmp = `${oldPath}.tmp`;
  writeFileSync(tmp, buf, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, oldPath);
  ftruncateSync(fd, 0);
  return st.size;
}

function sameFile(st, path) {
  try {
    const p = statSync(path);
    return p.dev === st.dev && p.ino === st.ino;
  } catch {
    return false;
  }
}
