// エラー解析結果の型定義
export interface AnalysisResult {
  errorType: string;
  summary: string;
  rootCause: string;
  filePath: string;
  lineNumber: string;
  diffCode: string;
  /** 修正手段の種類。"code": コードの差分で直せる / "task": コマンド実行・再起動・ケーブル抜き差し等、手順による対応が必要（省略時は "code" 扱い） */
  fixType?: "code" | "task";
  /** fixType が "task" の場合に、解決のために実施すべき手順を1つずつ格納する（code の場合は空配列 or 省略） */
  taskSteps?: string[];
  learningTitle: string;
  learningContent: string;
  preventionTips: string[];
  /** 実際にこの解析結果を生成したエンジン/モデル名（例: "gemini-3.8-flash-002" や "ローカル解析エンジン"） */
  modelUsed?: string;
  /** ユーザーが本来選択・指定していたモデル名（Gemini解析時のみ） */
  modelRequested?: string;
  /** 混雑やRPD(1日の上限)超過等により、指定モデルではなく別モデルに自動フォールバックしたか */
  usedFallbackModel?: boolean;
  /** フォールバック時にクォータ超過(RPD等)で使用できなかったモデル名の一覧 */
  quotaExceededModels?: string[];
  /** 修正箇所に関連する公式ドキュメントへのリンク（判別できた場合のみ） */
  officialDocLink?: OfficialDocLink;
}

export interface OfficialDocLink {
  label: string;
  url: string;
}

// エラー種別・ログ内容から関連する公式ドキュメントを推定する
export function getOfficialDocLink(errorType: string, contextText: string = ""): OfficialDocLink | null {
  const haystack = `${errorType}\n${contextText}`;

  if (/EADDRINUSE|Port\s+\d+\s+is already in use/i.test(haystack)) {
    return {
      label: "Node.js 公式: エラーコード一覧（EADDRINUSE ほか）",
      url: "https://nodejs.org/api/errors.html#common-system-errors",
    };
  }
  if (/ModuleNotFoundError|Cannot find module|MODULE_NOT_FOUND|failed to resolve import/i.test(haystack)) {
    return {
      label: "Node.js 公式: モジュール解決の仕組み",
      url: "https://nodejs.org/api/modules.html#all-together",
    };
  }
  if (/AttributeError/i.test(haystack)) {
    return {
      label: "Python 公式ドキュメント: 組み込み例外 AttributeError",
      url: "https://docs.python.org/ja/3/library/exceptions.html#AttributeError",
    };
  }
  if (/cannot read propert|TypeError/i.test(haystack)) {
    return {
      label: "MDN Web Docs: TypeError リファレンス",
      url: "https://developer.mozilla.org/ja/docs/Web/JavaScript/Reference/Global_Objects/TypeError",
    };
  }
  if (/SyntaxError|Unexpected token/i.test(haystack)) {
    return {
      label: "MDN Web Docs: SyntaxError リファレンス",
      url: "https://developer.mozilla.org/ja/docs/Web/JavaScript/Reference/Global_Objects/SyntaxError",
    };
  }
  if (/ReferenceError|is not defined/i.test(haystack)) {
    return {
      label: "MDN Web Docs: ReferenceError リファレンス",
      url: "https://developer.mozilla.org/ja/docs/Web/JavaScript/Reference/Global_Objects/ReferenceError",
    };
  }
  if (/CORS|Failed to fetch|NetworkError|ECONNREFUSED/i.test(haystack)) {
    return {
      label: "MDN Web Docs: オリジン間リソース共有（CORS）ガイド",
      url: "https://developer.mozilla.org/ja/docs/Web/HTTP/CORS",
    };
  }

  return null;
}

// ログからファイルパスと行番号を抽出する正規表現ヘルパー
function extractLocation(log: string): { file: string; line: string } {
  const lines = log.split("\n");

  // Pythonの「Traceback (most recent call last):」が存在する場合は末尾から逆順に探す
  // （Pythonはスタックの一番最後・下が実際にクラッシュした発生行）
  const isPythonTraceback = /Traceback \(most recent call last\):/i.test(log) || /File\s+["'][^"']+["'],\s+line\s+\d+/i.test(log);

  const searchLines = isPythonTraceback ? [...lines].reverse() : lines;

  for (const line of searchLines) {
    if (!line.includes("node_modules") && !line.includes("node:internal")) {
      // Python形式: File "/app/src/controllers/api_controller.py", line 15, in handle_request
      const pyMatch = line.match(/File\s+["']([^"']+)["'],\s+line\s+(\d+)/);
      if (pyMatch) {
        return { file: pyMatch[1], line: pyMatch[2] };
      }

      // JS/TS形式: at handle_request (src/controllers/api.ts:15:2)
      const stackMatch = line.match(/(?:at\s+[\w.<>]+\s+\()?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+):(\d+)(?::\d+)?\)?/);
      if (stackMatch) {
        return { file: stackMatch[1], line: stackMatch[2] };
      }
    }
  }

  // ユーザーコードが見つからない場合は全体から抽出
  const generalPyMatch = log.match(/File\s+["']([^"']+)["'],\s+line\s+(\d+)/);
  if (generalPyMatch) {
    return { file: generalPyMatch[1], line: generalPyMatch[2] };
  }

  const generalMatch = log.match(/(?:at\s+[\w.<>]+\s+\()?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+):(\d+)(?::\d+)?\)?/);
  if (generalMatch) {
    return { file: generalMatch[1], line: generalMatch[2] };
  }

  return { file: "設定・起動プロセス (vite.config.ts / src-tauri)", line: "1" };
}

// 入力されたエラーログを動的に解析するエンジン（内部実装）
function analyzeErrorLogCore(rawLog: string): AnalysisResult {
  const log = rawLog.trim();
  const location = extractLocation(log);

  // 1. ポート競合エラー (Port ... is already in use / EADDRINUSE)
  if (/Port\s+(\d+)\s+is already in use/i.test(log) || /EADDRINUSE/i.test(log)) {
    const portMatch = log.match(/Port\s+(\d+)\s+is already in use/i) || log.match(/:(\d+)/);
    const portNum = portMatch ? portMatch[1] : "1420";

    return {
      errorType: "EADDRINUSE: ポート重複・競合エラー ⚠️",
      summary: `ポート番号 ${portNum} が既に別のプロセス（以前起動したアプリやNodeプロセス）によって占有されています。`,
      rootCause: `Viteなどの開発サーバーは起動時に指定されたポート（${portNum}番）を確保（バインド）しますが、前回のプロセスが正しく終了せずバックグラウンドに残っているか、別ウィンドウで二重起動しているため起動に失敗しました。また、Tauriはフロントエンドの起動（beforeDevCommand）が失敗したことを検知して全体の起動を中断（ELIFECYCLE code 1）しています。`,
      filePath: "vite.config.ts / バックグラウンドプロセス",
      lineNumber: "15〜18行目 (server.port)",
      fixType: "task",
      taskSteps: [
        `【解決策1・推奨】ポートを占有している古いプロセスを終了する\nPowerShell の場合:\nGet-Process -Name "node", "tauri-app" -ErrorAction SilentlyContinue | Stop-Process -Force\n\nコマンドプロンプト (cmd) の場合:\ntaskkill /F /IM node.exe /T\ntaskkill /F /IM tauri-app.exe /T`,
        `【解決策2】空いている別のポートを自動使用する設定に変更する\nvite.config.ts の server.strictPort を false に変更してください（true だと競合時に即エラー終了、false なら空きポート（${Number(portNum) + 1}等）を自動探索します）。`,
        `上記いずれかを実施後、開発サーバーを再起動してポート ${portNum} で正常に起動するか確認する`,
      ],
      diffCode: `# 解決策1: ポートを占有している古いプロセスを終了する（推奨）
# [PowerShell の場合]:
Get-Process -Name "node", "tauri-app" -ErrorAction SilentlyContinue | Stop-Process -Force

# [コマンドプロンプト (cmd) の場合]:
taskkill /F /IM node.exe /T
taskkill /F /IM tauri-app.exe /T

# ----------------------------------------------------
# 解決策2: 空いている別のポートを自動使用する設定に変更
--- a/vite.config.ts
+++ b/vite.config.ts
@@ -16,4 +16,4 @@
   server: {
     port: ${portNum},
-    strictPort: true,   // trueだと競合時に即エラー終了
+    strictPort: false,  // falseにすると空きポート（${Number(portNum) + 1}等）を自動探索
   },`,
      learningTitle: "💡 学習ポイント: ポート番号（Port）とプロセスのライフサイクル",
      learningContent: "ポート番号はPC内で動く各サーバーアプリケーションの「部屋番号」のようなものです。同じポート番号を複数のアプリが同時に使うことはできません。開発中にターミナルをCtrl+Cで止めずに閉じたり、強制終了した場合、プロセスがバックグラウンドに「ゾンビプロセス」として残り、ポートを塞ぎ続けることがよくあります。",
      preventionTips: [
        "開発サーバーを終了する際は、ウィンドウをいきなり閉じずに必ずターミナルで [Ctrl + C] を押して正常終了する",
        "ポート競合が起きたらタスクマネージャーやコマンドで残存した node.exe を終了する",
        "Tauriの「beforeDevCommand terminated with a non-zero status code」は、フロントエンド側（Vite）のエラーが原因で発生する親エラーであることを見抜く"
      ],
    };
  }

  // 2. Python AttributeError: 'NoneType' object has no attribute ...
  if (/AttributeError:\s+'NoneType'\s+object has no attribute\s+['"]?([^'"]+)['"]?/i.test(log)) {
    const attrMatch = log.match(/AttributeError:\s+'NoneType'\s+object has no attribute\s+['"]?([^'"]+)['"]?/i);
    const attrName = attrMatch ? attrMatch[1] : "attribute";

    // 呼び出し元の関数名や変数をログから推定（例: response = get_user_profile(...) など）
    const lineSnippetMatch = log.match(/(?:response|user|data|result)\.([a-zA-Z0-9_]+)/i);
    const targetVar = lineSnippetMatch ? lineSnippetMatch[0].split(".")[0] : "対象変数";

    return {
      errorType: "AttributeError: 'NoneType' 属性参照エラー",
      summary: `未定義・空のデータ（None）に対して存在しないプロパティ '.${attrName}' を参照したため例外が発生しました。`,
      rootCause: `直前の処理（データベース検索や外部関数呼び出し）が該当するレコードを取得できず None を返却しました。その結果、戻り値を受け取った ${targetVar} が None の状態のまま '.${attrName}' にアクセスしたことが原因です。`,
      filePath: location.file,
      lineNumber: `${location.line}行目`,
      diffCode: `--- a/${location.file}
+++ b/${location.file}
@@ -${location.line},3 +${location.line},5 @@
- print("User ID: " + ${targetVar}.${attrName})
+ # 修正案: Noneチェック（ガード節）を追加して安全に参照する
+ if ${targetVar} is not None:
+     print("User ID: " + str(${targetVar}.${attrName}))
+ else:
+     print("ユーザー情報が見つかりませんでした")`,
      learningTitle: "💡 学習ポイント: Pythonにおける NoneType とガード節（Null Check）",
      learningContent: "Pythonの関数やSQLAlchemyなどのORM（.first()）は、対象データが存在しない場合に None を返します。None は特定の値を持たない特殊なオブジェクトであるため、そのまま '.${attrName}' のように属性アクセスするとクラッシュします。必ず事前に 'if obj is not None:' で安全性を担保しましょう。",
      preventionTips: [
        "DBクエリやAPI戻り値など、データが存在しない可能性がある場合は必ず事前に None チェックを行う",
        "関数の型ヒントに Optional[User] や User | None を明記し、mypy/Pyrightなどの静的解析を活用する",
        "getattr(obj, '${attrName}', None) や三項演算子を活用してデフォルト値を設ける"
      ],
    };
  }

  // 3. モジュール未検出 (Cannot find module / MODULE_NOT_FOUND)
  if (/Cannot find module/i.test(log) || /MODULE_NOT_FOUND/i.test(log) || /failed to resolve import/i.test(log)) {
    const pkgMatch = log.match(/Cannot find module\s+['"]([^'"]+)['"]/i) || log.match(/resolve import\s+['"]([^'"]+)['"]/i);
    const pkgName = pkgMatch ? pkgMatch[1] : "依存パッケージ";

    return {
      errorType: "ModuleNotFoundError: 依存パッケージ未検出",
      summary: `必要なパッケージまたはファイル '${pkgName}' が見つかりません。`,
      rootCause: `プロジェクトに必要なライブラリがインストールされていないか、import文の相対パス（./ や ../）が間違っています。`,
      filePath: location.file,
      lineNumber: `${location.line}行目`,
      fixType: "task",
      taskSteps: [
        `ターミナルで不足しているパッケージをインストールする\npnpm add ${pkgName}\n# または\nnpm install ${pkgName}`,
        `import文の相対パス（./ や ../）やパッケージ名のスペルミスがないか、${location.file} を確認する`,
        `インストール完了後、開発サーバーを再起動してエラーが解消したか確認する`,
      ],
      diffCode: `# ターミナルで不足しているパッケージをインストールしてください
pnpm add ${pkgName}
# または
npm install ${pkgName}

--- a/${location.file}
+++ b/${location.file}
@@ -1,3 +1,3 @@
- import { something } from '${pkgName}';
+ import { something } from '${pkgName}'; // インストール後に正常解決されます`,
      learningTitle: "💡 学習ポイント: package.json と node_modules の仕組み",
      learningContent: "Node.jsプロジェクトをGitからクローンしたり別環境に持ってきた直後は、`node_modules` が存在しないためパッケージ未検出エラーになります。作業開始前に必ず `pnpm install` または `npm install` を実行する習慣をつけましょう。",
      preventionTips: [
        "リポジトリ取得後は最初にパッケージマネージャーでインストールを行う",
        "自作モジュールをインポートする際は相対パスのスペルミス（大文字小文字含む）を確認する",
        "package.json の dependencies に正しく記載されているか確認する"
      ],
    };
  }

  // 3. Cannot read properties of undefined / null / TypeError
  if (/cannot read propert/i.test(log) || (/TypeError/i.test(log) && /undefined|null/i.test(log))) {
    const propMatch = log.match(/reading\s+'([^']+)'/i) || log.match(/of\s+'?([a-zA-Z0-9_]+)'?/i);
    const propName = propMatch ? propMatch[1] : "property";

    return {
      errorType: "TypeError: Null / Undefined 参照エラー",
      summary: `未定義（undefined または null）のオブジェクトに対して '.${propName}' を参照・呼び出そうとしています。`,
      rootCause: `変数の初期化前、または非同期APIレスポンスの取得完了前に、対象オブジェクトのプロパティ '${propName}' にアクセスしたことが原因です。`,
      filePath: location.file,
      lineNumber: `${location.line}行目`,
      diffCode: `--- a/${location.file}
+++ b/${location.file}
@@ -${location.line},3 +${location.line},3 @@
- const result = data.${propName};
+ const result = data?.${propName} ?? "初期値";`,
      learningTitle: "💡 学習ポイント: オプショナルチェーン (?.) と Null合体 (??)",
      learningContent: "TypeScript/JavaScriptでは `data?.${propName}` のように安全なアクセス演算子を使うことで、undefined/null時に例外を投げず安全に処理を継続できます。",
      preventionTips: [
        "オブジェクトの初期ステートにデフォルト値を設ける",
        "APIフェッチのローディング状態（isLoading）を判定してから表示する",
        "TypeScriptの strictNullChecks を有効にする"
      ],
    };
  }

  // 4. SyntaxError / 構文エラー
  if (/SyntaxError/i.test(log) || /Unexpected token/i.test(log)) {
    return {
      errorType: "SyntaxError: 構文エラー",
      summary: "コードの文法が正しくありません。括弧の不一致や不正な記号が含まれています。",
      rootCause: "波括弧 `{}`、丸括弧 `()`、またはクォーテーションの閉じ忘れ、あるいはカンマやセミコロンの指定位置が誤っています。",
      filePath: location.file,
      lineNumber: `${location.line}行目`,
      diffCode: `--- a/${location.file}
+++ b/${location.file}
@@ -${location.line},3 +${location.line},3 @@
- return ( <div> <span>未完了</span>
+ return ( <div> <span>修正完了</span> </div> );`,
      learningTitle: "💡 学習ポイント: エディタの構文ハイライトとLinterの活用",
      learningContent: "構文エラーはESLintやPrettierなどのフォーマッターを導入することで、保存時に自動検知・自動修正できます。",
      preventionTips: [
        "エディタで括弧の対応を色分けする設定を有効化する",
        "ファイル保存時に自動フォーマット（Format on Save）を実行する",
        "コミット前に git diff で意図しない記号の混入がないか確認する"
      ],
    };
  }

  // 5. ReferenceError / 未定義変数
  if (/ReferenceError/i.test(log) || /is not defined/i.test(log)) {
    const varMatch = log.match(/([a-zA-Z0-9_]+)\s+is not defined/i);
    const varName = varMatch ? varMatch[1] : "変数";

    return {
      errorType: "ReferenceError: 未定義の識別子参照",
      summary: `宣言されていない変数または関数 '${varName}' を参照しようとしました。`,
      rootCause: `'${varName}' のimport忘れ、変数スコープ外からのアクセス、またはスペルミスの可能性があります。`,
      filePath: location.file,
      lineNumber: `${location.line}行目`,
      diffCode: `--- a/${location.file}
+++ b/${location.file}
@@ -1,3 +1,4 @@
+ import { ${varName} } from "./modules/${varName}";
  
  export function main() {
    ${varName}();`,
      learningTitle: "💡 学習ポイント: モジュールのインポートとブロックスコープ",
      learningContent: "TypeScriptでは変数は宣言されたブロック `{}` 内でのみ有効です。別ファイルで定義した関数は明示的に export / import する必要があります。",
      preventionTips: [
        "自動インポート機能（VS Code Auto Import）を活用する",
        "typo（打ち間違い）がないか変数名を見直す",
        "スコープの階層（関数内、if文内）を意識する"
      ],
    };
  }

  // 6. Network / Fetch / CORS エラー
  if (/Failed to fetch|NetworkError|CORS|ECONNREFUSED/i.test(log)) {
    return {
      errorType: "Network / CORS / 接続拒否エラー",
      summary: "バックエンドAPIや外部サーバーとの通信に失敗しました。",
      rootCause: "APIサーバーが起動していない（ECONNREFUSED）、接続先URLやポート番号の誤り、またはブラウザのCORSポリシーによるブロックが発生しています。",
      filePath: location.file,
      lineNumber: `${location.line}行目`,
      diffCode: `--- a/${location.file}
+++ b/${location.file}
@@ -${location.line},3 +${location.line},3 @@
- const res = await fetch("http://localhost:3000/api");
+ const res = await fetch(import.meta.env.VITE_API_URL || "/api");`,
      learningTitle: "💡 学習ポイント: オリジン間リソース共有 (CORS) と接続先管理",
      learningContent: "フロントエンドとバックエンドのオリジン（プロトコル・ドメイン・ポート）が異なる場合、バックエンド側でAccess-Control-Allow-Originヘッダーの許可が必要です。",
      preventionTips: [
        "バックエンドサーバーが正常に起動しているか確認する",
        "Viteの開発プロキシ（server.proxy）を活用してCORSを回避する",
        "接続先URLを直接記述せず環境変数（.env）に切り出す"
      ],
    };
  }

  // 7. 汎用フォールバック（未知のエラーログ）
  const firstLine = log.split("\n").find((l) => l.trim().length > 0) || "エラーが発生しました";
  return {
    errorType: "Detected Runtime Exception / エラー",
    summary: `検出されたエラー: 「${firstLine.slice(0, 80)}」`,
    rootCause: `スタックトレースを解析した結果、${location.file} の ${location.line}行目付近の処理で例外がスローされています。`,
    filePath: location.file,
    lineNumber: `${location.line}行目`,
    diffCode: `--- a/${location.file}
+++ b/${location.file}
@@ -${location.line},3 +${location.line},3 @@
- try { dangerousOperation(); }
+ try { dangerousOperation(); } catch (error) { console.error("詳細ログ:", error); }`,
    learningTitle: "💡 学習ポイント: エラーハンドリングと例外の局所化",
    learningContent: "エラーが発生する可能性のある境界処理（ファイル読み書き、通信、JSONパース等）は `try...catch` で安全に捕捉し、ユーザーフレンドリーなメッセージに変換しましょう。",
    preventionTips: [
      "例外発生時にクラッシュさせず、エラー境界（ErrorBoundary）を設ける",
      "コンソールログにエラーの引数やコンテキスト情報を出力する",
      "入力値の型とバリデーションを強化する"
    ],
  };
}

// 公開API: ルールベース解析を実行し、関連する公式ドキュメントへのリンクを付与して返す
export function analyzeErrorLog(rawLog: string): AnalysisResult {
  const result = analyzeErrorLogCore(rawLog);
  result.officialDocLink = getOfficialDocLink(result.errorType, rawLog) ?? undefined;
  return result;
}
