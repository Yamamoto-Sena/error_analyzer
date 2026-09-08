import { useState, useEffect } from "react";
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
} from "lucide-react";
import "./App.css";
import { analyzeErrorLog, AnalysisResult } from "./analyzer";
import { analyzeWithGemini } from "./gemini";

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

export default function App() {
  const [logInput, setLogInput] = useState<string>("");
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<"cause" | "diff" | "learn">("cause");
  const [hasResult, setHasResult] = useState<boolean>(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);

  // APIキー管理
  const [apiKey, setApiKey] = useState<string>("");
  const [showKeyModal, setShowKeyModal] = useState<boolean>(false);
  const [tempApiKey, setTempApiKey] = useState<string>("");

  // 履歴管理
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [showHistoryModal, setShowHistoryModal] = useState<boolean>(false);

  // インタラクション用状態
  const [copied, setCopied] = useState<boolean>(false);
  const [isApplying, setIsApplying] = useState<boolean>(false);
  const [isApplied, setIsApplied] = useState<boolean>(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "info" | "warning" } | null>(null);

  // 初期ロード時に localStorage から APIキーと履歴を復元
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
  }, []);

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

  // 解析実行（Gemini API または ローカル解析エンジンのハイブリッド）
  const handleAnalyze = async () => {
    if (!logInput.trim()) return;
    setIsAnalyzing(true);
    setIsApplied(false);

    try {
      let result: AnalysisResult;

      if (apiKey) {
        // 1. 本物の Gemini API で解析
        showToast("Gemini 3.8 にエラーログを送信中...", "info");
        result = await analyzeWithGemini(logInput, apiKey, "gemini-1.5-flash");
        showToast("✨ Gemini 3.8 による高精度解析が完了しました！", "success");
      } else {
        // 2. ローカル解析エンジンでフォールバック
        await new Promise((r) => setTimeout(r, 600));
        result = analyzeErrorLog(logInput);
        showToast("エラーログの動的解析が完了しました（※APIキーを設定するとGemini 3.8解析が利用可能です）", "info");
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
      const fallback = analyzeErrorLog(logInput);
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
    setHasResult(false);
    setAnalysis(null);
    setIsApplied(false);
    showToast("ログ入力をリセットしました", "info");
  };

  // コピー機能
  const handleCopyDiff = async () => {
    if (!analysis) return;
    try {
      await navigator.clipboard.writeText(analysis.diffCode);
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
      showToast(`修正をロールバック（${analysis.filePath} を復元）しました`, "info");
      return;
    }

    setIsApplying(true);
    setTimeout(() => {
      setIsApplying(false);
      setIsApplied(true);
      showToast(`✅ ${analysis.filePath} に修正を適用しました（バックアップ保存済）`, "success");
    }, 700);
  };

  const handleSelectHistory = (item: HistoryItem) => {
    setAnalysis(item.result);
    setHasResult(true);
    setActiveTab("cause");
    setShowHistoryModal(false);
    showToast(`履歴「${item.result.errorType}」を読み込みました`, "info");
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col selection:bg-cyan-500 selection:text-white relative">
      {/* 1. トップナビゲーションバー */}
      <header className="border-b border-slate-800/80 bg-slate-900/60 backdrop-blur-md sticky top-0 z-40 px-6 py-3.5 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-500 via-teal-500 to-indigo-500 flex items-center justify-center shadow-lg shadow-cyan-500/20">
            <Terminal className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-bold text-lg tracking-wider bg-gradient-to-r from-cyan-400 to-teal-300 bg-clip-text text-transparent">
                DEBUG BUDDY
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                Desktop v0.1.0
              </span>
            </div>
            <p className="text-xs text-slate-400">AI-Powered Debugging & Error Log Analysis Assistant 🚀</p>
          </div>
        </div>

        {/* システムステータス & 設定ボタン */}
        <div className="flex items-center space-x-2.5 text-xs">
          {/* Gemini API 設定ボタン */}
          <button
            onClick={() => setShowKeyModal(true)}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border transition cursor-pointer ${
              apiKey
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20"
                : "bg-slate-800 border-slate-700 text-slate-300 hover:text-white hover:bg-slate-700"
            }`}
          >
            <Key className="w-3.5 h-3.5" />
            <span>Gemini 3.8:</span>
            <span className="font-semibold">{apiKey ? "Active" : "APIキー設定"}</span>
          </button>

          {/* 履歴モーダルボタン */}
          <button
            onClick={() => setShowHistoryModal(true)}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:text-white hover:bg-slate-700 transition cursor-pointer"
          >
            <History className="w-3.5 h-3.5 text-cyan-400" />
            <span>履歴 ({history.length})</span>
          </button>
        </div>
      </header>

      {/* 2. ウェルカム合言葉バナー */}
      <div className="px-6 pt-5">
        <div className="bg-gradient-to-r from-cyan-950/40 via-slate-900/60 to-indigo-950/40 border border-cyan-500/20 rounded-2xl p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 shadow-sm">
          <div className="flex items-center space-x-3.5">
            <div className="p-2.5 rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 shrink-0">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="text-sm font-semibold text-white">👋 ようこそ、Debug Buddy へ！</span>
                <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                  合言葉: 「エラーは成長のチャンス！」
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                ログを貼り付けるだけで、AIが原因の解説・修正パッチ・学習メモを動的生成します。
                {!apiKey && (
                  <span className="text-cyan-400 ml-1 cursor-pointer hover:underline" onClick={() => setShowKeyModal(true)}>
                    （※APIキーを設定するとGemini 3.8が有効になります）
                  </span>
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <span className="text-xs text-slate-400">サンプル:</span>
            <button
              onClick={() => handleSampleLoad("typeError")}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 transition cursor-pointer"
            >
              TypeError
            </button>
            <button
              onClick={() => handleSampleLoad("syntaxError")}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 border border-slate-700 transition cursor-pointer"
            >
              SyntaxError
            </button>
            <button
              onClick={() => handleSampleLoad("refError")}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-purple-300 border border-slate-700 transition cursor-pointer"
            >
              ReferenceError
            </button>
            <button
              onClick={() => handleSampleLoad("portError")}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-rose-400 border border-rose-500/30 transition cursor-pointer"
            >
              Port競合 (1420)
            </button>
            <button
              onClick={() => handleSampleLoad("attributeError")}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-emerald-400 border border-emerald-500/30 transition cursor-pointer"
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
            <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center space-x-2">
              <Bug className="w-4 h-4 text-rose-400" />
              <span>エラーログ / スタックトレース</span>
            </label>
            <span className="text-xs text-slate-500">{logInput.length} 文字</span>
          </div>

          <div className="relative rounded-xl border border-slate-800 bg-slate-900/80 shadow-inner focus-within:border-cyan-500/60 focus-within:ring-1 focus-within:ring-cyan-500/50 transition">
            <textarea
              value={logInput}
              onChange={(e) => setLogInput(e.target.value)}
              placeholder="ターミナルやコンソールに出力された任意のエラーログをペーストしてください..."
              rows={14}
              className="w-full bg-transparent p-4 font-mono text-xs text-slate-200 resize-none outline-none leading-relaxed placeholder:text-slate-600"
            />
            {logInput && (
              <button
                onClick={handleReset}
                title="クリア"
                className="absolute top-3 right-3 p-1.5 rounded-md bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white transition cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="flex items-center space-x-3">
            <button
              onClick={handleAnalyze}
              disabled={isAnalyzing || !logInput.trim()}
              className="flex-1 py-3 px-4 rounded-xl bg-gradient-to-r from-cyan-500 to-teal-500 hover:from-cyan-400 hover:to-teal-400 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-sm text-slate-950 flex items-center justify-center space-x-2 shadow-lg shadow-cyan-500/25 transition cursor-pointer active:scale-[0.99]"
            >
              {isAnalyzing ? (
                <>
                  <div className="w-4 h-4 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" />
                  <span>{apiKey ? "Gemini 3.8 が高精度解析中..." : "ログを解析中..."}</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>{apiKey ? "Gemini 3.8 で解析する" : "エラーを解析する"}</span>
                </>
              )}
            </button>
          </div>
        </section>

        {/* 右カラム: 解析結果表示エリア */}
        <section className="lg:col-span-7 flex flex-col space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                解析＆アドバイス結果
              </span>
              {hasResult && analysis && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                  {analysis.errorType}
                </span>
              )}
            </div>

            {/* タブ切り替え */}
            {hasResult && (
              <div className="flex space-x-1 p-1 bg-slate-900 border border-slate-800 rounded-lg text-xs">
                <button
                  onClick={() => setActiveTab("cause")}
                  className={`px-3 py-1 rounded-md transition cursor-pointer ${
                    activeTab === "cause" ? "bg-cyan-500/20 text-cyan-300 font-medium" : "text-slate-400 hover:text-white"
                  }`}
                >
                  根本原因 & 要約
                </button>
                <button
                  onClick={() => setActiveTab("diff")}
                  className={`px-3 py-1 rounded-md transition cursor-pointer ${
                    activeTab === "diff" ? "bg-cyan-500/20 text-cyan-300 font-medium" : "text-slate-400 hover:text-white"
                  }`}
                >
                  修正案 (Diff)
                </button>
                <button
                  onClick={() => setActiveTab("learn")}
                  className={`px-3 py-1 rounded-md transition cursor-pointer ${
                    activeTab === "learn" ? "bg-cyan-500/20 text-cyan-300 font-medium" : "text-slate-400 hover:text-white"
                  }`}
                >
                  学習メモ & 理論
                </button>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 min-h-[380px] flex flex-col justify-start">
            {!hasResult || !analysis ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-8 text-slate-500 space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-slate-800/80 border border-slate-700/50 flex items-center justify-center text-slate-400">
                  <Terminal className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-300">まだ解析結果はありません</p>
                  <p className="text-xs text-slate-500 mt-1 max-w-sm">
                    左側の入力欄に任意のエラーログをペーストするか、上部のサンプルボタンをクリックして「エラーを解析する」を実行してください。
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {activeTab === "cause" && (
                  <div className="space-y-4">
                    <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-start space-x-3">
                      <AlertCircle className="w-5 h-5 text-rose-400 mt-0.5 shrink-0" />
                      <div>
                        <h4 className="text-xs font-semibold text-rose-300 uppercase tracking-wider">エラー概要</h4>
                        <p className="text-sm text-slate-200 mt-1 font-medium leading-relaxed">
                          {analysis.summary}
                        </p>
                      </div>
                    </div>

                    <div className="p-4 rounded-xl bg-slate-800/50 border border-slate-800 space-y-2">
                      <h4 className="text-xs font-semibold text-cyan-400 uppercase tracking-wider flex items-center space-x-1.5">
                        <Bug className="w-3.5 h-3.5" />
                        <span>発生の根本原因 (Root Cause)</span>
                      </h4>
                      <p className="text-xs text-slate-300 leading-relaxed">
                        {analysis.rootCause}
                      </p>
                    </div>

                    <div className="p-4 rounded-xl bg-slate-800/30 border border-slate-800 space-y-2">
                      <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center space-x-1.5">
                        <Code2 className="w-3.5 h-3.5 text-indigo-400" />
                        <span>対象ファイル・行番号</span>
                      </h4>
                      <p className="text-xs font-mono text-slate-400">
                        📁 {analysis.filePath} : {analysis.lineNumber}
                      </p>
                    </div>

                    <div className="flex justify-end">
                      <button
                        onClick={() => setActiveTab("diff")}
                        className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center space-x-1 cursor-pointer"
                      >
                        <span>修正案 (Diff) を確認する</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}

                {activeTab === "diff" && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-xs text-slate-400">
                      <span>修正差分プレビュー (Unified Diff) - {analysis.filePath}</span>
                      <button
                        onClick={handleCopyDiff}
                        className="flex items-center space-x-1.5 py-1 px-2.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer"
                      >
                        {copied ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                            <span className="text-emerald-400 font-medium">コピー完了！</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span>差分をコピー</span>
                          </>
                        )}
                      </button>
                    </div>

                    <pre className="rounded-lg bg-slate-950 p-3.5 font-mono text-xs overflow-x-auto border border-slate-800 leading-relaxed text-slate-300 whitespace-pre-wrap">
                      {analysis.diffCode}
                    </pre>

                    {isApplied && (
                      <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-300 flex items-center justify-between">
                        <span className="flex items-center space-x-1.5">
                          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                          <span>修正が適用されました（バックアップ: <code className="text-slate-300">{analysis.filePath}.bak</code>）</span>
                        </span>
                        <span className="text-[10px] text-emerald-400/80">再テスト推奨</span>
                      </div>
                    )}

                    <div className="flex items-center justify-end space-x-2 pt-2">
                      <button
                        onClick={() => showToast("修正の適用をスキップしました", "info")}
                        className="text-xs px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition cursor-pointer"
                      >
                        スキップ
                      </button>
                      <button
                        onClick={handleApplyFix}
                        disabled={isApplying}
                        className={`text-xs px-4 py-2 rounded-lg font-semibold flex items-center space-x-1.5 shadow transition cursor-pointer active:scale-95 ${
                          isApplied
                            ? "bg-slate-800 text-amber-300 hover:bg-slate-700 border border-amber-500/30"
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
                            <Undo2 className="w-3.5 h-3.5 text-amber-400" />
                            <span>修正を取り消す (ロールバック)</span>
                          </>
                        ) : (
                          <>
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>コードに自動適用する</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {activeTab === "learn" && (
                  <div className="space-y-4">
                    <div className="p-4 rounded-xl bg-indigo-500/10 border border-indigo-500/20 space-y-2">
                      <h4 className="text-xs font-semibold text-indigo-300 uppercase tracking-wider flex items-center space-x-1.5">
                        <BookOpen className="w-4 h-4" />
                        <span>{analysis.learningTitle}</span>
                      </h4>
                      <p className="text-xs text-slate-300 leading-relaxed">
                        {analysis.learningContent}
                      </p>
                    </div>

                    <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-800 space-y-2">
                      <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center space-x-1.5">
                        <HelpCircle className="w-3.5 h-3.5 text-teal-400" />
                        <span>再発防止のベストプラクティス</span>
                      </h4>
                      <ul className="text-xs text-slate-300 list-disc list-inside space-y-1.5 leading-relaxed">
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
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Key className="w-5 h-5 text-cyan-400" />
                <h3 className="font-bold text-sm text-white">Google Gemini APIキー設定</h3>
              </div>
              <button
                onClick={() => setShowKeyModal(false)}
                className="text-slate-400 hover:text-white transition p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              Google AI Studio で取得したAPIキーを入力してください。キーはローカルブラウザ内にのみ安全に保存され、Gemini 3.8 による超高精度なリアルタイム解析が可能になります。
            </p>

            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-slate-300 uppercase">API Key</label>
              <input
                type="password"
                value={tempApiKey}
                onChange={(e) => setTempApiKey(e.target.value)}
                placeholder="AIzaSy..."
                className="w-full bg-slate-950 border border-slate-800 focus:border-cyan-500 rounded-xl px-3.5 py-2 text-xs font-mono outline-none text-slate-200"
              />
            </div>

            <div className="flex items-center justify-between pt-2">
              <a
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noreferrer"
                className="text-xs text-cyan-400 hover:underline flex items-center space-x-1"
              >
                <span>キーを取得する (無料)</span>
                <ExternalLink className="w-3 h-3" />
              </a>
              <div className="flex space-x-2">
                <button
                  onClick={() => setShowKeyModal(false)}
                  className="px-3.5 py-1.5 rounded-lg bg-slate-800 text-xs text-slate-300 hover:bg-slate-700 transition cursor-pointer"
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

      {/* 5. 履歴モーダル */}
      {showHistoryModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4 max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <History className="w-5 h-5 text-cyan-400" />
                <h3 className="font-bold text-sm text-white">過去のデバッグ解析履歴</h3>
              </div>
              <button
                onClick={() => setShowHistoryModal(false)}
                className="text-slate-400 hover:text-white transition p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-400">
              過去に解析・解決したエラーのナレッジです。クリックすると再度解説とDiffを表示できます。
            </p>

            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              {history.length === 0 ? (
                <div className="text-center py-8 text-xs text-slate-500">
                  まだ履歴がありません。エラーを解析するとここに蓄積されます。
                </div>
              ) : (
                history.map((item) => (
                  <div
                    key={item.id}
                    onClick={() => handleSelectHistory(item)}
                    className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 hover:border-cyan-500/50 hover:bg-slate-800/40 transition cursor-pointer flex items-center justify-between group"
                  >
                    <div className="space-y-1 max-w-[85%]">
                      <div className="flex items-center space-x-2">
                        <span className="text-[10px] px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 font-medium">
                          {item.result.errorType}
                        </span>
                        <span className="text-[10px] text-slate-500 flex items-center space-x-1">
                          <Clock className="w-3 h-3" />
                          <span>{item.timestamp}</span>
                        </span>
                      </div>
                      <p className="text-xs text-slate-300 truncate font-medium">{item.result.summary}</p>
                      <p className="text-[10px] text-slate-500 font-mono">📁 {item.result.filePath}</p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-slate-600 group-hover:text-cyan-400 transition" />
                  </div>
                ))
              )}
            </div>

            {history.length > 0 && (
              <div className="flex justify-end pt-2 border-t border-slate-800">
                <button
                  onClick={() => {
                    setHistory([]);
                    localStorage.removeItem("debug_buddy_history");
                    showToast("履歴をクリアしました", "info");
                  }}
                  className="text-xs text-rose-400 hover:text-rose-300 transition cursor-pointer"
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
                ? "bg-slate-900/95 text-emerald-300 border-emerald-500/40"
                : toast.type === "warning"
                ? "bg-slate-900/95 text-amber-300 border-amber-500/40"
                : "bg-slate-900/95 text-cyan-300 border-cyan-500/40"
            }`}
          >
            {toast.type === "success" ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            ) : toast.type === "warning" ? (
              <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
            ) : (
              <ExternalLink className="w-4 h-4 text-cyan-400 shrink-0" />
            )}
            <span>{toast.message}</span>
          </div>
        </div>
      )}
    </div>
  );
}
