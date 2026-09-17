import { useState } from "react";
import { MessageSquareText, Send, Loader2, KeyRound } from "lucide-react";
import { AnalysisResult, TokenUsage } from "./analyzer";
import { askFollowUpQuestion } from "./gemini";

export interface FollowUpEntry {
  id: string;
  question: string;
  answer: string;
  modelUsed?: string;
  usedFallbackModel?: boolean;
}

interface FollowUpPanelProps {
  analysis: AnalysisResult;
  /** 解析結果が別のものに切り替わるたびに親(App.tsx)がインクリメントする世代カウンタ。
   *  質問した時点のこの値をonAskedへ引き渡すことで、回答が届いた時点で表示中の
   *  解析結果と一致するかを親側で確認できるようにする（詳細はApp.tsxのonAsked実装参照）。 */
  analysisVersion: number;
  apiKey: string;
  selectedModel: string;
  entries: FollowUpEntry[];
  onAsked: (
    entry: FollowUpEntry,
    usage: { modelUsed?: string; tokenUsage?: TokenUsage; quotaExceededModels?: string[] },
    askedAtVersion: number
  ) => void;
  showToast: (message: string, type?: "success" | "info" | "warning") => void;
}

const MAX_QUESTION_LENGTH = 500;

/**
 * 解析結果（rootCause/diffCode等）に対して、ユーザーが自由記述で追加質問できるパネル。
 * 「開閉するモーダル」ではなく、解析結果に紐づいて常時表示されるインラインパネルという性質のため、
 * TerminalWatchModal.tsx等とは異なり意図的にModalではなくPanelと命名している。
 *
 * APIキー未設定時は機能自体を無効化し、案内文言のみ表示する。ローカル解析エンジン(analyzer.ts)は
 * 決定的な正規表現マッチングのみで自然言語の自由質問に意味的に応答する能力を持たないため、疑似的な
 * 応答を用意すると「理解していないのに回答しているように見える」誤った安心感を与えてしまう
 * （多層防御・誠実な失敗表示というこのアプリの設計哲学に反する）。
 */
export default function FollowUpPanel({
  analysis,
  analysisVersion,
  apiKey,
  selectedModel,
  entries,
  onAsked,
  showToast,
}: FollowUpPanelProps) {
  const [question, setQuestion] = useState("");
  const [isAsking, setIsAsking] = useState(false);

  if (!apiKey) {
    return (
      <div className="p-4 rounded-xl bg-slate-100 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 space-y-1.5">
        <div className="flex items-center space-x-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300">
          <MessageSquareText className="w-3.5 h-3.5" />
          <span>この結果について質問する</span>
        </div>
        <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed flex items-start space-x-1">
          <KeyRound className="w-3 h-3 mt-0.5 shrink-0" />
          <span>
            「なぜこの修正が必要か」等を深掘りできますが、Gemini
            APIキーが必要です。ローカル解析エンジンは決定的なルールベースのため、自由な質問には対応できません。
          </span>
        </p>
      </div>
    );
  }

  const handleAsk = async () => {
    const trimmed = question.trim();
    if (!trimmed || isAsking) return;
    // 応答が届くまでの間にユーザーが別の解析結果に切り替える可能性があるため、
    // 質問した時点のバージョンを捕捉しておき、onAsked経由で親に渡す。
    const askedAtVersion = analysisVersion;
    setIsAsking(true);
    try {
      // トークン消費対策として、過去のフォローアップ往復(entries)はプロンプトに含めない。
      // 毎回コンテキストとして送るのは元の解析結果のみとし、質問を重ねてもプロンプトが
      // 指数的に肥大化しないようにする（詳細はgemini.tsのaskFollowUpQuestionコメント参照）。
      const result = await askFollowUpQuestion(trimmed, apiKey, selectedModel, {
        errorType: analysis.errorType,
        summary: analysis.summary,
        rootCause: analysis.rootCause,
        fixType: analysis.fixType,
        diffCode: analysis.diffCode,
        taskSteps: analysis.taskSteps,
      });
      const entry: FollowUpEntry = {
        id: Date.now().toString(),
        question: trimmed,
        answer: result.answer,
        modelUsed: result.modelUsed,
        usedFallbackModel: result.usedFallbackModel,
      };
      onAsked(
        entry,
        {
          modelUsed: result.modelUsed,
          tokenUsage: result.tokenUsage,
          quotaExceededModels: result.quotaExceededModels,
        },
        askedAtVersion
      );
      setQuestion("");
    } catch (err) {
      showToast(`質問への回答に失敗しました: ${(err as Error).message}`, "warning");
    } finally {
      setIsAsking(false);
    }
  };

  return (
    <div className="p-4 rounded-xl bg-indigo-500/5 border border-indigo-500/20 space-y-3">
      <div className="flex items-center space-x-1.5 text-xs font-semibold text-indigo-700 dark:text-indigo-300">
        <MessageSquareText className="w-3.5 h-3.5" />
        <span>この結果について質問する</span>
      </div>

      {entries.length > 0 && (
        <div className="space-y-2">
          {entries.map((entry) => (
            <div key={entry.id} className="space-y-1">
              <p className="text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 rounded-lg px-3 py-1.5 inline-block">
                Q. {entry.question}
              </p>
              <p className="text-xs text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 leading-relaxed whitespace-pre-wrap">
                {entry.answer}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end space-x-2">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value.slice(0, MAX_QUESTION_LENGTH))}
          placeholder="例:「なぜこの修正が必要なのですか？」「他の直し方はありますか？」"
          rows={2}
          className="flex-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-800 focus:border-indigo-500 rounded-lg px-3 py-2 text-xs outline-none text-slate-800 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-600 resize-none"
        />
        <button
          onClick={handleAsk}
          disabled={isAsking || !question.trim()}
          className="shrink-0 flex items-center space-x-1.5 text-xs px-3 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white font-semibold transition cursor-pointer active:scale-95"
        >
          {isAsking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          <span>{isAsking ? "質問中..." : "質問する"}</span>
        </button>
      </div>
    </div>
  );
}
