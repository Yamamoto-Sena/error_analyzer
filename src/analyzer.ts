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
  /** Gemini解析時、送信前にログ中の機密情報らしき箇所をマスクした件数（0件/未使用時は省略） */
  maskedSecretsCount?: number;
  /** Gemini解析時のトークン消費量（ローカル解析エンジン使用時は省略） */
  tokenUsage?: TokenUsage;
}

export interface TokenUsage {
  /** 送信したプロンプト（ログ・指示文・画像等）のトークン数 */
  promptTokens: number;
  /** Geminiが生成した応答のトークン数 */
  responseTokens: number;
  /** 合計トークン数（promptTokens + responseTokens。APIが直接返す値をそのまま使う） */
  totalTokens: number;
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
  if (/ERESOLVE/i.test(haystack)) {
    return {
      label: "npm 公式ドキュメント: --legacy-peer-deps オプション",
      url: "https://docs.npmjs.com/cli/v10/using-npm/config#legacy-peer-deps",
    };
  }
  if (/EACCES|permission denied/i.test(haystack)) {
    return {
      label: "Node.js 公式: エラーコード一覧（EACCES ほか）",
      url: "https://nodejs.org/api/errors.html#common-system-errors",
    };
  }
  if (/docker/i.test(haystack)) {
    return {
      label: "Docker 公式ドキュメント: system prune（不要リソースの削除）",
      url: "https://docs.docker.com/engine/reference/commandline/system_prune/",
    };
  }
  if (/CONFLICT \(content\)|Automatic merge failed|would be overwritten by merge|stash them/i.test(haystack)) {
    return {
      label: "Git 公式ドキュメント: git merge",
      url: "https://git-scm.com/docs/git-merge",
    };
  }
  if (/error TS\d{4,5}:/i.test(haystack)) {
    return {
      label: "TypeScript 公式ハンドブック",
      url: "https://www.typescriptlang.org/docs/handbook/intro.html",
    };
  }
  if (/heap out of memory|Allocation failed/i.test(haystack)) {
    return {
      label: "Node.js 公式: --max-old-space-size オプション",
      url: "https://nodejs.org/api/cli.html#--max-old-space-sizesize-in-mib",
    };
  }
  if (/NullPointerException/i.test(haystack)) {
    return {
      label: "Oracle Java 公式ドキュメント: NullPointerException",
      url: "https://docs.oracle.com/javase/8/docs/api/java/lang/NullPointerException.html",
    };
  }
  if (/JSON/i.test(haystack) && /Unexpected token|Unexpected end|not valid JSON/i.test(haystack)) {
    return {
      label: "MDN Web Docs: JSON.parse() リファレンス",
      url: "https://developer.mozilla.org/ja/docs/Web/JavaScript/Reference/Global_Objects/JSON/parse",
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

// ローカル解析エンジンが、どの既知パターンにも一致せず汎用フォールバックへ
// 落ちた場合に使うerrorType。App.tsx側で「ログ欄だけでは既知パターンに
// 一致しなかったので、症状説明欄も含めて解析し直す」という優先順位判定
// （isGenericFallbackResult）にも使う共通の目印。
const GENERIC_FALLBACK_ERROR_TYPE = "Detected Runtime Exception / エラー";

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
-    print("User ID: " + ${targetVar}.${attrName})
+    # 修正案: Noneチェック（ガード節）を追加して安全に参照する
+    if ${targetVar} is not None:
+        print("User ID: " + str(${targetVar}.${attrName}))
+    else:
+        print("ユーザー情報が見つかりませんでした")`,
      learningTitle: "💡 学習ポイント: Pythonにおける NoneType とガード節（Null Check）",
      learningContent: `Pythonの関数やSQLAlchemyなどのORM（.first()）は、対象データが存在しない場合に None を返します。None は特定の値を持たない特殊なオブジェクトであるため、そのまま '.${attrName}' のように属性アクセスするとクラッシュします。必ず事前に 'if obj is not None:' で安全性を担保しましょう。`,
      preventionTips: [
        "DBクエリやAPI戻り値など、データが存在しない可能性がある場合は必ず事前に None チェックを行う",
        "関数の型ヒントに Optional[User] や User | None を明記し、mypy/Pyrightなどの静的解析を活用する",
        `getattr(obj, '${attrName}', None) や三項演算子を活用してデフォルト値を設ける`
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
-const result = data.${propName};
+const result = data?.${propName} ?? "初期値";`,
      learningTitle: "💡 学習ポイント: オプショナルチェーン (?.) と Null合体 (??)",
      learningContent: `TypeScript/JavaScriptでは \`data?.${propName}\` のように安全なアクセス演算子を使うことで、undefined/null時に例外を投げず安全に処理を継続できます。`,
      preventionTips: [
        "オブジェクトの初期ステートにデフォルト値を設ける",
        "APIフェッチのローディング状態（isLoading）を判定してから表示する",
        "TypeScriptの strictNullChecks を有効にする"
      ],
    };
  }

  // 3.6. JSON.parse 構文解析エラー
  // ("Unexpected token ... in JSON" は下記4.の汎用SyntaxError判定にもマッチしてしまうため、
  //  JSON特有の原因（APIがHTML/空文字を返した等）をより的確に案内できるよう、汎用判定より先に判定する)
  if (/Unexpected token .* in JSON/i.test(log) || /Unexpected end of JSON input/i.test(log) || /is not valid JSON/i.test(log)) {
    return {
      errorType: "JSON.parse: JSON構文解析エラー",
      summary: "JSON形式として不正な文字列をパース（解析）しようとしました。",
      rootCause: "APIレスポンスが期待通りのJSONではなかった（HTMLのエラーページが返ってきた、空文字だった等）か、設定ファイル・JSON文字列自体にカンマの過不足や引用符の閉じ忘れがあります。",
      filePath: location.file,
      lineNumber: `${location.line}行目`,
      diffCode: `--- a/${location.file}
+++ b/${location.file}
@@ -${location.line},3 +${location.line},5 @@
-const data = JSON.parse(responseText);
+let data;
+try {
+  data = JSON.parse(responseText);
+} catch (e) {
+  console.error("JSONパースに失敗した実際のレスポンス:", responseText);
+  throw e;
+}`,
      learningTitle: "💡 学習ポイント: JSON.parseの前にレスポンス内容を疑う",
      learningContent: "JSON.parseのエラーは『渡された文字列がそもそもJSONとして壊れている』ことを意味します。APIがエラー時にHTMLやプレーンテキストを返すケースは多いので、パース前に実際のレスポンス内容をログ出力して確認するのが近道です。",
      preventionTips: [
        "fetch後にresponse.okを確認してからJSON.parseする",
        "パース処理はtry/catchで囲み、失敗時に元の文字列をログ出力する",
        "APIサーバー側のエラーレスポンス形式を統一する",
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
-return ( <div> <span>未完了</span>
+return ( <div> <span>修正完了</span> </div> );`,
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
-const res = await fetch("http://localhost:3000/api");
+const res = await fetch(import.meta.env.VITE_API_URL || "/api");`,
      learningTitle: "💡 学習ポイント: オリジン間リソース共有 (CORS) と接続先管理",
      learningContent: "フロントエンドとバックエンドのオリジン（プロトコル・ドメイン・ポート）が異なる場合、バックエンド側でAccess-Control-Allow-Originヘッダーの許可が必要です。",
      preventionTips: [
        "バックエンドサーバーが正常に起動しているか確認する",
        "Viteの開発プロキシ（server.proxy）を活用してCORSを回避する",
        "接続先URLを直接記述せず環境変数（.env）に切り出す"
      ],
    };
  }

  // 7. npm/pnpm 依存関係解決エラー (ERESOLVE / peer dependency conflict)
  if (/ERESOLVE/i.test(log)) {
    const peerMatch = log.match(/peer\s+(\S+@\S+)/i);
    const peerName = peerMatch ? peerMatch[1] : "依存パッケージ";

    return {
      errorType: "ERESOLVE: npm 依存関係の競合",
      summary: `インストールしようとしたパッケージが要求するバージョンと、既存の依存関係（特に '${peerName}'）のバージョンが競合しています。`,
      rootCause: "npmはデフォルトでは依存関係のバージョンが厳密に一致しない場合、自動解決をせずにインストールを中断します（peer dependencyの衝突）。",
      filePath: "package.json",
      lineNumber: "dependencies / devDependencies",
      fixType: "task",
      taskSteps: [
        "package.json の該当パッケージのバージョン指定を、エラーメッセージが要求するバージョン範囲に合わせて更新する",
        "一時的な回避策として --legacy-peer-deps オプションを付けて再インストールする\nnpm install --legacy-peer-deps",
        "pnpmを使用している場合は pnpm install を実行し、pnpm-lock.yaml 上の解決結果を確認する",
      ],
      diffCode: `# 一時的な回避策（根本解決ではないため注意）
npm install --legacy-peer-deps

# 根本的には package.json の該当パッケージのバージョンを
# エラーメッセージが要求するバージョン範囲に合わせて修正してください`,
      learningTitle: "💡 学習ポイント: npmの peer dependency（ピア依存関係）",
      learningContent: "peer dependencyとは「このパッケージを使うなら、ホスト側にこのバージョンのライブラリも入れておいてね」という間接的な依存関係です。npm 7以降はこの整合性を厳密にチェックするため、バージョンが噛み合わないとインストール自体が失敗します。",
      preventionTips: [
        "package.json の依存バージョンはできるだけ最新の安定版に揃える",
        "--legacy-peer-deps は一時しのぎと割り切り、根本的にはバージョンを揃える",
        "pnpm/yarnなど別のパッケージマネージャーでは挙動が異なる点に注意する",
      ],
    };
  }

  // 8. EACCES / Permission denied（権限不足）
  if (/EACCES/i.test(log) || /permission denied/i.test(log)) {
    return {
      errorType: "EACCES: 権限不足エラー",
      summary: "ファイルまたはディレクトリへのアクセス権限が不足しているため、処理が拒否されました。",
      rootCause: "対象のファイル・フォルダの所有者や権限設定（パーミッション）が、現在実行しているユーザーの書き込み・実行を許可していません。グローバルインストールや保護されたディレクトリへの書き込み時によく発生します。",
      filePath: location.file,
      lineNumber: `${location.line}行目`,
      fixType: "task",
      taskSteps: [
        "【Windows】管理者としてPowerShell/コマンドプロンプトを起動して再実行する",
        "【macOS/Linux】対象フォルダの所有者を自分に変更する\nsudo chown -R $(whoami) 対象のフォルダパス",
        "npmのグローバルインストール権限エラーの場合は、nvm等でNode.jsをユーザー権限にインストールし直すことも検討する",
      ],
      diffCode: `# [Windows] 管理者権限のPowerShellで再実行するか、
# 対象フォルダのプロパティ→セキュリティタブで書き込み権限を確認してください

# [macOS/Linux]
sudo chown -R $(whoami) 対象のフォルダパス`,
      learningTitle: "💡 学習ポイント: ファイルパーミッションとOSのアクセス制御",
      learningContent: "OSは各ファイル・フォルダに「誰が読み書き実行できるか」という権限情報を持っています。特にシステムディレクトリ等グローバルな場所への書き込みは、意図しない破壊を防ぐため通常のユーザー権限では拒否されます。",
      preventionTips: [
        "むやみに sudo / 管理者権限を使わず、まず権限不足の理由を確認する",
        "npmのグローバルインストール先をユーザーディレクトリ配下に変更しておくと権限エラーを避けやすい",
        "プロジェクトのファイルは可能な限り自分の権限で完結する場所に置く",
      ],
    };
  }

  // 9. Docker関連エラー（デーモン未起動 / ディスク容量不足）
  if (/Cannot connect to the Docker daemon/i.test(log) || /docker daemon/i.test(log) || /no space left on device/i.test(log)) {
    const isDiskFull = /no space left on device/i.test(log);

    return {
      errorType: isDiskFull ? "Docker: ディスク容量不足エラー" : "Docker: デーモン未起動エラー",
      summary: isDiskFull
        ? "Dockerが使用しているディスク容量が上限に達しており、イメージ・コンテナの処理が失敗しています。"
        : "Docker Desktop（またはDockerデーモン）が起動していないため、Dockerコマンドが実行できません。",
      rootCause: isDiskFull
        ? "使わなくなった古いDockerイメージ・コンテナ・ビルドキャッシュ・ボリュームがディスク上に蓄積し、Dockerに割り当てられた容量を圧迫しています。"
        : "Dockerクライアント（CLI）はデーモン（バックグラウンドの実行プロセス）と通信して動作しますが、Docker Desktopが未起動、またはクラッシュしているためデーモンに接続できません。",
      filePath: "Docker Desktop / dockerd",
      lineNumber: "-",
      fixType: "task",
      taskSteps: isDiskFull
        ? [
            "不要なコンテナ・イメージ・ビルドキャッシュをまとめて削除する（実行前に必要なコンテナが無いか確認）\ndocker system prune -a --volumes",
            "削除後、ディスク使用状況を確認する\ndocker system df",
          ]
        : [
            "Docker Desktopアプリケーションを起動する（タスクトレイに常駐しているか確認）",
            "起動後、数十秒待ってから再度Dockerコマンドを実行する",
            "それでも解決しない場合はPCを再起動する",
          ],
      diffCode: isDiskFull
        ? `# 不要なDockerリソースを一括削除（要確認: 稼働中の必要なコンテナが無いか事前に確認）
docker system prune -a --volumes`
        : `# Docker Desktopを起動してから再実行してください
docker info  # デーモンに接続できるか確認`,
      learningTitle: isDiskFull ? "💡 学習ポイント: Dockerのディスク使用量管理" : "💡 学習ポイント: Dockerクライアントとデーモンの関係",
      learningContent: isDiskFull
        ? "Dockerはビルドのたびに中間レイヤーやキャッシュを蓄積します。定期的に docker system prune で掃除しないと、気づかぬうちにディスクを圧迫します。"
        : "`docker` コマンド自体はただの操作窓口（クライアント）で、実際の処理はバックグラウンドの `dockerd`（デーモン）が行います。デーモンが起動していないとどんなdockerコマンドも失敗します。",
      preventionTips: isDiskFull
        ? ["定期的に docker system df で使用量を確認する", "CI環境では自動的にpruneするジョブを組んでおく"]
        : ["開発開始時にDocker Desktopが起動しているかまず確認する習慣をつける", "OS起動時にDocker Desktopが自動起動する設定にしておく"],
    };
  }

  // 10. Git関連エラー（未コミット変更との衝突 / マージコンフリクト）
  if (/CONFLICT \(content\)/i.test(log) || /Automatic merge failed/i.test(log) || /would be overwritten by merge/i.test(log) || /Please commit your changes or stash them/i.test(log)) {
    const isUncommitted = /would be overwritten by merge/i.test(log) || /Please commit your changes or stash them/i.test(log);

    return {
      errorType: isUncommitted ? "Git: 未コミットの変更による競合" : "Git: マージコンフリクト",
      summary: isUncommitted
        ? "ローカルに未コミットの変更が残っているため、Gitが安全にマージ/切り替えができず処理を中断しました。"
        : "マージしようとした2つのブランチが同じ箇所を異なる内容に変更しており、Gitが自動でどちらを採用すべきか判断できていません。",
      rootCause: isUncommitted
        ? "作業ツリー（ワーキングディレクトリ）に未コミットの変更が残ったまま git pull / git merge / git checkout を実行すると、その変更が上書きされて失われる恐れがあるため、Gitは安全側に倒して処理を拒否します。"
        : "同じファイルの同じ行付近が、マージ元・マージ先の両方で別々に変更されているため、Gitのアルゴリズムでは自動統合できません。",
      filePath: location.file !== "設定・起動プロセス (vite.config.ts / src-tauri)" ? location.file : "(コンフリクトが発生したファイル)",
      lineNumber: "<<<<<<< / ======= / >>>>>>> の間",
      fixType: "task",
      taskSteps: isUncommitted
        ? [
            "変更を一旦コミットする\ngit add . && git commit -m \"作業中の変更を保存\"",
            "またはコミットせず一時退避する\ngit stash",
            "処理完了後、退避した変更を戻す場合は git stash pop",
          ]
        : [
            "コンフリクトが発生したファイルを開き、<<<<<<< / ======= / >>>>>>> で囲まれた範囲を確認する",
            "どちらの内容を採用するか（または両方を統合するか）を決めてマーカーを手動で編集・削除する",
            "解決後にステージしてマージを完了する\ngit add <ファイル名> && git commit",
          ],
      diffCode: isUncommitted
        ? `# 変更を退避してから再実行
git stash
git pull
git stash pop`
        : `<<<<<<< HEAD
（自分のブランチの内容）
=======
（マージ元ブランチの内容）
>>>>>>> マージ元ブランチ名

# ↑ このマーカー部分を、採用したい内容だけが残るように手動で編集してください`,
      learningTitle: isUncommitted ? "💡 学習ポイント: Gitが「安全側」に倒す設計思想" : "💡 学習ポイント: コンフリクトマーカーの読み方",
      learningContent: isUncommitted
        ? "Gitは「変更を失うかもしれない操作」を検知すると、自動では実行せずユーザーに確認を求めます。これはミスによるデータ消失を防ぐための安全設計です。"
        : "コンフリクトマーカーの `<<<<<<< HEAD` から `=======` までが自分側の変更、`=======` から `>>>>>>> ブランチ名` までが相手側の変更です。落ち着いてどちらを残すか判断しましょう。",
      preventionTips: isUncommitted
        ? ["作業中はこまめにコミットする習慣をつける", "pull前に git status で作業ツリーの状態を確認する"]
        : ["こまめにpull/mergeして差分を小さく保つ", "同じファイルを複数人で同時に編集する際は事前にコミュニケーションを取る", "コンフリクト解決後は必ず動作確認してからコミットする"],
    };
  }

  // 11. TypeScript コンパイルエラー (error TSxxxx)
  if (/error TS\d{4,5}:/i.test(log)) {
    const tsMatch = log.match(/error TS(\d{4,5}):\s*(.+)/i);
    const tsCode = tsMatch ? tsMatch[1] : "????";
    const tsMessage = tsMatch ? tsMatch[2].trim() : "型エラー";

    return {
      errorType: `TypeScript: コンパイルエラー (TS${tsCode})`,
      summary: `TypeScriptの型チェックでエラーが検出されました: ${tsMessage.slice(0, 100)}`,
      rootCause: `コードの型定義と、実際に渡している値・戻り値の型が一致していません（TS${tsCode}）。実行前の静的解析（tsc）の段階でこの不一致が検出されています。`,
      filePath: location.file,
      lineNumber: `${location.line}行目`,
      diffCode: `--- a/${location.file}
+++ b/${location.file}
@@ -${location.line},2 +${location.line},2 @@
# エラーメッセージの型定義に合わせて、変数の型注釈や渡す値を修正してください
# 例: 引数の型を合わせる、Optional(?)を付ける、as で明示的にキャストする 等
# 詳細: ${tsMessage}`,
      learningTitle: "💡 学習ポイント: TypeScriptの型エラーは「実行前」に守ってくれるガードレール",
      learningContent: "TypeScriptのコンパイルエラーは、実行時に起きたかもしれないバグを事前に検出してくれています。エラーメッセージに書かれている『期待される型』と『実際に渡されている型』を比較し、どちらを直すべきか判断しましょう。",
      preventionTips: [
        "any型を安易に使わず、具体的な型・interfaceを定義する",
        "エディタの型エラー表示（赤い波線）をこまめに確認しながらコーディングする",
        "strict モードを有効にして早期に型不整合を検出する",
      ],
    };
  }

  // 12. JavaScript ヒープメモリ不足 (OutOfMemory)
  if (/JavaScript heap out of memory/i.test(log) || /FATAL ERROR.*Allocation failed/i.test(log)) {
    return {
      errorType: "OutOfMemory: メモリ不足エラー",
      summary: "Node.jsプロセスが使用可能なメモリの上限に達し、強制終了しました。",
      rootCause: "大きなデータの一括処理、無限ループによるメモリリーク、または大規模プロジェクトのビルド処理がNode.jsのデフォルトメモリ上限（通常約1.5〜2GB）を超えたことが原因です。",
      filePath: "実行コマンド（npm run build 等）",
      lineNumber: "-",
      fixType: "task",
      taskSteps: [
        "Node.jsのメモリ上限を一時的に引き上げて再実行する（PowerShellの場合）\n$env:NODE_OPTIONS=\"--max-old-space-size=4096\"; npm run build",
        "bash/zshの場合\nNODE_OPTIONS=--max-old-space-size=4096 npm run build",
        "根本対策として、処理対象データを分割する・不要な変数参照を解放する等メモリ使用量そのものを見直す",
      ],
      diffCode: `# メモリ上限を一時的に引き上げる (PowerShell)
$env:NODE_OPTIONS="--max-old-space-size=4096"; npm run build

# (bash/zshの場合)
NODE_OPTIONS=--max-old-space-size=4096 npm run build`,
      learningTitle: "💡 学習ポイント: Node.jsのメモリ管理とヒープ",
      learningContent: "Node.js(V8エンジン)はデフォルトで確保するメモリ（ヒープ）に上限があります。大量データの処理やメモリリークがあると、この上限に達してプロセスごと強制終了されます。",
      preventionTips: [
        "大量データはストリーム処理やページング（分割処理）で扱う",
        "不要になったイベントリスナーやキャッシュを明示的に解放する",
        "メモリ使用量が急増していないか、開発時にプロファイラで確認する習慣をつける",
      ],
    };
  }

  // 13. Java NullPointerException
  if (/java\.lang\.NullPointerException/i.test(log)) {
    return {
      errorType: "NullPointerException: Java Null参照エラー",
      summary: "null（未初期化）のオブジェクトに対してメソッド呼び出しやフィールドアクセスを行おうとしました。",
      rootCause: "対象の変数が期待した値ではなくnullのまま処理に渡され、そのnullに対して .メソッド() や .フィールド のアクセスを行ったため例外が発生しました。",
      filePath: location.file,
      lineNumber: `${location.line}行目`,
      diffCode: `--- a/${location.file}
+++ b/${location.file}
@@ -${location.line},3 +${location.line},5 @@
-result.getValue();
+if (result != null) {
+    result.getValue();
+} else {
+    // nullの場合の処理をここに記述
+}`,
      learningTitle: "💡 学習ポイント: JavaにおけるNullPointerExceptionとOptional",
      learningContent: "Javaの参照型変数は初期化されていないとnullになります。null状態のオブジェクトへアクセスするとNullPointerException（通称NPE）が発生します。Java 8以降はOptional<T>を使うことで、nullの可能性を型として明示できます。",
      preventionTips: [
        "外部から受け取る値やDB検索結果は必ずnullチェックを行う",
        "Optional<T>を活用してnullの可能性を明示する",
        "@NonNull / @Nullableアノテーションで静的解析ツールにnull安全性をチェックさせる",
      ],
    };
  }

  // 14. 汎用フォールバック（未知のエラーログ）
  // App.tsxはログ欄・症状説明欄を両方入力すると、それぞれの内容を
  // 「【エラーログ / スタックトレース】」「【エラー内容・症状の説明（ユーザー記述）】」
  // というラベル行を先頭に付けて連結して渡してくる。このラベル行自体は実際の
  // エラー内容ではないため、「最初の非空行」としてそのまま拾ってしまうと
  // 「検出されたエラー: 「【エラーログ / スタックトレース】」」という無意味な
  // 表示になってしまう。行全体が【...】で囲まれただけの見出し行はスキップする。
  const firstLine =
    log.split("\n").find((l) => {
      const trimmed = l.trim();
      return trimmed.length > 0 && !/^【.*】$/.test(trimmed);
    }) || "エラーが発生しました";
  return {
    errorType: GENERIC_FALLBACK_ERROR_TYPE,
    summary: `検出されたエラー: 「${firstLine.slice(0, 80)}」`,
    rootCause: `スタックトレースを解析した結果、${location.file} の ${location.line}行目付近の処理で例外がスローされています。`,
    filePath: location.file,
    lineNumber: `${location.line}行目`,
    diffCode: `--- a/${location.file}
+++ b/${location.file}
@@ -${location.line},3 +${location.line},3 @@
-try { dangerousOperation(); }
+try { dangerousOperation(); } catch (error) { console.error("詳細ログ:", error); }`,
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

/**
 * `analyzeErrorLog`の結果が、既知の具体的なパターンに一致せず汎用フォールバックへ
 * 落ちたものかどうかを判定する。
 *
 * App.tsxはログ欄・症状説明欄を両方入力した場合、まずログ欄だけで解析を試み、
 * これがtrue（＝ログ欄だけでは具体的な手がかりが得られなかった）の場合のみ、
 * 症状説明欄も含めて解析し直す、という優先順位判定に使う。
 * これにより「ログ欄に具体的なエラーシグネチャがあれば、症状説明欄の内容と
 * 食い違っていてもログ欄側が優先される」という挙動を、暗黙の連結順序依存ではなく
 * 明示的な仕様にしている。
 */
export function isGenericFallbackResult(result: AnalysisResult): boolean {
  return result.errorType === GENERIC_FALLBACK_ERROR_TYPE;
}

// 「エラーらしいテキストか」を判定する高確度なキーワードのみに絞ったヒューリスティック。
// 一般的な "error" という単語だけだと、正常系ログでも頻出し誤検知が多くなるため、
// 単独の "error" は含めていない（下のGENERIC_KEYWORDS_PATTERNの方でカバーする）。
// npmは v9系のどこかでエラー接頭辞を "npm ERR!"（旧）から "npm error"（新・小文字/感嘆符なし）
// に変更しているため、両方を拾えるようにしている。
// もともとターミナル監視モード（TerminalWatchModal.tsx）専用に定義されていたものを、
// クリップボード監視モードとも共用できるようここへ切り出した。
// Wingarc製品（Dr.Sum Server / MotionBoard等）のエラーコードは、例外なく
// "8桁の16進数・先頭は8/9/aのいずれか"という統一フォーマットになっている
// （実測: 公式マニュアル記載の712件のエラーコード全件がこの形式に一致）。
// メッセージ本文の言い回しは「〜できません」「〜が不正です」等バラバラで
// 汎用キーワードでは大半を拾いきれないが、コードの「形」自体を検知対象にすれば、
// コードとメッセージが一緒に表示・コピーされる限り言い回しに関係なく拾える。
// （UUIDの先頭セグメント等、まれに無関係な8桁16進数と偶然一致する可能性はあるが、
// クリップボード監視はオプトイン機能であり誤検知時の実害も小さいため許容する）
const WINGARC_ERROR_CODE_PATTERN = /\b[89a][0-9a-f]{7}\b/i;

const HIGH_CONFIDENCE_SIGNAL_PATTERN = new RegExp(
  [
    "EADDRINUSE",
    "Traceback \\(most recent call last\\)",
    "Unhandled[ A-Za-z]*Rejection",
    "FATAL ERROR",
    "npm (?:ERR!|error)",
    "error TS\\d{4,5}",
    "Segmentation fault",
    "panic:",
    "Exception in thread",
    "NullPointerException",
    "CONFLICT \\(content\\)",
    WINGARC_ERROR_CODE_PATTERN.source,
  ].join("|"),
  "i"
);

// クリップボード監視モードが対象にするのは、ターミナルの生ログではなく
// MotionBoard・BigQuery（Google Cloud Console）等のアプリ/Webサービスが表示する
// エラーダイアログ/メッセージの文面であるため、上記の高確度シグネチャに加えて、
// より一般的なエラー関連キーワード（日英）も判定に含める。
// BigQuery等のクラウドサービスのエラーは "Not found: Dataset ...", "Access Denied: ...",
// "Exceeded rate limits", "Resources exceeded during query execution" のように、
// 単語 "error" を含まない言い回しも多いため、それらも拾えるようにしている。
const GENERIC_KEYWORDS_PATTERN =
  /\b(error|exception|failed|failure|denied|forbidden|unauthorized|invalid|unrecognized|exceeded|not\s+found|quota|timeout|timed\s+out|duplicate|warning|stack trace)\b|エラー|失敗|例外|不正な|拒否|権限がありません|許可されていません|超過|見つかりません|接続できません|失敗しました/i;

// あまりに短い文字列（単語1つのコピー等）まで拾うと誤検知が増えるため、
// クリップボード監視モードではこの文字数未満のテキストは判定対象から除外する。
const MIN_CLIPBOARD_TEXT_LENGTH = 20;

/**
 * 見た目上は同じに見えても文字コード上は異なる表記ゆれを吸収するための正規化。
 * - `normalize("NFKC")`: 全角英数字・全角スペース(U+3000)・半角カナ等を、対応する
 *   半角/標準形に変換する（例: "８０００１００６" → "80001006"、全角スペース → 半角スペース）。
 * - 続く空白の連続を1個の半角スペースに畳み込み、前後をtrimする（タブ・改行・NBSP・
 *   スペースが連続していたり混在していても同一視できるようにするため）。
 *
 * MotionBoard等、コピー元によって全角数字・全角スペースが混じった文言をユーザーが
 * 監視ワードとして手入力（またはコピペ）した際、実際のクリップボード内容と
 * 見た目は同じでも文字コードが微妙に異なり一致しない、という報告への対処。
 */
function normalizeForMatching(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/**
 * テキストが「エラーらしいか」を判定する。
 * @param options.genericKeywords true の場合、高確度シグネチャに加えて汎用的なエラー関連
 *   キーワード（日英）でも判定する（クリップボード監視モード向け）。false（既定）の場合は
 *   ターミナル出力向けの高確度シグネチャのみで判定する（誤検知を避けたいターミナル監視モード向け）。
 * @param options.minLength この文字数未満のテキストは、汎用キーワード判定(genericKeywords)
 *   では常にfalseとして扱う（既定0=制限なし）。高確度シグネチャ（HIGH_CONFIDENCE_SIGNAL_PATTERN、
 *   Wingarcエラーコードのような具体的な形を含む）は、それ自体の特異性で誤検知リスクが
 *   低いとみなし、この文字数フィルタの対象外とする（"npm ERR!"や単体のエラーコードだけを
 *   コピーした短い場合でも検知できるようにするため）。
 */
export function looksLikeErrorText(
  text: string,
  options: { genericKeywords?: boolean; minLength?: number } = {}
): boolean {
  const { genericKeywords = false, minLength = 0 } = options;
  const normalized = normalizeForMatching(text);
  if (HIGH_CONFIDENCE_SIGNAL_PATTERN.test(normalized)) return true;
  if (normalized.length < minLength) return false;
  return genericKeywords && GENERIC_KEYWORDS_PATTERN.test(normalized);
}

/** クリップボード監視モード向けの既定判定（汎用キーワード判定+短文除外を有効にしたもの） */
export function looksLikeErrorTextFromClipboard(text: string): boolean {
  return looksLikeErrorText(text, { genericKeywords: true, minLength: MIN_CLIPBOARD_TEXT_LENGTH });
}

/**
 * ユーザーが登録したカスタム監視ワード（MotionBoard等、組み込みの英語キーワードには
 * 引っかからない固有の言い回しをユーザー自身に追加してもらうためのもの）のいずれかを
 * テキストが含むかを判定する。組み込みのlooksLikeErrorText系とは異なり、
 * ユーザーが明示的に登録した文言との一致は誤検知リスクが低いとみなし、
 * 文字数フィルタ（MIN_CLIPBOARD_TEXT_LENGTH）は適用しない。
 * 大文字小文字は区別せず、全角/半角・空白の連続等の表記ゆれも`normalizeForMatching`で
 * 吸収したうえで部分一致を見る。空文字列のキーワードは無視する。
 */
export function matchesCustomKeywords(text: string, keywords: string[]): boolean {
  const haystack = normalizeForMatching(text).toLowerCase();
  return keywords.some((kw) => {
    const trimmed = normalizeForMatching(kw);
    return trimmed !== "" && haystack.includes(trimmed.toLowerCase());
  });
}
