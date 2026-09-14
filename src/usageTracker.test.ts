import { describe, expect, it } from "vitest";
import {
  createInMemoryStorage,
  formatDailyUsageTooltip,
  getPacificDateKey,
  loadDailyUsage,
  modelsWithQuotaExceededToday,
  recordGeminiUsage,
  totalTokensToday,
} from "./usageTracker";

describe("getPacificDateKey", () => {
  it("UTC日時を太平洋時間(PT)基準のYYYY-MM-DDに変換する", () => {
    // 2024-01-02T03:00:00Z は太平洋標準時(UTC-8)では 2024-01-01 19:00
    expect(getPacificDateKey(new Date("2024-01-02T03:00:00Z"))).toBe("2024-01-01");
  });
});

describe("loadDailyUsage", () => {
  it("何も保存されていない場合は空の状態を返す", () => {
    const storage = createInMemoryStorage();
    const state = loadDailyUsage(new Date("2024-06-01T12:00:00Z"), storage);
    expect(state.byModel).toEqual({});
  });

  it("太平洋時間の日付が変わっていたら古い集計を破棄する", () => {
    const storage = createInMemoryStorage();
    recordGeminiUsage("gemini-3.5-flash-lite", 100, [], new Date("2024-06-01T12:00:00Z"), storage);
    // 翌日（PT基準で日付が変わるタイミング）に読み込むと、前日分は引き継がれない
    const nextDay = loadDailyUsage(new Date("2024-06-03T12:00:00Z"), storage);
    expect(nextDay.byModel).toEqual({});
  });
});

describe("recordGeminiUsage", () => {
  it("同じモデルへの複数回の呼び出しを積算する", () => {
    const storage = createInMemoryStorage();
    const now = new Date("2024-06-01T12:00:00Z");
    recordGeminiUsage("gemini-3.5-flash-lite", 100, [], now, storage);
    const state = recordGeminiUsage("gemini-3.5-flash-lite", 50, [], now, storage);
    expect(state.byModel["gemini-3.5-flash-lite"]).toEqual({
      requestCount: 2,
      tokenTotal: 150,
      quotaExceededToday: false,
    });
  });

  it("quotaExceededModelsに渡したモデルはquotaExceededTodayがtrueになる", () => {
    const storage = createInMemoryStorage();
    const now = new Date("2024-06-01T12:00:00Z");
    const state = recordGeminiUsage("gemini-3.8-pro", 200, ["gemini-3.5-flash-lite"], now, storage);
    expect(state.byModel["gemini-3.5-flash-lite"].quotaExceededToday).toBe(true);
    // クォータ超過として記録されるモデル自体は、まだ実際に使われた（成功した）わけではないので
    // リクエスト数・トークン数はゼロのまま
    expect(state.byModel["gemini-3.5-flash-lite"].requestCount).toBe(0);
  });

  it("一度立ったquotaExceededTodayフラグは、同日中の以後の呼び出しでも保持される", () => {
    const storage = createInMemoryStorage();
    const now = new Date("2024-06-01T12:00:00Z");
    recordGeminiUsage("gemini-3.8-pro", 200, ["gemini-3.5-flash-lite"], now, storage);
    const state = recordGeminiUsage("gemini-3.8-pro", 200, [], now, storage);
    expect(state.byModel["gemini-3.5-flash-lite"].quotaExceededToday).toBe(true);
  });
});

describe("totalTokensToday / modelsWithQuotaExceededToday", () => {
  it("全モデル合算のトークン数と、超過検知モデルの一覧を返す", () => {
    const storage = createInMemoryStorage();
    const now = new Date("2024-06-01T12:00:00Z");
    recordGeminiUsage("model-a", 100, [], now, storage);
    const state = recordGeminiUsage("model-b", 50, ["model-a"], now, storage);
    expect(totalTokensToday(state)).toBe(150);
    expect(modelsWithQuotaExceededToday(state)).toEqual(["model-a"]);
  });
});

describe("formatDailyUsageTooltip", () => {
  it("モデル別の内訳と注意書きを含む文字列を生成する", () => {
    const storage = createInMemoryStorage();
    const now = new Date("2024-06-01T12:00:00Z");
    const state = recordGeminiUsage("gemini-3.5-flash-lite", 100, [], now, storage);
    const tooltip = formatDailyUsageTooltip(state);
    expect(tooltip).toContain("gemini-3.5-flash-lite: 1回 / 100 tokens");
    expect(tooltip).toContain("太平洋時間");
  });
});
