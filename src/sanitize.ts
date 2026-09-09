// エラーログを外部API（Gemini）へ送信する前に、機密情報らしき文字列をマスクするための
// サニタイズ処理。
//
// 対象: 01_requirements_definition.md の非機能要件（5.2 シークレット・機密情報の保護）で
// 「ログ内に含まれるトークン、APIキー、パスワード、個人情報（メールアドレス・IPアドレス等）を
// LLMへ送信する前にマスキングする」と定義されている項目に対応する。
//
// 注意: ローカル解析エンジン（analyzer.ts）は外部へ何も送信しないため、この処理は不要。
// マスキングが必要なのは gemini.ts が外部APIへリクエストを送る直前のみ。

export interface SanitizeResult {
  /** マスキング後のテキスト */
  sanitized: string;
  /** マスクした箇所の合計件数（0件ならユーザーへの通知は不要という判断に使う） */
  maskedCount: number;
}

interface MaskRule {
  /** デバッグ用のルール名（テストで参照する） */
  name: string;
  pattern: RegExp;
  /** マッチ全体を置き換える文字列、またはマッチから置換文字列を組み立てる関数 */
  replace: string | ((match: string, ...groups: string[]) => string);
}

// プライベート/ループバックIPは開発環境のエラー診断（例: DB接続先 127.0.0.1:5432）に
// 有用な情報であり、個人を特定する機密情報ではないため意図的にマスク対象から除外する。
// マスクするのは「個人や組織のネットワークを特定しうるパブリックIP」のみ。
function isPrivateOrLoopbackIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 127) return true; // ループバック
  if (a === 10) return true; // プライベート(10.0.0.0/8)
  if (a === 172 && b >= 16 && b <= 31) return true; // プライベート(172.16.0.0/12)
  if (a === 192 && b === 168) return true; // プライベート(192.168.0.0/16)
  if (a === 0 && b === 0) return true; // 0.0.0.0
  return false;
}

const RULES: MaskRule[] = [
  {
    // PEM形式の秘密鍵ブロック全体（複数行）
    name: "private-key-block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: "[MASKED_PRIVATE_KEY]",
  },
  {
    // AWSアクセスキーID
    name: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: "[MASKED_AWS_ACCESS_KEY]",
  },
  {
    // JWT（ヘッダー.ペイロード.署名の3パート構成）
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    replace: "[MASKED_JWT]",
  },
  {
    // Bearerトークン（Authorizationヘッダーの値部分）
    name: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9\-_.+/=]{8,}/gi,
    replace: "Bearer [MASKED_TOKEN]",
  },
  {
    // 接続文字列に含まれるパスワード部分（例: postgres://user:PASSWORD@host/db）
    name: "connection-string-password",
    pattern: /(:\/\/[^:\/\s@]+:)([^@\s]+)(@)/g,
    replace: (_match, prefix: string, _pw: string, suffix: string) => `${prefix}[MASKED]${suffix}`,
  },
  {
    // key=value / key: "value" 形式のシークレットらしき代入（.envの中身や設定ファイル等）。
    // 値側が既に他ルールで [MASKED... 済みの場合は二重マスキングで
    // より具体的なプレースホルダー（[MASKED_JWT]等）を潰してしまわないよう除外する。
    name: "key-value-secret",
    pattern:
      /\b((?:api[_-]?key|apikey|secret(?:[_-]?key)?|access[_-]?key|client[_-]?secret|password|passwd|pwd|token)\s*[:=]\s*)(["']?)((?!\[MASKED)[^\s"',;]{4,})\2/gi,
    replace: (_match, prefix: string, quote: string) => `${prefix}${quote}[MASKED]${quote}`,
  },
  {
    // メールアドレス
    name: "email",
    pattern: /\b[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}\b/g,
    replace: "[MASKED_EMAIL]",
  },
  {
    // パブリックIPv4アドレス（プライベート/ループバックは診断上有用なため除外）
    name: "public-ipv4",
    pattern: /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g,
    replace: (match: string) => (isPrivateOrLoopbackIPv4(match) ? match : "[MASKED_IP]"),
  },
];

/**
 * ログ・自由記述テキストの中から、APIキー・トークン・パスワード・メールアドレス・
 * パブリックIPアドレス等の機密情報らしき文字列をマスクして返す。
 * 外部LLM APIへ送信する直前にのみ適用する（ローカル解析エンジンには不要）。
 */
export function maskSensitiveInfo(text: string): SanitizeResult {
  let sanitized = text;
  let maskedCount = 0;

  for (const rule of RULES) {
    sanitized = sanitized.replace(rule.pattern, (...args: string[]) => {
      const match = args[0];
      const groups = args.slice(1, -2); // 末尾2つはoffsetとfull stringなので除く
      const replacement = typeof rule.replace === "string" ? rule.replace : rule.replace(match, ...groups);
      // 実際に内容が変わった場合のみ件数を加算する
      // （例: プライベートIPは判定の結果マスクしない=文字列は不変、というケースがあるため）
      if (replacement !== match) maskedCount++;
      return replacement;
    });
  }

  return { sanitized, maskedCount };
}
