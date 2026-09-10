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
        SS["secret_store.rs（APIキー）"]
    end

    subgraph OS["OS / 外部"]
        KC[("OSキーチェーン\n資格情報マネージャー")]
        FS[("プロジェクトフォルダ\n実ファイル + .debug-buddy-backups")]
        GIT["gitコマンド（サブプロセス）"]
        DEV["開発コマンド\n(npm run dev 等)"]
        API["Google Gemini API"]
    end

    UI -->|ログ/画像/症状| SN --> GM -->|HTTPS| API
    UI -->|APIキー無し/失敗時| AN
    UI <-->|invoke| LIB
    LIB --> FA --> FS
    LIB --> GS --> GIT
    LIB --> TW --> DEV
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
- マスク対象: PEM秘密鍵、AWSアクセスキー、各種APIキーらしき文字列、パスワード、メールアドレス、**パブリックIP**（プライベート/ループバックIPは開発情報として有用なため除外）など。
- Gemini呼び出しが失敗した場合は自動的にローカル解析エンジンへフォールバックし、その旨をトースト通知で案内します。

---

## 3. Gemini APIキーのデータフロー

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

## 4. 実ファイル適用・バックアップ・ロールバックのデータフロー

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

## 5. Git連携のデータフロー

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

## 6. ターミナル監視のデータフロー（試験的機能）

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

## 7. 解析履歴のデータフロー

- 保存先: ブラウザ/Webviewの `localStorage`（キー: `debug_buddy_history`）。**外部へは送信されません。**
- 最大100件。同一エラー（ファイル・行・エラー種別等が一致）は重複排除し、既存エントリの「再発回数」をインクリメント。
- エクスポート操作時のみ、JSON/Markdownとしてローカルファイルに書き出されます（`export_text_file` コマンド経由でRust側がファイル保存ダイアログを表示）。

---

## 8. データ保存先まとめ

| データ | 保存場所 | 平文か | 外部送信の有無 |
|---|---|---|---|
| Gemini APIキー（デスクトップ版） | OSキーチェーン | 暗号化/OS保護 | 送信先はGoogle Gemini APIのみ（リクエストヘッダー） |
| Gemini APIキー（Web版のみ） | `localStorage`（平文） | 平文 | 同上 |
| エラーログ本文・画像・症状説明 | 送信時のみメモリ上 | — | **Gemini API利用時のみ**、マスキング後にGoogleへ送信。ローカル解析時は送信なし |
| 解析結果・履歴 | `localStorage` | 平文 | 送信なし |
| モデル選択・テーマ・プロジェクトフォルダパス等の設定 | `localStorage` | 平文 | 送信なし |
| 修正前ファイルのバックアップ | 対象プロジェクト内 `.debug-buddy-backups/` | 平文（ソースコードそのまま） | 送信なし |
| 開発コマンドの標準出力/標準エラー | メモリ上でストリーミングのみ（永続化なし） | — | 送信なし |
