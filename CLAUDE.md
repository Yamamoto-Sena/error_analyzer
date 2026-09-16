# CLAUDE.md

このファイルは、このリポジトリで作業する Claude Code に向けたガイドです。

## プロジェクト概要

**Debug Buddy** — エンジニア向けの AI 搭載デバッグ・エラーログ解析デスクトップアプリ。
エラーログ／スタックトレース（またはスクリーンショット、症状の自由記述）を入力すると、AI が原因説明・修正diff・学習メモを生成する。ジュニアエンジニア向けを想定。現在も開発中で、UI・機能は変更されうる。

## 使用言語・フレームワーク・主要ライブラリ

- **デスクトップ基盤**: Tauri 2（Rust バックエンド + Web フロントエンド）。Electron ではない。
- **フロントエンド**: TypeScript + React 19 + Vite 8。スタイリングは Tailwind CSS v4（`@tailwindcss/vite`）、アイコンは `lucide-react`。
- **パッケージマネージャ**: pnpm（`pnpm-lock.yaml` が正。npm/yarn は使わない）。
- **Rust バックエンド（`src-tauri/`）**: `tauri`, `tauri-plugin-opener`, `tauri-plugin-dialog`, `tauri-plugin-clipboard-manager`, `serde`/`serde_json`, `keyring`（APIキーをOSキーチェーンに保存）, `encoding_rs`（Windows ターミナル出力の Shift-JIS/CP932 デコード）。テスト用 dev-dependency に `arboard`。
- **Gemini API 連携**: 公式 SDK は使わず、`src/gemini.ts` から `fetch()` で直接呼び出す。API キーはクエリではなく `x-goog-api-key` ヘッダーで送信（devtools のネットワークログに残さないため）。
- **TypeScript 設定**: `strict: true` に加え `noUnusedLocals` / `noUnusedParameters` / `noFallthroughCasesInSwitch` を有効化。ビルド本体は Vite が担い、`tsc` は型チェック専用（`noEmit: true`）。

## ディレクトリ構成

```
src/                        # React/TS フロントエンド
  App.tsx                   # メインの単一画面UI
  analyzer.ts                # ローカル・ルールベース（正規表現）解析エンジン、共有型定義
  gemini.ts                  # Gemini API 呼び出し（fetch、リトライ、モデル一覧・診断）
  models.ts                  # 選択可能な Gemini モデル一覧（App.tsx / gemini.ts 共通の単一情報源）
  sanitize.ts                 # ログ送信前に APIキー等の機密情報をマスク
  usageTracker.ts             # 太平洋時間の日次リセットに合わせたトークン/リクエスト使用量トラッキング（localStorage）
  ClipboardWatchModal.tsx     # クリップボード監視のモーダルUI
  TerminalWatchModal.tsx      # ターミナル監視のモーダルUI
  ModelDiagnosticsModal.tsx   # モデル疎通診断のモーダルUI
  *.test.ts                   # 各モジュールに併設された Vitest テスト
  debug_buddy/main.py         # 空ファイル（未使用のスタブ、実装なし）

src-tauri/                  # Tauri デスクトップシェル（Rust）
  src/lib.rs                 # Tauri コマンド群（フォルダ選択、修正の適用可否判定、適用/ロールバック、APIキー管理）
  src/fix_apply.rs            # diff解析・安全なパス解決・適用（純粋関数、テスト付き）
  src/git_status.rs           # Git 作業ツリーの dirty 判定
  src/terminal_watch.rs       # devコマンドの出力監視（CP932/Shift-JISデコード対応）
  src/clipboard_watch.rs      # OSクリップボードのポーリング監視
  src/secret_store.rs         # Gemini APIキーの OS キーチェーン保存
  tauri.conf.json             # productName "Debug Buddy" / identifier com.debugbuddy.app

01_requirements_definition.md  # 要件定義書
02_introduction_spec.md        # 起動画面・UI/UX仕様書
04_user_manual.md              # 使い方ガイド（03は欠番）
05_data_flow.md                # データフロー・アーキテクチャ説明

vscode-extension/            # 独立した実験的PoC（VS Code拡張）。本体アプリとは無関係
manual-test-fixtures/        # 手動検証用フィクスチャ（自動テスト対象外）
python-cli/, .env            # 未使用の残骸（python-cli は空、.envはREADME上「使用しない」と明記）
.github/workflows/deploy-pages.yml  # main push で GitHub Pages にフロントエンドをデプロイ
```

## 命名規則・コーディング規約

- **ファイル名**: 素の `.ts` モジュールは camelCase（`analyzer.ts`, `gemini.ts`, `sanitize.ts`, `usageTracker.ts`）。React コンポーネントは PascalCase（`App.tsx`, `ClipboardWatchModal.tsx` など）。
- **テストファイル**: `<対象>.test.ts` として同じディレクトリに併設（`tests/` ディレクトリには分離しない）。
- **識別子**: 変数・関数は camelCase、型・インターフェース・コンポーネントは PascalCase。インターフェースに `I` プレフィックスは付けない。
- **コンポーネント**: 関数コンポーネント + hooks（`useState`/`useEffect`/`useMemo`/`useRef`）のみ。クラスコンポーネントは使わない。小さなヘルパーコンポーネントは別ファイルに分けず、同一ファイル内に `function` 宣言として置く（例: `App.tsx` 内の `DiffView`, `TaskStepsView`）。
- **エラーハンドリング**: fail-soft（失敗時は例外を投げずデフォルト値にフォールバック）が徹底されている。未使用の場合は `catch { ... }` のように変数を束縛しない。
- **コメント**: ほぼ全て日本語。「何をしているか」だけでなく「なぜそうしたか」を説明する記述が多い（`gemini.ts` や `usageTracker.ts` に顕著）。新規コードもこのスタイル（日本語・理由重視）に合わせること。
- **Lint/Formatter設定なし**: ESLint/Prettier/Biome の設定ファイルは存在しない。コードスタイルは TypeScript の `strict` 系オプションと人力の慣習のみで担保されている。

## テスト

- **フロントエンド/TS**: Vitest（`environment: "node"`。`analyzer.ts`/`gemini.ts` はDOM非依存の純粋ロジックのため jsdom 不使用）。
  - 実行コマンド: `pnpm test`（内部で `vitest run`）
  - 対象: `src/analyzer.test.ts`, `src/gemini.test.ts`, `src/usageTracker.test.ts`, `src/sanitize.test.ts`
- **Rust側**: `src-tauri/` で `cargo test`（diff適用ロジック、バックアップ世代管理、Git dirty判定、ターミナル監視のエンコーディング処理などをカバー）。
  - クリップボード実機確認用の無視テスト: `cargo test -- --ignored arboard_can_read_back_written_text`

## よく使う開発コマンド

```bash
pnpm install              # 依存関係インストール（pnpm必須）
pnpm tauri dev             # デスクトップアプリとして起動（初回はRustビルドで時間がかかる）
pnpm dev:web               # フロントエンドのみブラウザで起動（ネイティブ機能は無効/スタブ）
pnpm build                 # tsc（型チェック）+ vite build（本番ビルド）
pnpm build:pages           # GitHub Pages 向けビルド（/error_analyzer/ ベースパス付与）
pnpm preview                # ビルド結果のプレビュー
pnpm tauri build            # デスクトップインストーラーの生成
pnpm test                   # フロントエンド/TSテスト（vitest run）
cd src-tauri && cargo test  # Rust側テスト
```

Gemini APIキーは `.env` ではなくアプリUI（「Gemini AI: APIキー設定」）から入力し、OSキーチェーン（`secret_store.rs`）に保存される。キー未設定でもローカルのルールベース解析エンジンで動作する。

## 注意点

- `src/debug_buddy/main.py` は0バイトの空ファイル、`python-cli/` も空のディレクトリ — 未使用のスタブなので実装の参考にしない。
- ルートの `.env` は README 上「使用しない」と明記されている残骸ファイル。信頼しないこと。
- `vscode-extension/` は本体アプリとは独立した別プロジェクト（実験的PoC）。
