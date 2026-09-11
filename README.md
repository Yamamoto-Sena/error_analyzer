# Debug Buddy 🚀
**AI-Powered Debugging & Error Log Analysis Desktop App for Engineers**

エラーログやスタックトレース（あるいはスクリーンショットや自由記述の症状説明）を貼り付けるだけで、AIが根本原因の解説・修正差分（diff）・学習メモを動的に生成してくれる、新人エンジニア向けのデバッグ支援デスクトップアプリです。

> ⚠️ 開発中のプロジェクトです。UI・機能は変更される可能性があります。

詳細な仕様は [01_requirements_definition.md](01_requirements_definition.md)（要件定義書）・[02_introduction_spec.md](02_introduction_spec.md)（起動画面・UI/UX仕様書）を参照してください。

---

## ✨ 主な機能

- **ハイブリッド解析エンジン**: Gemini APIキーを設定すればAIによる高精度解析、未設定でもルールベースのローカル解析エンジンにフォールバックして動作します
- **マルチモーダル入力**: エラーログのテキストに加え、エラー画面のスクリーンショット画像や自由記述の症状説明からも解析可能（画像解析にはAPIキーが必要）
- **モデル選択**: 解析に使うGeminiモデルをヘッダーから切替可能。APIキー設定時は利用可能なモデル一覧を動的取得（画像/動画/音声生成系・Live/Omni系・Robotics系・Lyria系・computer-use系・deep-research系/antigravity系・transcribe系・提供終了済みのgemini-2.5系など、誰が呼んでも使えないモデルは自動除外）
- **モデル診断**: プルダウン上の各モデルへ実際に軽量なリクエストを送信し、利用可/利用不可（権限・未対応／日次クォータ超過／一時的な混雑）を一覧表示。一覧には出るが実際には呼び出せないモデルを可視化できる
- **修正案の提示**: コードで直せる場合はUnified Diff形式の修正案、手順（コマンド実行・再起動等）で解決すべき場合はタスクリストを表示
- **実ファイルへの安全な適用（オプション・デスクトップ版のみ）**: プロジェクトフォルダを選択すると、diffの内容が実ファイルと一致するかを確認したうえで安全に適用でき、自動バックアップ（最大20世代）からいつでもロールバック可能
- **Git連携**: プロジェクトフォルダの未コミット変更を検知し、適用前に警告表示（処理はブロックしない）
- **ターミナル監視（試験的機能・デスクトップ版のみ）**: `npm run dev` などの開発コマンドをアプリ内から実行し、出力をリアルタイム監視。エラーを検知したら解析欄へワンクリックで取り込み、または自動解析まで実行可能
- **クリップボード監視（試験的機能・デスクトップ版のみ）**: MotionBoard・BigQuery（Google Cloud Console）等、他アプリ/ブラウザで出たエラーメッセージをコピーするだけで自動検知し、貼り付け操作なしで解析欄へ取り込み（オプトインで自動解析まで実行可能）。ヘッダーのボタン自体が実行中は色を変えて状態を表示
- **修正の検証**: 再実行後のログを再解析し、エラーが解消したか／別のエラーが出ていないかを検証。確認チェックリストで自己申告の精度を担保
- **解析履歴**: 直近の解析結果をローカルに保存（最大100件、同一エラーは重複排除・再発回数カウント）し、種類別/時系列での閲覧・検索・ピン留め・JSON/Markdownエクスポートに対応
- **セキュリティ**: Gemini APIキーはOSキーチェーンに保存。ログをAIへ送信する前にAPIキーやパスワード等の機密情報らしき文字列を自動マスキング
- **ライト/ダークモード**、日本語UI
- **右クリックメニュー**: WebView既定のブラウザ向けメニューは常に非表示にし、入力欄・テキスト選択上でのみ「コピー/切り取り/貼り付け」だけの最小メニューを表示（ローカルデスクトップアプリらしい操作感）

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
| 機密情報マスキング | [src/sanitize.ts](src/sanitize.ts)（Gemini送信前にAPIキー・パスワード等をマスク） |
| 実ファイル適用ロジック | Rust（[src-tauri/src/fix_apply.rs](src-tauri/src/fix_apply.rs)、パストラバーサル対策・バックアップ・ロールバック付き） |
| Git連携 | Rust（[src-tauri/src/git_status.rs](src-tauri/src/git_status.rs)、作業ツリーの未コミット変更検知） |
| ターミナル監視 | Rust（[src-tauri/src/terminal_watch.rs](src-tauri/src/terminal_watch.rs)、開発コマンドの実行・出力ストリーミング） |
| クリップボード監視 | Rust（[src-tauri/src/clipboard_watch.rs](src-tauri/src/clipboard_watch.rs)、`tauri-plugin-clipboard-manager`経由でのポーリング・変化配信） |
| APIキー保存 | Rust（[src-tauri/src/secret_store.rs](src-tauri/src/secret_store.rs)、OSキーチェーン経由） |

---

## 📂 ディレクトリ構成

```text
develop/
├── src/
│   ├── App.tsx                # UI本体（1画面構成のメインアプリ）
│   ├── analyzer.ts            # ローカル解析エンジン（ルールベース）と型定義
│   ├── gemini.ts               # Gemini API 呼び出し（リトライ・モデル一覧取得・モデル診断含む）
│   ├── models.ts               # 選択可能なGeminiモデルの一覧・既定値
│   ├── sanitize.ts             # Gemini送信前の機密情報マスキング
│   ├── TerminalWatchModal.tsx  # ターミナル監視モーダルUI
│   ├── ClipboardWatchModal.tsx # クリップボード監視モーダルUI
│   ├── ModelDiagnosticsModal.tsx # モデル診断モーダルUI
│   └── main.tsx                # エントリーポイント
├── src-tauri/
│   └── src/
│       ├── lib.rs              # Tauriコマンド（フォルダ選択・適用可否判定・適用・ロールバック・APIキー管理等）
│       ├── fix_apply.rs        # diff解析・安全なパス解決・適用ロジック（純粋関数・テスト付き）
│       ├── git_status.rs       # Git作業ツリーの汚れ判定
│       ├── terminal_watch.rs   # 開発コマンドの実行・出力ストリーミング
│       ├── clipboard_watch.rs  # OSクリップボードのテキストポーリング・変化配信
│       ├── secret_store.rs     # Gemini APIキーのOSキーチェーン保存・読み込み
│       └── main.rs
├── vscode-extension/              # （実験的PoC）VS Code拡張方式の検証。本体とは独立
├── 01_requirements_definition.md  # 要件定義書
├── 02_introduction_spec.md        # 起動画面・UI/UX仕様書
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

初回はRust側のビルドが走るため起動まで数分かかることがあります。2回目以降はキャッシュが効き高速に起動します。

ブラウザのみで（Tauriの機能を使わず）フロントエンドだけ確認したい場合:
```bash
pnpm dev:web
```
Web版ではプロジェクトフォルダ選択・実ファイルへの適用・Git連携・ターミナル監視・クリップボード監視など、ネイティブ機能に依存するボタンは無効化されます（ローカル解析エンジンやGemini API解析、履歴機能などは利用可能）。

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
# フロントエンド（解析ロジック: src/analyzer.ts, src/gemini.ts, src/sanitize.ts）
pnpm test

# Rust側（diff適用・バックアップ世代管理・Git判定・ターミナル監視の文字コード処理など）
cd src-tauri
cargo test

# クリップボード監視の「この端末でOSクリップボードの読み書きが機能するか」を確認する
# トラブルシューティング用テスト（通常のcargo testでは実行されない#[ignore]付き）
cargo test -- --ignored arboard_can_read_back_written_text
```

---

## 🧪 実験的な取り組み

- **[vscode-extension/](vscode-extension/)**: VS Code拡張方式でのエディタ内解析のPoC。本体アプリ（Tauriデスクトップ版）とは独立した別プロジェクトです。詳細は[vscode-extension/README.md](vscode-extension/README.md)を参照してください。
