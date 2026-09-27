// throttle: 同じ理由の WARN を「N 分に1行」へ間引く（M13・API_CONTRACT.md §6-2）。
// §6-2「異常が続く間 WARNING を出し続ける実装では、間引き（同じ理由は N 分に1行）も併せて置くこと」。
// 間引きはプロセスの中だけで効く。プロセスをまたぐ繰り返し（再起動ループ）は、起動側で
// 再起動しないようにして防ぐ（src/startup.js）。状態はファイルに持たない（SD に書かない）。

/** 同じ理由の間引きの間隔。 */
export const WARN_INTERVAL_MS = 10 * 60_000;

/**
 * hit() を呼ぶたびに、今回出すかどうかと、前回出してから黙った回数を返す。
 * 初回は必ず出す。以後は前回出してから intervalMs 経っていれば出す。
 */
export function createThrottle({ intervalMs = WARN_INTERVAL_MS, now = Date.now } = {}) {
  let lastEmitAt = null;
  let suppressed = 0;
  return {
    hit() {
      const t = now();
      if (lastEmitAt === null || t - lastEmitAt >= intervalMs) {
        const out = { emit: true, suppressed };
        lastEmitAt = t;
        suppressed = 0;
        return out;
      }
      suppressed++;
      return { emit: false, suppressed };
    },
  };
}
