import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ClipboardPaste, X, Play, Square, AlertTriangle, CheckCircle2, Plus, FlaskConical } from "lucide-react";
import { looksLikeErrorTextFromClipboard, matchesCustomKeywords, normalizeForMatching } from "./analyzer";
import { useWatchConnection } from "./useWatchConnection";

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

// カスタム監視ワード（組み込みのキーワードでは拾えない、ユーザー固有のエラー文言を
// 自分で登録してもらうための機能）の保存先・上限
const CUSTOM_KEYWORDS_STORAGE_KEY = "debug_buddy_clipboard_watch_custom_keywords";
const MAX_CUSTOM_KEYWORDS = 20;
const MAX_CUSTOM_KEYWORD_LENGTH = 100;

function loadCustomKeywords(): string[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEYWORDS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export default function ClipboardWatchModal({ open, onClose, onDetectedError, showToast, onRunningChange }: ClipboardWatchModalProps) {
  const { isRunning, isSyncingState, isStarting, startError, start, stop } = useWatchConnection({
    startCommand: "start_clipboard_watch",
    stopCommand: "stop_clipboard_watch",
    isRunningCommand: "is_clipboard_watch_running",
    onRunningChange,
  });
  const [autoAnalyze, setAutoAnalyze] = useState<boolean>(
    () => localStorage.getItem("debug_buddy_clipboard_watch_auto_analyze") === "true"
  );
  // 直近に検知した内容（自動解析OFF時、バナーでプレビュー表示するために保持）
  const [detectedPreview, setDetectedPreview] = useState<string | null>(null);
  const detectedTextRef = useRef<string>("");

  // カスタム監視ワード（組み込みキーワードでは拾えない独自の言い回しを、
  // ユーザー自身に登録してもらうための一覧）
  const [customKeywords, setCustomKeywords] = useState<string[]>(loadCustomKeywords);
  const [newKeywordInput, setNewKeywordInput] = useState<string>("");

  // 「この文章は検知されるか？」を実際にコピーせずその場で確認できる動作テスト欄。
  // 「監視ワードを登録したのに検知されない」といった問い合わせの多くは、実際の
  // クリップボード内容と登録した文言が(見た目は同じでも)微妙に違うことが原因のため、
  // 実際の判定ロジックをそのまま使って自己診断できるようにしている。
  const [testInput, setTestInput] = useState<string>("");
  const testResult = useMemo(() => {
    if (!testInput.trim()) return null;
    // matchesCustomKeywords(testInput, [kw])をキーワードごとに呼ぶと、testInput側の
    // normalizeForMatching（NFKC正規化）が登録キーワード数分（最大MAX_CUSTOM_KEYWORDS件）
    // 無駄に繰り返される。ここではtestInputの正規化を1回だけ行い、各キーワードとの
    // 比較にはmatchesCustomKeywords自身の判定ロジック（正規化+小文字化して部分一致）を
    // 展開した形で使い回す。
    const normalizedInput = normalizeForMatching(testInput).toLowerCase();
    const matchedKeyword = customKeywords.find((kw) => {
      const trimmed = normalizeForMatching(kw);
      return trimmed !== "" && normalizedInput.includes(trimmed.toLowerCase());
    });
    if (matchedKeyword) return { detected: true, reason: `監視ワード「${matchedKeyword}」に一致` };
    if (looksLikeErrorTextFromClipboard(testInput)) return { detected: true, reason: "組み込みのエラー判定に一致" };
    return { detected: false, reason: null };
  }, [testInput, customKeywords]);

  // イベントリスナー内から常に最新の値を読めるようにするためのref
  // （useEffectは[]依存で一度しか登録しないため、stateを直接読むとクロージャが古くなる）
  const autoAnalyzeRef = useRef(autoAnalyze);
  const onDetectedErrorRef = useRef(onDetectedError);
  const onCloseRef = useRef(onClose);
  const customKeywordsRef = useRef(customKeywords);

  useEffect(() => {
    autoAnalyzeRef.current = autoAnalyze;
    localStorage.setItem("debug_buddy_clipboard_watch_auto_analyze", String(autoAnalyze));
  }, [autoAnalyze]);
  useEffect(() => {
    onDetectedErrorRef.current = onDetectedError;
  }, [onDetectedError]);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    customKeywordsRef.current = customKeywords;
    localStorage.setItem(CUSTOM_KEYWORDS_STORAGE_KEY, JSON.stringify(customKeywords));
  }, [customKeywords]);

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
          // カスタム監視ワードとの一致を組み込み判定より先に見る（ユーザーが明示的に
          // 登録した文言なので、20文字未満などの組み込みの足切りを受けさせないため）。
          const isErrorLike =
            matchesCustomKeywords(text, customKeywordsRef.current) || looksLikeErrorTextFromClipboard(text);
          if (!isErrorLike) return;

          detectedTextRef.current = text;

          if (autoAnalyzeRef.current) {
            // 自動解析はユーザーが明示的にオプトインした「手離れ」重視の動作のため、
            // 検知→解析開始まで行ったらモーダルも自動で閉じる。開いたままだと、
            // メイン画面の解析結果が見えず「コピーだけしたのに何も起きていないように
            // 見える」という違和感につながっていた。
            onDetectedErrorRef.current(text, true);
            onCloseRef.current();
          } else {
            setDetectedPreview(text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text);
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
    setDetectedPreview(null);
    detectedTextRef.current = "";
    const result = await start();
    if (result === "started") {
      showToast("クリップボード監視を開始しました", "success");
    } else if (result === "already-running") {
      // 画面側は「未実行」のつもりでも、実はRust側で既に監視中だった場合
      // （開発中のリロード等で画面の状態だけがリセットされた場合に起こりうる）。
      showToast("クリップボード監視は既に開始されていました（画面表示を修正しました）", "info");
    }
  };

  const handleStop = async () => {
    if (await stop()) {
      showToast("クリップボード監視を停止しました", "info");
    }
  };

  const handleUseCapturedText = () => {
    onDetectedError(detectedTextRef.current, false);
    onClose();
  };

  const handleAddKeyword = () => {
    const trimmed = newKeywordInput.trim();
    if (!trimmed) return;
    if (trimmed.length > MAX_CUSTOM_KEYWORD_LENGTH) {
      showToast(`監視ワードは${MAX_CUSTOM_KEYWORD_LENGTH}文字以内にしてください`, "warning");
      return;
    }
    if (customKeywords.some((kw) => kw.toLowerCase() === trimmed.toLowerCase())) {
      showToast("同じ監視ワードは既に登録されています", "info");
      setNewKeywordInput("");
      return;
    }
    if (customKeywords.length >= MAX_CUSTOM_KEYWORDS) {
      showToast(`監視ワードは${MAX_CUSTOM_KEYWORDS}件までです。不要なものを削除してから追加してください`, "warning");
      return;
    }
    setCustomKeywords((prev) => [...prev, trimmed]);
    setNewKeywordInput("");
  };

  const handleRemoveKeyword = (index: number) => {
    setCustomKeywords((prev) => prev.filter((_, i) => i !== index));
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

        <div className="space-y-2">
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            監視ワードを追加（任意）: 「エラー」「失敗」等の組み込みキーワードでは拾えない、MotionBoard等の固有の言い回しをここに登録すると、その文字列を含むコピー内容も検知されるようになります。
          </p>
          <div className="flex items-center space-x-2">
            <input
              type="text"
              value={newKeywordInput}
              onChange={(e) => setNewKeywordInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddKeyword();
                }
              }}
              placeholder="例: データの取得に失敗しました"
              maxLength={MAX_CUSTOM_KEYWORD_LENGTH}
              className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-xs text-slate-800 dark:text-slate-200 outline-none focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/40 transition"
            />
            <button
              onClick={handleAddKeyword}
              disabled={!newKeywordInput.trim()}
              className="shrink-0 text-xs px-3 py-1.5 rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-700 dark:text-slate-200 font-semibold flex items-center space-x-1 transition cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>追加</span>
            </button>
          </div>
          {customKeywords.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {customKeywords.map((kw, idx) => (
                <span
                  key={`${kw}-${idx}`}
                  className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-700 dark:text-cyan-300"
                >
                  <span className="max-w-[200px] truncate">{kw}</span>
                  <button
                    onClick={() => handleRemoveKeyword(idx)}
                    className="hover:text-rose-500 transition cursor-pointer"
                    title="この監視ワードを削除"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <label className="flex items-center space-x-1.5 text-[11px] text-slate-500 dark:text-slate-400">
            <FlaskConical className="w-3.5 h-3.5 shrink-0" />
            <span>動作テスト（実際にコピーせず、この文章が検知されるか確認できます）</span>
          </label>
          <input
            type="text"
            value={testInput}
            onChange={(e) => setTestInput(e.target.value)}
            placeholder="検知されるか確認したい文章を入力・貼り付け"
            className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-xs text-slate-800 dark:text-slate-200 outline-none focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/40 transition"
          />
          {testResult && (
            <p
              className={`text-[11px] flex items-center space-x-1.5 ${
                testResult.detected ? "text-emerald-600 dark:text-emerald-400" : "text-slate-500 dark:text-slate-400"
              }`}
            >
              {testResult.detected ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}
              <span>
                {testResult.detected ? `✅ 検知されます（${testResult.reason}）` : "❌ 検知されません（監視ワードの追加をご検討ください）"}
              </span>
            </p>
          )}
        </div>

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
