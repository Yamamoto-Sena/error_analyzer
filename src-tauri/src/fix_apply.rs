//! 修正案(diff)を実ファイルに安全に適用できるか判定し、実際に適用するための
//! 純粋なロジック（ファイルI/Oはあるが、Tauriの実行時・コマンド機構には一切依存しない）。
//!
//! ここではまだ Tauri コマンドとしての公開（フロントエンドからの呼び出し）は行わない。
//! ロジック単体の正しさを `cargo test` で検証することが、このファイルの唯一の目的。
//! フロントエンドとの接続（invoke経由の呼び出し）は別ステップで `lib.rs` 側に追加する。
//!
//! NOTE: 現時点ではどこからも呼ばれていないため `dead_code` 警告が出る。
//! Step 2でTauriコマンドとして接続したら、この抑制は不要になるので削除する。
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};

/// なぜ自動適用できないのか。フロントエンドにそのまま文言のヒントとして渡す想定。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnapplicableReason {
    /// プロジェクトルート自体が存在しない・アクセスできない
    RootNotFound,
    /// 解決したパスがプロジェクトルートの外に出てしまう（パストラバーサル等）
    PathEscapesRoot,
    /// 対象ファイルが実在しない
    FileNotFound,
    /// 対象パスがファイルではない（ディレクトリ等）
    NotAFile,
    /// diffの少なくとも1つのハンクが、ファイルの内容と一致する箇所を持たない
    DiffNoMatch,
    /// diffのハンクが複数箇所にマッチしてしまい、一意に特定できない
    DiffAmbiguousMatch,
    /// 有効なハンクが1つも無い（空diff、または全ハンクが純粋な挿入でアンカーが無い等）
    NoHunks,
}

impl UnapplicableReason {
    /// フロントエンドに渡す安定した識別子（JSON化して使う）
    pub fn as_str(&self) -> &'static str {
        match self {
            UnapplicableReason::RootNotFound => "root-not-found",
            UnapplicableReason::PathEscapesRoot => "path-escapes-root",
            UnapplicableReason::FileNotFound => "file-not-found",
            UnapplicableReason::NotAFile => "not-a-file",
            UnapplicableReason::DiffNoMatch => "diff-no-match",
            UnapplicableReason::DiffAmbiguousMatch => "diff-ambiguous-match",
            UnapplicableReason::NoHunks => "no-hunks",
        }
    }
}

/// `file_path`（ログ解析やLLM出力に由来する、実在保証のない文字列）を
/// `root`（ユーザーが明示的に選んだプロジェクトフォルダ）を基準に安全に解決する。
///
/// - `file_path` が相対パスなら `root` に結合、絶対パスならそのまま扱う
/// - 実際に存在するパスのみ許可する（`canonicalize` はシンボリックリンクも解決するため、
///   リンク経由で `root` の外に出ようとするケースも弾ける）
/// - 正規化後のパスが `root` 配下に収まっていない場合は拒否する
/// - 対象がファイルではない（ディレクトリ等）場合も拒否する
pub fn resolve_within_root(root: &Path, file_path: &str) -> Result<PathBuf, UnapplicableReason> {
    let root_canon = fs::canonicalize(root).map_err(|_| UnapplicableReason::RootNotFound)?;

    let candidate = Path::new(file_path);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root_canon.join(candidate)
    };

    let joined_canon = fs::canonicalize(&joined).map_err(|_| UnapplicableReason::FileNotFound)?;

    if !joined_canon.starts_with(&root_canon) {
        return Err(UnapplicableReason::PathEscapesRoot);
    }

    if !joined_canon.is_file() {
        return Err(UnapplicableReason::NotAFile);
    }

    Ok(joined_canon)
}

/// Unified Diff の1ハンク分。前後の行番号やコンテキスト長は保持せず、
/// 「マッチさせるべき旧内容の行列」と「置き換え後の行列」だけを持つ、
/// 適用ロジックに必要な最小限の形。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    /// マッチ対象（コンテキスト行 + 削除される行）
    pub old_lines: Vec<String>,
    /// 置き換え後の内容（コンテキスト行 + 追加される行）
    pub new_lines: Vec<String>,
}

/// アプリ内で生成されるdiff文字列（LLM出力・ローカル解析どちらも含む、緩い形式の
/// Unified Diff風テキスト）からハンクを抽出する。
///
/// 前提とする緩さ:
/// - `--- a/...` / `+++ b/...` のファイルヘッダ行は無視する
///   （ファイルの対応付けは呼び出し側が `root` + `file_path` で別途行うため、
///   ヘッダの文字列が実際のパスと一致している保証は無い）
/// - コンテキスト行は本来 `半角スペース` で始まるべきだが、このアプリが生成する
///   diffは省略していることが多いため、`+`/`-`/`@@`/`---`/`+++` のどれでもない行は
///   すべてコンテキスト行として扱う
/// - `@@ ... @@` より前に出てくる行（コメント等）は無視する
pub fn parse_hunks(diff_code: &str) -> Vec<Hunk> {
    let mut hunks = Vec::new();
    let mut current: Option<Hunk> = None;

    for raw_line in diff_code.lines() {
        if raw_line.starts_with("---") || raw_line.starts_with("+++") {
            continue;
        }
        if raw_line.starts_with("@@") {
            if let Some(h) = current.take() {
                hunks.push(h);
            }
            current = Some(Hunk {
                old_lines: Vec::new(),
                new_lines: Vec::new(),
            });
            continue;
        }

        let Some(hunk) = current.as_mut() else {
            // @@ より前の行(見出しコメント等)はハンク未開始として無視する
            continue;
        };

        if let Some(rest) = raw_line.strip_prefix('+') {
            hunk.new_lines.push(rest.to_string());
        } else if let Some(rest) = raw_line.strip_prefix('-') {
            hunk.old_lines.push(rest.to_string());
        } else {
            let rest = raw_line.strip_prefix(' ').unwrap_or(raw_line);
            hunk.old_lines.push(rest.to_string());
            hunk.new_lines.push(rest.to_string());
        }
    }
    if let Some(h) = current.take() {
        hunks.push(h);
    }

    hunks
}

/// `file_lines` の中から `hunk.old_lines` と完全一致する連続範囲を探す。
/// 一致が無ければ `DiffNoMatch`、2箇所以上あれば `DiffAmbiguousMatch`、
/// アンカーとなる行が1つも無いハンク（純粋な挿入）は安全に位置決めできないため `NoHunks`。
pub fn locate_hunk(file_lines: &[String], hunk: &Hunk) -> Result<usize, UnapplicableReason> {
    if hunk.old_lines.is_empty() {
        return Err(UnapplicableReason::NoHunks);
    }

    let n = hunk.old_lines.len();
    if file_lines.len() < n {
        return Err(UnapplicableReason::DiffNoMatch);
    }

    let mut found: Option<usize> = None;
    for start in 0..=(file_lines.len() - n) {
        if file_lines[start..start + n] == hunk.old_lines[..] {
            if found.is_some() {
                return Err(UnapplicableReason::DiffAmbiguousMatch);
            }
            found = Some(start);
        }
    }

    found.ok_or(UnapplicableReason::DiffNoMatch)
}

/// 元のテキストにdiffのハンク群を適用し、新しいテキストを返す。
///
/// 安全設計の要:
/// - **all-or-nothing**: 全ハンクの位置が一意に確定した場合のみ書き換えを行う。
///   1つでも「見つからない」「複数箇所に一致する」ハンクがあれば、何も変更せずエラーで返す
///   （中途半端な適用はしない）
/// - ハンク同士が重なり合う場合も安全側に倒してエラーとする
/// - 元のファイルの改行コード（CRLF/LF）と末尾改行の有無を検出し、そのまま維持する
///   （不要な改行コードの一括変換によるノイズ差分を防ぐ）
pub fn apply_hunks_to_text(original: &str, hunks: &[Hunk]) -> Result<String, UnapplicableReason> {
    if hunks.is_empty() {
        return Err(UnapplicableReason::NoHunks);
    }

    let uses_crlf = original.contains("\r\n");
    let newline = if uses_crlf { "\r\n" } else { "\n" };
    let trailing_newline = original.ends_with('\n');

    let file_lines: Vec<String> = original.lines().map(|l| l.to_string()).collect();

    let mut located: Vec<(usize, usize, &Hunk)> = Vec::with_capacity(hunks.len());
    for hunk in hunks {
        let start = locate_hunk(&file_lines, hunk)?;
        located.push((start, hunk.old_lines.len(), hunk));
    }
    located.sort_by_key(|&(start, _, _)| start);

    for pair in located.windows(2) {
        let (s0, l0, _) = pair[0];
        let (s1, _, _) = pair[1];
        if s0 + l0 > s1 {
            return Err(UnapplicableReason::DiffAmbiguousMatch);
        }
    }

    let mut result: Vec<String> = Vec::new();
    let mut cursor = 0usize;
    for (start, len, hunk) in &located {
        result.extend_from_slice(&file_lines[cursor..*start]);
        result.extend(hunk.new_lines.iter().cloned());
        cursor = start + len;
    }
    result.extend_from_slice(&file_lines[cursor..]);

    let mut new_text = result.join(newline);
    if trailing_newline {
        new_text.push_str(newline);
    }
    Ok(new_text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// 外部クレート(tempfile等)を追加しないための、最小限の使い捨てテスト用ディレクトリ。
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!(
                "debug-buddy-fix-apply-test-{}-{}",
                std::process::id(),
                n
            ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn resolves_relative_path_within_root() {
        let tmp = TempDir::new();
        fs::write(tmp.path().join("a.txt"), "hello").unwrap();

        let resolved = resolve_within_root(tmp.path(), "a.txt").unwrap();

        assert_eq!(resolved, fs::canonicalize(tmp.path().join("a.txt")).unwrap());
    }

    #[test]
    fn rejects_path_traversal_outside_root() {
        let tmp = TempDir::new();
        let inner = tmp.path().join("inner");
        fs::create_dir_all(&inner).unwrap();
        fs::write(tmp.path().join("outside.txt"), "secret").unwrap();

        let err = resolve_within_root(&inner, "../outside.txt").unwrap_err();

        assert_eq!(err, UnapplicableReason::PathEscapesRoot);
    }

    #[test]
    fn rejects_missing_file() {
        let tmp = TempDir::new();

        let err = resolve_within_root(tmp.path(), "nope.txt").unwrap_err();

        assert_eq!(err, UnapplicableReason::FileNotFound);
    }

    #[test]
    fn rejects_directory_as_target() {
        let tmp = TempDir::new();
        fs::create_dir_all(tmp.path().join("subdir")).unwrap();

        let err = resolve_within_root(tmp.path(), "subdir").unwrap_err();

        assert_eq!(err, UnapplicableReason::NotAFile);
    }

    #[test]
    fn applies_single_matching_hunk() {
        let original = "line1\nold_a\nold_b\nline4\n";
        // アプリが実際に生成するdiffと同じ緩い形式（コンテキスト行に空白プレフィックス無し）
        let diff = "--- a/f.txt\n+++ b/f.txt\n@@ -1,4 +1,4 @@\nline1\n-old_a\n-old_b\n+new_a\nline4\n";

        let hunks = parse_hunks(diff);
        let applied = apply_hunks_to_text(original, &hunks).unwrap();

        assert_eq!(applied, "line1\nnew_a\nline4\n");
    }

    #[test]
    fn refuses_when_old_lines_dont_match_file() {
        let original = "line1\nactual_code\nline3\n";
        let diff = "@@ -1,3 +1,3 @@\n-different_code\n+patched\n";

        let hunks = parse_hunks(diff);
        let err = apply_hunks_to_text(original, &hunks).unwrap_err();

        assert_eq!(err, UnapplicableReason::DiffNoMatch);
    }

    #[test]
    fn refuses_when_old_lines_match_ambiguously() {
        let original = "dup\ndup\n";
        let diff = "@@ -1,1 +1,1 @@\n-dup\n+patched\n";

        let hunks = parse_hunks(diff);
        let err = apply_hunks_to_text(original, &hunks).unwrap_err();

        assert_eq!(err, UnapplicableReason::DiffAmbiguousMatch);
    }

    #[test]
    fn refuses_pure_insertion_hunk_with_no_anchor() {
        // old_linesが空(全て追加行)のハンクは、安全に挿入位置を特定できないため拒否する
        let diff = "@@ -1,0 +1,1 @@\n+brand_new_line\n";

        let hunks = parse_hunks(diff);
        let err = apply_hunks_to_text("line1\nline2\n", &hunks).unwrap_err();

        assert_eq!(err, UnapplicableReason::NoHunks);
    }

    #[test]
    fn preserves_crlf_and_trailing_newline_style() {
        let original = "a\r\nold\r\nb\r\n";
        let diff = "@@ -1,3 +1,3 @@\na\n-old\n+new\nb\n";

        let hunks = parse_hunks(diff);
        let applied = apply_hunks_to_text(original, &hunks).unwrap();

        assert_eq!(applied, "a\r\nnew\r\nb\r\n");
    }
}
