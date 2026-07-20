// client: EchoBridge本体API(:8099)へのHTTPシム。通信はHTTPのみ・URLは ECHOBRIDGE_URL 注入。
// Node標準 fetch のみ（新規npm依存を追加しない）。移植元: hap-bridge/hap_bridge/client.py。
const DEFAULT_BASE_URL = "http://127.0.0.1:8099";
const REQUEST_TIMEOUT_MS = 10_000;
const SSE_IDLE_TIMEOUT_MS = 60_000; // 無受信60秒(本体keepalive30秒×2欠落)で切断とみなす

export class ClientError extends Error {}

export class EchoBridgeClient {
  constructor({ baseUrl, token } = {}) {
    const raw = baseUrl || process.env.ECHOBRIDGE_URL || DEFAULT_BASE_URL;
    this.baseUrl = raw.replace(/\/+$/, ""); // 末尾/正規化
    this.token = token ?? process.env.ECHOBRIDGE_TOKEN ?? null;
  }

  _url(path) {
    let url = `${this.baseUrl}${path}`;
    if (this.token) {
      const sep = path.includes("?") ? "&" : "?";
      url += `${sep}key=${encodeURIComponent(this.token)}`;
    }
    return url;
  }

  static _mask(url) {
    return url.replace(/([?&]key=)[^&]*/, "$1***");
  }

  async _get(path) {
    const url = this._url(path);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(url, { signal: ctl.signal });
    } catch (e) {
      throw new ClientError(`接続不能/タイムアウト: ${e?.message ?? e} (${EchoBridgeClient._mask(url)})`);
    } finally {
      clearTimeout(timer);
    }
    if (resp.status === 401) throw new ClientError("トークン不一致または未設定 (401)");
    if (!resp.ok) throw new ClientError(`HTTP ${resp.status} (${EchoBridgeClient._mask(url)})`);
    let data;
    try {
      data = await resp.json();
    } catch (e) {
      throw new ClientError(`JSON解析失敗: ${e?.message ?? e}`);
    }
    if (data && data.ok === false) throw new ClientError(`本体がok:falseを返却: ${data.error ?? "(詳細なし)"}`);
    return data;
  }

  // --- 読み取り系 ---
  async getLights() {
    return (await this._get("/api/lights")).lights; // [{instance,name,dimmable}]
  }
  async getStates() {
    return (await this._get("/api/states")).states; // [{instance,is_on,brightness}]（-1=オフライン）
  }
  async getScenes() {
    // 本体 display_name を name に写す（移植元踏襲）。
    return (await this._get("/api/scenes")).scenes.map((s) => ({ key: s.key, name: s.display_name, group: s.group }));
  }

  // --- 操作系（停止点0以降のテストフェーズで実照明が動く）---
  async turnOn(instance) {
    return this._get(`/api/light/${Number(instance)}/on`);
  }
  async turnOff(instance) {
    return this._get(`/api/light/${Number(instance)}/off`);
  }
  async setBrightness(instance, value) {
    const v = Number(value);
    if (!(v >= 0 && v <= 100)) throw new ClientError(`brightnessは0-100の範囲: ${value}`);
    return this._get(`/api/light/${Number(instance)}/brightness/${v}`);
  }
  async runScene(key) {
    return this._get(`/api/scene/${encodeURIComponent(String(key))}`);
  }

  // --- SSE購読 ---
  // data:行JSONをyield。": ..."コメント(connected/keepalive)は null をyield（無イベント合図）。
  // 無受信60秒でabort→ClientError（sync側が再接続）。外部signalでの停止はabortで抜ける。
  async *streamEvents({ signal } = {}) {
    const url = this._url("/api/events");
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) {
      if (signal.aborted) ctl.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    let idle;
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => ctl.abort(), SSE_IDLE_TIMEOUT_MS);
    };
    let resp;
    let reader;
    try {
      resp = await fetch(url, { signal: ctl.signal, headers: { Accept: "text/event-stream" } });
      if (resp.status === 401) throw new ClientError("トークン不一致または未設定 (401)");
      if (!resp.ok || !resp.body) throw new ClientError(`SSE HTTP ${resp.status}`);
      resetIdle();
      reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break; // 正常終了（本体close）→ sync側でバックオフ再接続
        resetIdle();
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (line === "") continue;
          if (line.startsWith(":")) {
            yield null; // connected/keepalive
            continue;
          }
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            let obj;
            try {
              obj = JSON.parse(payload);
            } catch {
              console.warn(`[client] SSE不正data行スキップ: ${payload}`);
              continue;
            }
            yield obj;
          }
          // event:/id: 等は本体が使わないので無視
        }
      }
    } catch (e) {
      if (e instanceof ClientError) throw e;
      throw new ClientError(`SSE接続/読取エラー: ${e?.message ?? e}`);
    } finally {
      clearTimeout(idle);
      if (signal) signal.removeEventListener("abort", onAbort);
      try {
        await reader?.cancel();
      } catch {
        /* noop */
      }
    }
  }
}
