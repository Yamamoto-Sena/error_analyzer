import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeWithGemini } from "./gemini";

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

  it("すべての候補モデルが失敗した場合は最終エラーをthrowする", async () => {
    // 呼び出しのたびに新しいResponseを返す(同一インスタンスを使い回すとbodyが
    // 2回目以降 "already been read" エラーになるため)
    const fetchMock = vi.fn().mockImplementation(async () => new Response("server error", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeWithGemini("log", "KEY", "gemini-3.5-flash-lite")).rejects.toThrow(/Gemini API エラー \(500\)/);
  });
});
