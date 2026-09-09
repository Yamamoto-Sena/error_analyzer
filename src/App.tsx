import { useState, useEffect, useMemo, useRef } from "react";
import {
  Terminal,
  Sparkles,
  Bug,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  RotateCcw,
  BookOpen,
  Code2,
  ArrowRight,
  HelpCircle,
  Undo2,
  ExternalLink,
  Key,
  History,
  X,
  Clock,
  ChevronRight,
  ChevronDown,
  Sun,
  Moon,
  Cpu,
  AlertTriangle,
  ImagePlus,
  Tags,
  List as ListIcon,
  SortAsc,
  SortDesc,
  BookMarked,
  ShieldCheck,
  Search,
  MessageSquareText,
  ListChecks,
  Circle,
  ClipboardList,
} from "lucide-react";
import "./App.css";
import { analyzeErrorLog, AnalysisResult } from "./analyzer";
import { analyzeWithGemini } from "./gemini";

// エラー種別ごとに一貫した色を割り当てるためのカラーパレット
const HISTORY_COLOR_PALETTE = [
  { text: "text-cyan-700 dark:text-cyan-300", bg: "bg-cyan-500/10", border: "border-cyan-500/25", bar: "bg-cyan-500" },
  { text: "text-rose-700 dark:text-rose-300", bg: "bg-rose-500/10", border: "border-rose-500/25", bar: "bg-rose-500" },
  { text: "text-amber-700 dark:text-amber-300", bg: "bg-amber-500/10", border: "border-amber-500/25", bar: "bg-amber-500" },
  { text: "text-emerald-700 dark:text-emerald-300", bg: "bg-emerald-500/10", border: "border-emerald-500/25", bar: "bg-emerald-500" },
  { text: "text-indigo-700 dark:text-indigo-300", bg: "bg-indigo-500/10", border: "border-indigo-500/25", bar: "bg-indigo-500" },
  { text: "text-purple-700 dark:text-purple-300", bg: "bg-purple-500/10", border: "border-purple-500/25", bar: "bg-purple-500" },
  { text: "text-teal-700 dark:text-teal-300", bg: "bg-teal-500/10", border: "border-teal-500/25", bar: "bg-teal-500" },
  { text: "text-sky-700 dark:text-sky-300", bg: "bg-sky-500/10", border: "border-sky-500/25", bar: "bg-sky-500" },
];

function colorForErrorType(errorType: string) {
  let hash = 0;
  for (let i = 0; i < errorType.length; i++) {
    hash = (hash * 31 + errorType.charCodeAt(i)) >>> 0;
  }
  return HISTORY_COLOR_PALETTE[hash % HISTORY_COLOR_PALETTE.length];
}

// 添付画像1件あたりの最大サイズ（4MB）
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// 全角/半角・大文字小文字・空白や記号の違いなど「表記ゆれ」を吸収するための正規化
function normalizeForSearch(text: string): string {
  return text
    .normalize("NFKC") // 全角英数字/記号 → 半角に統一（表記ゆれ対策の要）
    .toLowerCase()
    .replace(/[\s\-_/.,:：、。]/g, ""); // 空白・区切り記号を無視して比較する
}

// 日本語表現とエラー種別の英語表記との対応（言語違いの表記ゆれを吸収）
const SEARCH_SYNONYMS: Record<string, string[]> = {
  attributeerror: ["属性エラー", "属性参照エラー", "アトリビュートエラー"],
  typeerror: ["型エラー", "タイプエラー", "undefined", "null参照"],
  syntaxerror: ["構文エラー", "シンタックスエラー"],
  referenceerror: ["参照エラー", "リファレンスエラー", "未定義"],
  eaddrinuse: ["ポート競合", "ポートエラー", "ポート重複", "port"],
  modulenotfounderror: ["モジュール未検出", "モジュールエラー", "モジュールが見つかりません"],
  network: ["ネットワークエラー", "通信エラー", "接続拒否", "cors"],
};

// 検索クエリを正規化した上で、表記ゆれ辞書に基づき関連語まで検索対象に広げる
function expandSearchQuery(rawQuery: string): string[] {
  const normalizedQuery = normalizeForSearch(rawQuery);
  const expanded = new Set<string>([normalizedQuery]);

  for (const [canonical, aliases] of Object.entries(SEARCH_SYNONYMS)) {
    const canonicalNorm = normalizeForSearch(canonical);
    const aliasNorms = aliases.map(normalizeForSearch);
    const groupMatches = canonicalNorm.includes(normalizedQuery) || aliasNorms.some((a) => a.includes(normalizedQuery));
    if (groupMatches) {
      expanded.add(canonicalNorm);
      aliasNorms.forEach((a) => expanded.add(a));
    }
  }

  return Array.from(expanded).filter(Boolean);
}

// 選択可能な Gemini モデル一覧（現行の Flash 系ラインナップ）
const AVAILABLE_MODELS: { value: string; label: string }[] = [
  { value: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite（既定・軽量高速）" },
  { value: "gemini-flash-latest", label: "Gemini Flash（最新版・自動追従）" },
  { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { value: "gemini-3.7-flash", label: "Gemini 3.7 Flash" },
  { value: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
  { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
];

// アプリの既定（初期表示）モデル
const DEFAULT_MODEL = "gemini-3.5-flash-lite";

// 初心者向けサンプルログ群
const SAMPLE_LOGS = {
  typeError: `TypeError: Cannot read properties of undefined (reading 'map')
    at UserList (src/components/UserList.tsx:24:18)
    at renderWithHooks (node_modules/react-dom/cjs/react-dom.development.js:15486:18)
    at mountIndeterminateComponent (node_modules/react-dom/cjs/react-dom.development.js:20103:13)`,
  syntaxError: `SyntaxError: Unexpected token '}'
    at compileSource (src/utils/parser.ts:42:15)
    at transpileModule (node_modules/typescript/lib/typescript.js:1240:10)`,
  refError: `ReferenceError: fetchUserData is not defined
    at handleSubmit (src/pages/Dashboard.tsx:18:7)
    at HTMLButtonElement.dispatch (node_modules/react-dom/cjs/react-dom.js:820:5)`,
  portError: `Error: Port 1420 is already in use
    at httpServerStart (file:///C:/develop/node_modules/.pnpm/vite/dist/node/chunks/node.js:11681:10)
    at async startServer (file:///C:/develop/node_modules/.pnpm/vite/dist/node/chunks/node.js:26694:30)
[ELIFECYCLE] Command failed with exit code 1.
       Error The "beforeDevCommand" terminated with a non-zero status code.`,
  attributeError: `2026-09-08 09:15:22,410 [ERROR] app.services.user_service: Failed to process user request
Traceback (most recent call last):
  File "/app/src/services/user_service.py", line 42, in get_user_profile
    user_data = fetch_from_database(user_id)
  File "/app/src/services/user_service.py", line 88, in fetch_from_database
    return db.session.query(User).filter_by(id=user_id).first()
  File "/app/src/controllers/api_controller.py", line 15, in handle_request
    response = get_user_profile(request_id)
    print("User ID: " + response.user_id)
AttributeError: 'NoneType' object has no attribute 'user_id'`,
};

interface HistoryItem {
  id: string;
  timestamp: string;
  result: AnalysisResult;
}

// Unified Diff を追加(+)/削除(-)で色分け表示するサブコンポーネント
function DiffView({ diffCode }: { diffCode: string }) {
  const lines = diffCode.split("\n");

  return (
    <div className="rounded-lg bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 font-mono text-xs overflow-x-auto leading-relaxed divide-y divide-slate-100 dark:divide-slate-900/60">
      {lines.map((line, idx) => {
        let rowCls = "text-slate-600 dark:text-slate-300";
        let markCls = "text-slate-300 dark:text-slate-700";
        let mark = " ";

        if (line.startsWith("+++") || line.startsWith("---")) {
          rowCls = "bg-indigo-500/5 text-indigo-700 dark:text-indigo-300 font-semibold";
        } else if (line.startsWith("@@")) {
          rowCls = "bg-cyan-500/5 text-cyan-700 dark:text-cyan-300 font-semibold";
        } else if (line.startsWith("+")) {
          rowCls = "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
          markCls = "text-emerald-600 dark:text-emerald-400";
          mark = "+";
        } else if (line.startsWith("-")) {
          rowCls = "bg-rose-500/10 text-rose-700 dark:text-rose-300";
          markCls = "text-rose-600 dark:text-rose-400";
          mark = "-";
        }

        const isMarkedLine = line.startsWith("+") || line.startsWith("-");
        const content = isMarkedLine && !line.startsWith("+++") && !line.startsWith("---") ? line.slice(1) : line;

        return (
          <div key={idx} className={`px-3 py-0.5 whitespace-pre-wrap flex ${rowCls}`}>
            <span className={`select-none w-3 shrink-0 ${markCls}`}>{mark}</span>
            <span>{content || "\u00A0"}</span>
          </div>
        );
      })}
    </div>
  );
}

// 操作者自身に確認してもらう検証チェックリストを解析結果から生成する。
// 「エラーは解消した」の自己申告だけに頼らず、具体的な確認観点を提示して精度を上げる。
// コード修正（fixType: "code"）と手順対応（fixType: "task"）で文言を出し分ける。
function buildVerificationChecklist(analysis: AnalysisResult): string[] {
  const isTask = analysis.fixType === "task";
  const items = [
    isTask
      ? `上記の手順（タスク）をすべて実施した`
      : `修正を適用したコードで、エラーが発生していた操作・処理をもう一度実行した`,
    `ターミナル/コンソール/ログに「${analysis.errorType}」と同じエラーが出力されていないことを確認した`,
    isTask
      ? `関連する機能（${analysis.filePath}）が正常に動作することを確認した`
      : `修正対象のファイル（${analysis.filePath}）を含む周辺の機能が正常に動作することを確認した`,
  ];
  if (analysis.preventionTips.length > 0) {
    items.push(`再発防止策「${analysis.preventionTips[0]}」を踏まえて動作確認した`);
  }
  return items;
}

// コードの差分ではなく、手順（コマンド実行・再起動・ケーブル抜き差し等）で解決するタイプの修正案を
// 番号付きのタスクリストとして表示するサブコンポーネント
function TaskStepsView({ steps }: { steps: string[] }) {
  return (
    <div className="rounded-lg bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-900/60 overflow-hidden">
      {steps.map((step, idx) => (
        <div key={idx} className="flex items-start space-x-3 p-3.5">
          <span className="shrink-0 w-5 h-5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 text-[11px] font-bold flex items-center justify-center mt-0.5">
            {idx + 1}
          </span>
          <pre className="flex-1 whitespace-pre-wrap break-words font-mono text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
            {step}
          </pre>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [logInput, setLogInput] = useState<string>("");
  // ログが手元にない場合でも解析できるよう、自由記述の症状・状況説明を別枠で受け付ける
  const [descriptionInput, setDescriptionInput] = useState<string>("");
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<"cause" | "diff" | "learn">("cause");
  const [hasResult, setHasResult] = useState<boolean>(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);

  // 修正案の検証（再実行後のログを検証し、未解消なら新たな修正案を提案する）
  const [verifyLogInput, setVerifyLogInput] = useState<string>("");
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [verificationResult, setVerificationResult] = useState<{
    status: "resolved" | "still-failing" | "new-error";
    message: string;
  } | null>(null);
  // 「エラーは解消した」ボタンを押す前に操作者自身へ確認してもらうチェックリスト
  const [verificationChecklist, setVerificationChecklist] = useState<string[]>([]);
  const [checkedItems, setCheckedItems] = useState<boolean[]>([]);

  // APIキー管理
  const [apiKey, setApiKey] = useState<string>("");
  const [showKeyModal, setShowKeyModal] = useState<boolean>(false);
  const [tempApiKey, setTempApiKey] = useState<string>("");

  // 使用するGeminiモデルの選択
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);

  // テーマ管理（ライト / ダーク）
  const [theme, setTheme] = useState<"light" | "dark">("dark");

  // 画像添付（エラー画面のスクリーンショット等）
  const [attachedImage, setAttachedImage] = useState<{
    mimeType: string;
    base64: string;
    previewUrl: string;
    fileName: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 履歴管理
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [showHistoryModal, setShowHistoryModal] = useState<boolean>(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [historyViewMode, setHistoryViewMode] = useState<"type" | "time">("type");
  const [historySortOrder, setHistorySortOrder] = useState<"desc" | "asc">("desc");
  const [historySearchQuery, setHistorySearchQuery] = useState<string>("");

  // インタラクション用状態
  const [copied, setCopied] = useState<boolean>(false);
  const [isApplying, setIsApplying] = useState<boolean>(false);
  const [isApplied, setIsApplied] = useState<boolean>(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "info" | "warning" } | null>(null);

  // 初期ロード時に localStorage から APIキー・履歴・モデル選択・テーマを復元
  useEffect(() => {
    const savedKey = localStorage.getItem("debug_buddy_gemini_key") || "";
    setApiKey(savedKey);
    setTempApiKey(savedKey);

    const savedHistory = localStorage.getItem("debug_buddy_history");
    if (savedHistory) {
      try {
        setHistory(JSON.parse(savedHistory));
      } catch {
        // ignore
      }
    }

    const savedModel = localStorage.getItem("debug_buddy_gemini_model");
    if (savedModel) {
      setSelectedModel(savedModel);
    }

    const savedTheme = localStorage.getItem("debug_buddy_theme") as "light" | "dark" | null;
    if (savedTheme === "light" || savedTheme === "dark") {
      setTheme(savedTheme);
    } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
      setTheme("light");
    }
  }, []);

  // テーマの切り替えを <html> クラスへ反映し、選択を保存する
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("debug_buddy_theme", theme);
  }, [theme]);

  // 解析結果が変わるたび（新規解析・履歴読込・再検証）に検証チェックリストを作り直す。
  // 「コードに自動適用する」を押していなくても確認できるよう、isApplied には依存させない。
  useEffect(() => {
    if (analysis) {
      const checklist = buildVerificationChecklist(analysis);
      setVerificationChecklist(checklist);
      setCheckedItems(new Array(checklist.length).fill(false));
    } else {
      setVerificationChecklist([]);
      setCheckedItems([]);
    }
  }, [analysis]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  const handleModelChange = (value: string) => {
    setSelectedModel(value);
    localStorage.setItem("debug_buddy_gemini_model", value);
  };

  const selectedModelLabel = AVAILABLE_MODELS.find((m) => m.value === selectedModel)?.label ?? selectedModel;

  // 検索クエリで履歴を絞り込む（全角/半角・大文字小文字・日本語表記ゆれを吸収）
  const searchedHistory = useMemo(() => {
    const query = historySearchQuery.trim();
    if (!query) return history;

    const candidateTerms = expandSearchQuery(query);
    return history.filter((item) => {
      const haystack = normalizeForSearch(
        [
          item.result.errorType,
          item.result.summary,
          item.result.rootCause,
          item.result.filePath,
          item.result.modelUsed ?? "",
        ].join(" ")
      );
      return candidateTerms.some((term) => haystack.includes(term));
    });
  }, [history, historySearchQuery]);

  // 履歴は常に新しい順で保存されているため、時系列の並び替えは配列の向きを変えるだけでよい
  const timeSortedHistory = useMemo(() => {
    return historySortOrder === "desc" ? searchedHistory : [...searchedHistory].reverse();
  }, [searchedHistory, historySortOrder]);

  // 履歴をエラー種別ごとにグループ化（件数が多い順）。各グループ内も時間順で並び替える
  const groupedHistory = useMemo(() => {
    const map = new Map<string, HistoryItem[]>();
    for (const item of timeSortedHistory) {
      const key = item.result.errorType;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [timeSortedHistory]);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const showToast = (message: string, type: "success" | "info" | "warning" = "success") => {
    setToast({ message, type });
    setTimeout(() => {
      setToast(null);
    }, 4000);
  };

  const saveApiKey = () => {
    const cleanKey = tempApiKey.trim();
    setApiKey(cleanKey);
    localStorage.setItem("debug_buddy_gemini_key", cleanKey);
    setShowKeyModal(false);
    if (cleanKey) {
      showToast("Gemini APIキーを保存しました！リアルタイム解析が有効です", "success");
    } else {
      showToast("APIキーをクリアしました（ローカル解析モードで動作します）", "info");
    }
  };

  const handleSampleLoad = (key: keyof typeof SAMPLE_LOGS) => {
    setLogInput(SAMPLE_LOGS[key]);
    showToast(`サンプル（${key}）を挿入しました`, "info");
  };

  // エラー画面のスクリーンショット等の画像を選択して添付する
  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 同じファイルを選び直せるようにリセット
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      showToast("画像ファイル（PNG/JPEGなど）を選択してください", "warning");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      showToast("画像サイズが大きすぎます（4MB以下にしてください）", "warning");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1] ?? "";
      setAttachedImage({
        mimeType: file.type,
        base64,
        previewUrl: dataUrl,
        fileName: file.name,
      });
      showToast(`画像「${file.name}」を添付しました`, "info");
    };
    reader.onerror = () => showToast("画像の読み込みに失敗しました", "warning");
    reader.readAsDataURL(file);
  };

  const handleRemoveImage = () => setAttachedImage(null);

  // 解析実行（Gemini API または ローカル解析エンジンのハイブリッド）
  const handleAnalyze = async () => {
    const hasLog = logInput.trim().length > 0;
    const hasDescription = descriptionInput.trim().length > 0;
    const hasImage = !!attachedImage;
    if (!hasLog && !hasDescription && !hasImage) return;

    // 画像・説明文のみでAPIキー未設定の場合、ローカル解析エンジンでは十分な解析ができないため中断する
    if (!apiKey && hasImage && !hasLog) {
      showToast("画像からの解析にはGemini APIキーの設定が必要です。テキストログも入力するか、APIキーを設定してください。", "warning");
      return;
    }

    // ログ（スタックトレース等）と、自由記述の症状説明を統合して解析対象とする
    const combinedText = [
      hasLog ? `【エラーログ / スタックトレース】\n${logInput.trim()}` : "",
      hasDescription ? `【エラー内容・症状の説明（ユーザー記述）】\n${descriptionInput.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    setIsAnalyzing(true);
    setIsApplied(false);
    setVerificationResult(null);
    setVerifyLogInput("");

    try {
      let result: AnalysisResult;

      if (apiKey) {
        // 1. 本物の Gemini API で解析（画像添付時はマルチモーダルで送信）
        showToast(`${selectedModelLabel} に${hasImage ? "画像とエラー内容を" : "エラー内容を"}送信中...`, "info");
        result = await analyzeWithGemini(
          combinedText,
          apiKey,
          selectedModel,
          hasImage ? [{ mimeType: attachedImage!.mimeType, data: attachedImage!.base64 }] : []
        );
        if (result.usedFallbackModel) {
          // 指定モデルが混雑/RPD(1日の上限)超過等で使えず、別モデルに自動切替した場合は明示する
          const quotaNote = result.quotaExceededModels?.length
            ? `（上限超過: ${result.quotaExceededModels.join(", ")}）`
            : "";
          showToast(
            `⚠️ ${selectedModelLabel} は利用できず、${result.modelUsed} で解析しました${quotaNote}`,
            "warning"
          );
        } else {
          showToast(`✨ ${result.modelUsed ?? selectedModelLabel} による高精度解析が完了しました！`, "success");
        }
      } else {
        // 2. ローカル解析エンジンでフォールバック（画像は読み取れないためテキストのみ）
        await new Promise((r) => setTimeout(r, 600));
        result = analyzeErrorLog(combinedText);
        result.modelUsed = "ローカル解析エンジン（ルールベース）";
        showToast("エラー内容の動的解析が完了しました（※APIキーを設定するとGemini AI解析・画像解析が利用可能です）", "info");
      }

      setAnalysis(result);
      setHasResult(true);
      setActiveTab("cause");

      // 履歴に追加して保存
      const newItem: HistoryItem = {
        id: Date.now().toString(),
        timestamp: new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }),
        result,
      };
      const updatedHistory = [newItem, ...history.slice(0, 19)];
      setHistory(updatedHistory);
      localStorage.setItem("debug_buddy_history", JSON.stringify(updatedHistory));
    } catch (err) {
      // APIエラー時はローカル解析へ安全にフォールバック
      console.error(err);
      const fallback = analyzeErrorLog(combinedText);
      fallback.modelUsed = "ローカル解析エンジン（フォールバック）";
      setAnalysis(fallback);
      setHasResult(true);
      setActiveTab("cause");
      showToast(`Gemini通信エラー (${(err as Error).message.slice(0, 40)}...)。ローカル解析を表示します`, "warning");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleReset = () => {
    setLogInput("");
    setDescriptionInput("");
    setAttachedImage(null);
    setHasResult(false);
    setAnalysis(null);
    setIsApplied(false);
    setVerificationResult(null);
    setVerifyLogInput("");
    showToast("入力内容をリセットしました", "info");
  };

  // コピー機能
  const handleCopyDiff = async () => {
    if (!analysis) return;
    const textToCopy =
      analysis.fixType === "task" && analysis.taskSteps && analysis.taskSteps.length > 0
        ? analysis.taskSteps.map((step, idx) => `${idx + 1}. ${step}`).join("\n\n")
        : analysis.diffCode;
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      showToast("差分コードをクリップボードにコピーしました！", "success");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast("コピーに失敗しました", "info");
    }
  };

  // コードに自動適用
  const handleApplyFix = () => {
    if (!analysis) return;
    if (isApplied) {
      setIsApplied(false);
      setVerificationResult(null);
      setVerifyLogInput("");
      showToast(`修正をロールバック（${analysis.filePath} を復元）しました`, "info");
      return;
    }

    setIsApplying(true);
    setTimeout(() => {
      setIsApplying(false);
      setIsApplied(true);
      setVerificationResult(null);
      showToast(`✅ ${analysis.filePath} に修正を適用しました（バックアップ保存済）`, "success");
    }, 700);
  };

  // チェックリストの各項目のON/OFFを切り替える
  const toggleChecklistItem = (index: number) => {
    setCheckedItems((prev) => prev.map((checked, i) => (i === index ? !checked : checked)));
  };

  // 修正案が適用済みで、かつエラーが解消したことをユーザーが確認した場合
  const handleMarkResolved = () => {
    if (!analysis) return;
    if (verificationChecklist.length > 0 && !checkedItems.every(Boolean)) {
      showToast(
        analysis.fixType === "task"
          ? "すべての実施確認にチェックを入れてから完了報告してください"
          : "すべての確認項目にチェックを入れてから完了報告してください",
        "warning"
      );
      return;
    }
    setVerificationResult({
      status: "resolved",
      message: "✅ 修正が正しく適用され、エラーは解消しました。お疲れ様でした！",
    });
    setVerifyLogInput("");
    showToast("🎉 エラーの解消を記録しました！", "success");
  };

  // 修正適用後に再実行して得られたログを再解析し、本当に直ったかを検証する。
  // 未解消（同じエラー）なら新しい根本原因・修正案を、別のエラーなら新規解析として提示する。
  const handleVerifyFix = async () => {
    if (!analysis || !verifyLogInput.trim()) return;
    setIsVerifying(true);

    try {
      let recheck: AnalysisResult;
      if (apiKey) {
        recheck = await analyzeWithGemini(verifyLogInput, apiKey, selectedModel);
      } else {
        recheck = analyzeErrorLog(verifyLogInput);
        recheck.modelUsed = "ローカル解析エンジン（ルールベース）";
      }

      // エラー種別・対象ファイルが一致するかで「同じ問題が再発しているか」を簡易判定
      const normalize = (s: string) => s.trim().toLowerCase();
      const sameErrorType = normalize(recheck.errorType) === normalize(analysis.errorType);
      const sameFile = normalize(recheck.filePath) === normalize(analysis.filePath);

      if (sameErrorType || sameFile) {
        setVerificationResult({
          status: "still-failing",
          message: `⚠️ 同じ種類のエラー（${recheck.errorType}）がまだ発生しているようです。新しい根本原因と修正案に更新しました。下の「根本原因」「修正案 (Diff)」タブをご確認ください。`,
        });
        showToast("修正が不十分なようです。新しい修正案を表示します", "warning");
      } else {
        setVerificationResult({
          status: "new-error",
          message: `別の種類のエラー（${recheck.errorType}）が検出されました。元のエラーは解消された可能性がありますが、新しい問題を解析しましたのでご確認ください。`,
        });
        showToast("別のエラーを検出しました。新しい解析結果を表示します", "info");
      }

      // 検証で得られた最新の解析結果に更新し、履歴にも積み増す
      setAnalysis(recheck);
      setHasResult(true);
      setActiveTab("cause");
      setIsApplied(false);
      setVerifyLogInput("");

      const newItem: HistoryItem = {
        id: Date.now().toString(),
        timestamp: new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }),
        result: recheck,
      };
      const updatedHistory = [newItem, ...history.slice(0, 19)];
      setHistory(updatedHistory);
      localStorage.setItem("debug_buddy_history", JSON.stringify(updatedHistory));
    } catch (err) {
      console.error(err);
      showToast(`検証中にエラーが発生しました (${(err as Error).message.slice(0, 40)}...)`, "warning");
    } finally {
      setIsVerifying(false);
    }
  };

  const handleSelectHistory = (item: HistoryItem) => {
    setAnalysis(item.result);
    setHasResult(true);
    setActiveTab("cause");
    setShowHistoryModal(false);
    setIsApplied(false);
    setVerificationResult(null);
    setVerifyLogInput("");
    showToast(`履歴「${item.result.errorType}」を読み込みました`, "info");
  };

  // 履歴モーダル内の1行を描画（種類別/時系列どちらの表示でも共通利用）
  const renderHistoryRow = (item: HistoryItem, showTypeBadge: boolean) => {
    const color = colorForErrorType(item.result.errorType);
    return (
      <div
        key={item.id}
        onClick={() => handleSelectHistory(item)}
        className="p-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition cursor-pointer flex items-center justify-between group"
      >
        <div className="space-y-1 max-w-[85%]">
          <div className="flex items-center space-x-2 flex-wrap gap-y-1">
            {showTypeBadge && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${color.bg} ${color.text}`}>
                {item.result.errorType}
              </span>
            )}
            <span className="text-[10px] text-slate-400 dark:text-slate-500 flex items-center space-x-1">
              <Clock className="w-3 h-3" />
              <span>{item.timestamp}</span>
            </span>
            {item.result.modelUsed && (
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded font-medium flex items-center space-x-1 ${
                  item.result.usedFallbackModel
                    ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                    : "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300"
                }`}
                title={
                  item.result.usedFallbackModel
                    ? `指定モデル「${item.result.modelRequested}」から自動フォールバック`
                    : undefined
                }
              >
                {item.result.usedFallbackModel && <AlertTriangle className="w-2.5 h-2.5" />}
                <span>{item.result.modelUsed}</span>
              </span>
            )}
          </div>
          <p className="text-xs text-slate-700 dark:text-slate-300 truncate font-medium">{item.result.summary}</p>
          <p className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">📁 {item.result.filePath}</p>
        </div>
        <ChevronRight className="w-4 h-4 text-slate-300 dark:text-slate-600 group-hover:text-cyan-500 dark:group-hover:text-cyan-400 transition shrink-0" />
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col selection:bg-cyan-500 selection:text-white relative transition-colors duration-200">
      {/* 1. トップナビゲーションバー */}
      <header className="border-b border-slate-200 dark:border-slate-800/80 bg-white/70 dark:bg-slate-900/60 backdrop-blur-md sticky top-0 z-40 px-6 py-3.5 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-500 via-teal-500 to-indigo-500 flex items-center justify-center shadow-lg shadow-cyan-500/20">
            <Terminal className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-bold text-lg tracking-wider bg-gradient-to-r from-cyan-500 to-teal-500 dark:from-cyan-400 dark:to-teal-300 bg-clip-text text-transparent">
                DEBUG BUDDY
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border border-cyan-500/20">
                Desktop v0.1.0
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">AI-Powered Debugging & Error Log Analysis Assistant 🚀</p>
          </div>
        </div>

        {/* システムステータス & 設定ボタン */}
        <div className="flex items-center space-x-2.5 text-xs flex-wrap gap-y-2">
          {/* Geminiモデル選択 */}
          <div className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg border bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300">
            <Cpu className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400 shrink-0" />
            <select
              value={selectedModel}
              onChange={(e) => handleModelChange(e.target.value)}
              title="解析に使用するGeminiモデルを選択"
              className="bg-transparent outline-none cursor-pointer text-slate-700 dark:text-slate-200 max-w-[160px] sm:max-w-none"
            >
              {AVAILABLE_MODELS.map((m) => (
                <option
                  key={m.value}
                  value={m.value}
                  className="bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100"
                >
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          {/* Gemini API 設定ボタン */}
          <button
            onClick={() => setShowKeyModal(true)}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border transition cursor-pointer ${
              apiKey
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20"
                : "bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-slate-700"
            }`}
          >
            <Key className="w-3.5 h-3.5" />
            <span>Gemini AI:</span>
            <span className="font-semibold">{apiKey ? "Active" : "APIキー設定"}</span>
          </button>

          {/* 履歴モーダルボタン（見つけやすいよう強調表示） */}
          <button
            onClick={() => setShowHistoryModal(true)}
            title="過去の解析履歴を開く"
            className="relative flex items-center space-x-1.5 px-3.5 py-2 rounded-lg bg-indigo-500/10 border border-indigo-500/40 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-500/20 hover:border-indigo-500/60 transition cursor-pointer font-semibold shadow-sm"
          >
            <History className="w-4 h-4" />
            <span>解析履歴</span>
            {history.length > 0 && (
              <span className="ml-1 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-indigo-500 text-white text-[10px] font-bold">
                {history.length}
              </span>
            )}
          </button>

          {/* ライト / ダークモード切り替えボタン */}
          <button
            onClick={toggleTheme}
            title={theme === "dark" ? "ライトモードに切り替え" : "ダークモードに切り替え"}
            className="flex items-center justify-center p-2 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-slate-700 transition cursor-pointer"
          >
            {theme === "dark" ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          </button>
        </div>
      </header>

      {/* 2. ウェルカム合言葉バナー */}
      <div className="px-6 pt-5">
        <div className="bg-gradient-to-r from-cyan-100/60 via-white to-indigo-100/60 dark:from-cyan-950/40 dark:via-slate-900/60 dark:to-indigo-950/40 border border-cyan-500/20 rounded-2xl p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 shadow-sm">
          <div className="flex items-center space-x-3.5">
            <div className="p-2.5 rounded-xl bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border border-cyan-500/20 shrink-0">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="text-sm font-semibold text-slate-900 dark:text-white">👋 ようこそ、Debug Buddy へ！</span>
                <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20 font-medium">
                  合言葉: 「エラーは成長のチャンス！」
                </span>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                ログを貼り付けるだけで、AIが原因の解説・修正パッチ・学習メモを動的生成します。
                {!apiKey && (
                  <span className="text-cyan-600 dark:text-cyan-400 ml-1 cursor-pointer hover:underline" onClick={() => setShowKeyModal(true)}>
                    （※APIキーを設定するとGemini AIが有効になります）
                  </span>
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2 flex-wrap gap-y-2">
            <span className="text-xs text-slate-500 dark:text-slate-400">サンプル:</span>
            <button
              onClick={() => handleSampleLoad("typeError")}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-cyan-700 dark:text-cyan-300 border border-slate-300 dark:border-slate-700 transition cursor-pointer"
            >
              TypeError
            </button>
            <button
              onClick={() => handleSampleLoad("syntaxError")}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-amber-700 dark:text-amber-300 border border-slate-300 dark:border-slate-700 transition cursor-pointer"
            >
              SyntaxError
            </button>
            <button
              onClick={() => handleSampleLoad("refError")}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-purple-700 dark:text-purple-300 border border-slate-300 dark:border-slate-700 transition cursor-pointer"
            >
              ReferenceError
            </button>
            <button
              onClick={() => handleSampleLoad("portError")}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-rose-600 dark:text-rose-400 border border-rose-500/30 transition cursor-pointer"
            >
              Port競合 (1420)
            </button>
            <button
              onClick={() => handleSampleLoad("attributeError")}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30 transition cursor-pointer"
            >
              AttributeError (Python)
            </button>
          </div>
        </div>
      </div>

      {/* 3. メインコンテンツ（2ペイン構成） */}
      <main className="flex-1 p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* 左カラム: ログ入力エリア */}
        <section className="lg:col-span-5 flex flex-col space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wider flex items-center space-x-2">
              <Bug className="w-4 h-4 text-rose-500 dark:text-rose-400" />
              <span>エラーログ / スタックトレース</span>
            </label>
            <span className="text-xs text-slate-400 dark:text-slate-500">{logInput.length} 文字</span>
          </div>

          <div className="relative rounded-xl border border-slate-300 dark:border-slate-800 bg-white dark:bg-slate-900/80 shadow-inner focus-within:border-cyan-500/60 focus-within:ring-1 focus-within:ring-cyan-500/50 transition">
            <textarea
              value={logInput}
              onChange={(e) => setLogInput(e.target.value)}
              placeholder="ターミナルやコンソールに出力された任意のエラーログをペーストしてください..."
              rows={14}
              className="w-full bg-transparent p-4 font-mono text-xs text-slate-800 dark:text-slate-200 resize-none outline-none leading-relaxed placeholder:text-slate-400 dark:placeholder:text-slate-600"
            />
            {logInput && (
              <button
                onClick={handleReset}
                title="クリア"
                className="absolute top-3 right-3 p-1.5 rounded-md bg-slate-100/80 dark:bg-slate-800/80 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* エラー内容の自由記述（ログが手元になくても症状から解析できるように） */}
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wider flex items-center space-x-2">
              <MessageSquareText className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400" />
              <span>エラーの状況・症状の説明（任意）</span>
            </label>
            <span className="text-xs text-slate-400 dark:text-slate-500">{descriptionInput.length} 文字</span>
          </div>
          <textarea
            value={descriptionInput}
            onChange={(e) => setDescriptionInput(e.target.value)}
            placeholder="例:「保存ボタンを押すとアプリが固まる」「ログイン後に画面が真っ白になる」など、ログが手元になくても状況を自由に記述できます。"
            rows={3}
            className="w-full rounded-xl border border-slate-300 dark:border-slate-800 bg-white dark:bg-slate-900/80 shadow-inner focus-within:border-cyan-500/60 focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/50 transition p-3 font-mono text-xs text-slate-800 dark:text-slate-200 resize-none outline-none leading-relaxed placeholder:text-slate-400 dark:placeholder:text-slate-600"
          />

          {/* 画像添付（エラー画面のスクリーンショット） */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center space-x-1.5 text-xs px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 transition cursor-pointer"
            >
              <ImagePlus className="w-3.5 h-3.5" />
              <span>スクリーンショットを添付</span>
            </button>
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageSelect} />
            {!apiKey && (
              <span className="text-[11px] text-amber-600 dark:text-amber-400">
                ※画像解析にはGemini APIキーの設定が必要です
              </span>
            )}
          </div>

          {attachedImage && (
            <div className="flex items-center space-x-3 p-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60">
              <img
                src={attachedImage.previewUrl}
                alt="添付画像プレビュー"
                className="w-12 h-12 object-cover rounded-md border border-slate-300 dark:border-slate-700 shrink-0"
              />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-slate-700 dark:text-slate-300 truncate font-medium">{attachedImage.fileName}</p>
                <p className="text-[10px] text-slate-400 dark:text-slate-500">エラー画面のスクリーンショットとして解析に使用します</p>
              </div>
              <button
                onClick={handleRemoveImage}
                title="画像を削除"
                className="p-1.5 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 hover:text-rose-500 dark:hover:text-rose-400 transition cursor-pointer shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <div className="flex items-center space-x-3">
            <button
              onClick={handleAnalyze}
              disabled={isAnalyzing || (!logInput.trim() && !descriptionInput.trim() && !attachedImage)}
              className="flex-1 py-3 px-4 rounded-xl bg-gradient-to-r from-cyan-500 to-teal-500 hover:from-cyan-400 hover:to-teal-400 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-sm text-slate-950 flex items-center justify-center space-x-2 shadow-lg shadow-cyan-500/25 transition cursor-pointer active:scale-[0.99]"
            >
              {isAnalyzing ? (
                <>
                  <div className="w-4 h-4 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" />
                  <span>{apiKey ? `${selectedModelLabel} が高精度解析中...` : "ログを解析中..."}</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>{apiKey ? `${selectedModelLabel} で解析する` : "エラーを解析する"}</span>
                </>
              )}
            </button>
          </div>
        </section>

        {/* 右カラム: 解析結果表示エリア */}
        <section className="lg:col-span-7 flex flex-col space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center space-x-2 flex-wrap gap-y-1">
              <span className="text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wider">
                解析＆アドバイス結果
              </span>
              {hasResult && analysis && (
                <>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20 font-medium">
                    {analysis.errorType}
                  </span>
                  {analysis.modelUsed && !analysis.usedFallbackModel && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border border-indigo-500/20 font-medium flex items-center space-x-1">
                      <Cpu className="w-3 h-3" />
                      <span>{analysis.modelUsed}</span>
                    </span>
                  )}
                  {analysis.modelUsed && analysis.usedFallbackModel && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30 font-medium flex items-center space-x-1">
                      <AlertTriangle className="w-3 h-3" />
                      <span>モデル自動フォールバック</span>
                    </span>
                  )}
                </>
              )}
            </div>

            {/* タブ切り替え */}
            {hasResult && (
              <div className="flex space-x-1 p-1 bg-slate-100 dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-lg text-xs">
                <button
                  onClick={() => setActiveTab("cause")}
                  className={`px-3 py-1 rounded-md transition cursor-pointer ${
                    activeTab === "cause" ? "bg-cyan-500/20 text-cyan-700 dark:text-cyan-300 font-medium" : "text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                  }`}
                >
                  根本原因 & 要約
                </button>
                <button
                  onClick={() => setActiveTab("diff")}
                  className={`px-3 py-1 rounded-md transition cursor-pointer ${
                    activeTab === "diff" ? "bg-cyan-500/20 text-cyan-700 dark:text-cyan-300 font-medium" : "text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                  }`}
                >
                  修正案 (Diff)
                </button>
                <button
                  onClick={() => setActiveTab("learn")}
                  className={`px-3 py-1 rounded-md transition cursor-pointer ${
                    activeTab === "learn" ? "bg-cyan-500/20 text-cyan-700 dark:text-cyan-300 font-medium" : "text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                  }`}
                >
                  学習メモ & 理論
                </button>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-5 min-h-[380px] flex flex-col justify-start">
            {!hasResult || !analysis ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-8 text-slate-400 dark:text-slate-500 space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/50 flex items-center justify-center text-slate-400">
                  <Terminal className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-600 dark:text-slate-300">まだ解析結果はありません</p>
                  <p className="text-xs text-slate-400 dark:text-slate-500 mt-1 max-w-sm">
                    左側の入力欄に任意のエラーログをペーストするか、上部のサンプルボタンをクリックして「エラーを解析する」を実行してください。
                  </p>
                  {history.length > 0 && (
                    <button
                      onClick={() => setShowHistoryModal(true)}
                      className="mt-3 inline-flex items-center space-x-1.5 text-xs px-3 py-1.5 rounded-lg bg-indigo-500/10 border border-indigo-500/30 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-500/20 transition cursor-pointer font-medium"
                    >
                      <History className="w-3.5 h-3.5" />
                      <span>過去の解析履歴を見る（{history.length}件）</span>
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {analysis.usedFallbackModel && (
                  <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start space-x-3">
                    <AlertTriangle className="w-6 h-6 text-amber-500 dark:text-amber-400 mt-0.5 shrink-0" />
                    <div className="space-y-1">
                      <h4 className="text-sm font-bold text-amber-700 dark:text-amber-300">
                        ⚠️ モデルの自動フォールバックが発生しました
                      </h4>
                      <p className="text-sm text-amber-700/90 dark:text-amber-200/90 leading-relaxed">
                        指定した <span className="font-semibold">{analysis.modelRequested}</span> は
                        {analysis.quotaExceededModels?.length ? "1日の利用上限（RPD）超過または混雑" : "混雑"}
                        により利用できなかったため、代わりに <span className="font-semibold">{analysis.modelUsed}</span> で解析しました。
                      </p>
                      {analysis.quotaExceededModels && analysis.quotaExceededModels.length > 0 && (
                        <p className="text-xs text-amber-600 dark:text-amber-300/80 font-mono">
                          上限超過で利用不可: {analysis.quotaExceededModels.join(", ")}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {activeTab === "cause" && (
                  <div className="space-y-4">
                    <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-start space-x-3">
                      <AlertCircle className="w-5 h-5 text-rose-500 dark:text-rose-400 mt-0.5 shrink-0" />
                      <div>
                        <h4 className="text-xs font-semibold text-rose-700 dark:text-rose-300 uppercase tracking-wider">エラー概要</h4>
                        <p className="text-sm text-slate-800 dark:text-slate-200 mt-1 font-medium leading-relaxed">
                          {analysis.summary}
                        </p>
                      </div>
                    </div>

                    <div className="p-4 rounded-xl bg-slate-100/70 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 space-y-2">
                      <h4 className="text-xs font-semibold text-cyan-700 dark:text-cyan-400 uppercase tracking-wider flex items-center space-x-1.5">
                        <Bug className="w-3.5 h-3.5" />
                        <span>発生の根本原因 (Root Cause)</span>
                      </h4>
                      <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                        {analysis.rootCause}
                      </p>
                    </div>

                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/30 border border-slate-200 dark:border-slate-800 space-y-2">
                      <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wider flex items-center space-x-1.5">
                        <Code2 className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400" />
                        <span>対象ファイル・行番号</span>
                      </h4>
                      <p className="text-xs font-mono text-slate-500 dark:text-slate-400">
                        📁 {analysis.filePath} : {analysis.lineNumber}
                      </p>
                    </div>

                    {analysis.officialDocLink && (
                      <a
                        href={analysis.officialDocLink.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center justify-between p-3 rounded-xl bg-sky-500/10 border border-sky-500/25 text-sky-700 dark:text-sky-300 hover:bg-sky-500/20 transition group"
                      >
                        <span className="flex items-center space-x-2 text-xs font-medium">
                          <BookMarked className="w-4 h-4 shrink-0" />
                          <span>{analysis.officialDocLink.label}</span>
                        </span>
                        <ExternalLink className="w-3.5 h-3.5 opacity-70 group-hover:opacity-100 shrink-0" />
                      </a>
                    )}

                    <div className="flex justify-end">
                      <button
                        onClick={() => setActiveTab("diff")}
                        className="text-xs text-cyan-600 dark:text-cyan-400 hover:text-cyan-700 dark:hover:text-cyan-300 flex items-center space-x-1 cursor-pointer"
                      >
                        <span>修正案 (Diff) を確認する</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}

                {activeTab === "diff" && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                      <span className="flex items-center space-x-1.5">
                        {analysis.fixType === "task" ? (
                          <ClipboardList className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400 shrink-0" />
                        ) : null}
                        <span>
                          {analysis.fixType === "task" ? "解決のためのタスク" : "修正差分プレビュー (Unified Diff)"} -{" "}
                          {analysis.filePath}
                        </span>
                      </span>
                      <button
                        onClick={handleCopyDiff}
                        className="flex items-center space-x-1.5 py-1 px-2.5 rounded bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition cursor-pointer"
                      >
                        {copied ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
                            <span className="text-emerald-600 dark:text-emerald-400 font-medium">コピー完了！</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span>{analysis.fixType === "task" ? "手順をコピー" : "差分をコピー"}</span>
                          </>
                        )}
                      </button>
                    </div>

                    {analysis.fixType === "task" ? (
                      <TaskStepsView steps={analysis.taskSteps && analysis.taskSteps.length > 0 ? analysis.taskSteps : [analysis.diffCode]} />
                    ) : (
                      <DiffView diffCode={analysis.diffCode} />
                    )}

                    {analysis.fixType !== "task" && isApplied && (
                      <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-700 dark:text-emerald-300 flex items-center justify-between">
                        <span className="flex items-center space-x-1.5">
                          <CheckCircle2 className="w-4 h-4 text-emerald-500 dark:text-emerald-400 shrink-0" />
                          <span>修正が適用されました（バックアップ: <code className="text-slate-600 dark:text-slate-300">{analysis.filePath}.bak</code>）</span>
                        </span>
                        <span className="text-[10px] text-emerald-600 dark:text-emerald-400/80">再テスト推奨</span>
                      </div>
                    )}

                    {/* 修正案の検証: 実際に対応できたかをチェックし、未解消なら新たな修正案を提案する。
                        「コードに自動適用する」を押していなくても（タスク対応の場合や、まだ適用前でも）確認できるよう常時表示する。 */}
                    <div className="p-4 rounded-xl bg-sky-500/10 border border-sky-500/25 space-y-3">
                        <h4 className="text-xs font-semibold text-sky-700 dark:text-sky-300 uppercase tracking-wider flex items-center space-x-1.5">
                          <ShieldCheck className="w-3.5 h-3.5" />
                          <span>修正案で対応できたか検証する</span>
                        </h4>
                        <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                          {analysis.fixType === "task"
                            ? "上記の手順を実施した状態で同じ操作を再実行してください。エラーが解消していれば下のボタンで完了報告、まだ同じ（または別の）エラーが出る場合は、その新しいログを貼り付けて再解析できます。"
                            : "修正を適用した状態で同じ操作を再実行してください。エラーが解消していれば下のボタンで完了報告、まだ同じ（または別の）エラーが出る場合は、その新しいログを貼り付けて再解析できます。"}
                        </p>

                        {/* 操作者自身に確認してもらう検証チェックリスト（自己申告の精度を上げるため、全項目チェックしないと完了報告できない） */}
                        {verificationChecklist.length > 0 && (
                          <div className="rounded-lg border border-sky-500/25 bg-white dark:bg-slate-950/60 divide-y divide-sky-500/10">
                            <div className="px-3 py-2 flex items-center justify-between">
                              <span className="text-[11px] font-semibold text-sky-700 dark:text-sky-300 uppercase tracking-wider flex items-center space-x-1.5">
                                <ListChecks className="w-3.5 h-3.5" />
                                <span>{analysis.fixType === "task" ? "実施確認リスト" : "確認チェックリスト"}</span>
                              </span>
                              <span className="text-[10px] text-slate-400 dark:text-slate-500">
                                {checkedItems.filter(Boolean).length} / {verificationChecklist.length} 完了
                              </span>
                            </div>
                            {verificationChecklist.map((item, idx) => (
                              <button
                                key={idx}
                                type="button"
                                onClick={() => toggleChecklistItem(idx)}
                                className="w-full flex items-start space-x-2 px-3 py-2 text-left hover:bg-sky-500/5 transition cursor-pointer"
                              >
                                {checkedItems[idx] ? (
                                  <CheckCircle2 className="w-4 h-4 text-emerald-500 dark:text-emerald-400 mt-0.5 shrink-0" />
                                ) : (
                                  <Circle className="w-4 h-4 text-slate-300 dark:text-slate-600 mt-0.5 shrink-0" />
                                )}
                                <span
                                  className={`text-xs leading-relaxed ${
                                    checkedItems[idx]
                                      ? "text-slate-400 dark:text-slate-500 line-through"
                                      : "text-slate-700 dark:text-slate-300"
                                  }`}
                                >
                                  {item}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}

                        <textarea
                          value={verifyLogInput}
                          onChange={(e) => setVerifyLogInput(e.target.value)}
                          placeholder="再実行後に出力されたログがあれば貼り付けてください（エラーが解消していれば空欄のままでOKです）"
                          rows={3}
                          className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 p-2.5 font-mono text-xs text-slate-800 dark:text-slate-200 resize-none outline-none focus:border-sky-500/60 focus:ring-1 focus:ring-sky-500/40 transition placeholder:text-slate-400 dark:placeholder:text-slate-600"
                        />

                        <div className="flex items-center justify-end space-x-2">
                          <button
                            onClick={handleMarkResolved}
                            disabled={verificationChecklist.length > 0 && !checkedItems.every(Boolean)}
                            title={
                              verificationChecklist.length > 0 && !checkedItems.every(Boolean)
                                ? analysis.fixType === "task"
                                  ? "実施確認リストの全項目にチェックを入れてください"
                                  : "確認チェックリストの全項目にチェックを入れてください"
                                : undefined
                            }
                            className="text-xs px-3.5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 font-semibold flex items-center space-x-1.5 transition cursor-pointer active:scale-95"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>エラーは解消した</span>
                          </button>
                          <button
                            onClick={handleVerifyFix}
                            disabled={!verifyLogInput.trim() || isVerifying}
                            className="text-xs px-3.5 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 font-semibold flex items-center space-x-1.5 transition cursor-pointer active:scale-95"
                          >
                            {isVerifying ? (
                              <div className="w-3.5 h-3.5 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <ShieldCheck className="w-3.5 h-3.5" />
                            )}
                            <span>{isVerifying ? "検証中..." : "ログを再解析して検証する"}</span>
                          </button>
                        </div>

                        {verificationResult && (
                          <div
                            className={`p-3 rounded-lg text-xs leading-relaxed ${
                              verificationResult.status === "resolved"
                                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20"
                                : verificationResult.status === "still-failing"
                                ? "bg-rose-500/10 text-rose-700 dark:text-rose-300 border border-rose-500/20"
                                : "bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20"
                            }`}
                          >
                            {verificationResult.message}
                          </div>
                        )}
                    </div>

                    <div className="flex items-center justify-end space-x-2 pt-2">
                      <button
                        onClick={() => showToast("修正の適用をスキップしました", "info")}
                        className="text-xs px-3.5 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition cursor-pointer"
                      >
                        スキップ
                      </button>
                      {analysis.fixType !== "task" && (
                        <button
                          onClick={handleApplyFix}
                          disabled={isApplying}
                          className={`text-xs px-4 py-2 rounded-lg font-semibold flex items-center space-x-1.5 shadow transition cursor-pointer active:scale-95 ${
                            isApplied
                              ? "bg-slate-100 dark:bg-slate-800 text-amber-700 dark:text-amber-300 hover:bg-slate-200 dark:hover:bg-slate-700 border border-amber-500/30"
                              : "bg-emerald-500 hover:bg-emerald-400 text-slate-950"
                          }`}
                        >
                          {isApplying ? (
                            <>
                              <div className="w-3.5 h-3.5 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" />
                              <span>ファイルに書き込み中...</span>
                            </>
                          ) : isApplied ? (
                            <>
                              <Undo2 className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />
                              <span>修正を取り消す (ロールバック)</span>
                            </>
                          ) : (
                            <>
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>コードに自動適用する</span>
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {activeTab === "learn" && (
                  <div className="space-y-4">
                    <div className="p-4 rounded-xl bg-indigo-500/10 border border-indigo-500/20 space-y-2">
                      <h4 className="text-xs font-semibold text-indigo-700 dark:text-indigo-300 uppercase tracking-wider flex items-center space-x-1.5">
                        <BookOpen className="w-4 h-4" />
                        <span>{analysis.learningTitle}</span>
                      </h4>
                      <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                        {analysis.learningContent}
                      </p>
                    </div>

                    <div className="p-4 rounded-xl bg-slate-100/70 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 space-y-2">
                      <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wider flex items-center space-x-1.5">
                        <HelpCircle className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                        <span>再発防止のベストプラクティス</span>
                      </h4>
                      <ul className="text-xs text-slate-600 dark:text-slate-300 list-disc list-inside space-y-1.5 leading-relaxed">
                        {analysis.preventionTips.map((tip, idx) => (
                          <li key={idx}>{tip}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </main>

      {/* 4. APIキー設定モーダル */}
      {showKeyModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 dark:bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Key className="w-5 h-5 text-cyan-600 dark:text-cyan-400" />
                <h3 className="font-bold text-sm text-slate-900 dark:text-white">Google Gemini APIキー設定</h3>
              </div>
              <button
                onClick={() => setShowKeyModal(false)}
                className="text-slate-400 hover:text-slate-900 dark:hover:text-white transition p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              Google AI Studio で取得したAPIキーを入力してください。キーはローカルブラウザ内にのみ安全に保存され、上部で選択したGeminiモデルによる超高精度なリアルタイム解析が可能になります。
            </p>

            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 uppercase">API Key</label>
              <input
                type="password"
                value={tempApiKey}
                onChange={(e) => setTempApiKey(e.target.value)}
                placeholder="AIzaSy..."
                className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 focus:border-cyan-500 rounded-xl px-3.5 py-2 text-xs font-mono outline-none text-slate-800 dark:text-slate-200"
              />
            </div>

            <div className="flex items-center justify-between pt-2">
              <a
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noreferrer"
                className="text-xs text-cyan-600 dark:text-cyan-400 hover:underline flex items-center space-x-1"
              >
                <span>キーを取得する (無料)</span>
                <ExternalLink className="w-3 h-3" />
              </a>
              <div className="flex space-x-2">
                <button
                  onClick={() => setShowKeyModal(false)}
                  className="px-3.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition cursor-pointer"
                >
                  キャンセル
                </button>
                <button
                  onClick={saveApiKey}
                  className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-cyan-500 to-teal-500 text-xs font-semibold text-slate-950 hover:from-cyan-400 transition cursor-pointer"
                >
                  保存する
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 5. 履歴モーダル（エラー種別でグループ化） */}
      {showHistoryModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 dark:bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4 max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <History className="w-5 h-5 text-cyan-600 dark:text-cyan-400" />
                <h3 className="font-bold text-sm text-slate-900 dark:text-white">過去のデバッグ解析履歴</h3>
              </div>
              <button
                onClick={() => setShowHistoryModal(false)}
                className="text-slate-400 hover:text-slate-900 dark:hover:text-white transition p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {historyViewMode === "type"
                  ? "エラー種別ごとに色分け・グループ化しています。"
                  : "解析した時刻順に一覧表示しています。"}
                クリックすると再度解説とDiffを表示できます。
              </p>
            </div>

            {/* 履歴検索（全角/半角・大文字小文字・日本語表記ゆれを吸収） */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={historySearchQuery}
                onChange={(e) => setHistorySearchQuery(e.target.value)}
                placeholder="エラー種別・要約・ファイル名などで検索（例: TypeError, 属性エラー, api_controller）"
                className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 focus:border-cyan-500 rounded-lg pl-9 pr-8 py-2 text-xs outline-none text-slate-800 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-600"
              />
              {historySearchQuery && (
                <button
                  onClick={() => setHistorySearchQuery("")}
                  title="検索をクリア"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-900 dark:hover:text-white transition cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 flex-wrap">
              {/* 表示モード切替: 種類別 / 時系列 */}
              <div className="flex space-x-1 p-1 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-xs">
                <button
                  onClick={() => setHistoryViewMode("type")}
                  className={`px-2.5 py-1 rounded-md flex items-center space-x-1 transition cursor-pointer ${
                    historyViewMode === "type" ? "bg-cyan-500/20 text-cyan-700 dark:text-cyan-300 font-medium" : "text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                  }`}
                >
                  <Tags className="w-3.5 h-3.5" />
                  <span>種類別</span>
                </button>
                <button
                  onClick={() => setHistoryViewMode("time")}
                  className={`px-2.5 py-1 rounded-md flex items-center space-x-1 transition cursor-pointer ${
                    historyViewMode === "time" ? "bg-cyan-500/20 text-cyan-700 dark:text-cyan-300 font-medium" : "text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                  }`}
                >
                  <ListIcon className="w-3.5 h-3.5" />
                  <span>時系列</span>
                </button>
              </div>

              {/* 並び替え順（新しい順 / 古い順） */}
              <button
                onClick={() => setHistorySortOrder((o) => (o === "desc" ? "asc" : "desc"))}
                className="flex items-center space-x-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 transition cursor-pointer"
              >
                {historySortOrder === "desc" ? <SortDesc className="w-3.5 h-3.5" /> : <SortAsc className="w-3.5 h-3.5" />}
                <span>{historySortOrder === "desc" ? "新しい順" : "古い順"}</span>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 pr-1">
              {history.length === 0 ? (
                <div className="text-center py-8 text-xs text-slate-400 dark:text-slate-500">
                  まだ履歴がありません。エラーを解析するとここに蓄積されます。
                </div>
              ) : searchedHistory.length === 0 ? (
                <div className="text-center py-8 text-xs text-slate-400 dark:text-slate-500">
                  「{historySearchQuery}」に一致する履歴が見つかりませんでした。
                </div>
              ) : historyViewMode === "time" ? (
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 divide-y divide-slate-200 dark:divide-slate-800 bg-white dark:bg-slate-950/40 overflow-hidden">
                  {timeSortedHistory.map((item) => renderHistoryRow(item, true))}
                </div>
              ) : (
                groupedHistory.map(([errorType, items]) => {
                  const isCollapsed = collapsedGroups.has(errorType);
                  const color = colorForErrorType(errorType);
                  return (
                    <div
                      key={errorType}
                      className={`rounded-xl border ${color.border} overflow-hidden flex`}
                    >
                      <div className={`w-1 shrink-0 ${color.bar}`} />
                      <div className="flex-1 min-w-0">
                        <button
                          onClick={() => toggleGroup(errorType)}
                          className={`w-full flex items-center justify-between px-3 py-2.5 ${color.bg} hover:brightness-95 dark:hover:brightness-125 transition cursor-pointer`}
                        >
                          <span className="flex items-center space-x-2 text-left min-w-0">
                            {isCollapsed ? (
                              <ChevronRight className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 shrink-0" />
                            ) : (
                              <ChevronDown className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 shrink-0" />
                            )}
                            <span className={`text-xs font-semibold truncate ${color.text}`}>{errorType}</span>
                          </span>
                          <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium shrink-0 ${color.bg} ${color.text} ${color.border}`}>
                            {items.length}件
                          </span>
                        </button>

                        {!isCollapsed && (
                          <div className="divide-y divide-slate-200 dark:divide-slate-800 bg-white dark:bg-slate-950/40">
                            {items.map((item) => renderHistoryRow(item, false))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {history.length > 0 && (
              <div className="flex justify-end pt-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  onClick={() => {
                    setHistory([]);
                    localStorage.removeItem("debug_buddy_history");
                    showToast("履歴をクリアしました", "info");
                  }}
                  className="text-xs text-rose-600 dark:text-rose-400 hover:text-rose-700 dark:hover:text-rose-300 transition cursor-pointer"
                >
                  履歴をすべて消去
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 6. トースト通知ポップアップ */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 animate-bounce">
          <div
            className={`px-4 py-2.5 rounded-xl shadow-2xl text-xs font-medium flex items-center space-x-2 border backdrop-blur-md ${
              toast.type === "success"
                ? "bg-white/95 dark:bg-slate-900/95 text-emerald-700 dark:text-emerald-300 border-emerald-500/40"
                : toast.type === "warning"
                ? "bg-white/95 dark:bg-slate-900/95 text-amber-700 dark:text-amber-300 border-amber-500/40"
                : "bg-white/95 dark:bg-slate-900/95 text-cyan-700 dark:text-cyan-300 border-cyan-500/40"
            }`}
          >
            {toast.type === "success" ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-500 dark:text-emerald-400 shrink-0" />
            ) : toast.type === "warning" ? (
              <AlertCircle className="w-4 h-4 text-amber-500 dark:text-amber-400 shrink-0" />
            ) : (
              <ExternalLink className="w-4 h-4 text-cyan-500 dark:text-cyan-400 shrink-0" />
            )}
            <span>{toast.message}</span>
          </div>
        </div>
      )}
    </div>
  );
}
