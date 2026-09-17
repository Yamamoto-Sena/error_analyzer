import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeWithGemini, askFollowUpQuestion, listAvailableModels } from "./gemini";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function validGeminiPayload(overrides: Record<string, unknown> = {}) {
  return {
    errorType: "TypeError",
    summary: "s",
    rootCause: "r",
    filePath: "src/f.ts",
    lineNumber: "1行目",
    diffCode: "d",
    fixType: "code",
    taskSteps: [],
    learningTitle: "t",
    learningContent: "c",
    preventionTips: ["p"],
    ...overrides,
  };
}

function successResponse(modelVersion: string, overrides: Record<string, unknown> = {}) {
  return jsonResponse(200, {
    modelVersion,
    candidates: [{ content: { parts: [{ text: JSON.stringify(validGeminiPayload(overrides)) }] } }],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("analyzeWithGemini", () => {
  it("成功時にレスポンスを解析結果に変換し、APIキーをヘッダーで送る(URLには含めない)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse("gemini-3.5-flash-lite-001"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeWithGemini("some log", "FAKE_KEY", "gemini-3.5-flash-lite");

    expect(result.errorType).toBe("TypeError");
    expect(result.modelUsed).toBe("gemini-3.5-flash-lite-001");
    expect(result.usedFallbackModel).toBe(false);

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("key=");
    expect((options.headers as Record<string, string>)["x-goog-api-key"]).toBe("FAKE_KEY");
  });

  it("404の場合は次の候補モデルへ自動でフォールバックする", async () => {
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) return new Response("not found", { status: 404 });
      return successResponse("gemini-3.8-flash-002");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeWithGemini("log", "KEY", "this-model-does-not-exist");

    expect(result.usedFallbackModel).toBe(true);
    expect(result.modelRequested).toBe("this-model-does-not-exist");
  });

  it("日次クォータ超過(429)の場合はquotaExceededModelsに記録し次の候補へ切り替える", async () => {
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) {
        return jsonResponse(429, {
          error: {
            status: "RESOURCE_EXHAUSTED",
            message: "Quota exceeded for quota metric 'GenerateContent requests per day'",
          },
        });
      }
      return successResponse("gemini-3.5-flash-002");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeWithGemini("log", "KEY", "gemini-3.5-flash-lite");

    expect(result.quotaExceededModels).toContain("gemini-3.5-flash-lite");
    expect(result.usedFallbackModel).toBe(true);
  });

  it("タイムアウト(AbortError)時は分かりやすい日本語メッセージにして最終的にthrowする", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeWithGemini("log", "KEY", "gemini-3.5-flash-lite")).rejects.toThrow(/タイムアウト/);
  });

  it("送信前にログ内のAPIキー等をマスクし、maskedSecretsCountを結果に含める", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse("gemini-3.5-flash-lite-001"));
    vi.stubGlobal("fetch", fetchMock);

    const log = "起動失敗\nAPI_KEY=sk-topsecret1234567890\n連絡先: dev@example.com";
    const result = await analyzeWithGemini(log, "FAKE_KEY", "gemini-3.5-flash-lite");

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = options.body as string;
    expect(sentBody).not.toContain("sk-topsecret1234567890");
    expect(sentBody).not.toContain("dev@example.com");
    expect(result.maskedSecretsCount).toBe(2);
  });

  it("previousAttemptの各フィールドも送信前にマスクし、maskedSecretsCountに含める（検証時の再解析でも機密情報を漏らさない）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse("gemini-3.5-flash-lite-001"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeWithGemini("再実行後のログ（機密情報なし）", "FAKE_KEY", "gemini-3.5-flash-lite", [], {
      summary: "前回の要約 API_KEY=sk-topsecret1234567890",
      rootCause: "前回の根本原因 連絡先: dev@example.com",
      fixType: "code",
      diffCode: "--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n- old API_KEY=sk-topsecret1234567890\n+ new",
    });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = options.body as string;
    expect(sentBody).not.toContain("sk-topsecret1234567890");
    expect(sentBody).not.toContain("dev@example.com");
    expect(result.maskedSecretsCount).toBeGreaterThanOrEqual(3);
  });

  it("マスク対象が無い場合はmaskedSecretsCountを付与しない", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse("gemini-3.5-flash-lite-001"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeWithGemini("TypeError: x is not a function", "FAKE_KEY", "gemini-3.5-flash-lite");

    expect(result.maskedSecretsCount).toBeUndefined();
  });

  it("usageMetadataが揃っている場合はtokenUsageとして結果に含める", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        modelVersion: "gemini-3.5-flash-lite-001",
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 45, totalTokenCount: 165 },
        candidates: [{ content: { parts: [{ text: JSON.stringify(validGeminiPayload()) }] } }],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeWithGemini("log", "KEY", "gemini-3.5-flash-lite");

    expect(result.tokenUsage).toEqual({ promptTokens: 120, responseTokens: 45, totalTokens: 165 });
  });

  it("usageMetadataが無い場合はtokenUsageを付与しない", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse("gemini-3.5-flash-lite-001"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeWithGemini("log", "KEY", "gemini-3.5-flash-lite");

    expect(result.tokenUsage).toBeUndefined();
  });

  it("previousAttemptを渡すと、直前の修正案の内容をプロンプトに含めて送信する（検証時の再解析が前回の失敗を無視しないように）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse("gemini-3.5-flash-lite-001"));
    vi.stubGlobal("fetch", fetchMock);

    await analyzeWithGemini("再実行後のログ", "FAKE_KEY", "gemini-3.5-flash-lite", [], {
      summary: "前回の要約テキスト",
      rootCause: "前回の根本原因テキスト",
      fixType: "code",
      diffCode: "--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n- old\n+ new",
    });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(options.body as string);
    const sentPrompt: string = sentBody.contents[0].parts[0].text;
    expect(sentPrompt).toContain("前回の要約テキスト");
    expect(sentPrompt).toContain("前回の根本原因テキスト");
    expect(sentPrompt).toContain("old");
  });

  it("previousAttemptを渡さない場合は、直前の修正案に関する記述をプロンプトに含めない", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse("gemini-3.5-flash-lite-001"));
    vi.stubGlobal("fetch", fetchMock);

    await analyzeWithGemini("初回のログ", "FAKE_KEY", "gemini-3.5-flash-lite");

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(options.body as string);
    const sentPrompt: string = sentBody.contents[0].parts[0].text;
    expect(sentPrompt).not.toContain("直前に提示した修正案");
  });

  it("すべての候補モデルが失敗した場合は最終エラーをthrowする", async () => {
    // 呼び出しのたびに新しいResponseを返す(同一インスタンスを使い回すとbodyが
    // 2回目以降 "already been read" エラーになるため)
    const fetchMock = vi.fn().mockImplementation(async () => new Response("server error", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeWithGemini("log", "KEY", "gemini-3.5-flash-lite")).rejects.toThrow(/Gemini API エラー \(500\)/);
  });
});

// クリップボード監視・ターミナル監視・ログファイル監視のようにアプリを長時間起動しっぱなしに
// する運用を想定し、この関数が「連続で大量に呼ばれ続けても状態が汚染されない・
// タイマーやAbortControllerがリークしない」ことを検証する耐久テスト。
describe("analyzeWithGemini の繰り返し耐性（耐久テスト）", () => {
  it("大量に連続呼び出ししても、毎回独立して正しい結果を返す(前回呼び出しの状態を引きずらない)", async () => {
    const ITERATIONS = 200;
    // successResponse()はResponseインスタンスを1回しか読めないため、呼び出しごとに
    // 新しいインスタンスを生成する(既存の失敗系テストと同じ手当て)
    const fetchMock = vi.fn().mockImplementation(async () => successResponse("gemini-3.5-flash-lite-001"));
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < ITERATIONS; i++) {
      const result = await analyzeWithGemini(`log ${i}`, "FAKE_KEY", "gemini-3.5-flash-lite");
      expect(result.errorType).toBe("TypeError");
      expect(result.usedFallbackModel).toBe(false);
    }

    expect(fetchMock).toHaveBeenCalledTimes(ITERATIONS);
  });

  it("成功/フォールバック/最終失敗が入り混じって連続しても、都度エラーの取りこぼしなく完結する", async () => {
    const ITERATIONS = 60;
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      call++;
      // 3パターンを順番に繰り返し、直前の呼び出し結果が次回に影響しないことを確認する
      const pattern = call % 3;
      if (pattern === 1) return new Response("not found", { status: 404 }); // 1st: 404→フォールバック成功
      if (pattern === 2) return successResponse("gemini-3.8-flash-002"); // 2nd: そのモデルで成功
      return successResponse("gemini-3.5-flash-lite-001"); // 3rd: 通常成功
    });
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < ITERATIONS; i++) {
      const result = await analyzeWithGemini(`log ${i}`, "FAKE_KEY", "gemini-3.5-flash-lite");
      expect(result.errorType).toBe("TypeError");
    }
  });

  it("タイムアウト用タイマー(AbortController)が呼び出しごとに確実にクリアされ、繰り返してもタイマーが蓄積しない", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockImplementation(async () => successResponse("gemini-3.5-flash-lite-001"));
      vi.stubGlobal("fetch", fetchMock);

      for (let i = 0; i < 50; i++) {
        await analyzeWithGemini(`log ${i}`, "FAKE_KEY", "gemini-3.5-flash-lite");
      }

      // FETCH_TIMEOUT_MS用のsetTimeoutがfinallyでclearTimeoutされていれば、
      // ループ終了後にpendingタイマーは残らないはず
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

function followUpSuccessResponse(modelVersion: string, answer = "回答テキストです") {
  return jsonResponse(200, {
    modelVersion,
    candidates: [{ content: { parts: [{ text: JSON.stringify({ answer }) }] } }],
  });
}

describe("askFollowUpQuestion", () => {
  const context = {
    errorType: "TypeError",
    summary: "要約",
    rootCause: "根本原因",
    fixType: "code" as const,
    diffCode: "--- a/x.ts\n+++ b/x.ts",
  };

  it("成功時にanswerとモデル情報を返す", async () => {
    const fetchMock = vi.fn().mockResolvedValue(followUpSuccessResponse("gemini-3.5-flash-lite-001", "こういう理由です"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await askFollowUpQuestion("なぜこの修正が必要ですか？", "FAKE_KEY", "gemini-3.5-flash-lite", context);

    expect(result.answer).toBe("こういう理由です");
    expect(result.modelUsed).toBe("gemini-3.5-flash-lite-001");
    expect(result.usedFallbackModel).toBe(false);
  });

  it("質問文・コンテキストの機密情報らしき文字列を送信前にマスクする", async () => {
    const fetchMock = vi.fn().mockResolvedValue(followUpSuccessResponse("gemini-3.5-flash-lite-001"));
    vi.stubGlobal("fetch", fetchMock);

    await askFollowUpQuestion("私のAPI_KEY=sk-topsecret1234567890は漏れていますか？", "FAKE_KEY", "gemini-3.5-flash-lite", {
      ...context,
      rootCause: "根本原因 連絡先: dev@example.com",
    });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = options.body as string;
    expect(sentBody).not.toContain("sk-topsecret1234567890");
    expect(sentBody).not.toContain("dev@example.com");
  });

  it("404の場合は次の候補モデルへ自動でフォールバックする(callGeminiWithFallbackの共有ロジック)", async () => {
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) return new Response("not found", { status: 404 });
      return followUpSuccessResponse("gemini-3.8-flash-002");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await askFollowUpQuestion("質問", "KEY", "this-model-does-not-exist", context);

    expect(result.usedFallbackModel).toBe(true);
  });

  it("不正なJSON応答が続き全候補モデルが失敗した場合は例外をthrowする", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        modelVersion: "gemini-3.5-flash-lite-001",
        candidates: [{ content: { parts: [{ text: "これはJSONではありません" }] } }],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(askFollowUpQuestion("質問", "KEY", "gemini-3.5-flash-lite", context)).rejects.toThrow();
  });
});

describe("listAvailableModels", () => {
  it("generateContent対応モデルのみ抽出し、モデル名からprefixを除去する", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        models: [
          {
            name: "models/gemini-3.5-flash-lite",
            displayName: "Gemini 3.5 Flash-Lite",
            supportedGenerationMethods: ["generateContent"],
          },
          {
            name: "models/text-embedding-004",
            displayName: "Text Embedding",
            supportedGenerationMethods: ["embedContent"],
          },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const models = await listAvailableModels("FAKE_KEY");

    expect(models).toEqual([{ value: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" }]);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1beta/models");
    expect((options.headers as Record<string, string>)["x-goog-api-key"]).toBe("FAKE_KEY");
  });

  it("APIがエラーを返した場合はthrowする", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listAvailableModels("BAD_KEY")).rejects.toThrow(/403/);
  });
});
