// startup: 起動時に本体API へ繋がるまで、終了せずにプロセスの中で待つ（M13・§6-2）。
// M11 までは本体不達なら exit 1 → Restart=on-failure（RestartSec=5）で約5秒ごとに再起動しており、
// プロセスごとに WARN が1行 error_addon.log へ積もっていた（プロセスの中の間引きが効かない）。
// 待つ側をプロセスの中へ移せば、(a) WARN は同じ理由で N 分に1行（throttle.js）に収まり、
// (b) 本体が戻れば次の再試行（最長 RETRY_MAX_MS 後）で起動を続け、
// (c) 再起動しないので ExecStartPre（ログの touch/chmod）も起動処理も繰り返さない＝SD に書かない。
import { createThrottle, WARN_INTERVAL_MS } from "./throttle.js";

export const RETRY_START_MS = 1_000;
export const RETRY_MAX_MS = 30_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetchConfig() が成功するまで再試行し、その値を返す。
 * 失敗は WARN（間引きあり）。再試行の間隔は 1秒から倍々で最長 30秒。
 * 成功したときに一度でも失敗していれば、その経過を stdout（journal）へ1行出す。
 */
export async function waitForUpstream({
  fetchConfig,
  baseUrl,
  log,
  warn,
  sleep = defaultSleep,
  now = Date.now,
  retryStartMs = RETRY_START_MS,
  retryMaxMs = RETRY_MAX_MS,
  warnIntervalMs = WARN_INTERVAL_MS,
}) {
  const throttle = createThrottle({ intervalMs: warnIntervalMs, now });
  const startedAt = now();
  let failures = 0;
  let delay = retryStartMs;
  for (;;) {
    try {
      const config = await fetchConfig();
      if (failures) {
        log(`本体API に接続できた（起動時の失敗 ${failures}回・待った時間 ${Math.round((now() - startedAt) / 1000)}秒）`);
      }
      return config;
    } catch (e) {
      failures++;
      const { emit, suppressed } = throttle.hit();
      if (emit) {
        const extra = suppressed ? `・前回から同じ失敗 ${suppressed}回を省略` : "";
        warn(
          `WARN 本体API不達のため起動を待機中（終了せず最長${Math.round(retryMaxMs / 1000)}秒ごとに再試行・この警告は${Math.round(warnIntervalMs / 60_000)}分に1行${extra}）: ${baseUrl} — ${e?.message ?? e}`,
        );
      }
    }
    await sleep(delay);
    delay = Math.min(delay * 2, retryMaxMs);
  }
}
