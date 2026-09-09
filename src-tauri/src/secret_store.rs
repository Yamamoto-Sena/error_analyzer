//! Gemini APIキーをOSのキーチェーン（Windows: 資格情報マネージャー /
//! macOS: キーチェーン / Linux: Secret Service）に保存・読み込み・削除するための
//! 薄いラッパー。
//!
//! これまでフロントエンド側で `localStorage` に平文保存していたが、OSがきちんと
//! 保護してくれる領域に移すことで、ファイルとしてそのまま読める状態を避ける。

use keyring::Entry;

/// キーチェーン上でこのアプリを識別するためのサービス名・ユーザー名。
/// 値そのものではなく「保存場所を特定するためのラベル」であり秘匿情報ではない。
const SERVICE_NAME: &str = "com.debugbuddy.app";
const KEY_USERNAME: &str = "gemini_api_key";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE_NAME, KEY_USERNAME)
        .map_err(|e| format!("キーチェーンへのアクセスに失敗しました: {e}"))
}

/// Gemini APIキーをOSキーチェーンに保存する。空文字が渡された場合は
/// 「クリアする」操作として扱い、既存のエントリを削除する
/// （未設定状態と空文字保存を区別する意味が無いため）。
pub fn save_api_key(key: &str) -> Result<(), String> {
    let e = entry()?;
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return match e.delete_credential() {
            Ok(()) => Ok(()),
            // 元々何も保存されていなかった場合はエラー扱いにしない
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(format!("APIキーの削除に失敗しました: {err}")),
        };
    }
    e.set_password(trimmed)
        .map_err(|err| format!("APIキーの保存に失敗しました: {err}"))
}

/// OSキーチェーンからGemini APIキーを読み込む。未保存の場合は `Ok(None)` を返す
/// （エラーではなく「まだ設定されていない」という正常な状態として扱う）。
pub fn load_api_key() -> Result<Option<String>, String> {
    let e = entry()?;
    match e.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("APIキーの読み込みに失敗しました: {err}")),
    }
}
