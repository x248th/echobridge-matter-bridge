# echobridge-matter-bridge

EchoBridge（Panasonic リンクプラス照明ブリッジ）本体の **Matter アドオン**。
本体が管理している照明とシーンを Matter ブリッジとして公開し、Apple Home 等から
操作できるようにする。

## 位置づけ

- **テスト用のアドオンです。CSA（Matter）の認証は取得していません。**
- そのため、ホームアプリへ追加するときに「認定されていないアクセサリ」の警告が出ます。
  そのまま追加すれば使えます（仕様です）。
- 動作の完成・継続を保証するものではありません（改善には努めます）。

## 必要なもの

- EchoBridge 本体が同じ機体で稼働していること（`:8099`）
- Node.js 22 LTS
- Apple Home で使う場合は、ホームハブ（Apple TV / HomePod 等）

## 導入

当面は手動導入です。Releases の tarball を展開し、展開したディレクトリで実行します。

```bash
sudo ./install.sh
```

将来的には本体の管理画面からインストールできるようにする予定です。
導入後の起動・停止・アンインストールは本体の管理画面から行います。

## ライセンス

Apache License, Version 2.0 — see [LICENSE](LICENSE).
Copyright 2026 Hibel

## 問い合わせ・製品情報

[hibel.jp](https://hibel.jp)（個別サポートの範囲は製品側のポリシーに従います）
