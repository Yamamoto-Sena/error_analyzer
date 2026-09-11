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
    //
    // ただし「コピーしても何も検知されない」という不具合の切り分けを容易にするため、
    // 開発コンソール（`pnpm tauri dev`実行時のターミナル）には常に開始時の状態を出力する。
    let initial_read = app.clipboard().read_text();
    eprintln!(
        "[clipboard_watch] 監視を開始します（初期値の読み取り: {}）",
        match &initial_read {
            Ok(t) => format!("成功・{}文字", t.chars().count()),
            Err(e) => format!("失敗（クリップボードが空か、テキスト以外の内容の可能性: {e}）"),
        }
    );
    let initial_text = initial_read.unwrap_or_default();

    let stop_flag = Arc::new(AtomicBool::new(false));
    *guard = Some(ClipboardWatchHandle {
        stop_flag: stop_flag.clone(),
    });
    drop(guard);

    std::thread::spawn(move || {
        let mut last_seen = initial_text;
        // 同じ内容のエラーを連続でログに出し続けてターミナルが埋まらないよう、
        // 直前に出力したエラーメッセージを覚えておき、変化があった時だけ再出力する。
        let mut last_logged_error: Option<String> = None;

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
            let text = match app.clipboard().read_text() {
                Ok(t) => {
                    last_logged_error = None;
                    t
                }
                Err(e) => {
                    let message = e.to_string();
                    if last_logged_error.as_deref() != Some(message.as_str()) {
                        eprintln!("[clipboard_watch] クリップボードの読み取りに失敗しました: {message}");
                        last_logged_error = Some(message);
                    }
                    continue;
                }
            };
            if text == last_seen {
                continue;
            }
            last_seen = text.clone();

            // 空文字（コピーではなくクリップボードのクリア等）には反応しない
            if text.trim().is_empty() {
                continue;
            }

            let preview: String = text.chars().take(60).collect();
            eprintln!(
                "[clipboard_watch] クリップボードの変化を検知（{}文字）: {preview}{}",
                text.chars().count(),
                if text.chars().count() > 60 { "…" } else { "" }
            );

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
        eprintln!("[clipboard_watch] 監視を停止しました");
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

#[cfg(test)]
mod tests {
    /// トラブルシューティング用: 「クリップボード監視をONにしてコピーしても検知されない」
    /// 場合に、原因が(a)この端末でのOSクリップボード読み書き自体が機能していないのか、
    /// (b)アプリ側の配線・ヒューリスティック判定の問題なのかを切り分けるための手動テスト。
    /// `tauri-plugin-clipboard-manager`が内部で使っているのと同じ`arboard`クレートを
    /// 直接呼び、Tauriアプリを起動しなくても検証できるようにしている。
    ///
    /// 通常の`cargo test`では実行しない(`#[ignore]`)。理由:
    /// - 実際にOSのクリップボードを書き換えてしまう副作用があり、CI等の無人環境や
    ///   ヘッドレス環境（クリップボードが利用できない）では失敗しうるため。
    /// 手動で実行する場合は次のコマンドを使う:
    ///   cargo test --package tauri-app -- --ignored arboard_can_read_back_written_text
    #[test]
    #[ignore]
    fn arboard_can_read_back_written_text_on_this_machine() {
        let mut clipboard =
            arboard::Clipboard::new().expect("この端末でのクリップボード初期化に失敗しました");
        let probe_text = "debug-buddy-clipboard-probe-12345";
        clipboard
            .set_text(probe_text)
            .expect("この端末でのクリップボードへの書き込みに失敗しました");

        // 一部の環境ではOSがクリップボードの更新を反映するまで一瞬ラグがあるため、
        // 実際のポーリングループ(POLL_INTERVAL=800ms)と同程度待ってから読み直す。
        std::thread::sleep(std::time::Duration::from_millis(200));

        let read_back = clipboard
            .get_text()
            .expect("この端末でのクリップボードからの読み取りに失敗しました");
        assert_eq!(
            read_back, probe_text,
            "書き込んだ内容と読み取った内容が一致しません（他のクリップボード管理ソフトが介在している可能性があります）"
        );
    }
}
