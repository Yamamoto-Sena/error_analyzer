// 修正案(diff)を実ファイルへ安全に適用するための純粋ロジック（判定・パッチ計算のみ）。
mod fix_apply;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use fix_apply::{compute_fix, resolve_within_root};
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

/// プロジェクトフォルダをネイティブのダイアログで選ばせる。
/// フロントエンドはJS版の `@tauri-apps/plugin-dialog` を一切呼ばず、この専用コマンドだけを使う
/// （フロントエンドに公開する操作を「フォルダを選ぶ」の1つだけに絞るための設計）。
#[tauri::command]
fn pick_project_root(app: tauri::AppHandle) -> Option<String> {
    let picked = app.dialog().file().blocking_pick_folder()?;
    let path = picked.into_path().ok()?;
    fs::canonicalize(&path)
        .ok()
        .map(|p| p.to_string_lossy().to_string())
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
        relative_path,
        created_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
    });
    write_manifest(root_path, &entries)?;

    // 3. バックアップとマニフェストの両方が確定してから、実ファイルを書き換える
    write_atomically(&applied.resolved_path, &applied.new_content)?;

    Ok(ApplyFixResult {
        backup_id: id,
        applied_path: applied.resolved_path.to_string_lossy().to_string(),
    })
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
            pick_project_root,
            check_fix_applicability,
            apply_fix,
            rollback_fix
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
