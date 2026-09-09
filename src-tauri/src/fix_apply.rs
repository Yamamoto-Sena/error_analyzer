//! 修正案(diff)を実ファイルに安全に適用できるか判定し、実際に適用するための
//! 純粋なロジック（ファイルI/Oはあるが、Tauriの実行時・コマンド機構には一切依存しない）。
//!
//! ここでは Tauri コマンドとしての公開（`#[tauri::command]`）は行わない。
//! バックアップの作成・ダイアログ表示などTauri固有の処理は `lib.rs` 側が担い、
//! このファイルは「安全に適用できるか」「適用した結果どうなるか」の計算だけに専念する。

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
            // 標準的なUnified Diff（`diff -u` / `git diff` / Geminiの実際の出力）は
            // 印の直後がそのままコードの内容（本来のインデントを含む）になる。
            // 印の後ろの空白を勝手に1つ取り除くと、本来のインデントを1文字削ってしまい
            // 実ファイルとの照合を誤らせるため、ここでは一切加工しない。
            // (このアプリ自身が生成する側のdiffテンプレートを、この標準形式に合わせている)
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

/// 「安全に適用できるか」の判定と「適用した場合の新しい内容」の計算を1回にまとめた結果。
/// バックアップの作成や実際の書き込みは呼び出し側（`lib.rs`）の責務とする。
#[derive(Debug)]
pub struct AppliedFix {
    /// `root` 配下であることを確認済みの、対象ファイルの正規化された絶対パス
    pub resolved_path: PathBuf,
    /// 適用前の元の内容（バックアップ用）
    pub original_content: String,
    /// 適用後の新しい内容（書き込み用）
    pub new_content: String,
}

/// `resolve_within_root` → ファイル読み込み → `parse_hunks` → `apply_hunks_to_text` を
/// まとめて行う。読み取りのみで、実際のファイル書き込みは行わない
/// （「適用できるかどうかの判定」と「実際に適用する」の両方から共通して呼び出される）。
pub fn compute_fix(
    root: &Path,
    file_path: &str,
    diff_code: &str,
) -> Result<AppliedFix, UnapplicableReason> {
    let resolved_path = resolve_within_root(root, file_path)?;
    let original_content =
        fs::read_to_string(&resolved_path).map_err(|_| UnapplicableReason::FileNotFound)?;
    let hunks = parse_hunks(diff_code);
    let new_content = apply_hunks_to_text(&original_content, &hunks)?;

    Ok(AppliedFix {
        resolved_path,
        original_content,
        new_content,
    })
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

    #[test]
    fn compute_fix_succeeds_end_to_end() {
        let tmp = TempDir::new();
        fs::write(tmp.path().join("app.py"), "line1\nold_value\nline3\n").unwrap();
        let diff = "@@ -1,3 +1,3 @@\nline1\n-old_value\n+new_value\nline3\n";

        let result = compute_fix(tmp.path(), "app.py", diff).unwrap();

        assert_eq!(result.original_content, "line1\nold_value\nline3\n");
        assert_eq!(result.new_content, "line1\nnew_value\nline3\n");
        assert_eq!(
            result.resolved_path,
            fs::canonicalize(tmp.path().join("app.py")).unwrap()
        );
    }

    #[test]
    fn compute_fix_refuses_when_file_content_does_not_match_diff() {
        let tmp = TempDir::new();
        fs::write(tmp.path().join("app.py"), "totally different content\n").unwrap();
        let diff = "@@ -1,1 +1,1 @@\n-old_value\n+new_value\n";

        let err = compute_fix(tmp.path(), "app.py", diff).unwrap_err();

        assert_eq!(err, UnapplicableReason::DiffNoMatch);
    }

    #[test]
    fn matches_standard_diff_style_preserving_real_indentation_exactly() {
        // 標準的なUnified Diff（`diff -u` / `git diff` / Geminiが実際に生成する形式）は
        // 印のすぐ後に本来のインデントを含むコード内容が続く（飾りのスペースは無い）。
        // 印の直後の文字を勝手に取り除いてはいけない（本来の4スペースインデントを
        // 削ってしまうと実ファイルと一致しなくなる）ことを確認する。
        let tmp = TempDir::new();
        fs::write(
            tmp.path().join("demo.js"),
            "function loadUser(user) {\n    return user.name;\n}\n",
        )
        .unwrap();
        let diff =
            "--- a/demo.js\n+++ b/demo.js\n@@ -1,3 +1,3 @@\n function loadUser(user) {\n-    return user.name;\n+    return user?.name;\n }\n";

        let result = compute_fix(tmp.path(), "demo.js", diff).unwrap();

        assert_eq!(
            result.new_content,
            "function loadUser(user) {\n    return user?.name;\n}\n"
        );
    }

    #[test]
    fn matches_this_apps_own_diff_templates_after_removing_the_decorative_space() {
        // src/analyzer.ts のテンプレートは、印の直後に本来のインデントがそのまま続く
        // 標準形式に合わせて書かれている（飾りのスペースは入れない）。
        let tmp = TempDir::new();
        fs::write(
            tmp.path().join("api_controller.py"),
            "def handle_request(request_id):\n    response = get_user_profile(request_id)\n    print(\"User ID: \" + response.user_id)\n",
        )
        .unwrap();
        let diff = "--- a/api_controller.py\n+++ b/api_controller.py\n@@ -3,1 +3,5 @@\n-    print(\"User ID: \" + response.user_id)\n+    if response is not None:\n+        print(\"User ID: \" + str(response.user_id))\n+    else:\n+        print(\"not found\")\n";

        let result = compute_fix(tmp.path(), "api_controller.py", diff).unwrap();

        assert_eq!(
            result.new_content,
            "def handle_request(request_id):\n    response = get_user_profile(request_id)\n    if response is not None:\n        print(\"User ID: \" + str(response.user_id))\n    else:\n        print(\"not found\")\n"
        );
    }
}
