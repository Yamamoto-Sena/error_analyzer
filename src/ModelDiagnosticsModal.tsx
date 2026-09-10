import { useState } from "react";
import { Cpu, X, Play, CheckCircle2, XCircle, AlertTriangle, Clock3, Copy, Check } from "lucide-react";
import { diagnoseModels, ModelDiagnosticResult } from "./gemini";
import { GeminiModelOption } from "./models";

interface ModelDiagnosticsModalProps {
  open: boolean;
  onClose: () => void;
  apiKey: string;
  models: GeminiModelOption[];
}

const STATUS_META: Record<
  ModelDiagnosticResult["status"],
  { label: string; icon: typeof CheckCircle2; className: string }
> = {
  ok: { label: "利用可", icon: CheckCircle2, className: "text-emerald-600 dark:text-emerald-400" },
  unavailable: { label: "利用不可（権限/未対応）", icon: XCircle, className: "text-rose-600 dark:text-rose-400" },
  quota: { label: "利用不可（日次クォータ超過）", icon: XCircle, className: "text-rose-600 dark:text-rose-400" },
  rate_limited: { label: "判定不能（一時的な混雑）", icon: Clock3, className: "text-amber-600 dark:text-amber-400" },
  error: { label: "エラー", icon: AlertTriangle, className: "text-amber-600 dark:text-amber-400" },
};

export default function ModelDiagnosticsModal({ open, onClose, apiKey, models }: ModelDiagnosticsModalProps) {
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current?: string }>({ done: 0, total: 0 });
  const [results, setResults] = useState<ModelDiagnosticResult[] | null>(null);
  const [copied, setCopied] = useState(false);

  const handleRun = async () => {
    if (!apiKey || models.length === 0 || isRunning) return;
    setIsRunning(true);
    setResults(null);
    setProgress({ done: 0, total: models.length });
    try {
      const res = await diagnoseModels(apiKey, models, (done, total, current) => {
        setProgress({ done, total, current: current?.label });
      });
      setResults(res);
    } finally {
      setIsRunning(false);
    }
  };

  const unusable = (results ?? []).filter((r) => r.status !== "ok");

  const handleCopy = async () => {
    if (!results) return;
    const lines = results.map((r) => {
      const meta = STATUS_META[r.status];
      const detail = r.httpStatus ? `${r.httpStatus} ${r.message ?? ""}` : r.message ?? "";
      return `[${meta.label}] ${r.label} (${r.value})${detail ? ` — ${detail}` : ""}`;
    });
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // クリップボード権限が無い環境ではコピー自体を諦める（致命的ではないため）
    }
  };

  return (
    <div
      className={
        open
          ? "fixed inset-0 z-50 bg-slate-950/50 dark:bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4"
          : "hidden"
      }
    >
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-xl w-full p-6 shadow-2xl space-y-4 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2">
            <Cpu className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <h3 className="font-bold text-sm text-slate-900 dark:text-white">モデル診断</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-900 dark:hover:text-white transition p-1 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed shrink-0">
          プルダウンに表示されている{models.length}件のモデルへ、実際に軽量なリクエストを1件ずつ送って
          呼び出せるかどうかを確認します。モデルの数だけAPI呼び出し（クォータ消費）が発生するため、
          必要な時だけ実行してください。APIキーはGoogleのAPIにのみ送られ、他には送信されません。
        </p>

        {!apiKey ? (
          <p className="text-xs text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/25 rounded-lg p-3 shrink-0">
            APIキーが未設定です。先にGemini APIキーを設定してください。
          </p>
        ) : (
          <button
            onClick={handleRun}
            disabled={isRunning}
            className="shrink-0 self-start text-xs px-3.5 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white font-semibold flex items-center space-x-1.5 transition cursor-pointer active:scale-95"
          >
            <Play className="w-3.5 h-3.5" />
            <span>{isRunning ? `診断中... (${progress.done}/${progress.total})` : results ? "もう一度診断する" : "診断を開始"}</span>
          </button>
        )}

        {isRunning && progress.current && (
          <p className="text-[11px] text-slate-400 dark:text-slate-500 shrink-0">確認中: {progress.current}</p>
        )}

        {results && (
          <>
            <div className="flex items-center justify-between shrink-0">
              <p className="text-xs text-slate-600 dark:text-slate-300">
                {unusable.length === 0 ? (
                  <span className="text-emerald-600 dark:text-emerald-400 font-semibold">全{results.length}件、実際に利用できました</span>
                ) : (
                  <span>
                    <span className="text-rose-600 dark:text-rose-400 font-semibold">{unusable.length}件</span>
                    {" / "}
                    {results.length}件が実際には利用できませんでした
                  </span>
                )}
              </p>
              <button
                onClick={handleCopy}
                className="text-[11px] px-2.5 py-1 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition flex items-center space-x-1 cursor-pointer"
              >
                {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                <span>{copied ? "コピーしました" : "結果をコピー"}</span>
              </button>
            </div>

            <div className="overflow-y-auto space-y-1.5 pr-1">
              {results.map((r) => {
                const meta = STATUS_META[r.status];
                const Icon = meta.icon;
                return (
                  <div
                    key={r.value}
                    className="flex items-start space-x-2 text-xs px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50"
                  >
                    <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${meta.className}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-slate-800 dark:text-slate-100 truncate">{r.label}</span>
                        <span className={`shrink-0 text-[10px] font-semibold ${meta.className}`}>{meta.label}</span>
                      </div>
                      {r.status !== "ok" && (
                        <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5 break-words">
                          {r.httpStatus ? `HTTP ${r.httpStatus}: ` : ""}
                          {r.message || "詳細不明"}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
