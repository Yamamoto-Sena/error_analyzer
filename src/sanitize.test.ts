import { describe, expect, it } from "vitest";
import { maskSensitiveInfo } from "./sanitize";

describe("maskSensitiveInfo", () => {
  it("メールアドレスをマスクする", () => {
    const { sanitized, maskedCount } = maskSensitiveInfo("エラー通知先: taro.yamada@example.co.jp でした");
    expect(sanitized).not.toContain("taro.yamada@example.co.jp");
    expect(sanitized).toContain("[MASKED_EMAIL]");
    expect(maskedCount).toBe(1);
  });

  it("key=value形式のAPIキー・パスワードをマスクする", () => {
    const { sanitized, maskedCount } = maskSensitiveInfo(
      'API_KEY=sk-abcdefghijklmnop\npassword: "SuperSecret123"'
    );
    expect(sanitized).not.toContain("sk-abcdefghijklmnop");
    expect(sanitized).not.toContain("SuperSecret123");
    expect(sanitized).toContain("[MASKED]");
    expect(maskedCount).toBe(2);
  });

  it("Bearerトークンをマスクする", () => {
    const { sanitized } = maskSensitiveInfo("Authorization header: Bearer abcdEFGH12345678.xyz");
    expect(sanitized).toContain("Bearer [MASKED_TOKEN]");
    expect(sanitized).not.toContain("abcdEFGH12345678");
  });

  it("JWTをマスクする", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const { sanitized } = maskSensitiveInfo(`token=${jwt}`);
    expect(sanitized).toContain("[MASKED_JWT]");
    expect(sanitized).not.toContain(jwt);
  });

  it("AWSアクセスキーIDをマスクする", () => {
    const { sanitized } = maskSensitiveInfo("AKIAIOSFODNN7EXAMPLE を使って接続しました");
    expect(sanitized).toContain("[MASKED_AWS_ACCESS_KEY]");
    expect(sanitized).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("接続文字列内のパスワードのみをマスクし、ユーザー名やホストは残す", () => {
    const { sanitized } = maskSensitiveInfo("postgres://dbuser:hunter2@db.internal.example.com:5432/app");
    expect(sanitized).toContain("dbuser");
    expect(sanitized).toContain("db.internal.example.com");
    expect(sanitized).not.toContain("hunter2");
    expect(sanitized).toContain("[MASKED]");
  });

  it("秘密鍵ブロック(PEM)をまるごとマスクする", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----";
    const { sanitized } = maskSensitiveInfo(`証明書エラー:\n${pem}`);
    expect(sanitized).toContain("[MASKED_PRIVATE_KEY]");
    expect(sanitized).not.toContain("MIIBOgIBAAJBAK");
  });

  it("パブリックIPv4アドレスはマスクする", () => {
    const { sanitized } = maskSensitiveInfo("接続失敗: 203.0.113.42:443 に到達できません");
    expect(sanitized).toContain("[MASKED_IP]");
    expect(sanitized).not.toContain("203.0.113.42");
  });

  it("プライベート/ループバックIPは診断に必要な情報のため残す(127.0.0.1, 192.168.x, 10.x)", () => {
    const { sanitized, maskedCount } = maskSensitiveInfo(
      "ECONNREFUSED 127.0.0.1:5432 / gateway 192.168.1.1 / internal 10.0.0.5"
    );
    expect(sanitized).toContain("127.0.0.1");
    expect(sanitized).toContain("192.168.1.1");
    expect(sanitized).toContain("10.0.0.5");
    expect(maskedCount).toBe(0);
  });

  it("機密情報が無いログはそのまま(件数0)で返す", () => {
    const log = "TypeError: Cannot read properties of undefined (reading 'map')\nat UserList (src/components/UserList.tsx:24:18)";
    const { sanitized, maskedCount } = maskSensitiveInfo(log);
    expect(sanitized).toBe(log);
    expect(maskedCount).toBe(0);
  });
});
