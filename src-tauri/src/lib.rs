// 修正案(diff)を実ファイルへ安全に適用するための純粋ロジック（判定・パッチ計算のみ）。
mod fix_apply;
// プロジェクトフォルダのGit作業ツリーが汚れていないかを判定する（git CLIのラッパー）。
mod git_status;
// Gemini APIキーをOSキーチェーンに保存・読み込みするための薄いラッパー。
mod secret_store;
// 開発コマンドをアプリ内から起動し、出力をリアルタイム配信する「ターミナル監視モード」。
mod terminal_watch;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use fix_apply::{compute_fix, resolve_within_root};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// バックアップ一式を保存するフォルダ名（プロジェクトルート直下に作成する）
const BACKUP_DIR_NAME: &str = ".debug-buddy-backups";
/// バックアップの一覧（id ⇔ 元のファイルの相対パス の対応）を記録するファイル名
const MANIFEST_FILE_NAME: &str = "manifest.json";
/// 同一ファイルにつき保持するバックアップの最大件数。これを超えた分は
/// 作成日時が古い順に自動で削除し、`.debug-buddy-backups` が無制限に
/// 肥大化するのを防ぐ（頻繁に「実ファイルに適用」を使うプロジェクトほど効く）。
const MAX_BACKUPS_PER_FILE: usize = 20;

/// `apply_fix` が返す結果。フロントエンドはこの `backup_id` を覚えておき、
/// ロールバック時に `rollback_fix` へそのまま渡す。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplyFixResult {
    backup_id: String,
    applied_path: String,
}

/// `check_fix_applicability` が返す、適用可否の判定結果。
/// `reason` は `fix_apply::UnapplicableReason::as_str()` の値（例: "file-not-found"）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FixCheckResult {
    applicable: bool,
    reason: Option<String>,
    resolved_path: Option<String>,
}

/// バックアップ管理ファイル(manifest.json)の1エントリ。
#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct BackupEntry {
    id: String,
    /// プロジェクトルートからの相対パス（区切り文字は "/" に統一）
    relative_path: String,
    created_at_unix_ms: u128,
}

/// プロセス内でのみ一意であればよい（同一ミリ秒の連続書き込みでもIDが衝突しないようにする）
static BACKUP_ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn generate_backup_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = BACKUP_ID_SEQUENCE.fetch_add(1, Ordering::SeqCst);
    format!("{nanos:x}-{seq:x}")
}

fn backup_dir(root: &Path) -> PathBuf {
    root.join(BACKUP_DIR_NAME)
}

/// マニフェストを読み込む。存在しない場合は空一覧として扱う。
/// 壊れている（パース失敗）場合は、過去のバックアップ対応関係を見失う危険があるため
/// 安全側に倒してエラーとし、書き込みを一切行わない。
fn read_manifest(root: &Path) -> Result<Vec<BackupEntry>, String> {
    let manifest_path = backup_dir(root).join(MANIFEST_FILE_NAME);
    if !manifest_path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("バックアップ管理ファイルの読み込みに失敗しました: {e}"))?;
    serde_json::from_str(&text).map_err(|_| {
        "バックアップ管理ファイルが壊れているため、安全のため処理を中止しました。".to_string()
    })
}

/// マニフェストを一時ファイル経由で書き込む（書き込み途中の破損を防ぐ）。
fn write_manifest(root: &Path, entries: &[BackupEntry]) -> Result<(), String> {
    let dir = backup_dir(root);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("バックアップ用フォルダの作成に失敗しました: {e}"))?;
    let manifest_path = dir.join(MANIFEST_FILE_NAME);
    let text = serde_json::to_string_pretty(entries)
        .map_err(|e| format!("バックアップ管理ファイルの直列化に失敗しました: {e}"))?;
    write_atomically(&manifest_path, &text)
}

/// `root` からの相対パスを "/" 区切りの文字列にして返す（Windowsの "\\" を含めない）。
fn relative_path_string(root: &Path, resolved: &Path) -> Result<String, String> {
    // `resolved` は `resolve_within_root` 経由で必ず canonicalize 済み
    // （Windowsでは `\\?\C:\...` という verbatim 形式になる）。
    // ここで `root` も同じ流儀で canonicalize してから比較しないと、
    // 呼び出し元が渡した素の文字列表現との食い違いで strip_prefix が失敗してしまう。
    let root_canon = fs::canonicalize(root)
        .map_err(|e| format!("プロジェクトルートの検証に失敗しました: {e}"))?;
    resolved
        .strip_prefix(&root_canon)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .map_err(|_| "内部エラー: 相対パスの計算に失敗しました。".to_string())
}

/// 一時ファイルに書いてからrenameすることで、書き込み途中の内容で
/// ファイルが上書きされたままになる事態を避ける。
fn write_atomically(path: &Path, content: &str) -> Result<(), String> {
    let file_name = path
        .file_name()
        .ok_or_else(|| "内部エラー: 対象パスにファイル名がありません。".to_string())?;
    let tmp_name = format!("{}.debugbuddy-tmp", file_name.to_string_lossy());
    let tmp_path = path.with_file_name(tmp_name);

    fs::write(&tmp_path, content)
        .map_err(|e| format!("一時ファイルへの書き込みに失敗しました: {e}"))?;
    fs::rename(&tmp_path, path).map_err(|e| format!("ファイルの更新に失敗しました: {e}"))?;
    Ok(())
}

/// 同一ファイル(`relative_path`)のバックアップが`MAX_BACKUPS_PER_FILE`件を超えている場合、
/// 作成日時が古い順に超過分の`.bak`ファイルを削除し、`entries`からも取り除く。
/// バックアップ本体の削除に失敗しても致命的ではないため無視する
/// （ディスク容量を圧迫しないことが目的で、削除の失敗で適用処理全体を失敗させたくないため）。
fn prune_backups_for_path(root: &Path, entries: &mut Vec<BackupEntry>, relative_path: &str) {
    let mut same_file_indices: Vec<usize> = entries
        .iter()
        .enumerate()
        .filter(|(_, e)| e.relative_path == relative_path)
        .map(|(i, _)| i)
        .collect();

    if same_file_indices.len() <= MAX_BACKUPS_PER_FILE {
        return;
    }

    // 古い順（created_at_unix_ms昇順）に並べ、超過分だけ削除対象にする
    same_file_indices.sort_by_key(|&i| entries[i].created_at_unix_ms);
    let excess_count = same_file_indices.len() - MAX_BACKUPS_PER_FILE;
    let remove_set: std::collections::HashSet<usize> =
        same_file_indices.into_iter().take(excess_count).collect();

    for &i in &remove_set {
        let backup_file = backup_dir(root).join(format!("{}.bak", entries[i].id));
        let _ = fs::remove_file(backup_file);
    }

    let mut i = 0usize;
    entries.retain(|_| {
        let keep = !remove_set.contains(&i);
        i += 1;
        keep
    });
}

/// Gemini APIキーをOSキーチェーンに保存する（空文字なら削除）。
/// 実処理は `secret_store` モジュールに委譲する。
#[tauri::command]
fn save_api_key(key: String) -> Result<(), String> {
    secret_store::save_api_key(&key)
}

/// OSキーチェーンからGemini APIキーを読み込む。未保存の場合は `null`（`None`）を返す。
#[tauri::command]
fn load_api_key() -> Result<Option<String>, String> {
    secret_store::load_api_key()
}

/// プロジェクトフォルダをネイティブのダイアログで選ばせる。
/// フロントエンドはJS版の `@tauri-apps/plugin-dialog` を一切呼ばず、この専用コマンドだけを使う
/// （フロントエンドに公開する操作を「フォルダを選ぶ」の1つだけに絞るための設計）。
#[tauri::command]
fn pick_project_root(app: tauri::AppHandle) -> Option<String> {
    // ダイアログがメインウィンドウの後ろに隠れて開いてしまい、応答を待ったまま
    // フリーズしたように見える問題を防ぐため、ダイアログを開く前に必ず前面へ出す。
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }

    let picked = app.dialog().file().blocking_pick_folder()?;
    let path = picked.into_path().ok()?;
    fs::canonicalize(&path)
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

/// 履歴のエクスポート等、ユーザーが選んだ任意の場所へテキストファイルを保存するための
/// 汎用コマンド。ネイティブの「名前を付けて保存」ダイアログを表示し、選択された場所に
/// そのまま書き込む。
/// （ブラウザの `<a download>` + Blob URL によるダウンロードは、TauriのWebView上では
/// 保存先ダイアログが出ず何も起きないことがあるため、デスクトップ版はこちらを使う。
/// エクスポート操作はユーザーが保存先を明示的に選ぶものであり、修正案の自動適用
/// （fix_apply::resolve_within_root）のようなプロジェクトルート配下への制限は不要）。
/// ダイアログでキャンセルされた場合は `Ok(None)` を返す（エラーではない）。
#[tauri::command]
fn export_text_file(
    app: tauri::AppHandle,
    default_name: String,
    content: String,
    filter_name: String,
    filter_extensions: Vec<String>,
) -> Result<Option<String>, String> {
    // ダイアログがメインウィンドウの後ろに隠れて開いてしまい、応答を待ったまま
    // フリーズしたように見える問題を防ぐため、ダイアログを開く前に必ず前面へ出す。
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }

    let extensions: Vec<&str> = filter_extensions.iter().map(String::as_str).collect();
    let picked = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter(&filter_name, &extensions)
        .blocking_save_file();

    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| format!("保存先パスの取得に失敗しました: {e}"))?;
    fs::write(&path, content).map_err(|e| format!("ファイルの書き込みに失敗しました: {e}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// 実際には書き込まず、「安全に適用できそうか」だけを判定する（読み取り専用）。
#[tauri::command]
fn check_fix_applicability(root: String, file_path: String, diff_code: String) -> FixCheckResult {
    match compute_fix(Path::new(&root), &file_path, &diff_code) {
        Ok(applied) => FixCheckResult {
            applicable: true,
            reason: None,
            resolved_path: Some(applied.resolved_path.to_string_lossy().to_string()),
        },
        Err(reason) => FixCheckResult {
            applicable: false,
            reason: Some(reason.as_str().to_string()),
            resolved_path: None,
        },
    }
}

/// 実際にファイルを書き換える。フロントエンドの事前チェック結果は信用せず、
/// 書き込み直前に必ずもう一度 `compute_fix` で再検証する（多層防御）。
#[tauri::command]
fn apply_fix(root: String, file_path: String, diff_code: String) -> Result<ApplyFixResult, String> {
    let root_path = Path::new(&root);

    let applied = compute_fix(root_path, &file_path, &diff_code)
        .map_err(|reason| format!("安全確認に失敗したため適用できません ({})", reason.as_str()))?;

    let relative_path = relative_path_string(root_path, &applied.resolved_path)?;

    // 1. バックアップ本体を先に保存する
    fs::create_dir_all(backup_dir(root_path))
        .map_err(|e| format!("バックアップ用フォルダの作成に失敗しました: {e}"))?;
    let id = generate_backup_id();
    let backup_file = backup_dir(root_path).join(format!("{id}.bak"));
    fs::write(&backup_file, &applied.original_content)
        .map_err(|e| format!("バックアップの作成に失敗しました: {e}"))?;

    // 2. バックアップが保存できてから、対応関係をマニフェストに記録する
    let mut entries = read_manifest(root_path)?;
    entries.push(BackupEntry {
        id: id.clone(),
        relative_path: relative_path.clone(),
        created_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
    });
    // 同一ファイルのバックアップが溜まり続けないよう、上限を超えた古いものを削除する
    prune_backups_for_path(root_path, &mut entries, &relative_path);
    write_manifest(root_path, &entries)?;

    // 3. バックアップとマニフェストの両方が確定してから、実ファイルを書き換える
    write_atomically(&applied.resolved_path, &applied.new_content)?;

    Ok(ApplyFixResult {
        backup_id: id,
        applied_path: applied.resolved_path.to_string_lossy().to_string(),
    })
}

/// `.debug-buddy-backups` ディレクトリ（バックアップ本体・マニフェストの両方）を
/// まるごと削除する。自動プルーニング（`MAX_BACKUPS_PER_FILE`）とは別に、
/// ユーザーが明示的にディスク容量を整理したい場合のための機能。
/// 適用済みの対象ファイル自体には一切触れない（削除するのはバックアップのみ）。
#[tauri::command]
fn clear_all_backups(root: String) -> Result<(), String> {
    let root_path = Path::new(&root);
    let dir = backup_dir(root_path);
    if dir.exists() {
        fs::remove_dir_all(&dir)
            .map_err(|e| format!("バックアップフォルダの削除に失敗しました: {e}"))?;
    }
    Ok(())
}

/// バックアップ一覧の1件をフロントエンドへ返す形（camelCaseで公開する）。
/// マニフェスト本体の `BackupEntry`（内部ストレージ形式）とは別に定義することで、
/// 既存の manifest.json のフィールド名（snake_case）を変更せずに済ませている。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupListEntry {
    id: String,
    relative_path: String,
    created_at_unix_ms: u128,
}

impl From<&BackupEntry> for BackupListEntry {
    fn from(e: &BackupEntry) -> Self {
        BackupListEntry {
            id: e.id.clone(),
            relative_path: e.relative_path.clone(),
            created_at_unix_ms: e.created_at_unix_ms,
        }
    }
}

/// 指定ファイルに対する過去のバックアップ一覧を、作成日時が新しい順で返す（読み取り専用）。
/// これまで `rollback_fix` は直近1件しか画面から選べなかったため、
/// 任意の世代を選んで戻せるように一覧取得コマンドを追加した。
#[tauri::command]
fn list_backups_for_file(root: String, file_path: String) -> Result<Vec<BackupListEntry>, String> {
    let root_path = Path::new(&root);

    // check_fix_applicability / apply_fix と同じ経路でパスを安全に解決することで、
    // 相対パス/絶対パス・大文字小文字・スラッシュの向きなどの表記ゆれを吸収する
    let resolved = resolve_within_root(root_path, &file_path)
        .map_err(|reason| format!("対象ファイルの安全確認に失敗しました ({})", reason.as_str()))?;
    let relative_path = relative_path_string(root_path, &resolved)?;

    let entries = read_manifest(root_path)?;
    let mut matched: Vec<BackupListEntry> = entries
        .iter()
        .filter(|e| e.relative_path == relative_path)
        .map(BackupListEntry::from)
        .collect();
    // manifestには常に作成順（古い→新しい）で追記されるため、単純に反転すれば新しい順になる。
    // created_at_unix_ms(ミリ秒)でのソートは、高速なテスト実行等で複数件が同一ミリ秒に
    // なり得ることを考えると不安定なため、挿入順の反転による決定的な方法をあえて採る。
    matched.reverse();
    Ok(matched)
}

/// `apply_fix` が作成したバックアップから、対象ファイルの内容を復元する。
/// バックアップファイル自体は削除しない（監査証跡・多重ロールバックの安全のため）。
#[tauri::command]
fn rollback_fix(root: String, backup_id: String) -> Result<(), String> {
    let root_path = Path::new(&root);

    let entries = read_manifest(root_path)?;
    let entry = entries
        .iter()
        .find(|e| e.id == backup_id)
        .ok_or_else(|| "指定されたバックアップが見つかりません。".to_string())?;

    // ロールバック時も、復元先が今なおプロジェクトルート配下の実ファイルであることを確認する
    let resolved = resolve_within_root(root_path, &entry.relative_path)
        .map_err(|reason| format!("復元先ファイルの安全確認に失敗しました ({})", reason.as_str()))?;

    let backup_file = backup_dir(root_path).join(format!("{backup_id}.bak"));
    let backup_content = fs::read_to_string(&backup_file)
        .map_err(|e| format!("バックアップファイルの読み込みに失敗しました: {e}"))?;

    write_atomically(&resolved, &backup_content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// 外部クレートを追加しないための、最小限の使い捨てテスト用ディレクトリ。
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!(
                "debug-buddy-lib-test-{}-{}",
                std::process::id(),
                n
            ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn apply_fix_then_rollback_restores_original_content() {
        let tmp = TempDir::new();
        let root = tmp.0.to_string_lossy().to_string();
        fs::write(tmp.0.join("sample.py"), "line1\nold_value\nline3\n").unwrap();
        let diff = "@@ -1,3 +1,3 @@\nline1\n-old_value\n+new_value\nline3\n".to_string();

        // 手動検証(DevToolsコンソール)で実際に踏んだ回帰: root文字列とcanonicalize後のパスの
        // 表記が食い違って相対パス計算が失敗するバグがあった。ここで固定して再発を防ぐ。
        let applied = apply_fix(root.clone(), "sample.py".to_string(), diff).unwrap();
        assert_eq!(
            fs::read_to_string(tmp.0.join("sample.py")).unwrap(),
            "line1\nnew_value\nline3\n"
        );

        rollback_fix(root, applied.backup_id).unwrap();
        assert_eq!(
            fs::read_to_string(tmp.0.join("sample.py")).unwrap(),
            "line1\nold_value\nline3\n"
        );
    }

    #[test]
    fn prune_backups_for_path_keeps_only_newest_entries_and_deletes_old_bak_files() {
        let tmp = TempDir::new();
        fs::create_dir_all(backup_dir(&tmp.0)).unwrap();

        let total = MAX_BACKUPS_PER_FILE + 5;
        let mut entries: Vec<BackupEntry> = (0..total)
            .map(|i| {
                let id = format!("id-{i}");
                fs::write(backup_dir(&tmp.0).join(format!("{id}.bak")), "dummy").unwrap();
                BackupEntry {
                    id,
                    relative_path: "app.py".to_string(),
                    created_at_unix_ms: i as u128,
                }
            })
            .collect();

        prune_backups_for_path(&tmp.0, &mut entries, "app.py");

        assert_eq!(entries.len(), MAX_BACKUPS_PER_FILE);
        // 残っているのは新しい(created_at_unix_msが大きい)ものだけ
        assert!(entries.iter().all(|e| e.created_at_unix_ms >= 5));
        // 削除されたはずの古いバックアップ本体はディスク上からも消えている
        for i in 0..5 {
            assert!(!backup_dir(&tmp.0).join(format!("id-{i}.bak")).exists());
        }
        // 残っているはずの新しいバックアップ本体はディスク上に残っている
        for i in 5..total {
            assert!(backup_dir(&tmp.0).join(format!("id-{i}.bak")).exists());
        }
    }

    #[test]
    fn prune_backups_for_path_does_not_touch_other_files() {
        let tmp = TempDir::new();
        fs::create_dir_all(backup_dir(&tmp.0)).unwrap();

        let mut entries: Vec<BackupEntry> = (0..(MAX_BACKUPS_PER_FILE + 3))
            .map(|i| BackupEntry {
                id: format!("a-{i}"),
                relative_path: "a.py".to_string(),
                created_at_unix_ms: i as u128,
            })
            .collect();
        entries.push(BackupEntry {
            id: "b-only".to_string(),
            relative_path: "b.py".to_string(),
            created_at_unix_ms: 0,
        });

        prune_backups_for_path(&tmp.0, &mut entries, "a.py");

        // 別ファイル(b.py)のエントリはプルーニング対象にならない
        assert!(entries.iter().any(|e| e.relative_path == "b.py"));
        assert_eq!(
            entries.iter().filter(|e| e.relative_path == "a.py").count(),
            MAX_BACKUPS_PER_FILE
        );
    }

    #[test]
    fn clear_all_backups_removes_backup_directory_entirely() {
        let tmp = TempDir::new();
        let root = tmp.0.to_string_lossy().to_string();
        fs::write(tmp.0.join("sample.py"), "line1\nold_value\nline3\n").unwrap();
        let diff = "@@ -1,3 +1,3 @@\nline1\n-old_value\n+new_value\nline3\n".to_string();
        apply_fix(root.clone(), "sample.py".to_string(), diff).unwrap();
        assert!(backup_dir(&tmp.0).exists());

        clear_all_backups(root).unwrap();

        assert!(!backup_dir(&tmp.0).exists());
        // 適用済みの対象ファイル自体は削除されない
        assert_eq!(
            fs::read_to_string(tmp.0.join("sample.py")).unwrap(),
            "line1\nnew_value\nline3\n"
        );
    }

    #[test]
    fn clear_all_backups_is_a_no_op_when_no_backups_exist_yet() {
        let tmp = TempDir::new();
        let root = tmp.0.to_string_lossy().to_string();

        clear_all_backups(root).unwrap();

        assert!(!backup_dir(&tmp.0).exists());
    }

    #[test]
    fn list_backups_for_file_returns_matching_entries_newest_first() {
        let tmp = TempDir::new();
        let root = tmp.0.to_string_lossy().to_string();
        fs::write(tmp.0.join("sample.py"), "line1\nold_value\nline3\n").unwrap();
        fs::write(tmp.0.join("other.py"), "a\n").unwrap();

        let diff1 = "@@ -1,3 +1,3 @@\nline1\n-old_value\n+new_value\nline3\n".to_string();
        let applied1 = apply_fix(root.clone(), "sample.py".to_string(), diff1).unwrap();

        let diff2 = "@@ -1,3 +1,3 @@\nline1\n-new_value\n+newer_value\nline3\n".to_string();
        let applied2 = apply_fix(root.clone(), "sample.py".to_string(), diff2).unwrap();

        let list = list_backups_for_file(root, "sample.py".to_string()).unwrap();

        assert_eq!(list.len(), 2);
        // 新しい順（2回目に作られたバックアップが先頭）
        assert_eq!(list[0].id, applied2.backup_id);
        assert_eq!(list[1].id, applied1.backup_id);
        assert!(list.iter().all(|e| e.relative_path == "sample.py"));
    }

    #[test]
    fn list_backups_for_file_returns_empty_when_no_backups_exist_for_that_file() {
        let tmp = TempDir::new();
        let root = tmp.0.to_string_lossy().to_string();
        fs::write(tmp.0.join("untouched.py"), "a\n").unwrap();

        let list = list_backups_for_file(root, "untouched.py".to_string()).unwrap();

        assert!(list.is_empty());
    }

    #[test]
    fn apply_fix_refuses_and_writes_nothing_when_diff_does_not_match() {
        let tmp = TempDir::new();
        let root = tmp.0.to_string_lossy().to_string();
        fs::write(tmp.0.join("mismatch.py"), "line1\nreal_content\nline3\n").unwrap();
        let diff = "@@ -1,3 +1,3 @@\nline1\n-old_value\n+new_value\nline3\n".to_string();

        let err = apply_fix(root, "mismatch.py".to_string(), diff).unwrap_err();

        assert!(err.contains("diff-no-match"));
        assert_eq!(
            fs::read_to_string(tmp.0.join("mismatch.py")).unwrap(),
            "line1\nreal_content\nline3\n",
            "適用不可のケースではファイルが一切変更されてはいけない"
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            save_api_key,
            load_api_key,
            pick_project_root,
            export_text_file,
            check_fix_applicability,
            apply_fix,
            rollback_fix,
            clear_all_backups,
            list_backups_for_file,
            git_status::check_git_dirty,
            terminal_watch::start_terminal_watch,
            terminal_watch::stop_terminal_watch
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // アプリ終了時にターミナル監視モードのプロセスが残らないよう後始末する
            if let tauri::RunEvent::ExitRequested { .. } = event {
                terminal_watch::kill_if_running();
            }
        });
}
