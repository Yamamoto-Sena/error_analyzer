//! 開発コマンド（`npm run dev` 等）をアプリ内から起動し、標準出力/標準エラーを
//! リアルタイムでフロントエンドへイベント配信するための「ターミナル監視モード」。
//!
//! 設計方針:
//! - フロントエンドがコピペしなくても実行中のログをそのまま監視できるようにすることが
//!   目的。「どの出力をエラーらしいと見なすか」のヒューリスティック判定は
//!   analyzer.ts側の判定ロジックと重複させたくないため、Rust側は生ログの配信に徹し、
//!   検知・自動解析の要否判断はフロントエンドに委ねる。
//! - 同時に監視できるプロセスは1つまで（グローバルなMutex<Option<Child>>で管理）。
//! - 既知の制約: Windowsではプロセスツリー（例: npmが起動したnode.exe）を
//!   完全にはkillしきれない場合がある（Job Object等を使えば厳密に実現できるが、
//!   本機能のスコープ外。手動で `taskkill /F /IM node.exe /T` 等が必要になることがある）。

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{AppHandle, Emitter};

use crate::encoding_util::decode_bytes;

fn watch_state() -> &'static Mutex<Option<Child>> {
    static STATE: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

#[derive(Clone, serde::Serialize)]
struct TerminalOutputPayload {
    stream: &'static str,
    line: String,
}

#[derive(Clone, serde::Serialize)]
struct TerminalExitPayload {
    code: Option<i32>,
}

#[cfg(windows)]
fn configure_no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW（黒いコンソール窓の一瞬表示を防ぐ）
}
#[cfg(not(windows))]
fn configure_no_window(_cmd: &mut Command) {}

/// シェル経由でコマンド文字列をそのまま実行する（パイプ・環境変数展開・npm.cmd解決等、
/// シェル依存の挙動をそのまま活かすため。任意コマンド実行はプロジェクトルート選択と同様、
/// ユーザー自身が入力した文字列のみを対象とする=リモートからの注入経路は無い）。
fn build_shell_command(command: &str) -> Command {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", command]);
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", command]);
        cmd
    }
}

/// 任意のコマンドをプロジェクトルートで起動し、標準出力/標準エラーを
/// `terminal-output` イベント（`{stream, line}`）で、終了時に `terminal-exit`
/// イベント（`{code}`）で配信する。コマンド自体は非同期に実行され、この呼び出しは
/// 起動が成功した時点ですぐ返る。
#[tauri::command]
pub fn start_terminal_watch(app: AppHandle, root: String, command: String) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("実行するコマンドを入力してください。".to_string());
    }

    let mut guard = watch_state()
        .lock()
        .map_err(|_| "内部エラー: 監視状態のロックに失敗しました。".to_string())?;
    if guard.is_some() {
        return Err("既に別のコマンドを監視中です。先に停止してください。".to_string());
    }

    let mut cmd = build_shell_command(&command);
    cmd.current_dir(Path::new(&root))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    configure_no_window(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("コマンドの起動に失敗しました: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *guard = Some(child);
    drop(guard);

    // stdout/stderrの両方がEOFに達した時点で、最後に検知したスレッドが
    // 終了コードを取得してterminal-exitイベントを出し、状態をクリアする。
    let remaining = Arc::new(AtomicUsize::new(2));

    if let Some(stdout) = stdout {
        spawn_reader_thread(app.clone(), stdout, "stdout", remaining.clone());
    } else {
        remaining.fetch_sub(1, Ordering::SeqCst);
    }
    if let Some(stderr) = stderr {
        spawn_reader_thread(app.clone(), stderr, "stderr", remaining.clone());
    } else {
        remaining.fetch_sub(1, Ordering::SeqCst);
    }

    Ok(())
}

fn spawn_reader_thread<R: std::io::Read + Send + 'static>(
    app: AppHandle,
    reader: R,
    stream: &'static str,
    remaining: Arc<AtomicUsize>,
) {
    std::thread::spawn(move || {
        let mut buffered = BufReader::new(reader);
        loop {
            let mut buf: Vec<u8> = Vec::new();
            let read = match buffered.read_until(b'\n', &mut buf) {
                Ok(n) => n,
                Err(_) => break,
            };
            if read == 0 {
                break; // EOF
            }
            // 末尾の改行(\n、および\r\nの場合は\rも)を取り除く（BufRead::lines()相当の挙動）
            if buf.last() == Some(&b'\n') {
                buf.pop();
                if buf.last() == Some(&b'\r') {
                    buf.pop();
                }
            }
            let line = decode_bytes(&buf);
            let _ = app.emit("terminal-output", TerminalOutputPayload { stream, line });
        }

        // fetch_subは「減算前」の値を返すため、1が返れば自分が最後の1本だった
        if remaining.fetch_sub(1, Ordering::SeqCst) == 1 {
            let code = {
                let mut guard = match watch_state().lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                let code = guard.as_mut().and_then(|c| c.wait().ok()).and_then(|s| s.code());
                *guard = None;
                code
            };
            let _ = app.emit("terminal-exit", TerminalExitPayload { code });
        }
    });
}

/// 実行中の監視プロセスを強制終了する。既に終了している場合は何もしない。
/// 実際の状態クリア・`terminal-exit` イベント送出は、EOFを検知したリーダースレッド側が行う。
#[tauri::command]
pub fn stop_terminal_watch() -> Result<(), String> {
    let mut guard = watch_state()
        .lock()
        .map_err(|_| "内部エラー: 監視状態のロックに失敗しました。".to_string())?;
    if let Some(child) = guard.as_mut() {
        let _ = child.kill();
    }
    Ok(())
}

/// アプリ終了時に監視中のプロセスが残らないよう、ベストエフォートで後始末する。
pub fn kill_if_running() {
    if let Ok(mut guard) = watch_state().lock() {
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
        }
    }
}

