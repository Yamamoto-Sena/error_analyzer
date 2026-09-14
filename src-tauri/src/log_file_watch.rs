//! 指定したログファイルへの追記をポーリングで検知し、新しい行をフロントエンドへ配信する
//! 「ログファイル監視モード」（試験的機能）。
//!
//! 設計方針:
//! - ターミナル監視(terminal_watch.rs)・クリップボード監視(clipboard_watch.rs)と同じく、
//!   「どの行をエラーらしいと見なすか」の判定はフロントエンド（analyzer.tsの
//!   `looksLikeErrorText`）に委ね、Rust側は生ログの配信に徹する。
//! - 監視対象はファイルであり、クリップボード監視と同様に「killすれば自然に終了する
//!   子プロセス」のような対象が存在しないため、停止は`Arc<AtomicBool>`の停止フラグを
//!   ポーリングループ側で確認する方式にしている（terminal_watch.rsの`Child::kill()`方式は
//!   使えない）。
//! - ローテーション（ファイルの入れ替わり・切り詰め）対応には、OS標準のファイル識別子API
//!   （Windows: creation_time、Unix: ino）のみを使う。既存2機能とも外部クレートを増やさない
//!   方針を踏襲し、`notify`クレート等の新規依存は追加しない。
//! - 監視開始時点のファイルサイズを基準（tail -f相当）にし、既存の内容は読み飛ばす
//!   （巨大な既存ログをいきなり全件流し込まないため。クリップボード監視が起動時の内容を
//!   「初期値」として無視するのと同じ考え方）。
//! - 1ティックごとに`File::open`→seek→読み取り→クローズという短命ハンドルにする
//!   （ハンドルを保持し続けると、外部のログローテーションツールによるリネーム/削除の
//!   妨げになりうるため）。
//!
//! 既知の制約: ポーリング方式であるため、1ポーリング間隔(POLL_INTERVAL)の間に複数回
//! ローテーションが起きた場合は検知漏れがありうる（terminal_watch.rsの「Windowsでは
//! プロセスツリーを完全にはkillしきれない場合がある」という既知の制約表明と同じ位置づけ）。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::encoding_util::decode_bytes;

/// ログファイルを確認する間隔。ファイルI/O(metadata+open+read)はクリップボード読み取りより
/// コストが高く、またログ監視はクリップボード監視ほどの即時性を要求しない（ユーザーが
/// 数秒待てる用途）ため、clipboard_watch.rsの800msより長めの1000msにしている。
const POLL_INTERVAL: Duration = Duration::from_millis(1000);

struct LogFileWatchHandle {
    stop_flag: Arc<AtomicBool>,
}

fn watch_state() -> &'static Mutex<Option<LogFileWatchHandle>> {
    static STATE: OnceLock<Mutex<Option<LogFileWatchHandle>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

#[derive(Clone, serde::Serialize)]
struct LogFileLinePayload {
    line: String,
}

/// ファイルの「実体識別子」。ローテーション（リネーム+新規作成や、別ファイルへの差し替え）を
/// 検知するために使う。取得できない場合はNone（呼び出し側でサイズ縮小のみのフォールバック
/// 判定に回す）。
///
/// Windowsでは本来ファイルシステム上の一意なID（file_index）が理想だが、std上でそれを
/// 取得するAPI(`MetadataExt::file_index`)は現時点で unstable feature
/// (`windows_by_handle`) の後ろにあり、安定版コンパイラでは使えない。代わりに同じく
/// `MetadataExt`が提供する安定版API`creation_time()`（ファイル作成時刻）を使う。
/// ログローテーションで「リネーム→新規作成」が起きた場合、新しいファイルの作成時刻は
/// 元のファイルと異なるため、実用上は同様にローテーション検知の目的を果たせる。
#[cfg(windows)]
fn file_identity(path: &Path) -> Option<u64> {
    use std::os::windows::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|m| m.creation_time())
}
#[cfg(unix)]
fn file_identity(path: &Path) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|m| m.ino())
}
#[cfg(not(any(windows, unix)))]
fn file_identity(_path: &Path) -> Option<u64> {
    None
}

/// ローテーション判定の結果。
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum RotationAction {
    /// 通常通り、前回位置からの続き読みでよい
    Continue,
    /// ファイルが入れ替わった/縮んだとみなし、先頭から読み直す（オフセットを0にする）
    ResetToStart,
}

/// 純粋関数として切り出す（ファイルI/Oを伴わないため cargo test で直接検証できる）。
fn detect_rotation(
    prev_identity: Option<u64>,
    prev_size: u64,
    cur_identity: Option<u64>,
    cur_size: u64,
) -> RotationAction {
    if let (Some(prev), Some(cur)) = (prev_identity, cur_identity) {
        if prev != cur {
            return RotationAction::ResetToStart;
        }
    }
    if cur_size < prev_size {
        return RotationAction::ResetToStart;
    }
    RotationAction::Continue
}

/// 新しく読めたバイト列をデコードした文字列(decoded_chunk)を、前回までの未確定な末尾断片
/// (pending)と結合し、完成した行だけを取り出す。改行で終わらない末尾はpendingとして
/// 次回に持ち越す。ファイルI/O・スレッドから独立した純粋関数としてテストできるようにしている。
fn extract_complete_lines(pending: &mut String, decoded_chunk: &str) -> Vec<String> {
    pending.push_str(decoded_chunk);
    let mut lines: Vec<String> = pending
        .split('\n')
        .map(|s| s.trim_end_matches('\r').to_string())
        .collect();
    // 最後の要素は「まだ改行が来ていない断片」なので、次回に持ち越すためpendingに戻す
    let last = lines.pop().unwrap_or_default();
    *pending = last;
    lines
}

/// ログファイルの追記監視を開始する。
///
/// 対象ファイルが監視開始時点で存在しない場合は即エラーとする（後から出現するログを
/// 待つモードは今回のスコープ外）。開始時点のファイルサイズを基準にし、既存の内容は
/// 読み飛ばす（tail -f相当）。
#[tauri::command]
pub fn start_log_file_watch(app: AppHandle, path: String) -> Result<(), String> {
    let file_path = PathBuf::from(&path);
    if !file_path.is_file() {
        return Err(format!("指定されたファイルが見つかりません: {path}"));
    }

    let mut guard = watch_state()
        .lock()
        .map_err(|_| "内部エラー: 監視状態のロックに失敗しました。".to_string())?;
    if guard.is_some() {
        return Err("既に別のログファイルを監視中です。先に停止してください。".to_string());
    }

    let initial_size = std::fs::metadata(&file_path).map(|m| m.len()).unwrap_or(0);
    let initial_identity = file_identity(&file_path);
    eprintln!(
        "[log_file_watch] 監視を開始します: {} (開始時点のサイズ: {}バイト、既存内容は読み飛ばします)",
        file_path.display(),
        initial_size
    );

    let stop_flag = Arc::new(AtomicBool::new(false));
    *guard = Some(LogFileWatchHandle {
        stop_flag: stop_flag.clone(),
    });
    drop(guard);

    std::thread::spawn(move || {
        let mut last_offset = initial_size;
        let mut last_size = initial_size;
        let mut last_identity = initial_identity;
        let mut pending = String::new();
        // 同じ内容のエラーを連続でログに出し続けてターミナルが埋まらないよう、
        // 直前に出力したエラーメッセージを覚えておき、変化があった時だけ再出力する
        // （clipboard_watch.rsと同じ配慮）。
        let mut last_logged_error: Option<String> = None;

        loop {
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(POLL_INTERVAL);
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }

            let metadata = match std::fs::metadata(&file_path) {
                Ok(m) => m,
                Err(e) => {
                    // ファイルが一時的にロックされている・削除された等の理由で読み取れない
                    // ことがあるが、監視自体を止める必要はないため、そのティックはスキップして
                    // 次回に回す（clipboard_watch.rsの「読み取り失敗時はそのティックをスキップ」
                    // という、ベストエフォートの方針を踏襲）。
                    let message = e.to_string();
                    if last_logged_error.as_deref() != Some(message.as_str()) {
                        eprintln!("[log_file_watch] ファイルの読み取りに失敗しました: {message}");
                        last_logged_error = Some(message);
                    }
                    continue;
                }
            };
            last_logged_error = None;

            let cur_size = metadata.len();
            let cur_identity = file_identity(&file_path);

            match detect_rotation(last_identity, last_size, cur_identity, cur_size) {
                RotationAction::ResetToStart => {
                    eprintln!(
                        "[log_file_watch] ログファイルのローテーションを検知しました。先頭から読み直します: {}",
                        file_path.display()
                    );
                    last_offset = 0;
                    pending.clear();
                }
                RotationAction::Continue => {}
            }

            if cur_size <= last_offset {
                last_size = cur_size;
                last_identity = cur_identity;
                continue;
            }

            let mut file = match File::open(&file_path) {
                Ok(f) => f,
                Err(_) => {
                    last_size = cur_size;
                    last_identity = cur_identity;
                    continue;
                }
            };
            if file.seek(SeekFrom::Start(last_offset)).is_err() {
                last_size = cur_size;
                last_identity = cur_identity;
                continue;
            }

            let mut buf = Vec::new();
            let read_bytes = match file.read_to_end(&mut buf) {
                Ok(n) => n,
                Err(_) => 0,
            };
            if read_bytes > 0 {
                let decoded = decode_bytes(&buf);
                for line in extract_complete_lines(&mut pending, &decoded) {
                    let _ = app.emit("log-file-output", LogFileLinePayload { line });
                }
                last_offset += read_bytes as u64;
            }
            last_size = cur_size;
            last_identity = cur_identity;
        }
    });

    Ok(())
}

/// ログファイル監視を停止する。既に停止している場合は何もしない。
///
/// clipboard_watch.rsと同様、停止フラグを立てるだけで即座に返る（監視スレッドは次の
/// ポーリングタイミングで自然に終了する。最大でも`POLL_INTERVAL`程度の遅延はある）。
#[tauri::command]
pub fn stop_log_file_watch() -> Result<(), String> {
    let mut guard = watch_state()
        .lock()
        .map_err(|_| "内部エラー: 監視状態のロックに失敗しました。".to_string())?;
    if let Some(handle) = guard.take() {
        handle.stop_flag.store(true, Ordering::Relaxed);
        eprintln!("[log_file_watch] 監視を停止しました");
    }
    Ok(())
}

/// 現在ログファイル監視が実行中かどうかを返す。画面を開き直した際にRust側の実際の状態を
/// 問い合わせ、表示を補正するために使う（clipboard_watch.rsの`is_clipboard_watch_running`
/// と同じ役割）。
#[tauri::command]
pub fn is_log_file_watch_running() -> bool {
    watch_state().lock().map(|g| g.is_some()).unwrap_or(false)
}

/// アプリ終了時に監視スレッドが残らないよう、ベストエフォートで後始末する。
pub fn stop_if_running() {
    if let Ok(mut guard) = watch_state().lock() {
        if let Some(handle) = guard.take() {
            handle.stop_flag.store(true, Ordering::Relaxed);
        }
    }
}

/// 監視するログファイルをネイティブの「ファイルを開く」ダイアログで選ばせる。
/// `pick_project_root`の`blocking_pick_folder()`と対をなす、ファイル選択版。
#[tauri::command]
pub fn pick_log_file(app: AppHandle) -> Option<String> {
    // ダイアログがメインウィンドウの後ろに隠れて開いてしまい、応答を待ったまま
    // フリーズしたように見える問題を防ぐため、ダイアログを開く前に必ず前面へ出す。
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }

    let picked = app.dialog().file().blocking_pick_file()?;
    let path = picked.into_path().ok()?;
    std::fs::canonicalize(&path)
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_rotation_continues_when_identity_unchanged_and_size_grows() {
        assert_eq!(detect_rotation(Some(1), 100, Some(1), 150), RotationAction::Continue);
    }

    #[test]
    fn detect_rotation_resets_when_identity_changes() {
        assert_eq!(detect_rotation(Some(1), 100, Some(2), 50), RotationAction::ResetToStart);
    }

    #[test]
    fn detect_rotation_resets_when_size_shrinks() {
        assert_eq!(detect_rotation(Some(1), 200, Some(1), 50), RotationAction::ResetToStart);
    }

    #[test]
    fn detect_rotation_falls_back_to_size_check_when_identity_unavailable() {
        // 識別子が取得できない環境では、サイズの増減のみで判定する
        assert_eq!(detect_rotation(None, 100, None, 150), RotationAction::Continue);
        assert_eq!(detect_rotation(None, 100, None, 50), RotationAction::ResetToStart);
    }

    #[test]
    fn detect_rotation_continues_when_size_unchanged() {
        assert_eq!(detect_rotation(Some(1), 100, Some(1), 100), RotationAction::Continue);
    }

    #[test]
    fn extract_complete_lines_returns_lines_and_keeps_trailing_fragment() {
        let mut pending = String::new();
        let lines = extract_complete_lines(&mut pending, "foo\nbar\nbaz-partial");
        assert_eq!(lines, vec!["foo".to_string(), "bar".to_string()]);
        assert_eq!(pending, "baz-partial");
    }

    #[test]
    fn extract_complete_lines_completes_fragment_across_calls() {
        let mut pending = String::new();
        let first = extract_complete_lines(&mut pending, "foo\nbar-part");
        assert_eq!(first, vec!["foo".to_string()]);
        assert_eq!(pending, "bar-part");

        let second = extract_complete_lines(&mut pending, "ial\nbaz\n");
        assert_eq!(second, vec!["bar-partial".to_string(), "baz".to_string()]);
        assert_eq!(pending, "");
    }

    #[test]
    fn extract_complete_lines_strips_trailing_carriage_return() {
        let mut pending = String::new();
        let lines = extract_complete_lines(&mut pending, "foo\r\nbar\r\n");
        assert_eq!(lines, vec!["foo".to_string(), "bar".to_string()]);
    }

    /// 実際のファイル追記を検知できるかの手動実行専用テスト（terminal_watch.rsやり方に倣い、
    /// ファイルI/Oと実時間の待機を伴うため通常の`cargo test`では実行しない）。
    /// 手動で実行する場合は次のコマンドを使う:
    ///   cargo test --package tauri-app -- --ignored tailing_a_growing_file_detects_appended_lines
    #[test]
    #[ignore]
    fn tailing_a_growing_file_detects_appended_lines() {
        use std::io::Write;

        let dir = std::env::temp_dir().join(format!("debug-buddy-log-watch-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("一時ディレクトリの作成に失敗しました");
        let file_path = dir.join("test.log");
        std::fs::write(&file_path, "").expect("初期ファイルの作成に失敗しました");

        let initial_size = std::fs::metadata(&file_path).unwrap().len();
        {
            let mut f = std::fs::OpenOptions::new().append(true).open(&file_path).unwrap();
            writeln!(f, "1行目のログ").unwrap();
            writeln!(f, "2行目のログ").unwrap();
        }

        std::thread::sleep(Duration::from_millis(100));

        let mut file = File::open(&file_path).unwrap();
        file.seek(SeekFrom::Start(initial_size)).unwrap();
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).unwrap();
        let decoded = decode_bytes(&buf);
        let mut pending = String::new();
        let lines = extract_complete_lines(&mut pending, &decoded);

        assert_eq!(lines, vec!["1行目のログ".to_string(), "2行目のログ".to_string()]);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
