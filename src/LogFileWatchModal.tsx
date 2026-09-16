import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FileText, X, Play, Square, FolderOpen, AlertTriangle, CheckCircle2 } from "lucide-react";
import { looksLikeErrorText } from "./analyzer";

interface LogFileWatchModalProps {
  open: boolean;
  onClose: () => void;
  /** エラーらしき行を検知した際に呼ばれる。第2引数は「自動解析」トグルがONだったか */
  onDetectedError: (capturedText: string, autoAnalyze: boolean) => void;
  showToast: (message: string, type?: "success" | "info" | "warning") => void;
  /** 監視の実行状態が変化するたびに呼ばれる。ヘッダーボタン等、モーダルの外に
   *  「今、監視中かどうか」を表示するために使う（モーダルを閉じていても分かるように）。 */
  onRunningChange?: (isRunning: boolean) => void;
}

// あまり多くのログを保持し続けるとメモリ・描画コストが増えるため、直近分のみ保持する
// （ターミナル監視モードと同じ考え方・同じ上限値）
const MAX_LINES = 500;
// エラー検知時にAnalysisResultへ渡すのは直近何行分か（長すぎるとGeminiのプロンプトが肥大化するため）
const CAPTURE_LAST_N_LINES = 150;

const FILE_PATH_STORAGE_KEY = "debug_buddy_log_file_watch_path";
const AUTO_ANALYZE_STORAGE_KEY = "debug_buddy_log_file_watch_auto_analyze";

export default function LogFileWatchModal({ open, onClose, onDetectedError, showToast, onRunningChange }: LogFileWatchModalProps) {
  const [filePath, setFilePath] = useState<string>(() => localStorage.getItem(FILE_PATH_STORAGE_KEY) || "");
  const [isPickingFile, setIsPickingFile] = useState<boolean>(false);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [isSyncingState, setIsSyncingState] = useState<boolean>(true);
  const [isStarting, setIsStarting] = useState<boolean>(false);
  const [lines, setLines] = useState<string[]>([]);
  const [autoAnalyze, setAutoAnalyze] = useState<boolean>(() => localStorage.getItem(AUTO_ANALYZE_STORAGE_KEY) === "true");
  const [errorDetected, setErrorDetected] = useState<boolean>(false);
  const [startError, setStartError] = useState<string | null>(null);

  // イベントリスナー内から常に最新の値を読めるようにするためのref
  // （useEffectは[]依存で一度しか登録しないため、stateを直接読むとクロージャが古くなる）
  const autoAnalyzeRef = useRef(autoAnalyze);
  const onDetectedErrorRef = useRef(onDetectedError);
  const onCloseRef = useRef(onClose);
  const rawLinesRef = useRef<string[]>([]);
  const hasTriggeredRef = useRef(false);
  const outputBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    autoAnalyzeRef.current = autoAnalyze;
    localStorage.setItem(AUTO_ANALYZE_STORAGE_KEY, String(autoAnalyze));
  }, [autoAnalyze]);
  useEffect(() => {
    onDetectedErrorRef.current = onDetectedError;
  }, [onDetectedError]);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    localStorage.setItem(FILE_PATH_STORAGE_KEY, filePath);
  }, [filePath]);

  // 監視の実行状態をモーダルの外（ヘッダーボタン等）にも伝える
  useEffect(() => {
    onRunningChange?.(isRunning);
  }, [isRunning, onRunningChange]);

  // マウント時、実際にRust側で監視中かどうかを問い合わせて画面状態を補正する
  // （クリップボード監視モードと同じ理由: 開発中のリロードやアプリ再起動直後の食い違い防止）。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const running = await invoke<boolean>("is_log_file_watch_running");
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
  // （ターミナル監視・クリップボード監視と同様、モーダルを閉じてもRust側の監視自体は
  //  バックグラウンドで継続しているため、閉じている間に検知した内容も取りこぼさないようにする）。
  useEffect(() => {
    let cancelled = false;
    let unlistenFn: (() => void) | null = null;

    (async () => {
      try {
        const unlisten = await listen<{ line: string }>("log-file-output", (event) => {
          const { line } = event.payload;
          rawLinesRef.current = [...rawLinesRef.current, line].slice(-MAX_LINES);
          setLines((prev) => [...prev, line].slice(-MAX_LINES));

          // ログファイルの1行はターミナル出力と性質が近い（コマンド出力の1行）ため、
          // クリップボード向けの自由記述判定(looksLikeErrorTextFromClipboard)ではなく、
          // ターミナル監視と同じlooksLikeErrorTextを使う。
          if (!hasTriggeredRef.current && looksLikeErrorText(line)) {
            hasTriggeredRef.current = true;
            setErrorDetected(true);
            if (autoAnalyzeRef.current) {
              const captured = rawLinesRef.current.slice(-CAPTURE_LAST_N_LINES).join("\n");
              onDetectedErrorRef.current(captured, true);
              onCloseRef.current();
            }
          }
        });
        if (cancelled) {
          unlisten();
          return;
        }
        unlistenFn = unlisten;
      } catch {
        // Tauriアプリの外（ブラウザ単体プレビュー等）では @tauri-apps/api のイベントAPIが
        // 使えないため、静かに諦める（ログファイル監視機能自体が使えないだけで、他の画面には影響させない）
      }
    })();

    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  }, []);

  // 新しい行が来たら自動で一番下までスクロールする
  useEffect(() => {
    const box = outputBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines]);

  const handlePickFile = async () => {
    setIsPickingFile(true);
    try {
      const picked = await invoke<string | null>("pick_log_file");
      if (picked) setFilePath(picked);
    } catch {
      // ダイアログのキャンセル等は握りつぶす（致命的ではない）
    } finally {
      setIsPickingFile(false);
    }
  };

  const handleStart = async () => {
    if (!filePath.trim()) return;
    setStartError(null);
    setIsStarting(true);
    setLines([]);
    rawLinesRef.current = [];
    hasTriggeredRef.current = false;
    setErrorDetected(false);
    try {
      await invoke("start_log_file_watch", { path: filePath });
      setIsRunning(true);
      showToast("ログファイル監視を開始しました（開始時点より前の内容は対象外です）", "success");
    } catch (err) {
      setStartError(String(err).slice(0, 200));
    } finally {
      setIsStarting(false);
    }
  };

  const handleStop = async () => {
    try {
      await invoke("stop_log_file_watch");
      setIsRunning(false);
      showToast("ログファイル監視を停止しました", "info");
    } catch (err) {
      setStartError(String(err).slice(0, 200));
    }
  };

  const handleUseCapturedText = () => {
    const captured = rawLinesRef.current.slice(-CAPTURE_LAST_N_LINES).join("\n");
    onDetectedError(captured, false);
    onClose();
  };

  return (
    <div className={open ? "fixed inset-0 z-50 bg-slate-950/50 dark:bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4" : "hidden"}>
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-2xl w-full p-6 shadow-2xl space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <FileText className="w-5 h-5 text-cyan-600 dark:text-cyan-400" />
            <h3 className="font-bold text-sm text-slate-900 dark:text-white">ログファイル監視モード（試験的機能）</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-900 dark:hover:text-white transition p-1 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          指定したログファイル（常駐サーバー等、このアプリから直接起動していないプロセスが出力するもの）への
          追記を監視し、新しい行をリアルタイムで表示します。ウィンドウを閉じても監視は継続します。
          監視開始より前からファイルに書かれていた内容は対象外です（新たに追記された分のみを検知します）。
        </p>

        <div className="flex items-center space-x-2">
          <input
            type="text"
            value={filePath}
            onChange={(e) => setFilePath(e.target.value)}
            disabled={isRunning}
            placeholder="例: C:\\myapp\\logs\\error.log"
            className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 font-mono text-xs text-slate-800 dark:text-slate-200 outline-none focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/40 disabled:opacity-60 transition"
          />
          <button
            onClick={handlePickFile}
            disabled={isRunning || isPickingFile}
            className="shrink-0 text-xs px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50 text-slate-600 dark:text-slate-300 font-semibold flex items-center space-x-1.5 transition cursor-pointer"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            <span>{isPickingFile ? "選択中..." : "参照..."}</span>
          </button>
          {isSyncingState ? (
            <button
              disabled
              className="shrink-0 text-xs px-3.5 py-2 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400 font-semibold flex items-center space-x-1.5 opacity-70"
            >
              <span>状態確認中...</span>
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
              disabled={isStarting || !filePath.trim()}
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
          <span>エラーを検知したら確認なしで自動的に解析する（Gemini APIキー設定時は自動で送信されます）</span>
        </label>

        <div className="flex items-center space-x-2 text-[11px] text-slate-400 dark:text-slate-500">
          <span className={`w-2 h-2 rounded-full shrink-0 ${isRunning ? "bg-emerald-500 animate-pulse" : "bg-slate-400 dark:bg-slate-600"}`} />
          <span>
            {isSyncingState ? "状態を確認しています..." : isRunning ? "監視中... ファイルへの追記を待っています" : "未実行"}
          </span>
        </div>

        <div
          ref={outputBoxRef}
          className="h-64 overflow-y-auto rounded-lg bg-slate-950 dark:bg-black border border-slate-800 p-3 font-mono text-[11px] leading-relaxed space-y-0.5"
        >
          {lines.length === 0 ? (
            <p className="text-slate-600">（まだ出力はありません）</p>
          ) : (
            lines.map((line, idx) => (
              <p key={idx} className="text-slate-300">
                {line}
              </p>
            ))
          )}
        </div>

        {errorDetected && !autoAnalyze && (
          <div className="flex items-center justify-between gap-3 flex-wrap p-3 rounded-lg bg-amber-500/10 border border-amber-500/25">
            <p className="text-xs text-amber-700 dark:text-amber-300 flex items-center space-x-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>エラーの可能性がある出力を検知しました</span>
            </p>
            <button
              onClick={handleUseCapturedText}
              className="shrink-0 text-xs px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold flex items-center space-x-1.5 transition cursor-pointer"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>この内容を解析欄にセットして閉じる</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
