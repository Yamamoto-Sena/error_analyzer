// Gemini APIのトークン消費量表示を、単なる「アプリを起動してからの累計（再起動で0に戻る）」
// ではなく、Google側の実際の日次クォータ（RPD: Requests Per Day）の集計境界に揃えるための
// モジュール。Googleの無料枠クォータは太平洋時間(PT)の深夜0時にリセットされるため、
// このアプリの集計もその境界に合わせてlocalStorageへ永続化することで、
// 「アプリを再起動したら0件に見えるが、実際はGoogle側でまだ今日分を使い切っている」
// という食い違いを防ぐ。
//
// 注意: Googleは第三者がAPIキー単位の残クォータを問い合わせられる公開APIを提供していない
// ため、あくまで「このアプリ経由で実際に送信したリクエストの記録」であり、Google公式の
// 正確な残クォータそのものではない（他のツール経由の利用も含まれない）。この限界はUI側の
// 説明文でも明示する。

export interface DailyModelUsage {
  /** この日、このモデルへ実際に送信したリクエスト数（RPDと直接比較できる数値） */
  requestCount: number;
  /** この日、このモデルで消費した合計トークン数 */
  tokenTotal: number;
  /** この日、Google側から日次クォータ超過(429 RESOURCE_EXHAUSTED, per-day)を実際に通知されたか */
  quotaExceededToday: boolean;
}

export interface DailyUsageState {
  /** 太平洋時間(PT)基準の日付キー（YYYY-MM-DD）。Googleの日次クォータ境界と一致させるため。 */
  periodKey: string;
  byModel: Record<string, DailyModelUsage>;
}

export const DAILY_USAGE_STORAGE_KEY = "debug_buddy_daily_gemini_usage";

// localStorage.getItem/setItemだけに依存する最小インターフェース（テスト時に差し替えるため）
export interface SimpleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** テスト用（vitestは`environment: "node"`のためlocalStorageが存在しない）のメモリ実装。
 *  実アプリ（ブラウザ/Tauri WebView）では本物のlocalStorageが使われ、こちらは使われない。 */
export function createInMemoryStorage(): SimpleStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
  };
}

function defaultStorage(): SimpleStorage {
  return typeof localStorage !== "undefined" ? localStorage : createInMemoryStorage();
}

/** 指定日時を太平洋時間(PT)基準の "YYYY-MM-DD" に変換する（Googleの日次クォータ境界と揃える） */
export function getPacificDateKey(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function emptyState(periodKey: string): DailyUsageState {
  return { periodKey, byModel: {} };
}

/** 現在の日次集計を読み込む。太平洋時間の日付が変わっていれば自動的に空の状態から始める。 */
export function loadDailyUsage(now: Date = new Date(), storage: SimpleStorage = defaultStorage()): DailyUsageState {
  const currentKey = getPacificDateKey(now);
  try {
    const raw = storage.getItem(DAILY_USAGE_STORAGE_KEY);
    if (!raw) return emptyState(currentKey);
    const parsed = JSON.parse(raw) as Partial<DailyUsageState> | null;
    if (!parsed || typeof parsed !== "object" || parsed.periodKey !== currentKey) {
      // 日付境界(PT深夜0時)を跨いでいたら、Google側の日次クォータもリセットされているはず
      // なので、このアプリ側の集計も新しい日として作り直す。
      return emptyState(currentKey);
    }
    return { periodKey: currentKey, byModel: parsed.byModel && typeof parsed.byModel === "object" ? parsed.byModel : {} };
  } catch {
    // JSONが壊れている・localStorageが使えない環境では、実害を避けるため空の状態から始める
    return emptyState(currentKey);
  }
}

function persist(state: DailyUsageState, storage: SimpleStorage): void {
  try {
    storage.setItem(DAILY_USAGE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // プライベートブラウズ等でlocalStorageに書けない場合は、画面表示だけ諦める（致命的ではない）
  }
}

/**
 * Gemini解析1回分の使用量を日次集計に加算し、保存したうえで新しい状態を返す。
 * `quotaExceededModels` には、今回のリクエストでGoogle側から実際に「日次クォータ超過」の
 * 429を受け取ったモデル名を渡す（推測ではなく、Google自身からの信号をそのまま記録する）。
 */
export function recordGeminiUsage(
  modelUsed: string,
  tokens: number,
  quotaExceededModels: string[] = [],
  now: Date = new Date(),
  storage: SimpleStorage = defaultStorage()
): DailyUsageState {
  const state = loadDailyUsage(now, storage);

  const current = state.byModel[modelUsed] ?? { requestCount: 0, tokenTotal: 0, quotaExceededToday: false };
  state.byModel[modelUsed] = {
    requestCount: current.requestCount + 1,
    tokenTotal: current.tokenTotal + tokens,
    quotaExceededToday: current.quotaExceededToday,
  };

  for (const model of quotaExceededModels) {
    const entry = state.byModel[model] ?? { requestCount: 0, tokenTotal: 0, quotaExceededToday: false };
    state.byModel[model] = { ...entry, quotaExceededToday: true };
  }

  persist(state, storage);
  return state;
}

/** 本日の合計トークン消費量（全モデル合算） */
export function totalTokensToday(state: DailyUsageState): number {
  return Object.values(state.byModel).reduce((sum, m) => sum + m.tokenTotal, 0);
}

/** 本日、日次クォータ超過をGoogle側から実際に通知されたモデル名の一覧 */
export function modelsWithQuotaExceededToday(state: DailyUsageState): string[] {
  return Object.entries(state.byModel)
    .filter(([, usage]) => usage.quotaExceededToday)
    .map(([model]) => model);
}

/** ヘッダーのトークンバッジに表示するツールチップ本文（モデル別の内訳＋注意書き） */
export function formatDailyUsageTooltip(state: DailyUsageState): string {
  const lines = Object.entries(state.byModel).map(
    ([model, usage]) =>
      `${model}: ${usage.requestCount}回 / ${usage.tokenTotal.toLocaleString()} tokens${
        usage.quotaExceededToday ? "（本日、日次上限超過をGoogle側から検知）" : ""
      }`
  );
  return [
    "太平洋時間(PT)の日付が変わるとGoogle側の日次クォータ(RPD)と合わせてリセットされます。",
    "このアプリ経由で実際に送信したリクエストの記録であり、他のツール経由の利用や",
    "Google側の正確な残クォータそのものではない点にご注意ください。",
    ...(lines.length > 0 ? ["", ...lines] : []),
  ].join("\n");
}
