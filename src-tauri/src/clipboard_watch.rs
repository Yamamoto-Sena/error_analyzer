//! OSクリップボードのテキストを定期的にポーリングし、変化を検知したら
//! フロントエンドへイベント配信するための「クリップボード監視モード」。
//!
//! 設計方針:
//! - MotionBoard等、このアプリが起動していない外部アプリのエラーダイアログ/メッセージは、
//!   ターミナル監視モード（terminal_watch.rs）のように標準出力を横取りする手段がないため、
//!   代わりにユーザーが普段どおり「コピー」した内容をクリップボード経由で検知する。
//! - ターミナル監視モードと同じく、「どの文字列をエラーらしいと見なすか」の判定は
//!   フロントエンド（analyzer.tsの`looksLikeErrorText`）に委ね、Rust側は
//!   「クリップボードのテキストが変化したこと」の検知・配信にのみ徹する。
//! - 対象はテキストのみ（画像/スクリーンショットは対象外）。画像をGeminiに渡せる形
//!   （PNG化+base64）に変換するには追加の依存関係が必要になり、既存のスクリーンショット
//!   手動貼り付け機能（App.tsxのhandlePasteImage）で今のところ代替できるため、
//!   スコープ外としている。
//! - 子プロセスを監視するterminal_watch.rsと異なり、クリップボード監視には
//!   「killすれば読み取りスレッドが自然に終了する」ような対象が存在しないため、
//!   停止は`Arc<AtomicBool>`の停止フラグをポーリングループ側で確認する方式にしている。
//! - 同時に監視できるのは1つまで（グローバルな`Mutex<Option<ClipboardWatchHandle>>`で管理、
//!   terminal_watch.rsと同じ「二重起動不可」方針）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// クリップボードを確認する間隔。短すぎるとCPUを無駄に消費し、長すぎると
/// 検知までの体感速度が悪くなるため、体感上ちょうど良いとされる800msにしている。
const POLL_INTERVAL: Duration = Duration::from_millis(800);

struct ClipboardWatchHandle {
    stop_flag: Arc<AtomicBool>,
}

fn watch_state() -> &'static Mutex<Option<ClipboardWatchHandle>> {
    static STATE: OnceLock<Mutex<Option<ClipboardWatchHandle>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

#[derive(Clone, serde::Serialize)]
struct ClipboardTextPayload {
    text: String,
}

/// クリップボードのテキスト監視を開始する。
///
/// 起動時点のクリップボード内容を「初期値」として読み込んでおくことで、
/// 監視開始前からコピーされていた内容にいきなり反応してしまうことを防ぐ
/// （ユーザーが「今から」コピーする内容だけを検知対象にしたいため）。
#[tauri::command]
pub fn start_clipboard_watch(app: AppHandle) -> Result<(), String> {
    let mut guard = watch_state()
        .lock()
        .map_err(|_| "内部エラー: 監視状態のロックに失敗しました。".to_string())?;
    if guard.is_some() {
        return Err("既にクリップボードを監視中です。先に停止してください。".to_string());
    }

    // 読み取り失敗（クリップボードが空、画像のみが入っている等）は「空文字」として扱う。
    // クリップボード監視はベストエフォートの機能であり、この時点でのエラーを
    // フロントエンドへ伝播させる必要はない。
    let initial_text = app.clipboard().read_text().unwrap_or_default();

    let stop_flag = Arc::new(AtomicBool::new(false));
    *guard = Some(ClipboardWatchHandle {
        stop_flag: stop_flag.clone(),
    });
    drop(guard);

    std::thread::spawn(move || {
        let mut last_seen = initial_text;

        loop {
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(POLL_INTERVAL);
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }

            // 他プロセスがクリップボードを掴んでいる等で読み取りに失敗することがあるが、
            // 監視自体を止める必要はないため、そのティックはスキップして次回に回す。
            let Ok(text) = app.clipboard().read_text() else {
                continue;
            };
            if text == last_seen {
                continue;
            }
            last_seen = text.clone();

            // 空文字（コピーではなくクリップボードのクリア等）には反応しない
            if text.trim().is_empty() {
                continue;
            }

            let _ = app.emit("clipboard-text-changed", ClipboardTextPayload { text });
        }
    });

    Ok(())
}

/// クリップボード監視を停止する。既に停止している場合は何もしない。
///
/// terminal_watch.rsの`stop_terminal_watch`と異なり、子プロセスをkillするのではなく
/// 停止フラグを立てるだけで即座に返る（監視スレッドは次のポーリングタイミングで
/// 自然に終了する。最大でも`POLL_INTERVAL`程度の遅延はあるが、この機能の性質上
/// 問題にならない）。
#[tauri::command]
pub fn stop_clipboard_watch() -> Result<(), String> {
    let mut guard = watch_state()
        .lock()
        .map_err(|_| "内部エラー: 監視状態のロックに失敗しました。".to_string())?;
    if let Some(handle) = guard.take() {
        handle.stop_flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// アプリ終了時に監視スレッドが残らないよう、ベストエフォートで後始末する。
pub fn stop_if_running() {
    if let Ok(mut guard) = watch_state().lock() {
        if let Some(handle) = guard.take() {
            handle.stop_flag.store(true, Ordering::Relaxed);
        }
    }
}
