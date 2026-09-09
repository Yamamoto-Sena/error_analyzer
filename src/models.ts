// 選択可能なGeminiモデルの定義（画面表示用の一覧と、API呼び出し失敗時の
// 自動フォールバック候補を、ここ1箇所にまとめて管理する）。
// App.tsx（表示用）とgemini.ts（フォールバック用）が別々にモデル名を
// ハードコードしていると、片方だけ更新した際に食い違う恐れがあるため。

export interface GeminiModelOption {
  value: string;
  label: string;
}

// 選択可能な Gemini モデル一覧（現行の Flash 系ラインナップ）
export const AVAILABLE_MODELS: GeminiModelOption[] = [
  { value: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite（既定・軽量高速）" },
  { value: "gemini-flash-latest", label: "Gemini Flash（最新版・自動追従）" },
  { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { value: "gemini-3.7-flash", label: "Gemini 3.7 Flash" },
  { value: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
  { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
];

// アプリの既定（初期表示）モデル
export const DEFAULT_MODEL = "gemini-3.5-flash-lite";

// 指定モデルが混雑/RPD超過等で使えなかった場合に、順番に自動試行する候補
// （実際に呼び出す側では、ユーザーが指定したモデルを先頭に置いた上で重複除去する）
// 注: gemini-1.5-flash/pro, gemini-2.0-flash は廃止済みのため候補から除外
export const FALLBACK_MODEL_IDS: string[] = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
