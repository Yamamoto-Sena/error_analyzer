//! プロジェクトフォルダのGit作業ツリーに未コミットの変更が残っていないかを判定する。
//! `git` CLIをサブプロセスとして呼び出す薄いラッパー（libgit2等の追加依存は使わない）。
//!
//! あくまで注意喚起のためのベストエフォートな判定であり、判定できない場合
//! （gitが未インストール、対象フォルダがGit管理下にない等）はエラーにはせず
//! 「判定不可（is_git_repo: false）」として扱う。実ファイル適用自体はこれまで通り
//! ブロックしない（既存の.bak自動バックアップが安全網のため、あくまで注意喚起）。

use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDirtyStatus {
    /// このフォルダがGitリポジトリ管理下かどうか（falseなら判定自体ができていない）
    pub is_git_repo: bool,
    /// 未コミットの変更（ステージ済み/未ステージ/未追跡ファイル含む）が存在するか
    pub is_dirty: bool,
    /// `git status --porcelain` が報告したエントリ数（目安表示用）
    pub changed_file_count: usize,
}

#[cfg(windows)]
fn configure_no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW: GUIアプリからサブプロセスを起動した際に、
    // 黒いコンソールウィンドウが一瞬表示されるのを防ぐ
    cmd.creation_flags(0x08000000);
}
#[cfg(not(windows))]
fn configure_no_window(_cmd: &mut Command) {}

/// `git status --porcelain` の出力から判定する（プロセス起動を伴わない純粋関数として
/// 分離し、単体テストしやすくしている）。
fn parse_porcelain_output(output: &str) -> (bool, usize) {
    let count = output.lines().filter(|l| !l.trim().is_empty()).count();
    (count > 0, count)
}

/// 指定フォルダのGit作業ツリーに未コミットの変更があるかを調べる。
/// gitコマンドが無い/対象がGitリポジトリでない等、判定できないケースは
/// `is_git_repo: false, is_dirty: false` を返す（＝呼び出し元は警告不要と判断してよい）。
pub fn check_dirty(root: &Path) -> GitDirtyStatus {
    let not_applicable = GitDirtyStatus {
        is_git_repo: false,
        is_dirty: false,
        changed_file_count: 0,
    };

    let mut cmd = Command::new("git");
    cmd.args(["status", "--porcelain"]).current_dir(root);
    configure_no_window(&mut cmd);

    let output = match cmd.output() {
        Ok(o) => o,
        Err(_) => return not_applicable, // gitコマンド自体が見つからない等
    };

    if !output.status.success() {
        // 典型的には「fatal: not a git repository」（Git管理下ではない）
        return not_applicable;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let (is_dirty, changed_file_count) = parse_porcelain_output(&stdout);

    GitDirtyStatus {
        is_git_repo: true,
        is_dirty,
        changed_file_count,
    }
}

/// 指定フォルダのGit作業ツリーの汚れ具合を判定する（読み取り専用）。
#[tauri::command]
pub fn check_git_dirty(root: String) -> GitDirtyStatus {
    check_dirty(Path::new(&root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_porcelain_output_counts_nonempty_lines() {
        let output = " M src/App.tsx\n?? new_file.rs\n";
        let (is_dirty, count) = parse_porcelain_output(output);
        assert!(is_dirty);
        assert_eq!(count, 2);
    }

    #[test]
    fn parse_porcelain_output_empty_is_clean() {
        let (is_dirty, count) = parse_porcelain_output("");
        assert!(!is_dirty);
        assert_eq!(count, 0);
    }

    #[test]
    fn check_dirty_on_non_git_folder_is_not_applicable() {
        // Git管理外の一時フォルダで確認する（判定不可 = 警告不要、という安全側の挙動）
        let dir = std::env::temp_dir().join(format!("debug-buddy-git-status-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let status = check_dirty(&dir);

        assert!(!status.is_git_repo);
        assert!(!status.is_dirty);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
