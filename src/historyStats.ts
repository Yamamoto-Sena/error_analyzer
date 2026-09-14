// 解析履歴（HistoryItem[]）を集計し、「振り返りダッシュボード」（HistoryDashboardModal.tsx）
// で表示するための純粋関数群。usageTracker.tsと同様、副作用（React state・localStorage）から
// 切り離した「読み込み→集計」の形にすることで、Vitestで直接テストできるようにしている。
//
// 重要な注意点: HistoryItem.timestamp（App.tsxのsaveToHistoryが生成）は
// `toLocaleTimeString`による「時刻のみ（例: "14:32"）」の文字列であり、日付情報を持たない。
// そのため時系列の判定・並び替えには使えない。一方でHistoryItem.idは`Date.now().toString()`
// （Unixミリ秒）で生成されており、正確な日時情報を持つため、本モジュールの集計は
// 必ずidを基準にする。idが数値化できない異常値の場合は、呼び出し元の配列の並び順
// （App.tsx側で常に新しい順に保たれている前提）にフォールバックし、日時自体はnullとする。

import { HistoryItem } from "./analyzer";

// エラー種別ごとに一貫した色を割り当てるためのカラーパレット
// （元はApp.tsxに定義されていたものをそのまま移設。既存の解析履歴モーダルの見た目を変えないため、
//  配列の並び・ハッシュ計算式は一切変更していない）
export const HISTORY_COLOR_PALETTE = [
  { text: "text-cyan-700 dark:text-cyan-300", bg: "bg-cyan-500/10", border: "border-cyan-500/25", bar: "bg-cyan-500" },
  { text: "text-rose-700 dark:text-rose-300", bg: "bg-rose-500/10", border: "border-rose-500/25", bar: "bg-rose-500" },
  { text: "text-amber-700 dark:text-amber-300", bg: "bg-amber-500/10", border: "border-amber-500/25", bar: "bg-amber-500" },
  { text: "text-emerald-700 dark:text-emerald-300", bg: "bg-emerald-500/10", border: "border-emerald-500/25", bar: "bg-emerald-500" },
  { text: "text-indigo-700 dark:text-indigo-300", bg: "bg-indigo-500/10", border: "border-indigo-500/25", bar: "bg-indigo-500" },
  { text: "text-purple-700 dark:text-purple-300", bg: "bg-purple-500/10", border: "border-purple-500/25", bar: "bg-purple-500" },
  { text: "text-teal-700 dark:text-teal-300", bg: "bg-teal-500/10", border: "border-teal-500/25", bar: "bg-teal-500" },
  { text: "text-sky-700 dark:text-sky-300", bg: "bg-sky-500/10", border: "border-sky-500/25", bar: "bg-sky-500" },
];

export function colorForErrorType(errorType: string) {
  let hash = 0;
  for (let i = 0; i < errorType.length; i++) {
    hash = (hash * 31 + errorType.charCodeAt(i)) >>> 0;
  }
  return HISTORY_COLOR_PALETTE[hash % HISTORY_COLOR_PALETTE.length];
}

/** HistoryItem.idをUnixミリ秒として解釈する。異常値（数値化できない等）の場合はnull。 */
function parseOccurredAt(item: HistoryItem): Date | null {
  const millis = Number(item.id);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  return new Date(millis);
}

export interface ErrorTypeFrequency {
  errorType: string;
  count: number;
  /** この種別が最後に発生した日時（idが異常値の項目しか無い場合はnull） */
  lastOccurredAt: Date | null;
}

/** エラー種別ごとの発生件数を、件数が多い順に集計する。 */
export function aggregateErrorTypeFrequency(history: HistoryItem[]): ErrorTypeFrequency[] {
  const map = new Map<string, { count: number; lastOccurredAt: Date | null }>();
  for (const item of history) {
    const key = item.result.errorType;
    const occurredAt = parseOccurredAt(item);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { count: 1, lastOccurredAt: occurredAt });
    } else {
      existing.count += 1;
      // historyは新しい順に並んでいる前提のため、既に記録済みのlastOccurredAtの方が新しいか
      // 同等であるはずだが、念のためより新しい方を採用する（idが異常値の項目が混じっていても安全）。
      if (occurredAt && (!existing.lastOccurredAt || occurredAt > existing.lastOccurredAt)) {
        existing.lastOccurredAt = occurredAt;
      }
    }
  }
  return Array.from(map.entries())
    .map(([errorType, v]) => ({ errorType, count: v.count, lastOccurredAt: v.lastOccurredAt }))
    .sort((a, b) => b.count - a.count);
}

export interface LearningDigestEntry {
  id: string;
  errorType: string;
  learningTitle: string;
  learningContent: string;
  filePath: string;
  occurredAt: Date | null;
}

/**
 * 直近の学習メモダイジェスト。historyは既に新しい順で並んでいる前提（App.tsxのsaveToHistoryが
 * 常に先頭へ追加するため）に依拠し、先頭からlimit件を取り出す。idのパースに失敗した項目が
 * 混じっていても、配列自体の並び順は信頼できるため問題なくフォールバックできる。
 */
export function buildRecentLearningDigest(history: HistoryItem[], limit = 5): LearningDigestEntry[] {
  return history.slice(0, limit).map((item) => ({
    id: item.id,
    errorType: item.result.errorType,
    learningTitle: item.result.learningTitle,
    learningContent: item.result.learningContent,
    filePath: item.result.filePath,
    occurredAt: parseOccurredAt(item),
  }));
}

/** 同一箇所での再発生（occurrenceCount >= minOccurrence）を、発生回数が多い順に抽出する。 */
export function computeRepeatOffenders(history: HistoryItem[], minOccurrence = 2): HistoryItem[] {
  return history.filter((item) => item.occurrenceCount >= minOccurrence).sort((a, b) => b.occurrenceCount - a.occurrenceCount);
}

export interface ModelUsageSplit {
  localCount: number;
  geminiCount: number;
  /** modelUsedが未設定など、ローカル/Geminiのどちらとも判別できなかった件数（通常は発生しない想定の防御的な値） */
  unknownCount: number;
}

/**
 * modelUsedが「ローカル解析エンジン」で始まるか（App.tsxが"ローカル解析エンジン（ルールベース）"
 * 等の文言をセットしている）でローカル/Gemini解析の内訳を集計する。
 */
export function computeModelUsageSplit(history: HistoryItem[]): ModelUsageSplit {
  let localCount = 0;
  let geminiCount = 0;
  let unknownCount = 0;
  for (const item of history) {
    const modelUsed = item.result.modelUsed;
    if (!modelUsed) {
      unknownCount++;
    } else if (modelUsed.startsWith("ローカル解析エンジン")) {
      localCount++;
    } else {
      geminiCount++;
    }
  }
  return { localCount, geminiCount, unknownCount };
}
