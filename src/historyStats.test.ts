import { describe, expect, it } from "vitest";
import {
  aggregateErrorTypeFrequency,
  buildRecentLearningDigest,
  colorForErrorType,
  computeModelUsageSplit,
  computeRepeatOffenders,
} from "./historyStats";
import { AnalysisResult, HistoryItem } from "./analyzer";

// テスト用のダミーHistoryItemを組み立てるヘルパー。
// idはUnixミリ秒文字列（historyStats.tsの集計が基準にする値）として渡す。
function makeItem(overrides: {
  id: string;
  errorType: string;
  occurrenceCount?: number;
  modelUsed?: string;
  learningTitle?: string;
  learningContent?: string;
  filePath?: string;
}): HistoryItem {
  const result: AnalysisResult = {
    errorType: overrides.errorType,
    summary: "summary",
    rootCause: "rootCause",
    filePath: overrides.filePath ?? "src/App.tsx",
    lineNumber: "1",
    diffCode: "",
    learningTitle: overrides.learningTitle ?? "学習タイトル",
    learningContent: overrides.learningContent ?? "学習内容",
    preventionTips: [],
    modelUsed: overrides.modelUsed,
  };
  return {
    id: overrides.id,
    timestamp: "12:00",
    result,
    occurrenceCount: overrides.occurrenceCount ?? 1,
    pinned: false,
  };
}

describe("aggregateErrorTypeFrequency", () => {
  it("履歴が0件の場合は空配列を返す", () => {
    expect(aggregateErrorTypeFrequency([])).toEqual([]);
  });

  it("エラー種別ごとの件数を降順に集計する", () => {
    const history = [
      makeItem({ id: "3000", errorType: "TypeError" }),
      makeItem({ id: "2000", errorType: "SyntaxError" }),
      makeItem({ id: "1000", errorType: "TypeError" }),
    ];
    const result = aggregateErrorTypeFrequency(history);
    expect(result[0]).toMatchObject({ errorType: "TypeError", count: 2 });
    expect(result[1]).toMatchObject({ errorType: "SyntaxError", count: 1 });
  });

  it("最後に発生した日時(lastOccurredAt)は同一種別内で最も新しいidを採用する", () => {
    const history = [
      makeItem({ id: "1000", errorType: "TypeError" }),
      makeItem({ id: "5000", errorType: "TypeError" }),
    ];
    const result = aggregateErrorTypeFrequency(history);
    expect(result[0].lastOccurredAt?.getTime()).toBe(5000);
  });

  it("idが数値化できない異常値でも例外を投げず、lastOccurredAtはnullになる", () => {
    const history = [makeItem({ id: "not-a-number", errorType: "TypeError" })];
    const result = aggregateErrorTypeFrequency(history);
    expect(result[0].lastOccurredAt).toBeNull();
  });
});

describe("buildRecentLearningDigest", () => {
  it("履歴が0件の場合は空配列を返す", () => {
    expect(buildRecentLearningDigest([])).toEqual([]);
  });

  it("limit未満の件数でも、あるだけ返す", () => {
    const history = [makeItem({ id: "1000", errorType: "TypeError" })];
    expect(buildRecentLearningDigest(history, 5)).toHaveLength(1);
  });

  it("先頭からlimit件のみを取り出す(historyは新しい順に並んでいる前提)", () => {
    const history = [
      makeItem({ id: "3000", errorType: "A", learningTitle: "最新" }),
      makeItem({ id: "2000", errorType: "B", learningTitle: "2番目" }),
      makeItem({ id: "1000", errorType: "C", learningTitle: "3番目" }),
    ];
    const digest = buildRecentLearningDigest(history, 2);
    expect(digest.map((d) => d.learningTitle)).toEqual(["最新", "2番目"]);
  });
});

describe("computeRepeatOffenders", () => {
  it("occurrenceCountが1の項目は含まれない", () => {
    const history = [
      makeItem({ id: "1000", errorType: "TypeError", occurrenceCount: 1 }),
      makeItem({ id: "2000", errorType: "SyntaxError", occurrenceCount: 3 }),
    ];
    const result = computeRepeatOffenders(history);
    expect(result).toHaveLength(1);
    expect(result[0].result.errorType).toBe("SyntaxError");
  });

  it("履歴が0件の場合は空配列を返す", () => {
    expect(computeRepeatOffenders([])).toEqual([]);
  });

  it("発生回数が多い順に並ぶ", () => {
    const history = [
      makeItem({ id: "1000", errorType: "A", occurrenceCount: 2 }),
      makeItem({ id: "2000", errorType: "B", occurrenceCount: 5 }),
    ];
    const result = computeRepeatOffenders(history);
    expect(result.map((i) => i.result.errorType)).toEqual(["B", "A"]);
  });
});

describe("computeModelUsageSplit", () => {
  it("modelUsedの接頭辞でローカル/Geminiを判別する", () => {
    const history = [
      makeItem({ id: "1000", errorType: "A", modelUsed: "ローカル解析エンジン(ルールベース)" }),
      makeItem({ id: "2000", errorType: "B", modelUsed: "gemini-3.8-flash-002" }),
      makeItem({ id: "3000", errorType: "C", modelUsed: undefined }),
    ];
    expect(computeModelUsageSplit(history)).toEqual({ localCount: 1, geminiCount: 1, unknownCount: 1 });
  });

  it("履歴が0件の場合は全て0になる", () => {
    expect(computeModelUsageSplit([])).toEqual({ localCount: 0, geminiCount: 0, unknownCount: 0 });
  });
});

describe("colorForErrorType", () => {
  it("同じ入力に対して常に同じ色を返す(決定性)", () => {
    const first = colorForErrorType("TypeError");
    const second = colorForErrorType("TypeError");
    expect(first).toBe(second);
  });

  it("異なる入力には異なる色が割り当たりうる(パレット内の値であること)", () => {
    const color = colorForErrorType("SyntaxError");
    expect(color.text).toContain("text-");
    expect(color.bar).toContain("bg-");
  });
});
