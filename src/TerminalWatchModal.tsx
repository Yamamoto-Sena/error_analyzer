import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal, X, Play, Square, FolderOpen, AlertTriangle, CheckCircle2 } from "lucide-react";

interface TerminalWatchModalProps {
  open: boolean;
  onClose: () => void;
  projectRoot: string | null;
  onPickProjectRoot: () => void;
  /** エラーらしき出力を検知した際に呼ばれる。第2引数は「自動解析」トグルがONだったか */
  onDetectedError: (capturedText: string, autoAnalyze: boolean) => void;
}

interface OutputLine {
  stream: "stdout" | "stderr";
  text: string;
}

// あまり多くのログを保持し続けるとメモリ・描画コストが増えるため、直近分のみ保持する
const MAX_LINES = 500;
// エラー検知時にAnalysisResultへ渡すのは直近何行分か（長すぎるとGeminiのプロンプトが肥大化するため）
const CAPTURE_LAST_N_LINES = 150;

// 「エラーらしい」と判定する高確度なキーワードのみに絞ったヒューリスティック。
// 一般的な "error" という単語だけだと、正常系ログでも頻出し誤検知が多くなるため含めない。
const ERROR_SIGNAL_PATTERN =
  /EADDRINUSE|Traceback \(most recent call last\)|Unhandled[ A-Za-z]*Rejection|FATAL ERROR|npm ERR!|error TS\d{4,5}|Segmentation fault|panic:|Exception in thread|NullPointerException|CONFLICT \(content\)/i;

const DEFAULT_COMMAND = "npm run dev";

export default function TerminalWatchModal({
  open,
  onClose,
  projectRoot,
  onPickProjectRoot,
  onDetectedError,
}: TerminalWatchModalProps) {
  const [command, setCommand] = useState<string>(() => localStorage.getItem("debug_buddy_watch_command") || DEFAULT_COMMAND);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [isStarting, setIsStarting] = useState<boolean>(false);
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [exitCode, setExitCode] = useState<number | null | undefined>(undefined); // undefined=未終了
  const [autoAnalyze, setAutoAnalyze] = useState<boolean>(
    () => localStorage.getItem("debug_buddy_watch_auto_analyze") === "true"
  );
  const [errorDetected, setErrorDetected] = useState<boolean>(false);
  const [pendingCapturedText, setPendingCapturedText] = useState<string>("");
  const [startError, setStartError] = useState<string | null>(null);

  // イベントリスナー内から常に最新の値を読めるようにするためのref
  // （useEffectは[]依存で一度しか登録しないため、stateを直接読むとクロージャが古くなる）
  const autoAnalyzeRef = useRef(autoAnalyze);
  const onDetectedErrorRef = useRef(onDetectedError);
  const rawLinesRef = useRef<string[]>([]);
  const hasTriggeredRef = useRef(false);
  const outputBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    autoAnalyzeRef.current = autoAnalyze;
    localStorage.setItem("debug_buddy_watch_auto_analyze", String(autoAnalyze));
  }, [autoAnalyze]);
  useEffect(() => {
    onDetectedErrorRef.current = onDetectedError;
  }, [onDetectedError]);
  useEffect(() => {
    localStorage.setItem("debug_buddy_watch_command", command);
  }, [command]);

  // Tauriイベントの購読は、モーダルの開閉に関わらずマウント時に一度だけ行う。
  // (モーダルを閉じてもRust側のプロセス監視自体はバックグラウンドで継続しているため、
  //  出力を取りこぼさないよう常時購読しておく)
  useEffect(() => {
    let cancelled = false;
    const unlistenFns: Array<() => void> = [];

    (async () => {
      try {
        const unlistenOutput = await listen<{ stream: "stdout" | "stderr"; line: string }>(
          "terminal-output",
          (event) => {
            const { stream, line } = event.payload;
            rawLinesRef.current = [...rawLinesRef.current, line].slice(-MAX_LINES);
            setLines((prev) => [...prev, { stream, text: line }].slice(-MAX_LINES));

            if (!hasTriggeredRef.current && ERROR_SIGNAL_PATTERN.test(line)) {
              triggerDetection();
            }
          }
        );
        if (cancelled) {
          unlistenOutput();
          return;
        }
        unlistenFns.push(unlistenOutput);

        const unlistenExit = await listen<{ code: number | null }>("terminal-exit", (event) => {
          setIsRunning(false);
          setExitCode(event.payload.code);
          // 非ゼロ終了は、途中経過のログでキーワードに引っかからなくても「エラーの可能性」とみなす
          if (!hasTriggeredRef.current && event.payload.code !== null && event.payload.code !== 0) {
            triggerDetection();
          }
        });
        if (cancelled) {
          unlistenExit();
          return;
        }
        unlistenFns.push(unlistenExit);
      } catch {
        // Tauriアプリの外（ブラウザ単体プレビュー等）では @tauri-apps/api のイベントAPIが
        // 使えないため、静かに諦める（ターミナル監視機能自体が使えないだけで、他の画面には影響させない）
      }
    })();

    function triggerDetection() {
      hasTriggeredRef.current = true;
      const captured = rawLinesRef.current.slice(-CAPTURE_LAST_N_LINES).join("\n");
      setPendingCapturedText(captured);
      setErrorDetected(true);
      if (autoAnalyzeRef.current) {
        onDetectedErrorRef.current(captured, true);
      }
    }

    return () => {
      cancelled = true;
      unlistenFns.forEach((fn) => fn());
    };
  }, []);

  // 新しい行が来たら自動で一番下までスクロールする
  useEffect(() => {
    const box = outputBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines]);

  const handleStart = async () => {
    if (!projectRoot || !command.trim()) return;
    setStartError(null);
    setIsStarting(true);
    setLines([]);
    rawLinesRef.current = [];
    hasTriggeredRef.current = false;
    setErrorDetected(false);
    setPendingCapturedText("");
    setExitCode(undefined);
    try {
      await invoke("start_terminal_watch", { root: projectRoot, command });
      setIsRunning(true);
    } catch (err) {
      setStartError(String(err).slice(0, 200));
    } finally {
      setIsStarting(false);
    }
  };

  const handleStop = async () => {
    try {
      await invoke("stop_terminal_watch");
      // 実際の isRunning=false / exitCode設定は terminal-exit イベント受信時に行う
      // （リーダースレッドがEOFを検知してから状態確定するまでに少しラグがあるため）
    } catch (err) {
      setStartError(String(err).slice(0, 200));
    }
  };

  const handleUseCapturedText = () => {
    onDetectedError(pendingCapturedText, false);
    onClose();
  };

  return (
    <div className={open ? "fixed inset-0 z-50 bg-slate-950/50 dark:bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4" : "hidden"}>
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-2xl w-full p-6 shadow-2xl space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Terminal className="w-5 h-5 text-cyan-600 dark:text-cyan-400" />
            <h3 className="font-bold text-sm text-slate-900 dark:text-white">ターミナル監視モード（試験的機能）</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-900 dark:hover:text-white transition p-1 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          開発コマンド（例: <code>npm run dev</code>）をこのアプリの中から実行し、出力をリアルタイムで表示します。
          ウィンドウを閉じても監視は継続し、エラーらしき出力を検知するとログ欄に自動セットします
          （下のチェックを入れると、そのまま自動で解析まで実行できます）。
        </p>

        {!projectRoot ? (
          <div className="flex items-center justify-between gap-3 flex-wrap p-3 rounded-lg bg-amber-500/10 border border-amber-500/25">
            <p className="text-xs text-amber-700 dark:text-amber-300">コマンドの実行にはプロジェクトフォルダの選択が必要です。</p>
            <button
              onClick={onPickProjectRoot}
              className="shrink-0 text-xs px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold flex items-center space-x-1.5 transition cursor-pointer"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span>フォルダを選択</span>
            </button>
          </div>
        ) : (
          <div className="flex items-center space-x-2">
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              disabled={isRunning}
              placeholder="npm run dev"
              className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 font-mono text-xs text-slate-800 dark:text-slate-200 outline-none focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/40 disabled:opacity-60 transition"
            />
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
                disabled={isStarting || !command.trim()}
                className="shrink-0 text-xs px-3.5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-semibold flex items-center space-x-1.5 transition cursor-pointer active:scale-95"
              >
                <Play className="w-3.5 h-3.5" />
                <span>{isStarting ? "起動中..." : "開始"}</span>
              </button>
            )}
          </div>
        )}

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
            {isRunning
              ? "実行中..."
              : exitCode === undefined
              ? "未実行"
              : exitCode === null
              ? "終了しました（終了コード不明）"
              : exitCode === 0
              ? "正常終了しました（終了コード 0）"
              : `終了コード ${exitCode} で終了しました`}
          </span>
        </div>

        <div
          ref={outputBoxRef}
          className="h-64 overflow-y-auto rounded-lg bg-slate-950 dark:bg-black border border-slate-800 p-3 font-mono text-[11px] leading-relaxed space-y-0.5"
        >
          {lines.length === 0 ? (
            <p className="text-slate-600">（まだ出力はありません）</p>
          ) : (
            lines.map((l, idx) => (
              <p key={idx} className={l.stream === "stderr" ? "text-rose-400" : "text-slate-300"}>
                {l.text}
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
