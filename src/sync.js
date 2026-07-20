// sync: 本体 /api/events(SSE) を購読し外部操作の状態変化をMatterタイルへ反映する。
// 契約（移植元 hap-bridge/hap_bridge/sync.py）: 初期全同期 → SSE購読 → 切断時 指数バックオフ
// 再接続 → 再接続時 full_sync → 5分保険ポーリング。切断中の取りこぼしは再接続時 full_sync で回収。
import { ClientError } from "./client.js";

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const FULL_SYNC_INTERVAL_MS = 300_000; // 5分保険

const ts = () => new Date().toISOString();
const log = (...a) => console.log(`[${ts()}]`, ...a);

export class StateSync {
  constructor(client, lightsByInstance, { fullSyncIntervalMs = FULL_SYNC_INTERVAL_MS } = {}) {
    this._client = client;
    this._lights = lightsByInstance;
    this._fullSyncIntervalMs = fullSyncIntervalMs;
    this._stopped = false;
    this._abort = null;
    this._lastFullSync = 0;
    this._loop = null;
  }

  start() {
    this._abort = new AbortController();
    this._loop = this._run();
  }

  async stop() {
    this._stopped = true;
    this._abort?.abort();
    try {
      await this._loop;
    } catch {
      /* noop */
    }
  }

  async _run() {
    let backoff = BACKOFF_START_MS;
    while (!this._stopped) {
      try {
        await this._fullSync(); // 初期/再接続同期（本体不達ならClientError→バックオフ）
        let connected = false;
        for await (const event of this._client.streamEvents({ signal: this._abort.signal })) {
          if (this._stopped) return;
          if (!connected) {
            connected = true;
            backoff = BACKOFF_START_MS; // 接続成功＝バックオフリセット
            log("[sync] SSE購読開始");
          }
          if (event !== null) await this._applyEvent(event);
          await this._maybeFullSync(); // keepalive(null)含め毎回、経過していれば保険の全同期
        }
        // ストリーム正常終了（本体close）→ 下でバックオフ後に再接続
      } catch (e) {
        if (this._stopped) return;
        const msg = e instanceof ClientError ? e.message : `想定外: ${e?.message ?? e}`;
        log(`[sync] SSE切断/エラー: ${msg} → ${Math.round(backoff / 1000)}秒後に再接続`);
      }
      if (this._stopped) return;
      await this._sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  }

  async _applyEvent(event) {
    const light = this._lights.get(event.instance);
    if (!light) {
      console.warn(`[sync] 未知instanceのイベントをスキップ: ${JSON.stringify(event)}`);
      return;
    }
    // 部分更新は undefined 透過（含まれない=無変更）。
    await light.applyState({ is_on: event.is_on, brightness: event.brightness });
  }

  async _maybeFullSync() {
    if (Date.now() - this._lastFullSync < this._fullSyncIntervalMs) return;
    try {
      await this._fullSync();
    } catch (e) {
      log(`[sync] 保険の全同期に失敗（SSE継続）: ${e?.message ?? e}`);
    }
  }

  async _fullSync() {
    const states = await this._client.getStates();
    for (const st of states) {
      const light = this._lights.get(st.instance);
      if (!light) continue;
      if (st.brightness === -1) {
        await light.applyState({ is_on: false, brightness: -1 }); // オフライン: OFF表示へ縮退
      } else {
        await light.applyState({ is_on: st.is_on, brightness: st.brightness });
      }
    }
    this._lastFullSync = Date.now();
    log(`[sync] 全同期実行: ${states.length}灯`);
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this._abort?.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }
}
