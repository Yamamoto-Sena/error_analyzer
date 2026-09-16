import { useMemo } from "react";
import { BarChart3, X, BookOpen, RotateCcw, Cpu, Cloud } from "lucide-react";
import { HistoryItem } from "./analyzer";
import {
  aggregateErrorTypeFrequency,
  buildRecentLearningDigest,
  colorForErrorType,
  computeModelUsageSplit,
  computeRepeatOffenders,
} from "./historyStats";

interface HistoryDashboardModalProps {
  open: boolean;
  onClose: () => void;
  history: HistoryItem[];
  /** 学習メモダイジェスト・再発ランキングの行をクリックした際に、該当する解析結果を開けるようにする */
  onSelectHistoryItem?: (item: HistoryItem) => void;
}

// 日時をローカル日付+時刻の短い表記に整形する（学習メモダイジェスト・再発ランキング表示用）
function formatOccurredAt(date: Date | null): string {
  if (!date) return "日時不明";
  return date.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function HistoryDashboardModal({ open, onClose, history, onSelectHistoryItem }: HistoryDashboardModalProps) {
  // historyは呼び出し元(App.tsx)で常に新しい順に保たれている前提。各集計はその前提に依拠する。
  const frequency = useMemo(() => aggregateErrorTypeFrequency(history), [history]);
  const digest = useMemo(() => buildRecentLearningDigest(history, 5), [history]);
  const repeatOffenders = useMemo(() => computeRepeatOffenders(history), [history]);
  const modelSplit = useMemo(() => computeModelUsageSplit(history), [history]);

  const maxFrequencyCount = frequency[0]?.count ?? 0;
  const modelTotal = modelSplit.localCount + modelSplit.geminiCount + modelSplit.unknownCount;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/50 dark:bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2">
            <BarChart3 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
            <h3 className="font-bold text-sm text-slate-900 dark:text-white">振り返りダッシュボード</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-900 dark:hover:text-white transition p-1 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        {history.length === 0 ? (
          <div className="text-center py-10 text-xs text-slate-400 dark:text-slate-500">
            まだ解析履歴がありません。エラーを解析するとここに振り返りが表示されます。
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-5 pr-1">
            {/* セクション1: エラー種別ごとの発生頻度 */}
            <section className="space-y-2">
              <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-300">よく詰まるエラー種別</h4>
              <div className="space-y-1.5">
                {frequency.map((f) => {
                  const color = colorForErrorType(f.errorType);
                  const widthPercent = maxFrequencyCount > 0 ? Math.max(6, (f.count / maxFrequencyCount) * 100) : 0;
                  return (
                    <div key={f.errorType} className="space-y-0.5">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className={`font-medium truncate ${color.text}`}>{f.errorType}</span>
                        <span className="text-slate-400 dark:text-slate-500 shrink-0 ml-2">
                          {f.count}件{f.lastOccurredAt ? ` ・ 最終 ${formatOccurredAt(f.lastOccurredAt)}` : ""}
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                        <div className={`h-full rounded-full ${color.bar}`} style={{ width: `${widthPercent}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* セクション2: 直近の学習メモダイジェスト */}
            <section className="space-y-2">
              <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center space-x-1.5">
                <BookOpen className="w-3.5 h-3.5" />
                <span>直近の学習メモ</span>
              </h4>
              <div className="space-y-1.5">
                {digest.map((entry) => (
                  <button
                    key={entry.id}
                    onClick={() => {
                      const item = history.find((h) => h.id === entry.id);
                      if (item) onSelectHistoryItem?.(item);
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-slate-800 dark:text-slate-100 truncate">{entry.learningTitle}</span>
                      <span className="text-[10px] text-slate-400 dark:text-slate-500 shrink-0">{formatOccurredAt(entry.occurredAt)}</span>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">{entry.learningContent}</p>
                  </button>
                ))}
              </div>
            </section>

            {/* セクション3: 繰り返し発生ランキング */}
            <section className="space-y-2">
              <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center space-x-1.5">
                <RotateCcw className="w-3.5 h-3.5" />
                <span>同じ問題の再発</span>
              </h4>
              {repeatOffenders.length === 0 ? (
                <p className="text-[11px] text-slate-400 dark:text-slate-500">同じ問題の再発はまだ検出されていません。</p>
              ) : (
                <div className="space-y-1.5">
                  {repeatOffenders.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => onSelectHistoryItem?.(item)}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-amber-500/25 bg-amber-500/10 hover:brightness-95 dark:hover:brightness-125 transition cursor-pointer"
                    >
                      <span className="text-xs text-amber-800 dark:text-amber-200 truncate">
                        {item.result.errorType} — {item.result.filePath}
                      </span>
                      <span className="text-[10px] font-semibold text-amber-700 dark:text-amber-300 shrink-0">
                        {item.occurrenceCount}回
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            {/* セクション4: ローカル/Gemini解析の利用比率 */}
            <section className="space-y-2">
              <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-300">解析エンジンの利用内訳</h4>
              <div className="flex items-center space-x-4 text-[11px] text-slate-600 dark:text-slate-300">
                <span className="flex items-center space-x-1">
                  <Cpu className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                  <span>ローカル解析: {modelSplit.localCount}件</span>
                </span>
                <span className="flex items-center space-x-1">
                  <Cloud className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                  <span>Gemini解析: {modelSplit.geminiCount}件</span>
                </span>
              </div>
              {/* 割合(%)は総数がある場合のみ実数の補足として表示し、少数件での極端なパーセンテージ表示を避ける */}
              {modelTotal > 0 && (
                <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden flex">
                  <div className="h-full bg-slate-400 dark:bg-slate-500" style={{ width: `${(modelSplit.localCount / modelTotal) * 100}%` }} />
                  <div className="h-full bg-indigo-500" style={{ width: `${(modelSplit.geminiCount / modelTotal) * 100}%` }} />
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
