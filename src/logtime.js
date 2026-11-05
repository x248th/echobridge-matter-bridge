// logtime: 自前ログの行頭の時刻（R-7）。error_addon.log と journal は人が直接読むので、機体のローカル時刻＋
// オフセットで書く。形は ir-bridge と同じ 2026-10-04T10:35:06+0900（ミリ秒なし・オフセットにコロンなし）。
// ★オフセットは固定せず、機体の TZ に従う。
// ★ここはログの行頭専用。status.json の値（updated_at・upstream_last_ok_at）と storage_identity.json の時刻は
//   ここを通さず UTC のまま書く（API_CONTRACT.md §6-3 が UTC を許し、表示の整形は本体が行う）。
const pad = (n) => String(n).padStart(2, "0");

export function ts(d = new Date()) {
  const minutesEast = -d.getTimezoneOffset(); // getTimezoneOffset は「UTC − ローカル」なので符号が逆
  const abs = Math.abs(minutesEast);
  const offset = `${minutesEast < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${date}T${time}${offset}`;
}
