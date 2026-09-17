//! clipboard_watch.rs と log_file_watch.rs の両方で使う、「同時に1つまでしか監視できない
//! 停止フラグベースの監視状態」を保持する単一スロットのレジストリと、「同じ内容のエラーが
//! 連続する間はeprintln!を繰り返さない」というエラーログの重複抑制ロジックの共通部分を
//! 切り出したもの。
//!
//! 元々は両ファイルにほぼ同一のコード（`OnceLock<Mutex<Option<Handle{stop_flag}>>>`の
//! レジストリ、二重起動チェック、停止フラグのpolling、エラーメッセージのdedup）が
//! 重複していたため、encoding_util.rsと同様の考え方でここへ切り出した。
//!
//! terminal_watch.rsは`Child`（子プロセス）を`kill()`で止める方式であり、停止フラグを
//! 使わないため、このモジュールの対象外（無理に共通化すると、killベースの挙動に
//! 停止フラグの概念を押し付けることになり、かえって分かりにくくなるため）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// ロック取得失敗（ポイズニング）時のエラー文言。clipboard_watch.rs/log_file_watch.rs
/// 両方で元々バイト同一の文言だったため、呼び出し元ごとにパラメータで渡す必要がなく、
/// ここに一元化する（「既に監視中です」という文言はモジュールごとに異なるため、
/// そちらは引き続き呼び出し元から渡してもらう）。
const LOCK_POISONED_MESSAGE: &str = "内部エラー: 監視状態のロックに失敗しました。";

/// 「同時に1つまでしか監視できない」種類の監視状態（停止フラグのみ）を保持するレジストリ。
pub struct StopFlagRegistry {
    slot: OnceLock<Mutex<Option<Arc<AtomicBool>>>>,
}

impl StopFlagRegistry {
    pub const fn new() -> Self {
        Self {
            slot: OnceLock::new(),
        }
    }

    fn mutex(&self) -> &Mutex<Option<Arc<AtomicBool>>> {
        self.slot.get_or_init(|| Mutex::new(None))
    }

    /// 新規監視の開始を試みる。既に監視中の場合は`already_running_message`をそのまま
    /// エラーとして返す（呼び出し元ごとに異なる既存の日本語エラー文言をそのまま
    /// 維持するため、こちらのみ呼び出し元から渡してもらう）。
    pub fn try_start(&self, already_running_message: &str) -> Result<Arc<AtomicBool>, String> {
        let mut guard = self
            .mutex()
            .lock()
            .map_err(|_| LOCK_POISONED_MESSAGE.to_string())?;
        if guard.is_some() {
            return Err(already_running_message.to_string());
        }
        let stop_flag = Arc::new(AtomicBool::new(false));
        *guard = Some(stop_flag.clone());
        Ok(stop_flag)
    }

    /// 監視を停止する。戻り値は「実際に停止処理を行ったか」（既に停止済みならfalse）。
    /// 呼び出し元が「何かを止めたときだけログを出す」という既存の挙動を維持できるように、
    /// この情報を返す。
    pub fn stop(&self) -> Result<bool, String> {
        let mut guard = self
            .mutex()
            .lock()
            .map_err(|_| LOCK_POISONED_MESSAGE.to_string())?;
        if let Some(flag) = guard.take() {
            flag.store(true, Ordering::Relaxed);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn is_running(&self) -> bool {
        self.mutex().lock().map(|g| g.is_some()).unwrap_or(false)
    }

    /// アプリ終了時のベストエフォート後始末用（ロック失敗時は諦めてよい）。
    pub fn stop_if_running(&self) {
        if let Ok(mut guard) = self.mutex().lock() {
            if let Some(flag) = guard.take() {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }
}

/// 「同じ内容のエラーが続く間はeprintln!を連続で出さない」ためのdedupヘルパー。
/// ポーリングループが読み取り失敗のたびに同じメッセージでターミナルを埋め尽くさない
/// ようにする、clipboard_watch.rs/log_file_watch.rs共通の配慮。
#[derive(Default)]
pub struct ErrorLogDedup(Option<String>);

impl ErrorLogDedup {
    pub fn new() -> Self {
        Self(None)
    }

    /// messageが前回ログ出力した内容と異なる場合のみ`[prefix] message`をeprintln!する。
    /// 戻り値は「実際に出力したか」（テストで副作用を確認しやすくするため）。
    pub fn log_if_changed(&mut self, prefix: &str, message: String) -> bool {
        if self.0.as_deref() != Some(message.as_str()) {
            eprintln!("[{prefix}] {message}");
            self.0 = Some(message);
            true
        } else {
            false
        }
    }

    /// 読み取り成功時など、直前のエラー状態をリセットする
    /// （次に同じエラーが起きたときに再度ログ出力されるようにするため）。
    pub fn clear(&mut self) {
        self.0 = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn try_start_succeeds_when_empty_and_returns_a_stop_flag() {
        let registry = StopFlagRegistry::new();
        let flag = registry.try_start("already running").unwrap();
        assert!(!flag.load(Ordering::Relaxed));
        assert!(registry.is_running());
    }

    #[test]
    fn try_start_fails_with_the_given_message_when_already_running() {
        let registry = StopFlagRegistry::new();
        registry.try_start("already running").unwrap();
        let err = registry.try_start("already running").unwrap_err();
        assert_eq!(err, "already running");
    }

    #[test]
    fn stop_sets_the_flag_and_clears_the_slot() {
        let registry = StopFlagRegistry::new();
        let flag = registry.try_start("already running").unwrap();
        let stopped = registry.stop().unwrap();
        assert!(stopped);
        assert!(flag.load(Ordering::Relaxed));
        assert!(!registry.is_running());
    }

    #[test]
    fn stop_is_a_no_op_and_returns_false_when_nothing_is_running() {
        let registry = StopFlagRegistry::new();
        let stopped = registry.stop().unwrap();
        assert!(!stopped);
    }

    #[test]
    fn stop_if_running_is_a_silent_no_op_when_nothing_is_running() {
        let registry = StopFlagRegistry::new();
        registry.stop_if_running();
        assert!(!registry.is_running());
    }

    #[test]
    fn stop_if_running_stops_an_active_watch() {
        let registry = StopFlagRegistry::new();
        let flag = registry.try_start("already running").unwrap();
        registry.stop_if_running();
        assert!(flag.load(Ordering::Relaxed));
        assert!(!registry.is_running());
    }

    #[test]
    fn error_log_dedup_logs_only_when_the_message_changes() {
        let mut dedup = ErrorLogDedup::new();
        assert!(dedup.log_if_changed("test", "boom".to_string()));
        assert!(!dedup.log_if_changed("test", "boom".to_string()));
        assert!(dedup.log_if_changed("test", "different".to_string()));
    }

    #[test]
    fn error_log_dedup_logs_again_after_clear() {
        let mut dedup = ErrorLogDedup::new();
        assert!(dedup.log_if_changed("test", "boom".to_string()));
        dedup.clear();
        assert!(dedup.log_if_changed("test", "boom".to_string()));
    }
}
