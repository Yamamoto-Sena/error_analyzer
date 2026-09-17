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

/// 現在クリップボード監視が実行中かどうかを返す。
///
/// フロントエンド（ClipboardWatchModal）の`isRunning`は画面を開き直した際に
/// 常に`false`から始まってしまい、実際にはRust側で監視が継続しているのに
/// 画面上は「未実行」に見える（＝ユーザーが「開始」を押すと「既に監視中です」
/// と言われるのに、画面には停止ボタンが出ない）という食い違いが起きうる。
/// マウント時にこのコマンドで実際の状態を問い合わせ、画面側の状態を
/// 実態に合わせて補正するために使う。
#[tauri::command]
pub fn is_clipboard_watch_running() -> bool {
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

    /// 耐久テスト（手動実行専用）: クリップボード監視をアプリ起動中ずっと有効にしておく
    /// 運用を想定し、start_clipboard_watch内のポーリングループが行っている
    /// 「読み取り→前回値と比較→変化のみ検知」という処理を、書き込みスレッドとは
    /// 独立したタイミングでポーリングし続けるスレッドに対して大量回数繰り返しても、
    /// 変化の取りこぼしが起きないことを確認する。
    ///
    /// 本番のstart_clipboard_watchと同じく、書き込み（＝ユーザーのコピー操作）と
    /// ポーリング（読み取りスレッド）を別スレッド・別タイミングで動かす構成にしている
    /// （書き込み直後にその場で読み返すだけでは、本番で起こりうる「ポーリング間隔をまたいだ
    /// 取りこぼし」を再現できないため）。書き込み間隔(WRITE_INTERVAL)はポーリング間隔
    /// (POLL_INTERVAL_FOR_TEST)より十分長くし、各変化が少なくとも1回はポーリングに
    /// 観測される時間的余裕を与えている（ユーザーが次にコピーするまでの間隔は、本番の
    /// POLL_INTERVAL=800msより十分長いのが通常のユースケースであるのと同じ前提）。
    ///
    /// 通常の`cargo test`では実行しない(`#[ignore]`)。理由: arboard_can_read_back_written_text
    /// と同様、実際にOSのクリップボードを書き換える副作用があり、無人/ヘッドレス環境では
    /// 失敗しうるため。
    ///
    /// 注意: `arboard::Clipboard`のインスタンスを複数スレッドから同時に生成・操作すると、
    /// OS側のクリップボードAPI（Windowsでは特に）がスレッド間の同時アクセスを想定しておらず、
    /// プロセスクラッシュ（ヒープ破損）を起こすことを確認済みのため、Clipboardインスタンスは
    /// 1つだけ生成して`Mutex`越しに共有し、読み取り/書き込みの排他制御はRust側で行う。
    /// スレッドを分けているのは、書き込みタイミングと読み取り(ポーリング)タイミングを
    /// 独立させ、書き込み直後にその場で読み返すだけでは再現できない「ポーリング間隔をまたいだ
    /// 取りこぼし」を検証するためであり、OSクリップボードへの同時アクセスを狙ったものではない。
    /// 手動で実行する場合は次のコマンドを使う:
    ///   cargo test --package tauri-app -- --ignored clipboard_polling_loop_detects_many_rapid_changes
    #[test]
    #[ignore]
    fn clipboard_polling_loop_detects_many_rapid_changes_without_missing_any() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Mutex};

        const CHANGES: usize = 200;
        const POLL_INTERVAL_FOR_TEST: std::time::Duration = std::time::Duration::from_millis(20);
        const WRITE_INTERVAL: std::time::Duration = std::time::Duration::from_millis(80);

        let stop = Arc::new(AtomicBool::new(false));
        let detected = Arc::new(Mutex::new(Vec::<String>::new()));
        let clipboard = Arc::new(Mutex::new(
            arboard::Clipboard::new().expect("この端末でのクリップボード初期化に失敗しました"),
        ));
        // 読み取りスレッドが基準値(last_seen)を確定させる前に書き込みスレッドが最初の
        // 変化を書き込んでしまうと、その変化が「基準値」として扱われて検知されず、
        // 常に1件だけ取りこぼしたように見える競合が起きる。それを避けるため、
        // 基準値の確定が完了するまで書き込み開始を待ち合わせる。
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();

        // 読み取りスレッド: start_clipboard_watchの本体ループと同じ
        // 「一定間隔でポーリングし、前回値と異なれば検知する」処理を、書き込み側とは
        // 独立したタイミングで回し続ける。
        let reader_stop = stop.clone();
        let reader_detected = detected.clone();
        let reader_clipboard = clipboard.clone();
        let reader = std::thread::spawn(move || {
            let mut last_seen = reader_clipboard.lock().unwrap().get_text().unwrap_or_default();
            let _ = ready_tx.send(());
            loop {
                if reader_stop.load(Ordering::Relaxed) {
                    break;
                }
                std::thread::sleep(POLL_INTERVAL_FOR_TEST);
                let text = reader_clipboard.lock().unwrap().get_text().unwrap_or_default();
                if text != last_seen {
                    last_seen = text.clone();
                    reader_detected.lock().unwrap().push(text);
                }
            }
        });

        ready_rx.recv().expect("読み取りスレッドの起動待機に失敗しました");

        // 書き込みスレッド（このテスト自身）: 読み取りスレッドとは非同期に、
        // 一定間隔でクリップボードへ書き込み続ける。
        let mut expected = Vec::with_capacity(CHANGES);
        for i in 0..CHANGES {
            let text = format!("debug-buddy-durability-probe-{i}");
            clipboard
                .lock()
                .unwrap()
                .set_text(text.clone())
                .expect("クリップボードへの書き込みに失敗しました");
            expected.push(text);
            std::thread::sleep(WRITE_INTERVAL);
        }
        // 最後の書き込みを読み取りスレッドが拾いきる猶予を与えてから停止する
        std::thread::sleep(POLL_INTERVAL_FOR_TEST * 5);
        stop.store(true, Ordering::Relaxed);
        reader.join().expect("読み取りスレッドの終了待機に失敗しました");

        let detected = Arc::try_unwrap(detected)
            .expect("読み取りスレッドの終了後もdetectedの参照が残っています")
            .into_inner()
            .expect("detectedのロックが汚染されています");
        assert_eq!(
            detected, expected,
            "書き込みスレッドとは独立にポーリングしていた読み取りスレッドが、\
             一部の変化を取りこぼしたか、順序が入れ替わりました（{}/{}件を検知）",
            detected.len(),
            expected.len()
        );
    }
}
