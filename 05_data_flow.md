# データの流れ（アーキテクチャ・データフロー説明）

**対象読者**: アプリを評価するエンジニア
**目的**: 「どのデータが」「どこで生成され」「どこに保存され」「どこへ送信されるか」を、機能ごとに図解する。特にセキュリティ・プライバシーの観点（何が外部に送信され、何がローカルに留まるか）を評価する際の参考資料。
**関連**: [01_requirements_definition.md](01_requirements_definition.md) 5章（非機能要件）／[04_user_manual.md](04_user_manual.md)

---

## 1. 全体アーキテクチャ

```mermaid
flowchart LR
    subgraph FE["フロントエンド (React / TypeScript)"]
        UI["App.tsx（画面）"]
        AN["analyzer.ts（ローカル解析エンジン）"]
        GM["gemini.ts（Gemini API呼び出し）"]
        SN["sanitize.ts（送信前マスキング）"]
        LS[("localStorage\n履歴・設定")]
    end

    subgraph BE["Tauriバックエンド (Rust, src-tauri)"]
        LIB["lib.rs（コマンド窓口）"]
        FA["fix_apply.rs（diff適用・バックアップ）"]
        GS["git_status.rs（git status呼び出し）"]
        TW["terminal_watch.rs（開発コマンド監視）"]
        CW["clipboard_watch.rs（クリップボード監視）"]
        LW["log_file_watch.rs（ログファイル監視）"]
        SS["secret_store.rs（APIキー）"]
    end

    subgraph OS["OS / 外部"]
        KC[("OSキーチェーン\n資格情報マネージャー")]
        FS[("プロジェクトフォルダ\n実ファイル + .debug-buddy-backups")]
        GIT["gitコマンド（サブプロセス）"]
        DEV["開発コマンド\n(npm run dev 等)"]
        CB[("OSクリップボード")]
        LF[("外部ログファイル\n(常駐サーバー等)")]
        API["Google Gemini API"]
    end

    UI -->|ログ/画像/症状| SN --> GM -->|HTTPS| API
    UI -->|APIキー無し/失敗時| AN
    UI <-->|invoke| LIB
    LIB --> FA --> FS
    LIB --> GS --> GIT
    LIB --> TW --> DEV
    LIB --> CW --> CB
    LIB --> LW --> LF
    LIB --> SS --> KC
    UI <--> LS
```

- Gemini APIへ**送信されるのはログ・画像・症状の説明文（マスキング後）のみ**。プロジェクトのソースコード全体は送信しません（画面上でユーザーが貼り付けたテキスト/画像のみが対象）。
- 実ファイルの読み書き・Git確認・開発コマンド実行・APIキー保存は、すべてRust側（Tauriバックエンド）が担当し、フロントエンドから`invoke`経由で呼び出します。

---

## 2. ログ解析のデータフロー

```mermaid
sequenceDiagram
    participant U as ユーザー
    participant UI as App.tsx
    participant SN as sanitize.ts
    participant GM as gemini.ts
    participant AN as analyzer.ts
    participant API as Gemini API
    participant LS as localStorage(履歴)

    U->>UI: ログ/画像/症状を入力し「解析する」
    alt APIキー設定済み
        UI->>SN: ログ本文をマスキング
        SN-->>UI: マスク後テキスト + マスク件数
        UI->>GM: 解析リクエスト（マスク後テキスト, 画像, 選択モデル）
        GM->>API: HTTPS POST（構造化JSON応答を要求）
        alt 成功
            API-->>GM: 構造化JSON（原因/diff/学習メモ）
        else 失敗・混雑・RPD超過
            GM->>API: フォールバックモデルで再試行
            API-->>GM: 応答 または 全滅
        end
        GM-->>UI: 解析結果 or エラー
    else APIキー未設定 or 全モデル失敗
        UI->>AN: ログ本文を渡す
        AN-->>UI: ルールベースの解析結果（正規表現マッチ）
    end
    UI->>LS: 結果を履歴に保存（重複排除・再発カウント）
    UI-->>U: 3タブ（根本原因/Diff/学習メモ）に表示
```

**ポイント**:
- マスキング（[sanitize.ts](src/sanitize.ts)）は **Gemini APIへ送る直前にのみ** 実行されます。ローカル解析エンジンは外部送信しないため対象外です。
- マスク対象: PEM秘密鍵、AWSアクセスキー、GitHub Personal Access Token（`ghp_`等）、Google APIキー（`AIzaSy...`）、Slackトークン（`xoxb-`等）、Stripeキー（`sk_live_`等）、接頭辞のない裸のシークレットキー（`sk-...`）、各種`key=value`形式のAPIキー・パスワード、メールアドレス、**パブリックIPv4/IPv6アドレス**（プライベート/ループバックIPは開発情報として有用なため除外）など。
- 修正検証（「ログを再解析して検証する」）でGeminiへ送信する「直前に提示した修正案」の内容（要約・根本原因・diffCode/taskSteps）も、ログ本文と同じくこのマスキングを経てから送信されます。
- Gemini呼び出しが失敗した場合は自動的にローカル解析エンジンへフォールバックし、その旨をトースト通知で案内します。

---

## 3. モデル一覧取得・モデル診断のデータフロー

```mermaid
sequenceDiagram
    participant U as ユーザー
    participant UI as App.tsx
    participant GM as gemini.ts
    participant API as Gemini API
    participant MD as ModelDiagnosticsModal

    U->>UI: APIキー設定完了/変更
    UI->>GM: listAvailableModels(apiKey)
    GM->>API: GET /v1beta/models
    API-->>GM: 全モデルのメタデータ
    Note over GM: generateContent非対応・画像/動画/音声生成系・Robotics/Live/Omni系・\nLyria系・computer-use系・deep-research系/antigravity系・transcribe系・\n提供終了済みgemini-2.5系を除外
    GM-->>UI: 選択肢一覧
    UI-->>U: モデル選択ドロップダウンに反映

    U->>MD: 「モデル診断」→「診断を開始」
    loop 一覧の各モデルへ1件ずつ（順に間隔を空けて送信）
        MD->>GM: diagnoseModels(apiKey, models)
        GM->>API: HTTPS POST generateContent（固定の短い確認用テキストのみ）
        alt 成功
            API-->>GM: 200 → 利用可
        else 404 / 403
            API-->>GM: 利用不可（権限/未対応）
        else 429（日次/月次クォータ超過が明確）
            API-->>GM: 利用不可（クォータ超過）
        else 429 / 503（一時的な混雑）
            GM->>API: 軽くリトライ（最大2回）
        end
        GM-->>MD: 1件ごとの判定結果
    end
    MD-->>U: 結果一覧（理由付き）。保存はせずモーダル内のメモリ上にのみ保持
```

**ポイント**:
- モデル診断は、ドロップダウンに表示されている件数分だけGoogle Gemini APIを呼び出します（＝モデルの数だけクォータを消費）。ユーザーが「診断を開始」を押した時のみ実行され、自動実行はしません。
- 送信されるのは固定の短い確認用テキストのみで、入力欄のエラーログ・画像・症状説明は一切含まれません。
- 診断結果はモーダルを閉じると破棄されます（「結果をコピー」を押した場合のみ、クリップボードにコピーされます）。

---

## 4. Gemini APIキーのデータフロー

```mermaid
sequenceDiagram
    participant U as ユーザー
    participant UI as App.tsx
    participant LIB as lib.rs (invoke)
    participant SS as secret_store.rs
    participant KC as OSキーチェーン

    U->>UI: APIキー設定モーダルにキーを入力
    UI->>LIB: invoke("save_api_key", key)
    LIB->>SS: save_api_key(key)
    SS->>KC: keyring::set_password（OS保護領域へ保存）
    Note over UI: Tauri外(pnpm dev:web)のみ localStorage にフォールバック保存

    U->>UI: アプリ再起動
    UI->>LIB: invoke("load_api_key")
    LIB->>SS: load_api_key()
    SS->>KC: keyring::get_password
    KC-->>UI: 保存済みキー（or 未設定=None）
    Note over UI: 旧バージョンでlocalStorageに平文残存があれば読み込みつつキーチェーンへ移行し、移行後はlocalStorageから削除
```

**ポイント**: デスクトップ版ではAPIキーは平文ファイルに保存されません（Windowsの資格情報マネージャー等、OSの保護領域を利用）。`pnpm dev:web` のようにTauriの外で動かした場合のみ`localStorage`に平文保存されます（ネイティブ機能が使えないブラウザ限定の代替経路）。

---

## 5. 実ファイル適用・バックアップ・ロールバックのデータフロー

```mermaid
sequenceDiagram
    participant U as ユーザー
    participant UI as App.tsx
    participant LIB as lib.rs
    participant FA as fix_apply.rs
    participant FS as プロジェクトフォルダ

    UI->>LIB: invoke("check_fix_applicability", root, file, diff)
    LIB->>FA: diffの削除行が実ファイルと一致するか検証
    FA->>FS: 対象ファイルを読み取り、パストラバーサル対策も検証
    FA-->>UI: 適用可否（不一致なら"実ファイルに適用する"は無効）

    U->>UI: 「バックアップを取って適用する」
    UI->>LIB: invoke("apply_fix", root, file, diff)
    LIB->>FA: apply_fix
    FA->>FS: 元ファイルを.debug-buddy-backups/へバックアップ（manifest.json更新）
    FA->>FS: 新内容をアトミックに書き込み
    FA-->>UI: 適用結果

    U->>UI: 「過去のバックアップ履歴」→「元に戻す」
    UI->>LIB: invoke("rollback_fix", root, backupId)
    LIB->>FA: rollback_fix
    FA->>FS: バックアップ内容を復元
```

**ポイント**:
- diffの「削除される行」がファイルの実内容と一字一句一致しない限り適用は拒否されます（AIの推測ミスによる誤書き込み防止）。
- バックアップは対象ファイルごとに最大20世代保持し、古いものから自動削除されます。
- バックアップ・manifestは対象プロジェクト内の `.debug-buddy-backups/` フォルダに保存されます（本リポジトリの管理外）。

---

## 6. Git連携のデータフロー

```mermaid
sequenceDiagram
    participant UI as App.tsx
    participant LIB as lib.rs
    participant GS as git_status.rs
    participant GIT as git（サブプロセス）

    UI->>LIB: プロジェクトフォルダ選択時に invoke("check_git_dirty" 等)
    LIB->>GS: check
    GS->>GIT: `git status --porcelain` を実行
    GIT-->>GS: 変更行一覧（標準出力）
    GS-->>UI: {isGitRepo, isDirty, changedFileCount}
```

判定できない場合（gitがインストールされていない・対象がGit管理下にない等）はエラーにせず「判定不可」として扱い、実ファイル適用自体はブロックしません（あくまで注意喚起用のベストエフォート判定）。

---

## 7. ターミナル監視のデータフロー（試験的機能）

```mermaid
sequenceDiagram
    participant U as ユーザー
    participant UI as TerminalWatchModal
    participant LIB as lib.rs
    participant TW as terminal_watch.rs
    participant DEV as 開発コマンド(子プロセス)

    U->>UI: 監視するコマンドを指定して開始
    UI->>LIB: invoke("start_terminal_watch", command)
    LIB->>TW: 子プロセスをspawn（同時1プロセスまで）
    loop 出力が発生するたび
        DEV-->>TW: stdout/stderr 1行
        TW-->>UI: Tauriイベントでリアルタイム配信
    end
    U->>UI: エラーらしき出力を「解析欄へ取り込む」
    Note over UI: エラー判定はフロントエンド側(App.tsx)で行い、Rust側は生ログ配信に徹する
```

---

## 8. クリップボード監視のデータフロー（試験的機能）

```mermaid
sequenceDiagram
    participant U as ユーザー（他アプリ・ブラウザ）
    participant CBWM as ClipboardWatchModal
    participant LIB as lib.rs
    participant CW as clipboard_watch.rs
    participant OSCB as OSクリップボード
    participant AN as analyzer.ts (looksLikeErrorTextFromClipboard)

    U->>CBWM: 「開始」を押す
    CBWM->>LIB: invoke("start_clipboard_watch")
    LIB->>CW: 現在のクリップボード内容を基準値として記録し、ポーリング開始
    loop 約800ms間隔
        CW->>OSCB: read_text()
        alt 基準値から変化あり
            CW-->>CBWM: Tauriイベント "clipboard-text-changed" で配信
            CBWM->>AN: looksLikeErrorTextFromClipboard(text)
            alt エラーらしいと判定
                CBWM-->>U: ログ欄へセット（自動解析ONなら解析まで実行しモーダルを閉じる）
            else エラーらしくない/20文字未満
                Note over CBWM: 何もしない（他の変化を待つ）
            end
        end
    end
    U->>CBWM: 「停止」を押す
    CBWM->>LIB: invoke("stop_clipboard_watch")
    LIB->>CW: 停止フラグを立てる（次のポーリングタイミングで自然終了）
```

**ポイント**:
- クリップボードの内容はメモリ上でポーリング・比較されるのみで、永続化・外部送信は一切行われません（エラーらしいと判定された内容だけが、通常の解析フローと同様にログ欄へ渡り、Gemini解析時のみマスキング後に送信されます）。
- 対象はテキストのみ。画像（スクリーンショット）はこのポーリングの対象外です。
- モーダルを開き直した際は `invoke("is_clipboard_watch_running")` で実際の監視状態を問い合わせ、画面表示を実態に合わせて補正します（開発中のリロードやアプリ再起動直後に、画面上は「未実行」なのにRust側では監視継続中、という食い違いを防ぐため）。
- ターミナル監視モードと状態管理（`OnceLock<Mutex<...>>`）は完全に独立しており、Rust側での競合はありません。フロントエンド側は共通の検知ハンドラを使うため、両方がほぼ同時にエラーを検知した場合は、先に解析処理が始まっている方を優先し、後着はログ欄へのセットのみに留めます。

---

## 9. ログファイル監視のデータフロー（試験的機能）

```mermaid
sequenceDiagram
    participant U as ユーザー
    participant LFWM as LogFileWatchModal
    participant LIB as lib.rs
    participant LW as log_file_watch.rs
    participant LF as 外部ログファイル

    U->>LFWM: 監視するファイルパスを指定して「開始」
    LFWM->>LIB: invoke("start_log_file_watch", path)
    LIB->>LW: ファイル末尾位置を基準値として記録し、ポーリング開始
    loop 追記が発生するたび
        LW->>LF: 新規追記分のみ読み取り
        LW-->>LFWM: Tauriイベント "log-file-output" で1行ずつ配信
    end
    U->>LFWM: エラーらしき出力を「解析欄へ取り込む」
    Note over LFWM: エラー判定はフロントエンド側(App.tsx/analyzer.ts)で行い、Rust側は追記分の生ログ配信に徹する（ターミナル監視と同じ設計方針）
```

**ポイント**:
- 監視開始より前からファイルに書かれていた内容は対象外で、新たに追記された行のみが配信されます。
- モーダルを閉じても監視はバックグラウンドで継続します。モーダルを開き直した際は `invoke("is_log_file_watch_running")` で実際の監視状態を問い合わせ、画面表示を補正します（クリップボード監視と同じ設計）。
- ファイル内容はメモリ上でストリーミングされるのみで、永続化・外部送信は一切行われません（エラーらしいと判定された内容だけが、通常の解析フローと同じ経路でログ欄へ渡ります）。

---

## 10. 解析履歴のデータフロー

- 保存先: ブラウザ/Webviewの `localStorage`（キー: `debug_buddy_history`）。**外部へは送信されません。**
- 最大100件。同一エラー（ファイル・行・エラー種別等が一致）は重複排除し、既存エントリの「再発回数」をインクリメント。
- エクスポート操作時のみ、JSON/Markdownとしてローカルファイルに書き出されます（`export_text_file` コマンド経由でRust側がファイル保存ダイアログを表示）。
- **振り返りダッシュボード**（[src/historyStats.ts](src/historyStats.ts)）は、この`localStorage`上の履歴を読み取って集計するのみで、新たな永続化・外部送信は発生しません。

---

## 11. データ保存先まとめ

| データ | 保存場所 | 平文か | 外部送信の有無 |
|---|---|---|---|
| Gemini APIキー（デスクトップ版） | OSキーチェーン | 暗号化/OS保護 | 送信先はGoogle Gemini APIのみ（リクエストヘッダー） |
| Gemini APIキー（Web版のみ） | `localStorage`（平文） | 平文 | 同上 |
| エラーログ本文・画像・症状説明 | 送信時のみメモリ上 | — | **Gemini API利用時のみ**、マスキング後にGoogleへ送信。ローカル解析時は送信なし |
| 解析結果・履歴 | `localStorage` | 平文 | 送信なし |
| モデル選択・テーマ・プロジェクトフォルダパス等の設定 | `localStorage` | 平文 | 送信なし |
| 修正前ファイルのバックアップ | 対象プロジェクト内 `.debug-buddy-backups/` | 平文（ソースコードそのまま） | 送信なし |
| 開発コマンドの標準出力/標準エラー | メモリ上でストリーミングのみ（永続化なし） | — | 送信なし |
| クリップボードの内容（監視ON時のみ） | メモリ上でポーリング・比較のみ（永続化なし） | — | エラーらしいと判定された内容のみ、通常の解析フローと同じ経路でログ欄へ渡る（Gemini利用時はマスキング後に送信） |
| 外部ログファイルの追記内容（監視ON時のみ） | メモリ上でストリーミングのみ（永続化なし） | — | エラーらしいと判定された内容のみ、通常の解析フローと同じ経路でログ欄へ渡る（Gemini利用時はマスキング後に送信） |
| フォローアップ質問の内容 | 送信時のみメモリ上（画面を離れると破棄、履歴には保存されない） | — | Gemini APIキー設定時のみ、直前の解析結果（要約・根本原因・diffCode/taskSteps）と合わせてGoogleへ送信 |
| モデル診断の確認用テキスト（固定文言、ログ本文は含まない） | 送信時のみメモリ上 | — | 診断実行時のみ、モデルの数だけGoogle Gemini APIへ送信。結果はモーダルを閉じると破棄され、保存・外部送信はされない |
