//! ターミナル監視・ログファイル監視の両方で使う、バイト列→文字列デコードの共通処理。
//!
//! Windowsのコンソールアプリ（cmd.exe経由で実行されるコマンド）や、一部のログファイルは
//! 必ずしもUTF-8で出力されるとは限らない。特に日本語ロケール環境では、エラーメッセージ等が
//! Shift-JIS(CP932)で出力されることが多い。まずUTF-8として解釈を試み、失敗した場合のみ
//! Shift-JISとして解釈することで、英語圏のツール（npm/git等、通常UTF-8で出力する）は
//! そのまま正しく扱いつつ、Windowsの日本語ローカライズ済みメッセージも取りこぼさないようにする。
//!
//! 元々は terminal_watch.rs 内の `decode_line` としてのみ実装されていたが、ログファイル監視
//! （log_file_watch.rs）でも全く同じデコード方針が必要になったため、共有ユーティリティとして
//! こちらへ切り出した。

pub fn decode_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::SHIFT_JIS.decode(bytes).0.into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_bytes_reads_valid_utf8_as_is() {
        let bytes = "npm error Missing script".as_bytes();
        assert_eq!(decode_bytes(bytes), "npm error Missing script");
    }

    #[test]
    fn decode_bytes_falls_back_to_shift_jis_for_non_utf8_bytes() {
        // 「指定されたファイルが見つかりません。」をShift-JIS(CP932)でエンコードしたバイト列。
        // 日本語ロケールのWindowsで cmd.exe / type コマンド等が実際に出力する形式を想定。
        let (bytes, _, had_errors) = encoding_rs::SHIFT_JIS.encode("指定されたファイルが見つかりません。");
        assert!(!had_errors);

        let decoded = decode_bytes(&bytes);

        assert_eq!(decoded, "指定されたファイルが見つかりません。");
    }
}
