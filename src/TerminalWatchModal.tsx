import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal, X, Play, Square, FolderOpen, AlertTriangle, CheckCircle2 } from "lucide-react";
import { looksLikeErrorText } from "./analyzer";

interface TerminalWatchModalProps {
  open: boolean;
  onClose: () => void;
  projectRoot: string | null;
  onPickProjectRoot: () => void;
  /** エラーらしき出力を検知した際に呼ばれる。第2引数は「自動解析」トグルがONだったか */
  onDetectedError: (capturedText: string, autoAnalyze: boolean) => void;
  /** コマンド欄への複数行貼り付けを1行に自動変換した際の案内などに使うトースト表示 */
  showToast: (message: string, type?: "success" | "info" | "warning") => void;
}

interface OutputLine {
  stream: "stdout" | "stderr";
  text: string;
}

// あまり多くのログを保持し続けるとメモリ・描画コストが増えるため、直近分のみ保持する
const MAX_LINES = 500;
// エラー検知時にAnalysisResultへ渡すのは直近何行分か（長すぎるとGeminiのプロンプトが肥大化するため）
const CAPTURE_LAST_N_LINES = 150;

const DEFAULT_COMMAND = "npm run dev";

export default function TerminalWatchModal({
  open,
  onClose,
  projectRoot,
  onPickProjectRoot,
  onDetectedError,
  showToast,
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
  const [startError, setStartError] = useState<string | null>(null);

  // イベントリスナー内から常に最新の値を読めるようにするためのref
  // （useEffectは[]依存で一度しか登録しないため、stateを直接読むとクロージャが古くなる）
  const autoAnalyzeRef = useRef(autoAnalyze);
  const onDetectedErrorRef = useRef(onDetectedError);
  const commandRef = useRef(command);
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
    commandRef.current = command;
    localStorage.setItem("debug_buddy_watch_command", command);
  }, [command]);

  // 直近の出力ログから解析欄へ渡すテキストを組み立てる。
  // 非ゼロ終了コードによる検知は、コマンドが実質何も標準出力/標準エラーへ
  // 書き出さないまま失敗するケース（例: シェルのクォート解釈の違いで
  // コマンド自体が起動に失敗する等）があり、その場合rawLinesRefが空のまま
  // になりうる。出力が空の場合でも「何が起きたか」を最低限伝えられるよう、
  // 実行コマンドと終了コードだけのフォールバック文を返す。
  const buildCapturedText = (exitCodeForFallback?: number | null) => {
    const raw = rawLinesRef.current.slice(-CAPTURE_LAST_N_LINES).join("\n");
    if (raw.trim()) return raw;
    const codeText = exitCodeForFallback === undefined ? "" : `\n終了コード: ${exitCodeForFallback ?? "不明"}`;
    return `（このコマンドは標準出力・標準エラーに何も出力しませんでした）\n実行コマンド: ${commandRef.current}${codeText}`;
  };

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

            if (!hasTriggeredRef.current && looksLikeErrorText(line)) {
              triggerDetection(undefined);
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
            triggerDetection(event.payload.code);
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

    function triggerDetection(exitCodeForFallback: number | null | undefined) {
      hasTriggeredRef.current = true;
      setErrorDetected(true);
      if (autoAnalyzeRef.current) {
        onDetectedErrorRef.current(buildCapturedText(exitCodeForFallback), true);
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

  // コマンド欄は1行用の<input>のため、複数行のスニペットを貼り付けても
  // ブラウザ側で改行が自動的に取り除かれ、コメント行と実行文がくっついた
  // 壊れた1行になってしまう（例: 行頭が`::`/`REM`/`#`等のコメントだと、
  // 残り全体が実行されず無視される）。貼り付け時点でこちらが割り込み、
  // コメント行を除いた残りをcmd.exeで正しく連続実行できる`&`区切りの
  // 1行に組み立て直す。
  const handleCommandPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    if (!pasted.includes("\n")) return; // 1行だけならブラウザ標準の貼り付けに任せる

    e.preventDefault();
    const allLines = pasted.split(/\r?\n/).map((l) => l.trim());
    const isCommentLine = (l: string) => l.startsWith("::") || l.startsWith("#") || /^rem\b/i.test(l);
    const meaningfulLines = allLines.filter((l) => l.length > 0 && !isCommentLine(l));

    if (meaningfulLines.length === 0) {
      showToast("貼り付けた内容がコメント行のみだったため、コマンド欄には反映していません", "warning");
      return;
    }

    setCommand(meaningfulLines.join(" & "));
    const hadComments = meaningfulLines.length < allLines.filter((l) => l.length > 0).length;
    showToast(
      `複数行が貼り付けられたため、cmd.exeで実行できる1行（"&"区切り）に自動変換しました${
        hadComments ? "（コメント行は除外）" : ""
      }`,
      "info"
    );
  };

  const handleUseCapturedText = () => {
    // 検知した瞬間(triggerDetection内)のスナップショットではなく、クリック時点で
    // 改めて組み立て直す。特に「非ゼロ終了コード」による検知は、直前まで出力されていた
    // 最後の数行がterminal-outputイベントとしてまだ画面に反映しきっていないタイミングと
    // 競合する可能性があり、その場合検知時点の内容が実際より少ないまま固まってしまう。
    // クリックはユーザーがバナーを見てから行う操作＝検知から確実に時間が経っているため、
    // ここで読み直せば出力の取りこぼしを避けられる（それでも出力自体が空の場合は、
    // buildCapturedTextが実行コマンド＋終了コードのフォールバック文を返す）。
    onDetectedError(buildCapturedText(exitCode), false);
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
              onPaste={handleCommandPaste}
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
