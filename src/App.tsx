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
  ClipboardList,
  FolderOpen,
  Save,
  Trash2,
  Coins,
  GitBranch,
  Star,
  Download,
  ClipboardPaste,
  Scissors,
  Layers,
  BarChart3,
  FileText,
  Wand2,
  Eye,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import { analyzeErrorLog, isGenericFallbackResult, AnalysisResult, HistoryItem, TokenUsage } from "./analyzer";
import { colorForErrorType } from "./historyStats";
import { analyzeWithGemini, listAvailableModels } from "./gemini";
import { AVAILABLE_MODELS, DEFAULT_MODEL, GeminiModelOption } from "./models";
import {
  DailyUsageState,
  formatDailyUsageTooltip,
  loadDailyUsage,
  modelsWithQuotaExceededToday,
  recordGeminiUsage,
  totalTokensToday,
} from "./usageTracker";
import TerminalWatchModal from "./TerminalWatchModal";
import ClipboardWatchModal from "./ClipboardWatchModal";
import LogFileWatchModal from "./LogFileWatchModal";
import ModelDiagnosticsModal from "./ModelDiagnosticsModal";
import HistoryDashboardModal from "./HistoryDashboardModal";
import FollowUpPanel, { FollowUpEntry } from "./FollowUpPanel";

// プロジェクトのGit作業ツリーが汚れていないかの判定結果(Rust側 check_git_dirty の戻り値)
interface GitDirtyStatus {
  isGitRepo: boolean;
  isDirty: boolean;
  changedFileCount: number;
}

// 実ファイルへ安全適用できるかどうかの判定結果(Rust側 check_fix_applicability の戻り値)
interface FixApplyCheck {
  applicable: boolean;
  reason: string | null;
  resolvedPath: string | null;
}

// なぜ実ファイルへ自動適用できないのかを、人が読める一言に変換する
// (reasonの値はsrc-tauri/src/fix_apply.rsのUnapplicableReason::as_strと対応させている)
function describeUnapplicableReason(reason: string | null): string {
  switch (reason) {
    case "root-not-found":
      return "選択したプロジェクトフォルダが見つかりません。";
    case "path-escapes-root":
      return "このファイルはプロジェクトフォルダの外にあるため、安全のため自動適用できません。";
    case "file-not-found":
      return "このファイルはプロジェクトフォルダ内に見つからないため、自動適用できません。";
    case "not-a-file":
      return "対象がファイルではないため、自動適用できません。";
    case "diff-no-match":
      return "修正案の内容が実際のファイルの中身と一致しないため、安全のため自動適用できません（手動での確認をおすすめします）。";
    case "diff-ambiguous-match":
      return "修正案が複数箇所に一致してしまい、どこを直すべきか一意に特定できないため自動適用できません。";
    case "no-hunks":
      return "この修正案は自動適用に対応していない形式のため、自動適用できません。";
    default:
      return "このファイルは自動適用の対象外です。";
  }
}

// 添付画像1件あたりの最大サイズ（4MB）
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// 解析履歴の保存件数上限（localStorage）
const MAX_HISTORY_ITEMS = 100;

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


// コードの差分ではなく、手順（コマンド実行・再起動・ケーブル抜き差し等）で解決するタイプの修正案を
// 番号付きのタスクリストとして表示するサブコンポーネント
function TaskStepsView({ steps }: { steps: string[] }) {
  // ステップごとに個別コピーできるようにする（どのステップがコピーされたかだけ2秒間表示）
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const handleCopyStep = async (step: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(step);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx((cur) => (cur === idx ? null : cur)), 2000);
    } catch {
      // クリップボードAPIが使えない環境では何もしない（ボタン表示自体は変化しない）
    }
  };

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
          <button
            type="button"
            onClick={() => handleCopyStep(step, idx)}
            title="この手順だけをコピー"
            className="shrink-0 p-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition cursor-pointer"
          >
            {copiedIdx === idx ? (
              <Check className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      ))}
    </div>
  );
}

// このページが実際のTauriデスクトップアプリ（ネイティブWebView）内で動いているか、
// それとも通常のブラウザ（GitHub Pages版のWeb版等）で動いているかを判定する。
// Tauri v2 は起動時に window.__TAURI_INTERNALS__ を注入するため、その有無で判定できる。
// プロジェクトフォルダ選択・実ファイル適用・Git汚れ判定・ターミナル監視など、
// OSのファイルシステム/プロセスに触れる機能はWeb版では原理的に提供できないため、
// これを使って該当UIを無効化・注記する（invokeが失敗して分かりにくいトーストが出るのを防ぐ）。
const IS_TAURI_RUNTIME = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export default function App() {
  const [logInput, setLogInput] = useState<string>("");
  // ログが手元にない場合でも解析できるよう、自由記述の症状・状況説明を別枠で受け付ける
  const [descriptionInput, setDescriptionInput] = useState<string>("");
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  // isAnalyzing(state)と同期して更新するref。複数の監視モードがほぼ同時にエラーを
  // 検知した際の二重解析防止ガード（handleWatchDetectedError）は、次の再描画まで
  // 反映されないstateではなく、このrefを参照する（詳細はhandleWatchDetectedError内コメント）。
  const isAnalyzingRef = useRef(false);
  const [activeTab, setActiveTab] = useState<"cause" | "diff" | "learn">("cause");
  const [hasResult, setHasResult] = useState<boolean>(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  // analysisが「別の解析結果」に置き換わるたびにインクリメントする世代カウンタ。
  // フォローアップ質問(FollowUpPanel)の非同期応答が、質問した時点と異なる解析結果に
  // 紛れ込むのを防ぐガードに使う（詳細はFollowUpPanelのonAsked呼び出し箇所のコメント）。
  const analysisVersionRef = useRef(0);

  // 修正案の検証（再実行後のログを検証し、未解消なら新たな修正案を提案する）
  const [verifyLogInput, setVerifyLogInput] = useState<string>("");
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [verificationResult, setVerificationResult] = useState<{
    status: "resolved" | "still-failing" | "new-error";
    message: string;
  } | null>(null);
  // 修正案で対応できたかの3択（未選択/解決できなかった＝再解析/違う方法で解決できた）。
  // 以前は自動生成のチェックリスト全項目チェックを必須にしていたが、意味の薄い自己申告に
  // なりがちだったため、結果に応じた3つの選択肢を選ぶ方式に変更した。
  const [resolutionChoice, setResolutionChoice] = useState<"unresolved" | "different" | null>(null);
  // 「違う方法で解決できた」選択時に、実際に行った方法を記録する自由記述欄
  const [differentMethodInput, setDifferentMethodInput] = useState<string>("");
  // 解析結果へのフォローアップ質問(Q&A)。非永続(履歴保存の対象外)で、analysisが
  // 入れ替わるたびにクリアする（詳細はFollowUpPanel.tsxのコメント参照）。
  const [followUpEntries, setFollowUpEntries] = useState<FollowUpEntry[]>([]);

  // APIキー管理
  const [apiKey, setApiKey] = useState<string>("");
  const [showKeyModal, setShowKeyModal] = useState<boolean>(false);
  const [tempApiKey, setTempApiKey] = useState<string>("");

  // 使用するGeminiモデルの選択
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  // モデル一覧はmodels.tsのハードコードを初期値とし、APIキー設定時にGoogle側から
  // 動的取得できればそちらに差し替える（取得失敗時はハードコードのままフォールバック）。
  const [availableModels, setAvailableModels] = useState<GeminiModelOption[]>(AVAILABLE_MODELS);
  // Gemini解析のトークン消費量。Google側の日次クォータ(RPD)がリセットされる太平洋時間(PT)の
  // 深夜0時を境界として集計し、localStorageに永続化する（アプリを再起動しても本日分は
  // 保持される＝「再起動したら0件に見えるが実際はまだ今日分を使い切っている」を防ぐ）。
  const [dailyUsage, setDailyUsage] = useState<DailyUsageState>(() => loadDailyUsage());

  // アプリを開いたまま太平洋時間の日付が変わった場合に備え、定期的に日次境界を再チェックする
  // （新たな解析が実行されればその時点でも自動的に切り替わるため、これはあくまで保険）。
  useEffect(() => {
    const id = setInterval(() => {
      setDailyUsage((prev) => {
        const fresh = loadDailyUsage();
        return fresh.periodKey !== prev.periodKey ? fresh : prev;
      });
    }, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);
  // プロジェクトのGit作業ツリーが汚れていないかの判定結果(実ファイル適用前の注意喚起用)
  const [gitDirtyStatus, setGitDirtyStatus] = useState<GitDirtyStatus | null>(null);
  const [showTerminalWatchModal, setShowTerminalWatchModal] = useState<boolean>(false);
  // ターミナル監視が実際に実行中かどうか（isClipboardWatchingと同じ理由で引き上げている）
  const [isTerminalWatching, setIsTerminalWatching] = useState<boolean>(false);
  const [showClipboardWatchModal, setShowClipboardWatchModal] = useState<boolean>(false);
  // クリップボード監視が実際に実行中かどうか。モーダルを閉じていてもヘッダーの
  // ボタン上で分かるようにするため、モーダル内部の状態をここに引き上げている。
  const [isClipboardWatching, setIsClipboardWatching] = useState<boolean>(false);
  const [showLogFileWatchModal, setShowLogFileWatchModal] = useState<boolean>(false);
  // ログファイル監視が実際に実行中かどうか（isClipboardWatchingと同じ理由で引き上げている）
  const [isLogFileWatching, setIsLogFileWatching] = useState<boolean>(false);
  // ヘッダーが混雑してきたため、ターミナル/クリップボード/ログファイル監視の3ボタンを
  // 1つの「監視」ドロップダウンに集約している。その開閉状態。
  const [showWatchMenu, setShowWatchMenu] = useState<boolean>(false);
  const [showModelDiagnosticsModal, setShowModelDiagnosticsModal] = useState<boolean>(false);

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
  const [showHistoryDashboardModal, setShowHistoryDashboardModal] = useState<boolean>(false);
  // 種類別ビューで明示的に開いた（展開した）エラー種別のグループ名を保持する。
  // 初期状態では空＝全グループが閉じており、まず「どんなエラーが起きているか」の
  // 一覧（種別名＋件数）だけが見える。クリックした種別だけが展開される。
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [historyViewMode, setHistoryViewMode] = useState<"type" | "time">("type");
  const [historySortOrder, setHistorySortOrder] = useState<"desc" | "asc">("desc");
  const [historySearchQuery, setHistorySearchQuery] = useState<string>("");

  // インタラクション用状態
  const [copied, setCopied] = useState<boolean>(false);
  const [isApplying, setIsApplying] = useState<boolean>(false);
  const [isApplied, setIsApplied] = useState<boolean>(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "info" | "warning" } | null>(null);
  const [toastCopied, setToastCopied] = useState<boolean>(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 自作の右クリックメニュー（Issue #3）。入力欄・テキスト選択上でのみ、
  // 「コピー/切り取り/貼り付け」だけの最小メニューを自前で表示する。
  // 詳細は下のuseEffect（handleContextMenu）を参照。
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    target: HTMLInputElement | HTMLTextAreaElement | null;
    canCut: boolean;
    canCopy: boolean;
  } | null>(null);

  // 実ファイルへの安全適用（プロジェクトフォルダ選択・可否判定・確認モーダル・実適用/実ロールバック）
  // ※あくまで追加機能。上のプレビュー用state(isApplying/isApplied)とは独立させており、
  //   projectRootが未設定/対象外のケースでは、これまで通りプレビューのみの動作にフォールバックする。
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [isPickingRoot, setIsPickingRoot] = useState<boolean>(false);
  const [applyCheck, setApplyCheck] = useState<FixApplyCheck | null>(null);
  const [isCheckingApply, setIsCheckingApply] = useState<boolean>(false);
  const [showRealApplyConfirm, setShowRealApplyConfirm] = useState<boolean>(false);
  const [isRealApplying, setIsRealApplying] = useState<boolean>(false);
  const [isRollingBackReal, setIsRollingBackReal] = useState<boolean>(false);
  const [isClearingBackups, setIsClearingBackups] = useState<boolean>(false);
  const [realApplyResult, setRealApplyResult] = useState<{ backupId: string; appliedPath: string } | null>(
    null
  );
  // 過去のバックアップ履歴（複数世代）を一覧表示し、任意の時点へ戻せるようにする機能
  const [showBackupHistory, setShowBackupHistory] = useState<boolean>(false);
  const [isLoadingBackupHistory, setIsLoadingBackupHistory] = useState<boolean>(false);
  const [backupHistory, setBackupHistory] = useState<
    { id: string; relativePath: string; createdAtUnixMs: number }[]
  >([]);

  // APIキーの読み込み（OSキーチェーン優先、Tauri外や旧バージョンからの移行はlocalStorageにフォールバック）。
  // 右クリックメニュー（コンテキストメニュー）の見直し（Issue #3）
  // 何も対処しないと、WebView既定の「戻る/進む/再読み込み/検証」等の
  // ブラウザ向けメニューがそのまま出てしまい、ローカルアプリとして不自然になる。
  // OS標準メニューにそのまま任せる方法だと、開発中はメニューに「検証」
  // （DevTools）まで混ざって見えてしまうため、ここでは
  //   ・入力欄やテキスト選択上では「コピー/切り取り/貼り付け」だけの
  //     自作メニューを表示する
  //   ・それ以外の「何もないところ」ではメニュー自体を出さない
  // という方針にし、ブラウザ既定のメニューは常に使わない。
  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      // 常にブラウザ既定のメニューは表示しない（代わりに自作メニューを出すか、何も出さない）
      event.preventDefault();

      const target = event.target as HTMLElement | null;
      const editableEl = target?.closest("input, textarea") as
        | HTMLInputElement
        | HTMLTextAreaElement
        | null;
      const domSelectionLength = window.getSelection()?.toString().length ?? 0;

      if (editableEl) {
        const start = editableEl.selectionStart ?? 0;
        const end = editableEl.selectionEnd ?? 0;
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          target: editableEl,
          canCopy: end > start,
          canCut: end > start,
        });
        return;
      }

      if (domSelectionLength > 0) {
        // 入力欄以外でのテキスト選択（結果表示エリアの文章など）はコピーのみ許可
        setContextMenu({ x: event.clientX, y: event.clientY, target: null, canCopy: true, canCut: false });
        return;
      }

      // それ以外（何もないところ）はメニュー自体を表示しない
      setContextMenu(null);
    };

    window.addEventListener("contextmenu", handleContextMenu);
    return () => window.removeEventListener("contextmenu", handleContextMenu);
  }, []);

  // メニュー表示中に、外側クリック・スクロール・Escapeキーで閉じる
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  // 監視ドロップダウンメニュー表示中に、外側クリック・Escapeキーで閉じる（contextMenuと同じ仕組み）
  useEffect(() => {
    if (!showWatchMenu) return;
    const close = () => setShowWatchMenu(false);
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [showWatchMenu]);

  // input/textareaはReactが管理する状態(value)と実際のDOM値がズレないよう、
  // Reactが上書きしているvalueのsetterを直接呼んでから input イベントを発火させる。
  // （el.value = ... だけだとReact側のonChangeが呼ばれず、画面に反映されない）
  const setEditableValue = (el: HTMLInputElement | HTMLTextAreaElement, nextValue: string) => {
    const prototype =
      el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    nativeSetter?.call(el, nextValue);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const handleMenuCopy = async () => {
    if (!contextMenu) return;
    const { target } = contextMenu;
    const text = target
      ? target.value.substring(target.selectionStart ?? 0, target.selectionEnd ?? 0)
      : (window.getSelection()?.toString() ?? "");
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error("コピーに失敗しました", err);
      showToast("コピーに失敗しました", "warning");
    }
    setContextMenu(null);
  };

  const handleMenuCut = async () => {
    if (!contextMenu?.target) return;
    const el = contextMenu.target;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const text = el.value.substring(start, end);
    try {
      await navigator.clipboard.writeText(text);
      setEditableValue(el, el.value.slice(0, start) + el.value.slice(end));
      // ブラウザは value を直接書き換えるとカーソルを末尾に飛ばしてしまうため、
      // dispatchEvent（＝Reactのonchange処理・再描画まで含む）が完了した直後、
      // 同期的にカーソル位置を明示的に戻す。（requestAnimationFrameだと、
      // ウィンドウが最小化・非アクティブなタイミングでは発火が遅れ／されず、
      // カーソル位置が末尾のままになることがあるため使わない）
      el.focus();
      el.setSelectionRange(start, start);
    } catch (err) {
      console.error("切り取りに失敗しました", err);
      showToast("切り取りに失敗しました", "warning");
    }
    setContextMenu(null);
  };

  const handleMenuPaste = async () => {
    if (!contextMenu?.target) return;
    const el = contextMenu.target;
    try {
      const text = await navigator.clipboard.readText();
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      setEditableValue(el, el.value.slice(0, start) + text + el.value.slice(end));
      const cursor = start + text.length;
      // 切り取り処理と同様の理由で、rAFを使わず同期的にカーソル位置を戻す
      el.focus();
      el.setSelectionRange(cursor, cursor);
    } catch (err) {
      console.error("貼り付けに失敗しました", err);
      showToast("貼り付けに失敗しました（Ctrl+Vもお試しください）", "warning");
    }
    setContextMenu(null);
  };

  // 他の初期化（履歴・モデル選択・テーマ等）は同期的なlocalStorage読み込みのみなので、
  // 非同期処理が必要なAPIキーだけ別のeffectに分けている。
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // 1. まずOSキーチェーンから読み込みを試みる（Tauriアプリ内でのみ動作）
        const stored = await invoke<string | null>("load_api_key");
        if (cancelled) return;
        if (stored) {
          setApiKey(stored);
          setTempApiKey(stored);
          return;
        }
      } catch {
        // invokeが使えない(dev:web等のTauri外プレビュー)場合は、下のlocalStorage読み込みにフォールバックする
      }

      // 2. キーチェーンに値が無い場合: 旧バージョンでlocalStorageに平文保存されていたキーが
      //    残っていないか確認し、あれば読み込みつつキーチェーンへ移行する（移行できたらlocalStorageからは消す）
      const legacyKey = localStorage.getItem("debug_buddy_gemini_key") || "";
      if (!legacyKey) return;
      if (cancelled) return;
      setApiKey(legacyKey);
      setTempApiKey(legacyKey);
      try {
        await invoke("save_api_key", { key: legacyKey });
        localStorage.removeItem("debug_buddy_gemini_key");
      } catch {
        // キーチェーンへの移行に失敗した場合は、これまで通りlocalStorageに残したままにする
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // 初期ロード時に localStorage から 履歴・モデル選択・テーマ等を復元
  useEffect(() => {
    const savedHistory = localStorage.getItem("debug_buddy_history");
    if (savedHistory) {
      try {
        // occurrenceCount/pinned導入以前に保存された履歴には無いフィールドなので、
        // 読み込み時に既定値（1回目・未ピン留め）を補う
        const parsed = JSON.parse(savedHistory) as Partial<HistoryItem>[];
        setHistory(parsed.map((item) => ({ occurrenceCount: 1, pinned: false, ...item } as HistoryItem)));
      } catch {
        // ignore
      }
    }

    const savedModel = localStorage.getItem("debug_buddy_gemini_model");
    if (savedModel) {
      setSelectedModel(savedModel);
    }

    const savedProjectRoot = localStorage.getItem("debug_buddy_project_root");
    if (savedProjectRoot) {
      setProjectRoot(savedProjectRoot);
    }

    const savedTheme = localStorage.getItem("debug_buddy_theme") as "light" | "dark" | null;
    if (savedTheme === "light" || savedTheme === "dark") {
      setTheme(savedTheme);
    } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
      setTheme("light");
    }

    // トークン消費量表示は「真にこのセッション（アプリを起動してから今まで）」の
    // 累計であることが分かりやすいよう、あえてlocalStorageへの永続化はしない
    // （以前はlocalStorageに永続化していたため、表示上「セッション累計」と
    // 案内しているのに実際は起動しても0に戻らず「いつからの累計か分からない」
    // という分かりにくさがあった）。
  }, []);

  // APIキーが設定されている間、そのキーで実際に使えるGeminiモデル一覧を動的取得する。
  // models.ts のハードコードはGoogle側のラインナップ変更に追従できないための保険であり、
  // 取得できた場合はそちらを優先し、失敗時(オフライン・権限不足等)はハードコードのまま使う。
  useEffect(() => {
    if (!apiKey) {
      setAvailableModels(AVAILABLE_MODELS);
      return;
    }
    let cancelled = false;
    listAvailableModels(apiKey)
      .then((fetched) => {
        if (cancelled || fetched.length === 0) return;
        // 現在選択中のモデルが一覧に無い場合(廃止モデル等)でも選択自体は維持できるよう、先頭に補う
        const merged = fetched.some((m) => m.value === selectedModel)
          ? fetched
          : [{ value: selectedModel, label: `${selectedModel}（現在の選択）` }, ...fetched];
        setAvailableModels(merged);
      })
      .catch(() => {
        // オフライン・キー不正等: これまで通りハードコードされた一覧にフォールバックする
        if (!cancelled) setAvailableModels(AVAILABLE_MODELS);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  // プロジェクトフォルダが選択されている間、Git作業ツリーが汚れていないかを判定する
  // (読み取り専用。git未インストール/Git管理外の場合はisGitRepo:falseとして扱われ、警告は出ない)
  useEffect(() => {
    if (!projectRoot) {
      setGitDirtyStatus(null);
      return;
    }
    let cancelled = false;
    invoke<GitDirtyStatus>("check_git_dirty", { root: projectRoot })
      .then((status) => {
        if (!cancelled) setGitDirtyStatus(status);
      })
      .catch(() => {
        if (!cancelled) setGitDirtyStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectRoot]);

  // 実ファイルへの適用・ロールバックが成功した直後にGitの汚れ状態を再取得する。
  // 上のuseEffectはprojectRoot選択時にしか走らないため、そのままだと「適用直後、
  // まさに今書き換えたファイル分だけ未コミットになっている」状態を検知できず、
  // 警告バッジが古い（適用前の）判定のまま表示され続けてしまう。
  const refreshGitDirtyStatus = () => {
    if (!projectRoot) return;
    invoke<GitDirtyStatus>("check_git_dirty", { root: projectRoot })
      .then(setGitDirtyStatus)
      .catch(() => setGitDirtyStatus(null));
  };

  // テーマの切り替えを <html> クラスへ反映し、選択を保存する
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("debug_buddy_theme", theme);
  }, [theme]);

  // プロジェクトフォルダが選択されていて、かつコード修正(fixType!=="task")の場合のみ、
  // 「実ファイルへ安全に適用できるか」を裏で自動判定する（実際の書き込みは一切行わない読み取り専用の問い合わせ）。
  // Tauriアプリの外（ブラウザ単体プレビュー等）では invoke が使えないため、失敗時は静かに
  // 「未対応」として扱い、これまで通りのプレビューのみの表示にフォールバックする。
  useEffect(() => {
    let cancelled = false;
    setRealApplyResult(null);
    setApplyCheck(null);
    setBackupHistory([]);
    setShowBackupHistory(false);

    if (!analysis || analysis.fixType === "task" || !projectRoot) {
      return;
    }

    setIsCheckingApply(true);
    invoke<FixApplyCheck>("check_fix_applicability", {
      root: projectRoot,
      filePath: analysis.filePath,
      diffCode: analysis.diffCode,
    })
      .then((result) => {
        if (!cancelled) setApplyCheck(result);
      })
      .catch(() => {
        if (!cancelled) setApplyCheck(null);
      })
      .finally(() => {
        if (!cancelled) setIsCheckingApply(false);
      });

    return () => {
      cancelled = true;
    };
  }, [analysis, projectRoot]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  const handleModelChange = (value: string) => {
    setSelectedModel(value);
    localStorage.setItem("debug_buddy_gemini_model", value);
  };

  const selectedModelLabel = availableModels.find((m) => m.value === selectedModel)?.label ?? selectedModel;

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
    setExpandedGroups((prev) => {
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
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastCopied(false);
    setToast({ message, type });
    // warning（エラー・失敗系）は内容を読んで対処を検討する時間が必要なため長めに表示する
    const autoDismissMs = type === "warning" ? 8000 : 4000;
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
    }, autoDismissMs);
  };

  const dismissToast = () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(null);
  };

  const copyToastMessage = async () => {
    if (!toast) return;
    try {
      await navigator.clipboard.writeText(toast.message);
      setToastCopied(true);
      setTimeout(() => setToastCopied(false), 2000);
    } catch {
      // クリップボードAPIが使えない環境では静かに諦める（トースト自体は表示され続ける）
    }
  };

  const saveApiKey = async () => {
    const cleanKey = tempApiKey.trim();
    setApiKey(cleanKey);
    try {
      // OSキーチェーンへ保存（空文字なら削除として扱われる。詳細はsrc-tauri/src/secret_store.rs参照）
      await invoke("save_api_key", { key: cleanKey });
      // キーチェーンへの保存に成功したら、移行前の平文コピーが残っていないよう念のため削除する
      localStorage.removeItem("debug_buddy_gemini_key");
    } catch {
      // invokeが使えない(dev:web等のTauri外プレビュー)場合のみ、従来通りlocalStorageに保存する
      localStorage.setItem("debug_buddy_gemini_key", cleanKey);
    }
    setShowKeyModal(false);
    if (cleanKey) {
      showToast("Gemini APIキーを保存しました！リアルタイム解析が有効です", "success");
    } else {
      showToast("APIキーをクリアしました（ローカル解析モードで動作します）", "info");
    }
  };

  // ログ入力が別内容に置き換わる際、古い解析結果が新しい入力と矛盾したまま
  // 画面に残らないよう、解析結果関連stateを破棄する。
  // （realApplyResult等は、analysisの変化に連動する既存のuseEffectが自動的にクリアするため、
  // ここでは触らない）
  // resolutionChoice/differentMethodInput/followUpEntriesの3点セットは、解析結果が
  // 別のものに置き換わる複数箇所（clearAnalysisResult自身に加え、handleAnalyze・
  // handleVerifyFix・handleSelectHistory）で共通してリセットが必要なため、
  // コピペによる漏れを防ぐためここに集約する。
  // （handleApplyFixのundo/apply分岐は意図的にfollowUpEntriesをリセットしないため、
  // ここには含めず個別のまま残している）
  const resetFollowUpState = () => {
    setResolutionChoice(null);
    setDifferentMethodInput("");
    setFollowUpEntries([]);
  };

  const clearAnalysisResult = () => {
    setHasResult(false);
    setAnalysis(null);
    setIsApplied(false);
    setVerificationResult(null);
    setVerifyLogInput("");
    resetFollowUpState();
  };

  const handleSampleLoad = (key: keyof typeof SAMPLE_LOGS) => {
    setLogInput(SAMPLE_LOGS[key]);
    clearAnalysisResult();
    showToast(`サンプル（${key}）を挿入しました`, "info");
  };

  // エラー画面のスクリーンショット等の画像ファイルを添付する（ファイル選択・クリップボード貼り付け共通処理）
  const processImageFile = (file: File, source: "select" | "paste") => {
    if (!file.type.startsWith("image/")) {
      if (source === "select") showToast("画像ファイル（PNG/JPEGなど）を選択してください", "warning");
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
        fileName: file.name || "clipboard-image.png",
      });
      showToast(
        source === "paste" ? "クリップボードの画像を添付しました" : `画像「${file.name}」を添付しました`,
        "info"
      );
    };
    reader.onerror = () => showToast("画像の読み込みに失敗しました", "warning");
    reader.readAsDataURL(file);
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 同じファイルを選び直せるようにリセット
    if (!file) return;
    processImageFile(file, "select");
  };

  const handleRemoveImage = () => setAttachedImage(null);

  // テキストエリアへのペースト時、クリップボードに画像（スクリーンショット等）が
  // 含まれていれば自動で添付する。通常のテキスト貼り付けは妨げない。
  const handlePasteImage = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          processImageFile(file, "paste");
        }
        return;
      }
    }
  };

  // Ctrl+Enter (macOSはCmd+Enter) で解析を実行するショートカット
  const handleAnalyzeShortcut = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      if (!isAnalyzing) void handleAnalyze();
    }
  };

  // 解析結果を履歴に積んで保存する（新規解析・再検証どちらからも呼ばれる共通処理）。
  // 「エラー種別 + ファイルパス + 行番号」が一致する既存の履歴（＝同じ箇所で起きた同じエラー）は
  // 古い方を削除してから今回の結果を先頭に追加することで、同じエラーの繰り返しで履歴が
  // 埋まってしまわず、実質的により多くの“異なる”エラーを記録できるようにする。
  // その際、発生回数(occurrenceCount)を引き継いで+1し、ピン留め(pinned)状態も維持する。
  const saveToHistory = (result: AnalysisResult) => {
    const isSameError = (item: HistoryItem) =>
      item.result.errorType === result.errorType &&
      item.result.filePath === result.filePath &&
      item.result.lineNumber === result.lineNumber;
    const previousOccurrence = history.find(isSameError);

    const newItem: HistoryItem = {
      id: Date.now().toString(),
      timestamp: new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }),
      result,
      occurrenceCount: (previousOccurrence?.occurrenceCount ?? 0) + 1,
      pinned: previousOccurrence?.pinned ?? false,
    };
    const deduped = history.filter((item) => !isSameError(item));

    // 100件上限はピン留めしていない項目だけに適用する（ピン留め項目は自動削除の対象外）
    let keptCount = 0;
    const updatedHistory = [newItem, ...deduped].filter((item) => {
      if (item.pinned) return true;
      keptCount++;
      return keptCount <= MAX_HISTORY_ITEMS;
    });

    setHistory(updatedHistory);
    localStorage.setItem("debug_buddy_history", JSON.stringify(updatedHistory));

    // 同じ箇所・同じエラー種別が繰り返し発生している場合は、根本対応を見直す合図として知らせる
    if (newItem.occurrenceCount >= 2) {
      showToast(
        `⚠️ 同じ箇所（${result.filePath}）で「${result.errorType}」が${newItem.occurrenceCount}回目の発生です。根本原因への対応を見直すタイミングかもしれません`,
        "warning"
      );
    }
  };

  // Gemini解析結果のトークン消費量を、Google側の日次クォータ境界(太平洋時間の深夜0時)に
  // 揃えた集計へ加算する。新規解析(handleAnalyze)・検証時の再解析(handleVerifyFix)の
  // どちらもGemini APIを実際に消費するため、両方からこの共通処理を呼ぶ
  // （片方でしか呼ばないと、ヘッダーの「本日のトークン消費量」が実際より少なく表示され続ける）。
  // AnalysisResultの構造的部分型として受け取る（FollowUpAnswer等、tokenUsage/modelUsed/
  // quotaExceededModelsを同名で持つ型もそのまま渡せるようにするため）
  const recordUsageForResult = (result: { modelUsed?: string; tokenUsage?: TokenUsage; quotaExceededModels?: string[] }) => {
    if (!result.tokenUsage) return;
    setDailyUsage(
      recordGeminiUsage(result.modelUsed ?? selectedModel, result.tokenUsage.totalTokens, result.quotaExceededModels ?? [])
    );
  };

  // 解析実行（Gemini API または ローカル解析エンジンのハイブリッド）。
  // `overrideLog` が指定された場合（ターミナル監視モードからの自動解析）は、
  // logInputへの反映を待たずその文字列をそのまま解析対象にする(setState後の非同期タイミング問題を回避するため)。
  const handleAnalyze = async (overrideLog?: string) => {
    const effectiveLog = overrideLog ?? logInput;
    const hasLog = effectiveLog.trim().length > 0;
    const hasDescription = overrideLog === undefined && descriptionInput.trim().length > 0;
    const hasImage = overrideLog === undefined && !!attachedImage;
    if (!hasLog && !hasDescription && !hasImage) return;

    // 画像・説明文のみでAPIキー未設定の場合、ローカル解析エンジンでは十分な解析ができないため中断する
    if (!apiKey && hasImage && !hasLog) {
      showToast("画像からの解析にはGemini APIキーの設定が必要です。テキストログも入力するか、APIキーを設定してください。", "warning");
      return;
    }

    // ログ（スタックトレース等）と、自由記述の症状説明を統合して解析対象とする
    const combinedText = [
      hasLog ? `【エラーログ / スタックトレース】\n${effectiveLog.trim()}` : "",
      hasDescription ? `【エラー内容・症状の説明（ユーザー記述）】\n${descriptionInput.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    setIsAnalyzing(true);
    isAnalyzingRef.current = true;
    setIsApplied(false);
    setVerificationResult(null);
    setVerifyLogInput("");
    resetFollowUpState();

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
        // 送信前にAPIキーやメールアドレス等の機密情報らしき箇所をマスクした場合は、
        // ユーザーが「何が送られたか」を把握できるよう明示する
        const maskNote = result.maskedSecretsCount
          ? `（🔒 送信前に機密情報らしき箇所を${result.maskedSecretsCount}件マスクしました）`
          : "";
        if (result.usedFallbackModel) {
          // 指定モデルが混雑/RPD(1日の上限)超過等で使えず、別モデルに自動切替した場合は明示する
          const quotaNote = result.quotaExceededModels?.length
            ? `（上限超過: ${result.quotaExceededModels.join(", ")}）`
            : "";
          showToast(
            `⚠️ ${selectedModelLabel} は利用できず、${result.modelUsed} で解析しました${quotaNote}${maskNote}`,
            "warning"
          );
        } else {
          showToast(`✨ ${result.modelUsed ?? selectedModelLabel} による高精度解析が完了しました！${maskNote}`, "success");
        }

        recordUsageForResult(result);
      } else {
        // 2. ローカル解析エンジンでフォールバック（画像は読み取れないためテキストのみ）
        await new Promise((r) => setTimeout(r, 600));
        // ログ欄・症状説明欄の両方に入力がある場合、まずログ欄だけで解析を試みる。
        // 具体的なエラーシグネチャに一致すればそれを採用し、症状説明欄の内容とは
        // 食い違っていてもログ欄側を優先する（既知パターンに一致しない場合のみ、
        // 症状説明欄も含めた全文で解析し直す）。これにより「たまたま連結時に
        // ログ欄が先に来るので優先される」という暗黙の挙動を、明示的な優先順位
        // として仕様化している。
        if (hasLog && hasDescription) {
          const logOnlyResult = analyzeErrorLog(effectiveLog.trim());
          const usedLogOnly = !isGenericFallbackResult(logOnlyResult);
          result = usedLogOnly ? logOnlyResult : analyzeErrorLog(combinedText);
          // ローカル解析エンジンは決定的なルールベースなので、Geminiと違い「実際にどちらを
          // 使ったか」を自己申告ではなく、この分岐そのものから確実に説明できる。
          result.inputPriorityNote = usedLogOnly
            ? "エラーログ欄の内容から解析しました（症状説明欄は、ログ欄だけで既知のパターンに一致したため参照していません）"
            : "エラーログ欄だけでは既知のパターンに一致しなかったため、症状説明欄の内容も含めて解析しました";
        } else {
          result = analyzeErrorLog(combinedText);
        }
        result.modelUsed = "ローカル解析エンジン（ルールベース）";
        if (hasImage) {
          // ログ/症状説明欄にテキストがあるため上のブロック（!apiKey && hasImage && !hasLog）は
          // 素通りしてここまで来ているが、ローカル解析エンジンは画像を一切読まないため、
          // 添付した画像が黙って無視されていることを明示しないと「画像も見てくれているはず」と
          // 誤解されるリスクがある（トーストは消えるため、優先順位の説明にも残す）。
          const imageIgnoredNote = "添付した画像はローカル解析エンジンでは解析対象外のため使用していません";
          result.inputPriorityNote = result.inputPriorityNote ? `${result.inputPriorityNote}。${imageIgnoredNote}` : imageIgnoredNote;
          showToast(
            "テキストのみで解析しました（添付した画像はローカル解析エンジンでは解析対象外です。画像も解析するにはGemini APIキーを設定してください）",
            "warning"
          );
        } else {
          showToast("エラー内容の動的解析が完了しました（※APIキーを設定するとGemini AI解析・画像解析が利用可能です）", "info");
        }
      }

      // ログ・症状説明・画像のうち実際に入力されたのが1種類だけなら、優先順位を
      // 説明する意味が無いため（Gemini側の自己申告ミスに対する保険も兼ねて）ここで確実に消す。
      const providedSourceCount = [hasLog, hasDescription, hasImage].filter(Boolean).length;
      if (providedSourceCount < 2) {
        result.inputPriorityNote = undefined;
      }

      setAnalysis(result);
      analysisVersionRef.current += 1;
      setHasResult(true);
      setActiveTab("cause");
      saveToHistory(result);
    } catch (err) {
      // APIエラー時はローカル解析へ安全にフォールバック
      console.error(err);
      const fallback = analyzeErrorLog(combinedText);
      fallback.modelUsed = "ローカル解析エンジン（フォールバック）";
      setAnalysis(fallback);
      analysisVersionRef.current += 1;
      setHasResult(true);
      setActiveTab("cause");
      showToast(`Gemini通信エラー (${(err as Error).message.slice(0, 300)})。ローカル解析を表示します`, "warning");
    } finally {
      setIsAnalyzing(false);
      isAnalyzingRef.current = false;
    }
  };

  const handleReset = () => {
    setLogInput("");
    setDescriptionInput("");
    setAttachedImage(null);
    clearAnalysisResult();
    showToast("入力内容をリセットしました", "info");
  };

  // ターミナル監視モード／クリップボード監視モードが、エラーらしき内容を検知した際に呼ばれる
  // 共通ハンドラ。autoAnalyze=false の場合はログ欄にセットするだけ(API呼び出しは行わず、
  // ユーザー自身の「エラーを解析する」クリックを待つ)。autoAnalyze=true はユーザーが明示的に
  // オプトインした場合のみで、そのまま解析まで自動実行する。
  const handleWatchDetectedError = (sourceLabel: string, capturedText: string, autoAnalyze: boolean) => {
    if (!capturedText.trim()) {
      // 検知はしたが、内容の取得タイミングの都合で復元できなかった場合。
      // ログ欄を空文字で上書きして「セットしました」と誤認させるより、
      // 現在の入力内容を維持したまま正直に失敗を伝える方が安全。
      showToast(`エラーの可能性を検知しましたが、内容を取得できませんでした。お手数ですが${sourceLabel}の内容を直接コピーして貼り付けてください。`, "warning");
      return;
    }
    setLogInput(capturedText);
    setDescriptionInput("");
    setAttachedImage(null);
    clearAnalysisResult();
    if (autoAnalyze) {
      // ターミナル監視・クリップボード監視は同時に有効化できるため、両方が
      // ほぼ同時にエラーを検知すると、ここが2重に呼ばれてhandleAnalyzeの
      // 非同期処理が重複実行されうる（Gemini解析結果やトークン集計等の共有state
      // を後勝ちで奪い合い、画面がどちらの結果か分からなくなる）。
      // 既に解析中の場合は自動実行を見送り、ログ欄にセットするだけに留める
      // （＝手動の「エラーを解析する」を待つ、autoAnalyze=falseと同じ扱い）。
      // ガードにはisAnalyzing（state）ではなくisAnalyzingRef（ref）を使う。
      // stateはsetIsAnalyzing(true)を呼んだ直後の再描画までは古い値のままのため、
      // 同一tick内で2つの監視ソースがほぼ同時に発火すると両方がisAnalyzing===false
      // を読んでしまいこのガードをすり抜ける。refは同期的に更新するため、この
      // タイミング問題が起きない。
      if (isAnalyzingRef.current) {
        showToast(
          `${sourceLabel}でエラーを検知しましたが、他の解析が進行中のためログ欄にセットするだけに留めました。完了後に「エラーを解析する」を押してください`,
          "warning"
        );
        return;
      }
      showToast(`${sourceLabel}でエラーを検知したため、自動で解析します`, "warning");
      void handleAnalyze(capturedText);
    } else {
      showToast(`${sourceLabel}でエラーらしき内容を検知し、ログ欄にセットしました。「エラーを解析する」を押してください`, "warning");
    }
  };

  const handleTerminalWatchError = (capturedText: string, autoAnalyze: boolean) =>
    handleWatchDetectedError("ターミナル監視", capturedText, autoAnalyze);

  const handleClipboardWatchError = (capturedText: string, autoAnalyze: boolean) =>
    handleWatchDetectedError("クリップボード監視", capturedText, autoAnalyze);

  const handleLogFileWatchError = (capturedText: string, autoAnalyze: boolean) =>
    handleWatchDetectedError("ログファイル監視", capturedText, autoAnalyze);

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

  // コードに自動適用（プレビュー）
  // NOTE: 現バージョンは実ファイルへの書き込みを行わない「プレビュー」機能。
  // Tauri側に実I/O・バックアップ・ロールバックのコマンドが実装されるまでは、
  // ユーザーに誤解を与えないよう文言は必ず「プレビュー」であることを明示する。
  const handleApplyFix = () => {
    if (!analysis) return;
    if (isApplied) {
      setIsApplied(false);
      setVerificationResult(null);
      setVerifyLogInput("");
      setResolutionChoice(null);
      setDifferentMethodInput("");
      showToast(`プレビューを取り消しました（${analysis.filePath} は変更されていません）`, "info");
      return;
    }

    setIsApplying(true);
    setTimeout(() => {
      setIsApplying(false);
      setIsApplied(true);
      setVerificationResult(null);
      setResolutionChoice(null);
      setDifferentMethodInput("");
      showToast(
        `📝 ${analysis.filePath} への適用をプレビュー表示しました（※実ファイルは書き換えていません。反映するには上の差分を「差分をコピー」してご自身のエディタで適用してください）`,
        "info"
      );
    }, 700);
  };

  // プロジェクトフォルダをネイティブのダイアログで選ぶ（Tauriアプリ内でのみ動作）
  const handlePickProjectRoot = async () => {
    setIsPickingRoot(true);
    try {
      // ダイアログがウィンドウの裏に隠れる等でOSからの応答が返ってこない場合でも、
      // ボタンが「選択中...」のまま永久に固まって再操作不能にならないよう、
      // 一定時間で必ず諦めて操作可能な状態に戻す（保険）。
      const picked = await Promise.race([
        invoke<string | null>("pick_project_root"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("PICK_PROJECT_ROOT_TIMEOUT")), 120_000)
        ),
      ]);
      if (picked) {
        setProjectRoot(picked);
        localStorage.setItem("debug_buddy_project_root", picked);
        showToast(`プロジェクトフォルダを設定しました: ${picked}`, "success");
      }
    } catch (err) {
      const message =
        err instanceof Error && err.message === "PICK_PROJECT_ROOT_TIMEOUT"
          ? "フォルダ選択ダイアログの応答がありませんでした。ウィンドウの裏に隠れていないか確認するか、もう一度お試しください。"
          : "フォルダ選択に失敗しました（この機能はTauriアプリ内でのみ利用できます）";
      showToast(message, "warning");
    } finally {
      setIsPickingRoot(false);
    }
  };

  const handleClearProjectRoot = () => {
    setProjectRoot(null);
    localStorage.removeItem("debug_buddy_project_root");
    showToast("プロジェクトフォルダの設定を解除しました", "info");
  };

  // 「実ファイルへの適用」を使うたびに溜まっていくバックアップ(.debug-buddy-backups)を
  // まとめて削除する。自動的な世代管理（直近20件/ファイルまで保持）とは別に、
  // ユーザーが明示的にディスク容量を整理したい場合のための手動操作。
  const handleClearAllBackups = async () => {
    if (!projectRoot) return;
    const confirmed = window.confirm(
      "このプロジェクトのバックアップ（過去に「実ファイルに適用」した際の復元用データ）をすべて削除します。よろしいですか？\n※適用済みのファイル自体は変更されません。ロールバックできなくなる点のみご注意ください。"
    );
    if (!confirmed) return;

    setIsClearingBackups(true);
    try {
      await invoke("clear_all_backups", { root: projectRoot });
      setRealApplyResult(null);
      showToast("バックアップをすべて削除しました", "info");
    } catch (err) {
      showToast(`バックアップの削除に失敗しました: ${String(err).slice(0, 300)}`, "warning");
    } finally {
      setIsClearingBackups(false);
    }
  };

  // 実ファイルへの適用（確認モーダルでのOK後に実行される）。
  // check_fix_applicabilityの結果に関わらず、書き込み直前にRust側で必ず再検証される。
  const handleRealApplyConfirmed = async () => {
    if (!analysis || !projectRoot) return;
    setShowRealApplyConfirm(false);
    setIsRealApplying(true);
    try {
      const result = await invoke<{ backupId: string; appliedPath: string }>("apply_fix", {
        root: projectRoot,
        filePath: analysis.filePath,
        diffCode: analysis.diffCode,
      });
      setRealApplyResult(result);
      showToast(`✅ 実際に書き換えました: ${result.appliedPath}`, "success");
      // バックアップ履歴を表示中であれば、今回作成された分も含めて最新化する
      if (showBackupHistory) void loadBackupHistory();
      // 実ファイルを書き換えたため、Git汚れ状態の表示も最新化する
      refreshGitDirtyStatus();
    } catch (err) {
      showToast(`実ファイルへの適用に失敗しました: ${String(err).slice(0, 300)}`, "warning");
    } finally {
      setIsRealApplying(false);
    }
  };

  // 指定したバックアップ世代(backupId)から実ファイルを復元する共通処理。
  // 直近のロールバック（handleRealRollback）と、過去世代を選んでのロールバック
  // （backupHistoryからの選択）の両方から呼び出す。
  const handleRollbackToBackup = async (backupId: string) => {
    if (!projectRoot) return;
    setIsRollingBackReal(true);
    try {
      await invoke("rollback_fix", { root: projectRoot, backupId });
      showToast("バックアップから元のファイル内容に復元しました", "info");
      if (realApplyResult?.backupId === backupId) setRealApplyResult(null);
      // バックアップ履歴を表示中であれば最新の状態に更新する
      if (showBackupHistory) void loadBackupHistory();
      // 実ファイルを復元したため、Git汚れ状態の表示も最新化する
      refreshGitDirtyStatus();
    } catch (err) {
      showToast(`ロールバックに失敗しました: ${String(err).slice(0, 300)}`, "warning");
    } finally {
      setIsRollingBackReal(false);
    }
  };

  // 実ファイルのロールバック（直近に自分が適用した分を戻す、これまで通りのボタン）
  const handleRealRollback = () => {
    if (!realApplyResult) return;
    void handleRollbackToBackup(realApplyResult.backupId);
  };

  // このファイルの過去のバックアップ一覧を取得する（読み取り専用）
  const loadBackupHistory = async () => {
    if (!projectRoot || !analysis) return;
    setIsLoadingBackupHistory(true);
    try {
      const list = await invoke<{ id: string; relativePath: string; createdAtUnixMs: number }[]>(
        "list_backups_for_file",
        { root: projectRoot, filePath: analysis.filePath }
      );
      setBackupHistory(list);
    } catch (err) {
      showToast(`バックアップ履歴の取得に失敗しました: ${String(err).slice(0, 300)}`, "warning");
      setBackupHistory([]);
    } finally {
      setIsLoadingBackupHistory(false);
    }
  };

  // バックアップ履歴の開閉。開くタイミングで一覧を取得する（毎回の再描画では取得しない）
  const handleToggleBackupHistory = () => {
    const next = !showBackupHistory;
    setShowBackupHistory(next);
    if (next) void loadBackupHistory();
  };

  // 提示した修正案どおりでエラーが解消したことをユーザーが確認した場合
  const handleMarkResolved = () => {
    if (!analysis) return;
    setVerificationResult({
      status: "resolved",
      message: "✅ 修正が正しく適用され、エラーは解消しました。お疲れ様でした！",
    });
    setResolutionChoice(null);
    setVerifyLogInput("");
    showToast("🎉 エラーの解消を記録しました！", "success");
  };

  // 提示した修正案とは違う方法で自力解決した場合。今後の振り返りの参考になるよう、
  // 実際に行った方法を自由記述で記録してから完了報告する。
  const handleMarkResolvedDifferently = () => {
    if (!analysis || !differentMethodInput.trim()) return;
    setVerificationResult({
      status: "resolved",
      message: `✅ 提示した修正案とは違う方法で解決しました。記録: 「${differentMethodInput.trim()}」`,
    });
    setResolutionChoice(null);
    setDifferentMethodInput("");
    showToast("🎉 別の方法での解決を記録しました！", "success");
  };

  // 修正適用後に再実行して得られたログを再解析し、本当に直ったかを検証する。
  // 未解消（同じエラー）なら新しい根本原因・修正案を、別のエラーなら新規解析として提示する。
  const handleVerifyFix = async () => {
    if (!analysis || !verifyLogInput.trim()) return;
    setIsVerifying(true);

    try {
      let recheck: AnalysisResult;
      if (apiKey) {
        // 直前に提示した修正案（要約・根本原因・diffCode/taskSteps）をプロンプトへ含めることで、
        // 「今回のログはその修正を適用した後に再実行して得られたもの」という前提をGeminiに
        // 伝える。これが無いと、Geminiは初見のログとして解析し、既に試して効かなかった
        // 修正案を気づかず繰り返し提案してしまう。
        recheck = await analyzeWithGemini(verifyLogInput, apiKey, selectedModel, [], {
          summary: analysis.summary,
          rootCause: analysis.rootCause,
          fixType: analysis.fixType,
          diffCode: analysis.diffCode,
          taskSteps: analysis.taskSteps,
        });
        recordUsageForResult(recheck);
      } else {
        // ローカル解析エンジンは決定的なルールベースのパターンマッチであり、「直前の修正案が
        // 効かなかった」という文脈を踏まえて提案を変えることはできない（同じログ種別には常に
        // 同じ結果を返す）。そのため、実質的に前回と同じ修正案を繰り返しているケースを検知し、
        // 下のメッセージでユーザーに正直に伝える（repeatedLocalFixNoteを参照）。
        recheck = analyzeErrorLog(verifyLogInput);
        recheck.modelUsed = "ローカル解析エンジン（ルールベース）";
      }

      // エラー種別・対象ファイルが一致するかで「同じ問題が再発しているか」を簡易判定。
      // 「種別は違うがファイルだけ同じ」（例: 修正の副作用で別種のエラーが同じファイルに
      // 発生した）を、種別が同じ場合とORでまとめて「同じ種類のエラー」と表示していると、
      // 実際には別のエラーなのに誤った文言になってしまうため、3パターンに分けて判定する。
      const normalize = (s: string) => s.trim().toLowerCase();
      const sameErrorType = normalize(recheck.errorType) === normalize(analysis.errorType);
      const sameFile = normalize(recheck.filePath) === normalize(analysis.filePath);
      // ローカル解析エンジンの汎用フォールバックは、既知パターンに一致しなかった場合に常に
      // 同じ固定のerrorType/filePathを返す。そのため、前回・今回とも汎用フォールバックだと
      // 「errorTypeが一致した」というだけでは実際に同じ問題かどうか判定できない（無関係な
      // 別のエラーが、たまたま両方とも未知パターンだっただけの可能性がある）。この場合は
      // 誤って「同じエラーが継続している」と断定せず、判定できない旨を正直に伝える。
      const bothGenericFallback = !apiKey && isGenericFallbackResult(analysis) && isGenericFallbackResult(recheck);

      if (bothGenericFallback) {
        setVerificationResult({
          status: "still-failing",
          message:
            "❓ このログはローカル解析エンジンの既知パターンに一致しなかったため、前回と同じ問題が続いているのか、別の未知のエラーなのかを自動判定できませんでした。下の「根本原因」タブの内容と実際のログを見比べてご確認いただくか、Gemini APIキーを設定するとより正確に判定できます。",
        });
        showToast("この内容ではローカル解析エンジンが同一性を判定できませんでした", "info");
      } else if (sameErrorType) {
        // ローカル解析エンジンは決定的なルールベースのため、直前の修正案が効かなかったという
        // 文脈を考慮できず、実質的に同じdiffCode/taskStepsを繰り返し提示することがある。
        // その場合は「新しい修正案」という表現が誤解を招くため、その旨を正直に付記する。
        // ただし、汎用フォールバック（isGenericFallbackResult）はどんなログでもほぼ固定の
        // diffCode/errorType/filePathを返すため、"内容が完全一致"という判定条件だけでは
        // 「実際には無関係な別のエラーが、たまたま両方とも汎用フォールバックに落ちただけ」の
        // ケースを「同じ修正案の再提示」と誤って断定してしまう。汎用フォールバックの場合は
        // この注記自体を出さない。
        const repeatedLocalFixNote =
          !apiKey &&
          !isGenericFallbackResult(recheck) &&
          recheck.diffCode === analysis.diffCode &&
          JSON.stringify(recheck.taskSteps ?? []) === JSON.stringify(analysis.taskSteps ?? [])
            ? "（※ローカル解析エンジンは直前の修正案が効かなかったという情報を考慮できないため、前回と同じ内容を再提示しています。手動での深掘り、またはGemini APIキーの設定をご検討ください）"
            : "";
        setVerificationResult({
          status: "still-failing",
          message: `⚠️ 同じ種類のエラー（${recheck.errorType}）がまだ発生しているようです。新しい根本原因と修正案に更新しました。下の「根本原因」「修正案 (Diff)」タブをご確認ください。${repeatedLocalFixNote}`,
        });
        showToast("修正が不十分なようです。新しい修正案を表示します", "warning");
      } else if (sameFile) {
        setVerificationResult({
          status: "new-error",
          message: `元のエラーは解消されたようですが、同じファイル（${recheck.filePath}）で別の種類の問題（${recheck.errorType}）が新たに検出されました。修正の副作用の可能性もあるため、あわせてご確認ください。`,
        });
        showToast("同じファイルで別の問題を検出しました。新しい解析結果を表示します", "warning");
      } else {
        setVerificationResult({
          status: "new-error",
          message: `別の種類のエラー（${recheck.errorType}）が検出されました。元のエラーは解消された可能性がありますが、新しい問題を解析しましたのでご確認ください。`,
        });
        showToast("別のエラーを検出しました。新しい解析結果を表示します", "info");
      }

      // 検証で得られた最新の解析結果に更新し、履歴にも積み増す
      setAnalysis(recheck);
      analysisVersionRef.current += 1;
      setHasResult(true);
      setActiveTab("cause");
      setIsApplied(false);
      setVerifyLogInput("");
      resetFollowUpState();
      saveToHistory(recheck);
    } catch (err) {
      console.error(err);
      showToast(`検証中にエラーが発生しました (${(err as Error).message.slice(0, 300)})`, "warning");
    } finally {
      setIsVerifying(false);
    }
  };

  const handleSelectHistory = (item: HistoryItem) => {
    setAnalysis(item.result);
    analysisVersionRef.current += 1;
    setHasResult(true);
    setActiveTab("cause");
    setShowHistoryModal(false);
    setIsApplied(false);
    setVerificationResult(null);
    setVerifyLogInput("");
    resetFollowUpState();
    showToast(`履歴「${item.result.errorType}」を読み込みました`, "info");
  };

  // 履歴のピン留めを切り替える。ピン留め中は100件上限の自動削除対象から除外される。
  const handleToggleHistoryPin = (id: string) => {
    setHistory((prev) => {
      const updated = prev.map((item) => (item.id === id ? { ...item, pinned: !item.pinned } : item));
      localStorage.setItem("debug_buddy_history", JSON.stringify(updated));
      return updated;
    });
  };

  // 履歴を書き出し用にファイルとして保存する共通処理。
  // Tauriデスクトップ版では、ブラウザの `<a download>` + Blob URL によるダウンロードが
  // WebView上では保存先ダイアログが出ず何も起きないことがあるため、ネイティブの
  // 「名前を付けて保存」ダイアログ経由でRust側に書き込ませる（export_text_fileコマンド）。
  // Web版（ブラウザ単体プレビュー）では従来通りBlobダウンロードにフォールバックする。
  // 戻り値: 実際に保存された場合はtrue、ダイアログをキャンセルした場合はfalse。
  const saveTextFile = async (
    filename: string,
    content: string,
    mimeType: string,
    filterName: string,
    filterExtensions: string[]
  ): Promise<boolean> => {
    if (IS_TAURI_RUNTIME) {
      const savedPath = await invoke<string | null>("export_text_file", {
        defaultName: filename,
        content,
        filterName,
        filterExtensions,
      });
      return savedPath !== null;
    }
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    return true;
  };

  // 履歴全件をJSONとしてエクスポートする（バックアップ・他ツールへの取り込み用）
  const handleExportHistoryJson = async () => {
    if (history.length === 0) return;
    const dateStr = new Date().toISOString().slice(0, 10);
    try {
      const saved = await saveTextFile(
        `debug-buddy-history-${dateStr}.json`,
        JSON.stringify(history, null, 2),
        "application/json",
        "JSON",
        ["json"]
      );
      if (saved) showToast(`履歴${history.length}件をJSONでエクスポートしました`, "success");
    } catch (err) {
      showToast(`エクスポートに失敗しました: ${String(err).slice(0, 300)}`, "warning");
    }
  };

  // 履歴全件をMarkdownレポートとしてエクスポートする（レビュー・チーム共有用）
  const handleExportHistoryMarkdown = async () => {
    if (history.length === 0) return;
    const dateStr = new Date().toISOString().slice(0, 10);
    const lines: string[] = [`# Debug Buddy 解析履歴（${dateStr} エクスポート、全${history.length}件）`, ""];
    for (const item of history) {
      const r = item.result;
      lines.push(`## ${item.pinned ? "📌 " : ""}${r.errorType}${item.occurrenceCount > 1 ? `（${item.occurrenceCount}回発生）` : ""}`);
      lines.push(`- 解析時刻: ${item.timestamp}`);
      lines.push(`- 対象ファイル: \`${r.filePath}\`（${r.lineNumber}）`);
      lines.push(`- 要約: ${r.summary}`);
      lines.push("", "### 根本原因", r.rootCause, "");
      if (r.diffCode) {
        lines.push("### 修正案", "```diff", r.diffCode, "```", "");
      }
      lines.push("### 学習メモ", r.learningContent, "");
      if (r.preventionTips.length > 0) {
        lines.push("### 再発防止策", ...r.preventionTips.map((tip) => `- ${tip}`), "");
      }
      lines.push("---", "");
    }
    try {
      const saved = await saveTextFile(`debug-buddy-history-${dateStr}.md`, lines.join("\n"), "text/markdown", "Markdown", ["md"]);
      if (saved) showToast(`履歴${history.length}件をMarkdownでエクスポートしました`, "success");
    } catch (err) {
      showToast(`エクスポートに失敗しました: ${String(err).slice(0, 300)}`, "warning");
    }
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
            {item.occurrenceCount > 1 && (
              <span
                title="同じ箇所・同じエラー種別が繰り返し発生した回数"
                className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-rose-500/10 text-rose-600 dark:text-rose-400 flex items-center space-x-1"
              >
                <RotateCcw className="w-2.5 h-2.5" />
                <span>{item.occurrenceCount}回目</span>
              </span>
            )}
          </div>
          <p className="text-xs text-slate-700 dark:text-slate-300 truncate font-medium">{item.result.summary}</p>
          <p className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">📁 {item.result.filePath}</p>
        </div>
        <div className="flex items-center space-x-1 shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleToggleHistoryPin(item.id);
            }}
            title={item.pinned ? "ピン留めを解除（100件上限の自動削除対象に戻す）" : "ピン留め（100件上限の自動削除対象から外す）"}
            className={`p-1 rounded transition cursor-pointer ${
              item.pinned
                ? "text-amber-500 hover:text-amber-600"
                : "text-slate-300 dark:text-slate-600 opacity-0 group-hover:opacity-100 hover:text-amber-500"
            }`}
          >
            <Star className="w-3.5 h-3.5" fill={item.pinned ? "currentColor" : "none"} />
          </button>
          <ChevronRight className="w-4 h-4 text-slate-300 dark:text-slate-600 group-hover:text-cyan-500 dark:group-hover:text-cyan-400 transition" />
        </div>
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
              {availableModels.map((m) => (
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

          {/* Gemini解析のトークン消費量（本日分）。Google側の日次クォータ(RPD)がリセットされる
              太平洋時間の深夜0時を境界に集計し、localStorageで永続化しているため、アプリを
              再起動しても本日分の数値は保持される（0件のうちは表示しない）。
              いずれかのモデルで本日、日次上限超過をGoogle側から実際に検知していればアンバー表示にする。 */}
          {totalTokensToday(dailyUsage) > 0 && (
            <span
              title={formatDailyUsageTooltip(dailyUsage)}
              className={`flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg border ${
                modelsWithQuotaExceededToday(dailyUsage).length > 0
                  ? "bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300"
                  : "bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400"
              }`}
            >
              <Coins className="w-3.5 h-3.5 shrink-0" />
              <span>{totalTokensToday(dailyUsage).toLocaleString()} tokens（本日）</span>
              {modelsWithQuotaExceededToday(dailyUsage).length > 0 && (
                <AlertTriangle className="w-3 h-3 shrink-0" />
              )}
            </span>
          )}

          <div className="hidden sm:block w-px h-6 bg-slate-300 dark:bg-slate-700 mx-0.5" />

          {/* 監視系メニュー: ターミナル監視・クリップボード監視・ログファイル監視をまとめる。
              以前はヘッダーに3つ個別のボタンを並べており混雑していたため、1つのドロップダウンに
              集約した。いずれかが実行中の場合は、集約ボタン自体に緑色＋点滅ドットを表示する。 */}
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowWatchMenu((prev) => !prev);
              }}
              title="ターミナル監視・クリップボード監視・ログファイル監視をまとめて開く"
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border transition cursor-pointer ${
                isClipboardWatching || isLogFileWatching || isTerminalWatching
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20"
                  : "bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-slate-700"
              }`}
            >
              {(isClipboardWatching || isLogFileWatching || isTerminalWatching) && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
              )}
              <Eye className="w-3.5 h-3.5" />
              <span>監視</span>
              <ChevronDown className="w-3 h-3" />
            </button>

            {showWatchMenu && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute left-0 mt-1.5 w-64 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl z-50 overflow-hidden divide-y divide-slate-100 dark:divide-slate-800"
              >
                <button
                  onClick={() => {
                    setShowWatchMenu(false);
                    if (IS_TAURI_RUNTIME) setShowTerminalWatchModal(true);
                  }}
                  disabled={!IS_TAURI_RUNTIME}
                  title={!IS_TAURI_RUNTIME ? "Web版では利用できません（デスクトップアプリ版でのみ利用可能）" : undefined}
                  className="w-full flex items-center space-x-2 px-3 py-2.5 text-left text-xs hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer"
                >
                  {isTerminalWatching ? (
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                  ) : (
                    <Terminal className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 shrink-0" />
                  )}
                  <span className="flex-1 text-slate-700 dark:text-slate-200">
                    {isTerminalWatching ? "ターミナル監視: 監視中" : "ターミナル監視（試験的機能）"}
                  </span>
                </button>
                <button
                  onClick={() => {
                    setShowWatchMenu(false);
                    if (IS_TAURI_RUNTIME) setShowClipboardWatchModal(true);
                  }}
                  disabled={!IS_TAURI_RUNTIME}
                  title={!IS_TAURI_RUNTIME ? "Web版では利用できません（デスクトップアプリ版でのみ利用可能）" : undefined}
                  className="w-full flex items-center space-x-2 px-3 py-2.5 text-left text-xs hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer"
                >
                  {isClipboardWatching ? (
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                  ) : (
                    <ClipboardPaste className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 shrink-0" />
                  )}
                  <span className="flex-1 text-slate-700 dark:text-slate-200">
                    {isClipboardWatching ? "クリップボード監視: 監視中" : "クリップボード監視（試験的機能）"}
                  </span>
                </button>
                <button
                  onClick={() => {
                    setShowWatchMenu(false);
                    if (IS_TAURI_RUNTIME) setShowLogFileWatchModal(true);
                  }}
                  disabled={!IS_TAURI_RUNTIME}
                  title={!IS_TAURI_RUNTIME ? "Web版では利用できません（デスクトップアプリ版でのみ利用可能）" : undefined}
                  className="w-full flex items-center space-x-2 px-3 py-2.5 text-left text-xs hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer"
                >
                  {isLogFileWatching ? (
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                  ) : (
                    <FileText className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 shrink-0" />
                  )}
                  <span className="flex-1 text-slate-700 dark:text-slate-200">
                    {isLogFileWatching ? "ログファイル監視: 監視中" : "ログファイル監視（試験的機能）"}
                  </span>
                </button>
              </div>
            )}
          </div>

          <div className="hidden sm:block w-px h-6 bg-slate-300 dark:bg-slate-700 mx-0.5" />

          {/* プロジェクトフォルダ選択（実ファイルへの適用機能を使うための前提設定）。
              ネイティブのフォルダ選択ダイアログ・ファイルI/Oが必要なため、Web版では利用できない。 */}
          <button
            onClick={() => IS_TAURI_RUNTIME && handlePickProjectRoot()}
            disabled={isPickingRoot || !IS_TAURI_RUNTIME}
            title={
              !IS_TAURI_RUNTIME
                ? "Web版では利用できません（デスクトップアプリ版でのみ利用可能）"
                : projectRoot
                ? `プロジェクトフォルダ: ${projectRoot}（クリックで変更）`
                : "プロジェクトフォルダを選択すると、実ファイルへの安全な自動適用が使えます"
            }
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed max-w-[220px] ${
              projectRoot
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20"
                : "bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-slate-700"
            }`}
          >
            <FolderOpen className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">
              {projectRoot ? projectRoot.split(/[\\/]/).pop() : "プロジェクトフォルダ未選択"}
            </span>
          </button>
          {projectRoot && (
            <>
              <button
                onClick={handleClearAllBackups}
                disabled={isClearingBackups}
                title="このプロジェクトの修正バックアップ(.debug-buddy-backups)をすべて削除して整理します"
                className="flex items-center justify-center p-1.5 rounded-lg text-slate-400 hover:text-amber-500 dark:hover:text-amber-400 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 transition cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={handleClearProjectRoot}
                title="プロジェクトフォルダの設定を解除"
                className="flex items-center justify-center p-1.5 rounded-lg text-slate-400 hover:text-rose-500 dark:hover:text-rose-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </>
          )}

          {/* Git作業ツリーが汚れている場合の注意喚起（実ファイル適用をブロックはしない） */}
          {gitDirtyStatus?.isDirty && (
            <span
              title={`未コミットの変更が${gitDirtyStatus.changedFileCount}件あります。実ファイルへの適用前にコミットまたは退避することをお勧めします`}
              className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg border bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300"
            >
              <GitBranch className="w-3.5 h-3.5 shrink-0" />
              <span>未コミットの変更あり ({gitDirtyStatus.changedFileCount})</span>
            </span>
          )}

          <div className="hidden sm:block w-px h-6 bg-slate-300 dark:bg-slate-700 mx-0.5" />

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

          {/* 振り返りダッシュボードボタン。history stateはWeb版でもlocalStorage経由で使えるため、
              ターミナル/クリップボード監視ボタンと違いIS_TAURI_RUNTIMEによるゲートは不要。 */}
          <button
            onClick={() => setShowHistoryDashboardModal(true)}
            title="解析履歴を集計した振り返りダッシュボードを開く"
            className="flex items-center space-x-1.5 px-3.5 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20 hover:border-emerald-500/60 transition cursor-pointer font-semibold shadow-sm"
          >
            <BarChart3 className="w-4 h-4" />
            <span>振り返り</span>
          </button>

          <div className="hidden sm:block w-px h-6 bg-slate-300 dark:bg-slate-700 mx-0.5" />

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

      {/* 旧ウェルカム合言葉バナーは常設の装飾要素で場所を取るだけだったため撤去。
          サンプルボタンは実際に使う場面（まだ解析結果が無い右側パネル）に移設した。 */}

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
              onChange={(e) => {
                setLogInput(e.target.value);
                clearAnalysisResult();
              }}
              onPaste={handlePasteImage}
              onKeyDown={handleAnalyzeShortcut}
              placeholder="ターミナルやコンソールに出力された任意のエラーログをペーストしてください...（画像を貼り付けると自動で添付されます / Ctrl+Enterで解析実行）"
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
            onPaste={handlePasteImage}
            onKeyDown={handleAnalyzeShortcut}
            placeholder="例:「保存ボタンを押すとアプリが固まる」「ログイン後に画面が真っ白になる」など、ログが手元になくても状況を自由に記述できます。（Ctrl+Enterで解析実行）"
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
              onClick={() => handleAnalyze()}
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
                  {analysis.tokenUsage && (
                    <span
                      title={`プロンプト: ${analysis.tokenUsage.promptTokens} / 応答: ${analysis.tokenUsage.responseTokens}`}
                      className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-300 dark:border-slate-700 font-medium flex items-center space-x-1"
                    >
                      <Coins className="w-3 h-3" />
                      <span>{analysis.tokenUsage.totalTokens.toLocaleString()} tokens</span>
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
                    左側の入力欄に任意のエラーログをペーストするか、下のサンプルを試して「エラーを解析する」を実行してください。
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

                {/* サンプルログ（旧ウェルカムバナーから移設）。解析結果が出た後は
                    このパネル自体が非表示になるため、常設ヘッダーと違い自動的に隠れる。 */}
                <div className="pt-1">
                  <p className="text-[11px] text-slate-400 dark:text-slate-500 mb-1.5">サンプルを試す:</p>
                  <div className="flex items-center justify-center flex-wrap gap-1.5">
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
                    {/* ログ欄・症状説明欄・画像のうち2つ以上が入力された場合に、実際にどれを
                        優先して解析したかを明示する（従来はrootCauseの文中に埋もれて分かり
                        にくかったため、専用の見出し付きボックスとして先頭に出す）。 */}
                    {analysis.inputPriorityNote && (
                      <div className="p-3 rounded-xl bg-indigo-500/10 border border-indigo-500/25 flex items-start space-x-2.5">
                        <Layers className="w-4 h-4 text-indigo-600 dark:text-indigo-400 mt-0.5 shrink-0" />
                        <div>
                          <h4 className="text-[11px] font-semibold text-indigo-700 dark:text-indigo-300 uppercase tracking-wider">
                            入力の優先順位について
                          </h4>
                          <p className="text-xs text-indigo-700/90 dark:text-indigo-200/90 mt-0.5 leading-relaxed">
                            {analysis.inputPriorityNote}
                          </p>
                        </div>
                      </div>
                    )}

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

                    {analysis.fixType !== "task" && (
                      <p className="text-[11px] text-slate-400 dark:text-slate-500 flex items-center space-x-1.5">
                        <AlertCircle className="w-3 h-3 shrink-0" />
                        <span>現在のバージョンでは実ファイルへの自動書き込みは行いません。「コードに適用する」はプレビュー表示のみで、反映するには差分をコピーしてご自身のエディタに貼り付けてください。</span>
                      </p>
                    )}

                    {analysis.fixType === "task" ? (
                      <TaskStepsView steps={analysis.taskSteps && analysis.taskSteps.length > 0 ? analysis.taskSteps : [analysis.diffCode]} />
                    ) : (
                      <DiffView diffCode={analysis.diffCode} />
                    )}

                    {analysis.fixType !== "task" && isApplied && (
                      <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-700 dark:text-emerald-300 flex items-center justify-between">
                        <span className="flex items-center space-x-1.5">
                          <CheckCircle2 className="w-4 h-4 text-emerald-500 dark:text-emerald-400 shrink-0" />
                          <span>
                            修正内容をプレビュー表示中です（<code className="text-slate-600 dark:text-slate-300">{analysis.filePath}</code> 自体はまだ書き換えられていません）
                          </span>
                        </span>
                        <span className="text-[10px] text-emerald-600 dark:text-emerald-400/80">上の差分を手動で反映してください</span>
                      </div>
                    )}

                    {/* 修正案の検証: 実際に対応できたかをチェックし、未解消なら新たな修正案を提案する。
                        「コードに適用する（プレビュー）」を押していなくても（タスク対応の場合や、まだ適用前でも）確認できるよう常時表示する。 */}
                    <div className="p-4 rounded-xl bg-sky-500/10 border border-sky-500/25 space-y-3">
                        <h4 className="text-xs font-semibold text-sky-700 dark:text-sky-300 uppercase tracking-wider flex items-center space-x-1.5">
                          <ShieldCheck className="w-3.5 h-3.5" />
                          <span>修正案で対応できたか検証する</span>
                        </h4>
                        <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                          {analysis.fixType === "task"
                            ? "上記の手順を実施した状態で同じ操作を再実行し、結果に近いものを選んでください。"
                            : "修正を適用した状態で同じ操作を再実行し、結果に近いものを選んでください。"}
                        </p>

                        {/* 修正案の結果を3択で報告してもらう方式。以前は自動生成のチェックリストに
                            全項目チェックしないと完了報告できない仕組みだったが、確認観点が形骸化し
                            意味のある自己申告になっていなかったため、結果に応じた3択に置き換えた。 */}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <button
                            onClick={handleMarkResolved}
                            className="text-xs px-3 py-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 font-semibold flex items-center justify-center space-x-1.5 transition cursor-pointer active:scale-95"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>解決できた</span>
                          </button>
                          <button
                            onClick={() => setResolutionChoice((prev) => (prev === "unresolved" ? null : "unresolved"))}
                            className={`text-xs px-3 py-2.5 rounded-lg border font-semibold flex items-center justify-center space-x-1.5 transition cursor-pointer active:scale-95 ${
                              resolutionChoice === "unresolved"
                                ? "border-rose-500/50 bg-rose-500/15 text-rose-700 dark:text-rose-300"
                                : "border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-900"
                            }`}
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span>解決できなかった</span>
                          </button>
                          <button
                            onClick={() => setResolutionChoice((prev) => (prev === "different" ? null : "different"))}
                            className={`text-xs px-3 py-2.5 rounded-lg border font-semibold flex items-center justify-center space-x-1.5 transition cursor-pointer active:scale-95 ${
                              resolutionChoice === "different"
                                ? "border-indigo-500/50 bg-indigo-500/15 text-indigo-700 dark:text-indigo-300"
                                : "border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-900"
                            }`}
                          >
                            <Wand2 className="w-3.5 h-3.5" />
                            <span>違う方法で解決できた</span>
                          </button>
                        </div>

                        {/* 「解決できなかった」選択時: 再実行後のログを貼り付けて再解析する（従来の検証フローと同じ） */}
                        {resolutionChoice === "unresolved" && (
                          <div className="space-y-2">
                            <textarea
                              value={verifyLogInput}
                              onChange={(e) => setVerifyLogInput(e.target.value)}
                              placeholder="再実行後に出力されたログを貼り付けてください"
                              rows={3}
                              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 p-2.5 font-mono text-xs text-slate-800 dark:text-slate-200 resize-none outline-none focus:border-sky-500/60 focus:ring-1 focus:ring-sky-500/40 transition placeholder:text-slate-400 dark:placeholder:text-slate-600"
                            />
                            <div className="flex items-center justify-end">
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
                          </div>
                        )}

                        {/* 「違う方法で解決できた」選択時: 実際に行った方法を記録してから完了報告する */}
                        {resolutionChoice === "different" && (
                          <div className="space-y-2">
                            <textarea
                              value={differentMethodInput}
                              onChange={(e) => setDifferentMethodInput(e.target.value)}
                              placeholder="どのように解決したか、実際に行った方法を記録しておきましょう（例:「バージョンを上げて解決した」等）"
                              rows={3}
                              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 p-2.5 text-xs text-slate-800 dark:text-slate-200 resize-none outline-none focus:border-indigo-500/60 focus:ring-1 focus:ring-indigo-500/40 transition placeholder:text-slate-400 dark:placeholder:text-slate-600"
                            />
                            <div className="flex items-center justify-end">
                              <button
                                onClick={handleMarkResolvedDifferently}
                                disabled={!differentMethodInput.trim()}
                                className="text-xs px-3.5 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold flex items-center space-x-1.5 transition cursor-pointer active:scale-95"
                              >
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                <span>この内容で完了報告する</span>
                              </button>
                            </div>
                          </div>
                        )}

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

                    {/* 解析結果へのフォローアップ質問。「なぜこの修正が必要か」等を深掘りできる。
                        Gemini APIキー必須（未設定時はFollowUpPanel内で案内のみ表示）。 */}
                    <FollowUpPanel
                      analysis={analysis}
                      analysisVersion={analysisVersionRef.current}
                      apiKey={apiKey}
                      selectedModel={selectedModel}
                      entries={followUpEntries}
                      onAsked={(entry, usage, askedAtVersion) => {
                        // 質問した時点から解析結果が別のものに切り替わっていたら
                        // （回答を待つ間に履歴の別項目を開いた等）、この回答は今表示中の
                        // 解析結果とは無関係なので追加しない（別の解析結果のQ&Aに
                        // 紛れ込むのを防ぐ）。
                        if (askedAtVersion !== analysisVersionRef.current) {
                          showToast("解析結果が切り替わったため、この質問への回答は破棄されました", "info");
                          return;
                        }
                        setFollowUpEntries((prev) => [...prev, entry]);
                        recordUsageForResult(usage);
                      }}
                      showToast={showToast}
                    />

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
                              <span>プレビュー生成中...</span>
                            </>
                          ) : isApplied ? (
                            <>
                              <Undo2 className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />
                              <span>プレビューを取り消す</span>
                            </>
                          ) : (
                            <>
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>コードに適用する（プレビュー）</span>
                            </>
                          )}
                        </button>
                      )}
                    </div>

                    {/* 実ファイルへの安全な適用（追加機能）。プロジェクトフォルダ選択・可否判定・
                        実適用/実ロールバックは、上のプレビュー機能とは独立して動作する。
                        projectRoot未選択・判定不可のケースでは、これまで通りプレビューのみで
                        何も壊れないようにフォールバックする。 */}
                    {analysis.fixType !== "task" && (
                      <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/25 space-y-3">
                        <h4 className="text-xs font-semibold text-amber-700 dark:text-amber-300 uppercase tracking-wider flex items-center space-x-1.5">
                          <Save className="w-3.5 h-3.5" />
                          <span>実ファイルへの適用（オプション）</span>
                        </h4>

                        {!IS_TAURI_RUNTIME ? (
                          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed flex items-start space-x-1.5">
                            <AlertTriangle className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400 shrink-0 mt-0.5" />
                            <span>
                              この機能（実ファイルへの安全な適用）はデスクトップアプリ版でのみ利用できます。
                              Web版では上の差分を「差分をコピー」してご自身のエディタで適用してください。
                            </span>
                          </p>
                        ) : !projectRoot ? (
                          <div className="flex items-center justify-between gap-3 flex-wrap">
                            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                              プロジェクトフォルダを選択すると、安全性を確認したうえで実際のファイルへ書き込めます（対応できないケースはこれまで通りプレビューのみになります）。
                            </p>
                            <button
                              onClick={handlePickProjectRoot}
                              disabled={isPickingRoot}
                              className="shrink-0 text-xs px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-semibold flex items-center space-x-1.5 transition cursor-pointer"
                            >
                              <FolderOpen className="w-3.5 h-3.5" />
                              <span>{isPickingRoot ? "選択中..." : "フォルダを選択"}</span>
                            </button>
                          </div>
                        ) : isCheckingApply ? (
                          <p className="text-xs text-slate-500 dark:text-slate-400 flex items-center space-x-1.5">
                            <span className="w-3 h-3 border-2 border-slate-400 border-t-transparent rounded-full animate-spin shrink-0" />
                            <span>安全に適用できるか確認中...</span>
                          </p>
                        ) : realApplyResult ? (
                          <div className="flex items-center justify-between gap-3 flex-wrap">
                            <p className="text-xs text-emerald-700 dark:text-emerald-300 flex items-center space-x-1.5">
                              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                              <span>
                                実際に書き換えました:{" "}
                                <code className="text-slate-600 dark:text-slate-300">{realApplyResult.appliedPath}</code>
                              </span>
                            </p>
                            <button
                              onClick={handleRealRollback}
                              disabled={isRollingBackReal}
                              className="shrink-0 text-xs px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-amber-700 dark:text-amber-300 border border-amber-500/30 disabled:opacity-50 flex items-center space-x-1.5 transition cursor-pointer"
                            >
                              <Undo2 className="w-3.5 h-3.5" />
                              <span>{isRollingBackReal ? "復元中..." : "実ファイルを元に戻す"}</span>
                            </button>
                          </div>
                        ) : applyCheck?.applicable ? (
                          <div className="space-y-2">
                            {gitDirtyStatus?.isDirty && (
                              <p className="text-[11px] text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/25 rounded-lg px-2.5 py-1.5 flex items-start space-x-1.5">
                                <GitBranch className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                <span>
                                  このプロジェクトには未コミットの変更が{gitDirtyStatus.changedFileCount}件あります。
                                  自動バックアップ（.bakファイル）は作成されますが、可能であれば先にコミットまたは
                                  <code className="mx-0.5">git stash</code>で退避することをお勧めします。
                                </span>
                              </p>
                            )}
                            <div className="flex items-center justify-between gap-3 flex-wrap">
                              <p className="text-xs text-slate-600 dark:text-slate-300">
                                <code className="text-slate-500 dark:text-slate-400">{applyCheck.resolvedPath}</code>{" "}
                                に安全に適用できることを確認しました。
                              </p>
                              <button
                                onClick={() => setShowRealApplyConfirm(true)}
                                disabled={isRealApplying}
                                className="shrink-0 text-xs px-3.5 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-semibold flex items-center space-x-1.5 shadow transition cursor-pointer active:scale-95"
                              >
                                <Save className="w-3.5 h-3.5" />
                                <span>{isRealApplying ? "適用中..." : "実ファイルに適用する"}</span>
                              </button>
                            </div>
                          </div>
                        ) : (
                          <p className="text-xs text-slate-500 dark:text-slate-400 flex items-center space-x-1.5">
                            <AlertTriangle className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400 shrink-0" />
                            <span>{describeUnapplicableReason(applyCheck?.reason ?? null)}</span>
                          </p>
                        )}

                        {/* 過去のバックアップ履歴（複数世代）。直近1件だけでなく、任意の時点まで
                            戻せるように一覧表示する。取得は開いたときだけ行う（読み取り専用）。 */}
                        {projectRoot && (
                          <div className="pt-3 mt-1 border-t border-amber-500/20 space-y-2">
                            <button
                              type="button"
                              onClick={handleToggleBackupHistory}
                              className="text-xs flex items-center space-x-1.5 text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100 transition cursor-pointer"
                            >
                              <History className="w-3.5 h-3.5" />
                              <span>{showBackupHistory ? "過去のバックアップ履歴を閉じる" : "過去のバックアップ履歴を見る"}</span>
                              {showBackupHistory ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                            </button>

                            {showBackupHistory &&
                              (isLoadingBackupHistory ? (
                                <p className="text-xs text-slate-500 dark:text-slate-400 flex items-center space-x-1.5">
                                  <span className="w-3 h-3 border-2 border-slate-400 border-t-transparent rounded-full animate-spin shrink-0" />
                                  <span>読み込み中...</span>
                                </p>
                              ) : backupHistory.length === 0 ? (
                                <p className="text-xs text-slate-400 dark:text-slate-500">このファイルのバックアップはまだありません。</p>
                              ) : (
                                <div className="rounded-lg border border-amber-500/20 bg-white dark:bg-slate-950/60 divide-y divide-amber-500/10 max-h-56 overflow-y-auto">
                                  {backupHistory.map((entry, idx) => (
                                    <div key={entry.id} className="flex items-center justify-between gap-3 px-3 py-2">
                                      <span className="text-xs text-slate-600 dark:text-slate-300 flex items-center space-x-1.5 min-w-0">
                                        <Clock className="w-3.5 h-3.5 shrink-0 text-slate-400 dark:text-slate-500" />
                                        <span className="truncate">
                                          {new Date(entry.createdAtUnixMs).toLocaleString("ja-JP")}
                                        </span>
                                        {idx === 0 && (
                                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300">
                                            最新
                                          </span>
                                        )}
                                      </span>
                                      <button
                                        onClick={() => handleRollbackToBackup(entry.id)}
                                        disabled={isRollingBackReal}
                                        className="shrink-0 text-[11px] px-2.5 py-1 rounded-md bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-amber-700 dark:text-amber-300 border border-amber-500/30 disabled:opacity-50 flex items-center space-x-1 transition cursor-pointer"
                                      >
                                        <Undo2 className="w-3 h-3" />
                                        <span>この時点に戻す</span>
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              ))}
                          </div>
                        )}
                      </div>
                    )}
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

      {/* 実ファイル適用の最終確認モーダル。破壊的操作（バックアップは取るが実ファイルを書き換える）
          のため、ボタン一発ではなく必ずこの確認を経てから apply_fix を呼び出す。 */}
      {showRealApplyConfirm && analysis && applyCheck?.resolvedPath && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 dark:bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Save className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                <h3 className="font-bold text-sm text-slate-900 dark:text-white">実ファイルへの適用の確認</h3>
              </div>
              <button
                onClick={() => setShowRealApplyConfirm(false)}
                className="text-slate-400 hover:text-slate-900 dark:hover:text-white transition p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              以下のファイルを実際に書き換えます。書き換え前の内容は自動でバックアップされ、あとから「元に戻す」でいつでも復元できます。
            </p>

            <div className="rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-3">
              <code className="text-xs text-slate-700 dark:text-slate-300 break-all">{applyCheck.resolvedPath}</code>
            </div>

            {gitDirtyStatus?.isDirty && (
              <p className="text-[11px] text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/25 rounded-lg px-2.5 py-2 flex items-start space-x-1.5">
                <GitBranch className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>
                  未コミットの変更が{gitDirtyStatus.changedFileCount}件残っています。このアプリの自動バックアップとは別に、
                  Gitでもコミット/退避しておくと、より安全に元の状態へ戻せます。
                </span>
              </p>
            )}

            <div className="flex items-center justify-end space-x-2 pt-2">
              <button
                onClick={() => setShowRealApplyConfirm(false)}
                className="px-3.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition cursor-pointer"
              >
                キャンセル
              </button>
              <button
                onClick={handleRealApplyConfirmed}
                className="px-4 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-xs font-semibold text-slate-950 flex items-center space-x-1.5 transition cursor-pointer"
              >
                <Save className="w-3.5 h-3.5" />
                <span>バックアップを取って適用する</span>
              </button>
            </div>
          </div>
        </div>
      )}

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
              Google AI Studio で取得したAPIキーを入力してください。
              {IS_TAURI_RUNTIME
                ? "キーはOSのキーチェーン（資格情報マネージャー等）に安全に保存され、"
                : "Web版ではキーはこのブラウザのlocalStorageに保存されます（共有・公共のPCでは入力後、使い終わったら忘れずにクリアしてください）。"}
              上部で選択したGeminiモデルによる超高精度なリアルタイム解析が可能になります。
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

            {/* モデル診断（プルダウンに出ているが実際には呼び出せないモデルを洗い出す）。
                頻繁に使う操作ではないため、常設のヘッダーボタンではなくAPIキー設定の中に置く。
                キー設定済みのときだけ表示する（未設定では実行できないため）。 */}
            {apiKey && (
              <button
                onClick={() => {
                  setShowKeyModal(false);
                  setShowModelDiagnosticsModal(true);
                }}
                title="一覧の各モデルへ実際にリクエストを送り、使えるか確認します"
                className="w-full flex items-center justify-center space-x-1.5 px-3 py-2 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
              >
                <Cpu className="w-3.5 h-3.5" />
                <span>登録済みモデルを診断する</span>
              </button>
            )}

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
                  ? "まずエラー種別ごとの一覧（色分け・件数）だけを表示しています。種別名をクリックすると中身が展開されます。"
                  : "解析した時刻順に一覧表示しています。クリックすると再度解説とDiffを表示できます。"}
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
                  const isCollapsed = !expandedGroups.has(errorType);
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
              <div className="flex items-center justify-between gap-2 flex-wrap pt-2 border-t border-slate-200 dark:border-slate-800">
                <div className="flex items-center space-x-1.5">
                  <button
                    onClick={handleExportHistoryJson}
                    title="履歴全件をJSONファイルとしてダウンロード（バックアップ・他ツールへの取り込み用）"
                    className="flex items-center space-x-1 text-xs px-2 py-1 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>JSON</span>
                  </button>
                  <button
                    onClick={handleExportHistoryMarkdown}
                    title="履歴全件をMarkdownレポートとしてダウンロード（レビュー・チーム共有用）"
                    className="flex items-center space-x-1 text-xs px-2 py-1 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Markdown</span>
                  </button>
                </div>
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

      {/* 5.5. ターミナル監視モード（試験的機能）。閉じてもバックグラウンドでの監視自体は継続する
          ため、show/hideはCSSのみで切り替え、コンポーネント自体はアンマウントしない。 */}
      <TerminalWatchModal
        open={showTerminalWatchModal}
        onClose={() => setShowTerminalWatchModal(false)}
        projectRoot={projectRoot}
        onPickProjectRoot={handlePickProjectRoot}
        onDetectedError={handleTerminalWatchError}
        showToast={showToast}
        onRunningChange={setIsTerminalWatching}
      />

      {/* 5.6. クリップボード監視モード（試験的機能）。ターミナル監視モードと同様、閉じても
          バックグラウンドでの監視自体は継続するため、show/hideはCSSのみで切り替え、
          コンポーネント自体はアンマウントしない。 */}
      <ClipboardWatchModal
        open={showClipboardWatchModal}
        onClose={() => setShowClipboardWatchModal(false)}
        onDetectedError={handleClipboardWatchError}
        showToast={showToast}
        onRunningChange={setIsClipboardWatching}
      />

      {/* 5.7. ログファイル監視モード（試験的機能）。他の監視モードと同様、閉じても
          バックグラウンドでの監視自体は継続するため、show/hideはCSSのみで切り替え、
          コンポーネント自体はアンマウントしない。 */}
      <LogFileWatchModal
        open={showLogFileWatchModal}
        onClose={() => setShowLogFileWatchModal(false)}
        onDetectedError={handleLogFileWatchError}
        showToast={showToast}
        onRunningChange={setIsLogFileWatching}
      />

      <ModelDiagnosticsModal
        open={showModelDiagnosticsModal}
        onClose={() => setShowModelDiagnosticsModal(false)}
        apiKey={apiKey}
        models={availableModels}
      />

      <HistoryDashboardModal
        open={showHistoryDashboardModal}
        onClose={() => setShowHistoryDashboardModal(false)}
        history={history}
        onSelectHistoryItem={(item) => {
          handleSelectHistory(item);
          setShowHistoryDashboardModal(false);
        }}
      />

      {/* 右クリックメニュー（コピー/切り取り/貼り付けのみの自作メニュー。Issue #3） */}
      {contextMenu && (
        <div
          className="fixed z-50 min-w-[140px] rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-xl py-1 text-xs text-slate-700 dark:text-slate-200"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 150),
            top: Math.min(contextMenu.y, window.innerHeight - 120),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.canCut && (
            <button
              onClick={handleMenuCut}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
            >
              <Scissors className="w-3.5 h-3.5" />
              <span>切り取り</span>
            </button>
          )}
          <button
            onClick={handleMenuCopy}
            disabled={!contextMenu.canCopy}
            className={`w-full flex items-center gap-2 px-3 py-2 text-left ${
              contextMenu.canCopy
                ? "hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
                : "opacity-40 cursor-not-allowed"
            }`}
          >
            <Copy className="w-3.5 h-3.5" />
            <span>コピー</span>
          </button>
          {contextMenu.target && (
            <button
              onClick={handleMenuPaste}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
            >
              <ClipboardPaste className="w-3.5 h-3.5" />
              <span>貼り付け</span>
            </button>
          )}
        </div>
      )}

      {/* 6. トースト通知ポップアップ
          エラー(warning)は内容を読んで対処を検討できるよう、表示時間を延ばし(showToast側)、
          手動で閉じる「×」ボタンと、長い文言を報告・共有用にコピーできるボタンを付ける。 */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 max-w-md animate-bounce">
          <div
            className={`px-4 py-2.5 rounded-xl shadow-2xl text-xs font-medium flex items-start space-x-2 border backdrop-blur-md ${
              toast.type === "success"
                ? "bg-white/95 dark:bg-slate-900/95 text-emerald-700 dark:text-emerald-300 border-emerald-500/40"
                : toast.type === "warning"
                ? "bg-white/95 dark:bg-slate-900/95 text-amber-700 dark:text-amber-300 border-amber-500/40"
                : "bg-white/95 dark:bg-slate-900/95 text-cyan-700 dark:text-cyan-300 border-cyan-500/40"
            }`}
          >
            {toast.type === "success" ? (
              <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-500 dark:text-emerald-400 shrink-0" />
            ) : toast.type === "warning" ? (
              <AlertCircle className="w-4 h-4 mt-0.5 text-amber-500 dark:text-amber-400 shrink-0" />
            ) : (
              <ExternalLink className="w-4 h-4 mt-0.5 text-cyan-500 dark:text-cyan-400 shrink-0" />
            )}
            <span className="whitespace-pre-wrap break-words">{toast.message}</span>
            <div className="flex items-center space-x-1 shrink-0">
              {toast.type === "warning" && (
                <button
                  onClick={copyToastMessage}
                  title="エラー内容をコピー"
                  className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 transition cursor-pointer"
                >
                  {toastCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              )}
              <button
                onClick={dismissToast}
                title="閉じる"
                className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 transition cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
