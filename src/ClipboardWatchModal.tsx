import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ClipboardPaste, X, Play, Square, AlertTriangle, CheckCircle2 } from "lucide-react";
import { looksLikeErrorTextFromClipboard } from "./analyzer";

interface ClipboardWatchModalProps {
  open: boolean;
  onClose: () => void;
  /** エラーらしきテキストを検知した際に呼ばれる。第2引数は「自動解析」トグルがONだったか */
  onDetectedError: (capturedText: string, autoAnalyze: boolean) => void;
  showToast: (message: string, type?: "success" | "info" | "warning") => void;
}

// バナー等でのプレビュー表示が長くなりすぎないようにする文字数
const PREVIEW_MAX_CHARS = 300;

export default function ClipboardWatchModal({ open, onClose, onDetectedError, showToast }: ClipboardWatchModalProps) {
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [isStarting, setIsStarting] = useState<boolean>(false);
  const [autoAnalyze, setAutoAnalyze] = useState<boolean>(
    () => localStorage.getItem("debug_buddy_clipboard_watch_auto_analyze") === "true"
  );
  const [startError, setStartError] = useState<string | null>(null);
  // 直近に検知した内容（自動解析OFF時、バナーでプレビュー表示するために保持）
  const [detectedPreview, setDetectedPreview] = useState<string | null>(null);
  const detectedTextRef = useRef<string>("");

  // イベントリスナー内から常に最新の値を読めるようにするためのref
  // （useEffectは[]依存で一度しか登録しないため、stateを直接読むとクロージャが古くなる）
  const autoAnalyzeRef = useRef(autoAnalyze);
  const onDetectedErrorRef = useRef(onDetectedError);

  useEffect(() => {
    autoAnalyzeRef.current = autoAnalyze;
    localStorage.setItem("debug_buddy_clipboard_watch_auto_analyze", String(autoAnalyze));
  }, [autoAnalyze]);
  useEffect(() => {
    onDetectedErrorRef.current = onDetectedError;
  }, [onDetectedError]);

  // Tauriイベントの購読は、モーダルの開閉に関わらずマウント時に一度だけ行う
  // （ターミナル監視モードと同様、モーダルを閉じてもRust側の監視自体はバックグラウンドで
  //  継続しているため、閉じている間に検知した内容も取りこぼさないようにする）。
  useEffect(() => {
    let cancelled = false;
    let unlistenFn: (() => void) | null = null;

    (async () => {
      try {
        const unlisten = await listen<{ text: string }>("clipboard-text-changed", (event) => {
          const { text } = event.payload;
          if (!looksLikeErrorTextFromClipboard(text)) return;

          detectedTextRef.current = text;
          setDetectedPreview(text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text);

          if (autoAnalyzeRef.current) {
            onDetectedErrorRef.current(text, true);
          }
        });
        if (cancelled) {
          unlisten();
          return;
        }
        unlistenFn = unlisten;
      } catch {
        // Tauriアプリの外（ブラウザ単体プレビュー等）では @tauri-apps/api のイベントAPIが
        // 使えないため、静かに諦める（クリップボード監視機能自体が使えないだけで、他の画面には影響させない）
      }
    })();

    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  }, []);

  const handleStart = async () => {
    setStartError(null);
    setIsStarting(true);
    setDetectedPreview(null);
    detectedTextRef.current = "";
    try {
      await invoke("start_clipboard_watch");
      setIsRunning(true);
      showToast("クリップボード監視を開始しました", "success");
    } catch (err) {
      setStartError(String(err).slice(0, 200));
    } finally {
      setIsStarting(false);
    }
  };

  const handleStop = async () => {
    try {
      await invoke("stop_clipboard_watch");
      setIsRunning(false);
      showToast("クリップボード監視を停止しました", "info");
    } catch (err) {
      setStartError(String(err).slice(0, 200));
    }
  };

  const handleUseCapturedText = () => {
    onDetectedError(detectedTextRef.current, false);
    onClose();
  };

  return (
    <div className={open ? "fixed inset-0 z-50 bg-slate-950/50 dark:bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4" : "hidden"}>
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-2xl w-full p-6 shadow-2xl space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <ClipboardPaste className="w-5 h-5 text-cyan-600 dark:text-cyan-400" />
            <h3 className="font-bold text-sm text-slate-900 dark:text-white">クリップボード監視モード（試験的機能）</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-900 dark:hover:text-white transition p-1 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          MotionBoard等、他のアプリで作業中に出たエラーメッセージをコピーするだけで、
          このアプリに貼り付けなくても自動で検知します。ウィンドウを閉じても監視は継続し、
          エラーらしきテキストをコピーするとログ欄に自動セットします
          （下のチェックを入れると、そのまま自動で解析まで実行できます）。
        </p>

        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/25">
          <p className="text-[11px] text-amber-700 dark:text-amber-300 leading-relaxed">
            ⚠️ ONの間は、クリップボードの内容を定期的に確認します。パスワード等の機密情報はGeminiへの送信前に自動マスキングされますが、
            意図しない内容を検知してしまう可能性があるため、必要なときだけONにしてください。
          </p>
        </div>

        <div className="flex items-center justify-end">
          {isRunning ? (
            <button
              onClick={handleStop}
              className="shrink-0 text-xs px-3.5 py-2 rounded-lg bg-rose-500 hover:bg-rose-400 text-white font-semibold flex items-center space-x-1.5 transition cursor-pointer active:scale-95"
            >
              <Square className="w-3.5 h-3.5" />
              <span>停止</span>
            </button>
          ) : (
            <button
              onClick={handleStart}
              disabled={isStarting}
              className="shrink-0 text-xs px-3.5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-semibold flex items-center space-x-1.5 transition cursor-pointer active:scale-95"
            >
              <Play className="w-3.5 h-3.5" />
              <span>{isStarting ? "起動中..." : "開始"}</span>
            </button>
          )}
        </div>

        {startError && (
          <p className="text-[11px] text-rose-600 dark:text-rose-400 flex items-center space-x-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>{startError}</span>
          </p>
        )}

        <label className="flex items-center space-x-2 text-[11px] text-slate-500 dark:text-slate-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoAnalyze}
            onChange={(e) => setAutoAnalyze(e.target.checked)}
            className="rounded border-slate-300 dark:border-slate-700 cursor-pointer"
          />
          <span>エラーらしき内容をコピーしたら確認なしで自動的に解析する（Gemini APIキー設定時は自動で送信されます）</span>
        </label>

        <div className="flex items-center space-x-2 text-[11px] text-slate-400 dark:text-slate-500">
          <span className={`w-2 h-2 rounded-full shrink-0 ${isRunning ? "bg-emerald-500 animate-pulse" : "bg-slate-400 dark:bg-slate-600"}`} />
          <span>{isRunning ? "監視中... 他のアプリでエラーをコピーしてください" : "未実行"}</span>
        </div>

        {detectedPreview && !autoAnalyze && (
          <div className="space-y-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/25">
            <p className="text-xs text-amber-700 dark:text-amber-300 flex items-center space-x-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>エラーの可能性があるテキストのコピーを検知しました</span>
            </p>
            <p className="text-[11px] font-mono text-slate-600 dark:text-slate-400 whitespace-pre-wrap break-words max-h-24 overflow-y-auto">
              {detectedPreview}
            </p>
            <div className="flex justify-end">
              <button
                onClick={handleUseCapturedText}
                className="shrink-0 text-xs px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold flex items-center space-x-1.5 transition cursor-pointer"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>この内容を解析欄にセットして閉じる</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
