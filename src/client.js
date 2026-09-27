// client: EchoBridge本体API(:8099)へのHTTPシム。通信はHTTPのみ・URLは ECHOBRIDGE_URL 注入。
// Node標準 fetch のみ（新規npm依存を追加しない）。移植元: hap-bridge/hap_bridge/client.py。
import { createThrottle } from "./throttle.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:8099";
const REQUEST_TIMEOUT_MS = 10_000;
const SSE_IDLE_TIMEOUT_MS = 60_000; // 無受信60秒(本体keepalive30秒×2欠落)で切断とみなす

const ts = () => new Date().toISOString();
// WARN相当は stderr へ（systemd の StandardError=append:data/error_addon.log に載る）。
// ★時刻と WARN を付ける（M15・C2）。§6-2 で本体が貼るのは末尾20行なので、時刻が無いと突合できない。
const warn = (...a) => console.warn(`[${ts()}]`, ...a);

export class ClientError extends Error {}

// --- 応答の形の検査（M15・A2）---
// 本体の応答が契約（API_CONTRACT.md §3）どおりかをここで確かめ、違えば ClientError にする。
// ★ここで投げておくと、起動時は waitForUpstream の待ち＋間引きへ、稼働中は sync のバックオフ
//   再接続へ合流する。素通りさせると index.js や devices.js の中で TypeError になり、
//   未捕捉 → exit 1 → Restart=on-failure で5秒ごとの再起動ループになっていた（M14・A2）。
const shapeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "配列" : typeof v);
const bad = (what, v) => new ClientError(`本体の応答の形が契約と違う: ${what}（${shapeOf(v)}）`);

function asArray(v, what) {
  if (!Array.isArray(v)) throw bad(`${what} が配列でない`, v);
  return v;
}
function asObject(v, what) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw bad(`${what} がオブジェクトでない`, v);
  return v;
}
function asInt(v, what) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw bad(`${what} が数値でない`, v);
  return v;
}
function asString(v, what) {
  if (typeof v !== "string") throw bad(`${what} が文字列でない`, v);
  return v;
}
function asBool(v, what) {
  if (typeof v !== "boolean") throw bad(`${what} が真偽値でない`, v);
  return v;
}

export class EchoBridgeClient {
  constructor({ baseUrl, token, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const raw = baseUrl || process.env.ECHOBRIDGE_URL || DEFAULT_BASE_URL;
    this.baseUrl = raw.replace(/\/+$/, ""); // 末尾/正規化
    this.token = token ?? process.env.ECHOBRIDGE_TOKEN ?? null;
    this.timeoutMs = timeoutMs;
    // SSE の不正 data 行の WARN の間引き（M13・§6-2）。再接続をまたいで効くよう接続ごとでなくここに持つ。
    this._badLineThrottle = createThrottle();
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

  // ★タイムアウトは本文の読み取り（resp.json）まで覆う（M15・A1）。
  // 以前は fetch が解決した時点で clearTimeout していたため、本体がヘッダだけ返して本文を
  // 止めると**無期限に待って**いた（起動時なら status.json が出ず install.sh が失敗、
  // 稼働中なら同期ループが止まったまま再接続もしない）。
  async _get(path) {
    const url = this._url(path);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      let resp;
      try {
        resp = await fetch(url, { signal: ctl.signal });
      } catch (e) {
        throw new ClientError(`接続不能/タイムアウト: ${e?.message ?? e} (${EchoBridgeClient._mask(url)})`);
      }
      if (resp.status === 401) throw new ClientError("トークン不一致または未設定 (401)");
      if (!resp.ok) throw new ClientError(`HTTP ${resp.status} (${EchoBridgeClient._mask(url)})`);
      let data;
      try {
        data = await resp.json();
      } catch (e) {
        if (ctl.signal.aborted) {
          throw new ClientError(
            `本文の読み取りがタイムアウト(${Math.round(this.timeoutMs / 1000)}秒) (${EchoBridgeClient._mask(url)})`,
          );
        }
        throw new ClientError(`JSON解析失敗: ${e?.message ?? e}`);
      }
      if (data && data.ok === false) throw new ClientError(`本体がok:falseを返却: ${data.error ?? "(詳細なし)"}`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  // --- 読み取り系（返す前に形を検査する・M15・A2）---
  async getLights() {
    const lights = asArray((await this._get("/api/lights")).lights, "lights");
    return lights.map((l, i) => {
      asObject(l, `lights[${i}]`);
      return {
        instance: asInt(l.instance, `lights[${i}].instance`),
        name: asString(l.name, `lights[${i}].name`),
        dimmable: asBool(l.dimmable, `lights[${i}].dimmable`),
      };
    });
  }
  async getStates() {
    // [{instance,is_on,brightness}]（brightness -1 = 真オフライン。§3 でこの経路にだけ現れる）
    const states = asArray((await this._get("/api/states")).states, "states");
    return states.map((s, i) => {
      asObject(s, `states[${i}]`);
      return {
        instance: asInt(s.instance, `states[${i}].instance`),
        is_on: asBool(s.is_on, `states[${i}].is_on`),
        brightness: asInt(s.brightness, `states[${i}].brightness`),
      };
    });
  }
  async getScenes() {
    // 本体 display_name を name に写す（移植元踏襲）。
    const scenes = asArray((await this._get("/api/scenes")).scenes, "scenes");
    return scenes.map((s, i) => {
      asObject(s, `scenes[${i}]`);
      return {
        key: asString(s.key, `scenes[${i}].key`),
        name: asString(s.display_name, `scenes[${i}].display_name`),
        // group は本体が常に出すが、欠けていても全体グループ(0)として扱えば壊れない。
        group: s.group == null ? 0 : asInt(s.group, `scenes[${i}].group`),
      };
    });
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
              // 本体が壊れた行を出し続けても、error_addon.log へは同じ理由で N 分に1行（throttle.js）。
              const { emit, suppressed } = this._badLineThrottle.hit();
              if (emit) {
                const extra = suppressed ? `（前回から ${suppressed}行を省略）` : "";
                warn(`WARN [client] SSE不正data行スキップ${extra}: ${payload}`);
              }
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
