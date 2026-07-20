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
sudo systemctl restart matter-bridge

cat <<EOF

==> インストール完了。
    状態:     systemctl status matter-bridge
    ログ:     journalctl -u matter-bridge -f
    異常ログ: data/error_addon.log（WARN以上のみ・起動時に1MB超で.oldへローテ）
    ペアリング: 管理画面(http://echobridge.local:8080)の「Matter」カードにQRとPINが出ます
                （PINは data/status.json にも入ります・QRは data/qr.svg）

    本体と同じ機体で動かす場合、トークンの設定は不要です（本体のトークン認証が
    ON/OFF どちらでも）。本体を別の機体に置く構成のときだけ data/env に
    ECHOBRIDGE_URL= と ECHOBRIDGE_TOKEN= を書いて chmod 600 data/env（詳細は README）。
EOF
