# Debug Buddy 🚀
**AI-Powered Debugging & Error Log Analysis Desktop App for Engineers**

エラーログやスタックトレース（あるいはスクリーンショットや自由記述の症状説明）を貼り付けるだけで、AIが根本原因の解説・修正差分（diff）・学習メモを動的に生成してくれる、新人エンジニア向けのデバッグ支援デスクトップアプリです。

> ⚠️ 開発中のプロジェクトです。UI・機能は変更される可能性があります。

---

## ✨ 主な機能

- **ハイブリッド解析エンジン**: Gemini APIキーを設定すればAIによる高精度解析、未設定でもルールベースのローカル解析エンジンにフォールバックして動作します
- **マルチモーダル入力**: エラーログのテキストに加え、エラー画面のスクリーンショット画像や自由記述の症状説明からも解析可能（画像解析にはAPIキーが必要）
- **修正案の提示**: コードで直せる場合はUnified Diff形式の修正案、手順（コマンド実行・再起動等）で解決すべき場合はタスクリストを表示
- **実ファイルへの安全な適用（オプション）**: プロジェクトフォルダを選択すると、diffの内容が実ファイルと一致するかを確認したうえで安全に適用でき、自動バックアップからいつでもロールバック可能
- **修正の検証**: 再実行後のログを再解析し、エラーが解消したか／別のエラーが出ていないかを検証。確認チェックリストで自己申告の精度を担保
- **解析履歴**: 直近の解析結果をローカルに保存し、種類別/時系列での閲覧・検索・グループ化に対応
- **ライト/ダークモード**、日本語UI

---

## 🛠️ 技術スタック

| レイヤー | 技術 |
|---|---|
| デスクトップフレームワーク | [Tauri 2](https://tauri.app/)（Rust） |
| フロントエンド | React 19 + TypeScript + Vite |
| スタイリング | Tailwind CSS v4 |
| アイコン | lucide-react |
| AI解析エンジン | Google Gemini API（`fetch` による直接呼び出し。SDK不使用） |
| ローカル解析エンジン | 正規表現ベースのルールエンジン（[src/analyzer.ts](src/analyzer.ts)） |
| 実ファイル適用ロジック | Rust（[src-tauri/src/fix_apply.rs](src-tauri/src/fix_apply.rs)、パストラバーサル対策・バックアップ・ロールバック付き） |

---

## 📂 ディレクトリ構成

```text
develop/
├── src/
│   ├── App.tsx            # UI本体（1画面構成のメインアプリ）
│   ├── analyzer.ts         # ローカル解析エンジン（ルールベース）と型定義
│   ├── gemini.ts            # Gemini API 呼び出し
│   └── main.tsx             # エントリーポイント
├── src-tauri/
│   └── src/
│       ├── lib.rs            # Tauriコマンド（フォルダ選択・適用可否判定・適用・ロールバック・APIキー管理）
│       ├── fix_apply.rs      # diff解析・安全なパス解決・適用ロジック（純粋関数・テスト付き）
│       ├── secret_store.rs   # Gemini APIキーのOSキーチェーン保存・読み込み
│       └── main.rs
├── 01_requirements_definition.md
├── 02_introduction_spec.md
├── package.json
└── vite.config.ts
```

---

## 🚀 クイックスタート

### 前提
- Node.js（[package.json](package.json) の devDependencies に対応するバージョン）
- [pnpm](https://pnpm.io/)（`pnpm-lock.yaml` を使用）
- Rust ツールチェーン（Tauriのビルドに必要。[Tauriの前提条件](https://tauri.app/start/prerequisites/)を参照）

### 1. 依存関係のインストール
```bash
pnpm install
```

### 2. デスクトップアプリとして起動（開発モード）
```bash
pnpm tauri dev
```

ブラウザのみで（Tauriの機能を使わず）フロントエンドだけ確認したい場合:
```bash
pnpm dev:web
```

### 3. Gemini APIキーの設定
`.env` ファイルは使用しません。アプリ起動後、右上の **「Gemini AI: APIキー設定」** ボタンからGoogle AI Studioで取得したAPIキーを入力してください。キーはOSのキーチェーン（Windowsの資格情報マネージャー等、[src-tauri/src/secret_store.rs](src-tauri/src/secret_store.rs)経由）に保存されます。未設定でもローカル解析エンジンで動作します。

キーの取得: https://aistudio.google.com/app/apikey

### 4. ビルド
```bash
pnpm build        # tsc && vite build
pnpm tauri build  # デスクトップアプリのインストーラー生成
```

---

## 🧪 テスト

```bash
# フロントエンド（解析ロジック: src/analyzer.ts, src/gemini.ts）
pnpm test

# Rust側（diff適用・バックアップ世代管理などの判定・適用ロジック）
cd src-tauri
cargo test
```
