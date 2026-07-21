#!/usr/bin/env bash
# EchoBridge Matter Bridge インストーラ（冪等・再実行安全）。
# 依存導入・data/準備・systemd unitを実パスに置換して配置・sudoers配置・enable/startまで行う。
# 構成はHAP版 install.sh の踏襲（venv/pip → Node/npm ci に翻案）。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
USER_NAME="$(id -un)"
UNIT_SRC="$REPO_DIR/systemd/matter-bridge.service"
UNIT_DST="/etc/systemd/system/matter-bridge.service"
UNIT_TMP="/tmp/matter-bridge.service.$$"
# sudoers: 本体WebUIがアドオンを起動/停止/再起動するための最小権限（手動visudo工程を廃止）。
# 命名はアドオンidのフル形 echobridge-addon-<id> に正規化（旧短名 echobridge-addon-matter は下で撤去）。
SUDOERS_DST="/etc/sudoers.d/echobridge-addon-matter-bridge"
SUDOERS_TMP="/tmp/echobridge-addon-matter-bridge.$$"
# 移行: 旧短名 sudoers を撤去（M5でフルidへ正規化・冪等）。
SUDOERS_OLD="/etc/sudoers.d/echobridge-addon-matter"
SYSTEMCTL="$(command -v systemctl)"
NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm)"
STATUS_JSON="$REPO_DIR/data/status.json"
# 起動確認のタイムアウト（秒）。Pi4実測≈5秒に対する余裕を見て90秒。環境変数で上書き可（検証用）。
STARTUP_TIMEOUT="${MATTER_BRIDGE_STARTUP_TIMEOUT:-90}"

# 起動確認: data/status.json が「確認開始時刻より後に」書き直されるのを待つ。
# systemctl is-active 等の起動直後判定では、起動後に遅れてクラッシュする故障
# （S1初出荷ゲート検証ではUDP 5540の占有によるバインド失敗）が確認をすり抜ける偽陽性窓があり、
# rc=0でインストール成功扱い→クラッシュループ→status.json不在の半導入状態、という袋小路を生む。
# アドオンは起動完了時に必ず status.json を書く（src/status.js の startStatusWriter）ので、
# その新規書き込みを「プロセスが実際に立ち上がりきった」ことの実証に使う。
# 既存ファイル（前回導入時のもの）での誤検知を避けるため、restart より前に置いたマーカーと
# mtime を比較する（-nt＝マーカーより新しい）。
wait_for_started() {
    local status_path="$1" marker="$2" timeout="$3" waited=0
    echo "==> 起動確認: $status_path の新規書き込みを待つ（最大 ${timeout}秒）"
    while [ "$waited" -lt "$timeout" ]; do
        if [ -e "$status_path" ] && [ "$status_path" -nt "$marker" ]; then
            echo "==> 起動確認OK: ${waited}秒でアドオンが status.json を書き直した（起動完了）"
            return 0
        fi
        sleep 1
        waited=$((waited + 1))
    done
    echo "!! 起動確認に失敗: ${timeout}秒以内に status.json が書き直されなかった。" >&2
    echo "!! アドオンが起動できていない（または起動直後にクラッシュした）可能性が高い。" >&2
    echo "!! ログを確認すること:" >&2
    echo "!!     journalctl -u matter-bridge -n 50 --no-pager" >&2
    echo "!!     systemctl status matter-bridge" >&2
    return 1
}

echo "==> REPO=$REPO_DIR USER=$USER_NAME NODE=$NODE_BIN"

# sudo で実行された場合、$USER_NAME は root になる（unitのUser=とsudoers対象がrootになり不正）。
# 実ユーザ(SUDO_USER)へ倒す＝「sudo ./install.sh」で正しい所有者が入る。
if [ "$USER_NAME" = "root" ] && [ -n "${SUDO_USER:-}" ]; then
    USER_NAME="$SUDO_USER"
    echo "==> sudo実行を検出: USER=$USER_NAME を対象にする"
fi

if [ -z "$NODE_BIN" ] || [ -z "$NPM_BIN" ]; then
    echo "!! node/npm が見つからない。Node.js（運用目標 22 LTS）を先に入れること。" >&2
    exit 1
fi

# 1. 依存（node_modules 不在時のみ npm ci。@matter/main は package-lock.json で完全固定）
if [ ! -d "$REPO_DIR/node_modules" ]; then
    echo "==> 依存インストール（npm ci）"
    (cd "$REPO_DIR" && sudo -u "$USER_NAME" "$NPM_BIN" ci --no-fund --no-audit)
else
    echo "==> node_modules 既存 → npm ci はスキップ"
fi

# 2. data/（Matterのペアリング/fabric等の永続状態・status.json・qr.svg の置き場。gitignore済み）
mkdir -p "$REPO_DIR/data"
chown "$USER_NAME" "$REPO_DIR/data"
# error_addon.log の所有権と権限を揃える（M11）。
# systemd の StandardError=append: は mode を指定できず、systemd が新規作成すると
# root:root 644 になる（status.json・qr.svg は 600 なので非対称だった）。
# unit側の ExecStartPre でも 600 を立てるが、そちらは User= 権限で走るため
# 旧版が root所有で作った既存ファイルには chmod できない。ここ（root権限）で移行させる。
touch "$REPO_DIR/data/error_addon.log"
chown "$USER_NAME" "$REPO_DIR/data/error_addon.log"
chmod 600 "$REPO_DIR/data/error_addon.log"

# 3. unitテンプレートのプレースホルダを実パスに置換 → 配置
echo "==> systemd unit配置: $UNIT_DST"
sed -e "s|%REPO%|$REPO_DIR|g" -e "s|%USER%|$USER_NAME|g" -e "s|%NODE%|$NODE_BIN|g" "$UNIT_SRC" > "$UNIT_TMP"
sudo cp "$UNIT_TMP" "$UNIT_DST"
rm -f "$UNIT_TMP"

# 4. sudoers 自動配置（本体WebUIのアドオン起動/停止/再起動をNOPASSWDで許可）
#    一時ファイルに生成 → visudo -c で構文検証 → 合格時のみ配置（検証失敗なら配置せず中断）。
#    絶対パスの systemctl・matter-bridge.service 完全形（本体WebUIの呼び方に一致）・3動詞限定。
#    本体が撃つ完全形に一致させる（enable/disable は W2の恒久トグル・restart は W3の再取得後自動再起動用）:
#      systemctl enable --now  matter-bridge.service
#      systemctl disable --now matter-bridge.service
#      systemctl restart       matter-bridge.service
echo "==> sudoers生成・検証: $SUDOERS_DST"
cat > "$SUDOERS_TMP" <<SUDO
# EchoBridge Matterアドオン: 本体WebUIがアドオンを起動/停止/再起動するための最小権限。
# install.sh が visudo -c 検証を通してから配置する（手動 visudo 工程は不要）。
$USER_NAME ALL=(ALL) NOPASSWD: $SYSTEMCTL enable --now matter-bridge.service, $SYSTEMCTL disable --now matter-bridge.service, $SYSTEMCTL restart matter-bridge.service
SUDO
if sudo visudo -c -f "$SUDOERS_TMP" >/dev/null; then
    # install=cp相当＋権限を原子的に設定（sudoers.dは0440/root:root必須）。冪等（毎回上書き）。
    sudo install -m 0440 -o root -g root "$SUDOERS_TMP" "$SUDOERS_DST"
    rm -f "$SUDOERS_TMP"
    echo "==> sudoers配置: $SUDOERS_DST（visudo -c 合格）"
    # 旧短名を撤去（フルidへの正規化移行・存在しなければ無害）。
    if [ -e "$SUDOERS_OLD" ]; then
        sudo rm -f "$SUDOERS_OLD"
        echo "==> 旧短名sudoers撤去: $SUDOERS_OLD"
    fi
else
    rm -f "$SUDOERS_TMP"
    echo "!! sudoers構文検証(visudo -c)に失敗。配置せず中断する。" >&2
    exit 1
fi

# 5. 反映＋自動起動有効化＋起動
sudo systemctl daemon-reload
sudo systemctl enable matter-bridge

# 起動確認の基準時刻マーカーは restart より前に置く（これより新しい status.json だけを
# 「今回の起動が書いたもの」と認める）。失敗時は exit 1＝本体インストールヘルパーの
# 自動ロールバックが発火する側へ倒す（半導入状態の袋小路を構造的に消す）。
STARTUP_MARKER="$(mktemp "${TMPDIR:-/tmp}/matter-bridge-startmark.XXXXXX")"
sudo systemctl restart matter-bridge
if ! wait_for_started "$STATUS_JSON" "$STARTUP_MARKER" "$STARTUP_TIMEOUT"; then
    rm -f "$STARTUP_MARKER"
    exit 1
fi
rm -f "$STARTUP_MARKER"

cat <<EOF

==> インストール完了。
    状態:     systemctl status matter-bridge
    ログ:     journalctl -u matter-bridge -f
    異常ログ: data/error_addon.log（WARN以上のみ・起動時に1MB超で.oldへローテ）
    ペアリング: 管理画面(http://echobridge.local:8080)の「スマートホーム連携（β版）」カードに
                QRとPINが出ます
                （PINは data/status.json にも入ります・QRは data/qr.svg）

    本体と同じ機体で動かす場合、トークンの設定は不要です（本体のトークン認証が
    ON/OFF どちらでも）。本体を別の機体に置く構成のときだけ data/env に
    ECHOBRIDGE_URL= と ECHOBRIDGE_TOKEN= を書いて chmod 600 data/env（詳細は README）。
EOF
