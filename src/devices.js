// devices: /api/lights・/api/scenes から動的にエンドポイントを生成し、双方向マッピングする。
// エコー抑制=リモート適用(SSE/全同期→Matter set)は context.offline=true で発火するため、
//   ハンドラ側で offline を判別して本体へ送り返さない（A-6実証）。
// 冪等ガード=両方向とも last-known 値と比較し同値なら何もしない（本体のINF同値重複対策）。
// 調光連射抑制=currentLevel$Changed はドラッグ中に連続発火するため trailing debounce 300ms。
import { Endpoint } from "@matter/main";
import { DimmableLightDevice } from "@matter/main/devices/dimmable-light";
import { OnOffLightDevice } from "@matter/main/devices/on-off-light";
import { OnOffPlugInUnitDevice } from "@matter/main/devices/on-off-plug-in-unit";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";

const LEVEL_DEBOUNCE_MS = 300;
const SCENE_AUTO_OFF_MS = 300;

const ts = () => new Date().toISOString();
const log = (...a) => console.log(`[${ts()}]`, ...a);
// WARN相当は stderr へ（systemd の StandardError=append:data/error_addon.log に載る）。
const warn = (...a) => console.warn(`[${ts()}]`, ...a);

/**
 * シーンの表示名を組み立てる（移植元 hap_bridge/accessories.py の後置き規則を踏襲）。
 * グループ有り(≠0)なら "{シーン名} @G{グループ番号}"、全体(0)は後置きなし。
 * 本体APIはグループ番号のみ露出し、グループ名は本体config専管でHTTP契約に出てこない
 * （名前を出すには本体API拡張が要る＝次期バージョン候補として起票）。番号でも
 * 「消灯」「点灯」等の同名シーンがグループ間で衝突しなくなる＝重複解消の目的は満たす。
 * "G"付き書式は人間の指定（M4停止点1②）。アドオン化以前のモノリス版がグループ名未設定時に
 * 既定生成していた "G{番号}"（参照 v1.1.11 setup.py）と同じ見え方になる。
 */
export function sceneLabel(scene) {
  const group = scene.group ?? 0;
  return group ? `${scene.name} @G${group}` : scene.name;
}

// nodeLabel は Matter仕様上 UTF-8 32バイト制約。matter.js自体はJS .length で検査するため32文字
// 以内なら通るが、コントローラ側がバイトで弾く可能性に備えバイト長で丸める。
export function clampNodeLabel(name) {
  if (Buffer.byteLength(name, "utf8") <= 32) return name;
  // 末尾切詰めだと語尾の識別子（例「東」「西」）が落ちて衝突するため、まず全角スペースを
  // 半角へ詰めてバイトを稼ぐ（例「リビングブラケット　東」33B→「リビングブラケット 西」31B）。
  let s = name.replace(/　/g, " ").replace(/ +/g, " ").trim();
  if (Buffer.byteLength(s, "utf8") <= 32) return s;
  const cps = [...s];
  while (cps.length && Buffer.byteLength(cps.join(""), "utf8") > 32) cps.pop();
  return cps.join("");
}

// 変換: b%(1-100) → Matter level(1-254) / level → %(1-100)。b=0 は onOff=false（levelは据え置き）。
export const pctToLevel = (p) => Math.max(1, Math.round((p * 254) / 100));
export const levelToPct = (l) => Math.min(100, Math.max(1, Math.round((l * 100) / 254)));

class LightBridge {
  constructor(client, instance, dimmable, endpoint) {
    this.client = client;
    this.instance = instance;
    this.dimmable = dimmable;
    this.ep = endpoint;
    this.known = { isOn: null, pct: null }; // 本体の last-known 状態（冪等ガード基準）
    this._levelTimer = null;
    this._pendingPct = null;

    endpoint.events.onOff.onOff$Changed.on((value, _old, ctx) => {
      if (ctx?.offline) return; // 自分のリモート適用＝送り返さない
      if (value === this.known.isOn) return; // 冪等
      this.known.isOn = value;
      const p = (value ? this.client.turnOn(this.instance) : this.client.turnOff(this.instance));
      p.then(() => log(`→本体 light ${this.instance} ${value ? "on" : "off"}`)).catch((e) =>
        warn(`WARN light ${this.instance} on/off 送信失敗: ${e?.message ?? e}`),
      );
    });

    if (dimmable) {
      endpoint.events.levelControl.currentLevel$Changed.on((value, _old, ctx) => {
        if (ctx?.offline) return;
        const pct = levelToPct(value);
        this._pendingPct = pct;
        clearTimeout(this._levelTimer);
        this._levelTimer = setTimeout(() => this._flushLevel(), LEVEL_DEBOUNCE_MS); // trailing 最終値のみ送信
      });
    }
  }

  _flushLevel() {
    const pct = this._pendingPct;
    if (pct == null || pct === this.known.pct) return; // 冪等
    this.known.pct = pct;
    this.client
      .setBrightness(this.instance, pct)
      .then(() => log(`→本体 light ${this.instance} brightness ${pct}`))
      .catch((e) => warn(`WARN light ${this.instance} brightness 送信失敗: ${e?.message ?? e}`));
  }

  // 本体→Matter のリモート適用（offline set＝ハンドラは送り返さない）。部分更新は undefined 透過。
  async applyState({ is_on, brightness } = {}) {
    const patch = {};
    if (brightness === -1) {
      // 真オフライン: 到達不可＋OFF表示へ縮退（SSE経路に-1は流れない＝全同期専用）。
      await this.ep.set({ bridgedDeviceBasicInformation: { reachable: false } });
      if (this.known.isOn !== false) patch.onOff = { onOff: false };
      this.known.isOn = false;
      if (Object.keys(patch).length) await this.ep.set(patch);
      return;
    }
    await this.ep.set({ bridgedDeviceBasicInformation: { reachable: true } });
    if (is_on !== undefined && is_on !== this.known.isOn) {
      patch.onOff = { onOff: is_on };
      this.known.isOn = is_on;
    }
    if (this.dimmable && brightness !== undefined && brightness > 0) {
      const pct = brightness;
      if (pct !== this.known.pct) {
        patch.levelControl = { currentLevel: pctToLevel(pct) };
        this.known.pct = pct;
      }
    }
    if (Object.keys(patch).length) await this.ep.set(patch);
  }
}

class SceneBridge {
  constructor(client, key, endpoint) {
    this.client = client;
    this.key = key;
    this.ep = endpoint;
    this._firing = false;
    endpoint.events.onOff.onOff$Changed.on((value, _old, ctx) => {
      if (ctx?.offline) return; // 自動OFF戻しは offline set＝再発火しない
      if (value !== true) return; // モメンタリ: OFFイベントは無視
      if (this._firing) return; // INF重複での二重発火を防ぐ
      this._firing = true;
      this.client
        .runScene(this.key)
        .then(() => log(`→本体 scene ${this.key} 発火`))
        .catch((e) => warn(`WARN scene ${this.key} 発火失敗: ${e?.message ?? e}`));
      setTimeout(() => {
        this.ep.set({ onOff: { onOff: false } }).catch(() => {}); // 300ms後に自動OFF（offline）
        this._firing = false;
      }, SCENE_AUTO_OFF_MS);
    });
  }
}

// nodeLabel の書き戻し観測（動作には一切介入しない・ログのみの計器）。
// 目的: 「コントローラ（Apple Home等）がユーザのリネームをブリッジへ書き戻すか」の実証。
// ctx.offline の別で発生源を切り分ける（このコードベースでは offline=当方のep.set由来・
// devices.js の onOff$Changed と同じ規約。falsy=ネットワーク経由＝コントローラの書込み）。
// M4では「タイル名は変わらなかった＝Appleは追加時の名前を保持」と観測済み。本計器はそれを
// イベントレベルで確定させる（何も出なければ「書き戻さない」の実証）。
function watchNodeLabel(kind, id, ep) {
  ep.events.bridgedDeviceBasicInformation.nodeLabel$Changed.on((value, oldValue, ctx) => {
    const origin = ctx?.offline ? "offline(自set)" : "online(コントローラ)";
    log(`nodeLabel変化 ${kind} ${id}: "${oldValue}"→"${value}" [${origin}]`);
  });
}

// aggregator 配下に照明・シーンのエンドポイントを生成して追加する。
// 返り値: { lightsByInstance: Map<instance, LightBridge>, abScene }。
export async function buildBridge({ client, aggregator, lights, scenes }) {
  const lightsByInstance = new Map();
  for (const l of lights) {
    const Device = l.dimmable ? DimmableLightDevice : OnOffLightDevice;
    const ep = new Endpoint(Device.with(BridgedDeviceBasicInformationServer), {
      id: `light-${l.instance}`, // storageキー安定のため恒久固定
      bridgedDeviceBasicInformation: { nodeLabel: clampNodeLabel(l.name), reachable: true },
    });
    await aggregator.add(ep);
    watchNodeLabel("light", l.instance, ep);
    lightsByInstance.set(l.instance, new LightBridge(client, l.instance, l.dimmable, ep));
  }

  // シーンは全て標準のコンセント型 OnOffPlugInUnitDevice で統一（M3のA/B判定の結論）。
  // 試験した MountedOnOffControl(0x10F・Matter1.4新設) は Apple Home で「非対応」表示＝操作不能
  // だったため不採用（M3人間報告⑥）。0x10Fに割り当てていた「全消灯」も本統一で操作可能になる。
  for (const s of scenes) {
    const ep = new Endpoint(OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer), {
      id: `scene-${s.key}`, // storageキー安定のため恒久固定（表示名を変えてもidは変えない）
      bridgedDeviceBasicInformation: { nodeLabel: clampNodeLabel(sceneLabel(s)), reachable: true },
    });
    await aggregator.add(ep);
    watchNodeLabel("scene", s.key, ep);
    new SceneBridge(client, s.key, ep);
  }

  return { lightsByInstance };
}
