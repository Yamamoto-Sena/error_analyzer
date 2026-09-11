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
  /** 監視の実行状態が変化するたびに呼ばれる。ヘッダーボタン等、モーダルの外に
   *  「今、監視中かどうか」を表示するために使う（モーダルを閉じていても分かるように）。 */
  onRunningChange?: (isRunning: boolean) => void;
}

// バナー等でのプレビュー表示が長くなりすぎないようにする文字数
const PREVIEW_MAX_CHARS = 300;

export default function ClipboardWatchModal({ open, onClose, onDetectedError, showToast, onRunningChange }: ClipboardWatchModalProps) {
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [isSyncingState, setIsSyncingState] = useState<boolean>(true);
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

  // 監視の実行状態をモーダルの外（ヘッダーボタン等）にも伝える
  useEffect(() => {
    onRunningChange?.(isRunning);
  }, [isRunning, onRunningChange]);

  // マウント時、実際にRust側で監視中かどうかを問い合わせて画面状態を補正する。
  // これをしないと、開発中のリロードやアプリ再起動直後の画面表示は常に
  // isRunning=falseから始まってしまい、「実際にはバックグラウンドで監視が
  // 継続しているのに画面には『開始』ボタンしか出ない（＝停止ボタンが
  // どこにも無い）」という食い違いが起きうる。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const running = await invoke<boolean>("is_clipboard_watch_running");
        if (!cancelled) setIsRunning(running);
      } catch {
        // Tauriアプリの外（ブラウザ単体プレビュー等）では常にfalse扱いのままでよい
      } finally {
        if (!cancelled) setIsSyncingState(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      // 画面側は「未実行」のつもりでも、実はRust側で既に監視中だった場合
      // （開発中のリロード等で画面の状態だけがリセットされた場合に起こりうる）、
      // ここで実際の状態を問い合わせて補正する。これをしないと、エラーメッセージで
      // 「先に停止してください」と言われても、画面には停止ボタンが出ないままになる。
      try {
        const running = await invoke<boolean>("is_clipboard_watch_running");
        setIsRunning(running);
        if (running) {
          showToast("クリップボード監視は既に開始されていました（画面表示を修正しました）", "info");
        } else {
          setStartError(String(err).slice(0, 200));
        }
      } catch {
        setStartError(String(err).slice(0, 200));
      }
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
          {isSyncingState ? (
            <button
              disabled
              className="shrink-0 text-xs px-3.5 py-2 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400 font-semibold flex items-center space-x-1.5 opacity-70"
            >
              <span>現在の状態を確認中...</span>
            </button>
          ) : isRunning ? (
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
          <span>
            {isSyncingState
              ? "状態を確認しています..."
              : isRunning
              ? "監視中... 他のアプリでエラーをコピーしてください（このウィンドウを閉じても監視は続きます。停止するには、ここでもう一度開いて「停止」を押してください）"
              : "未実行"}
          </span>
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
