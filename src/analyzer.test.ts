import { describe, expect, it } from "vitest";
import { analyzeErrorLog, getOfficialDocLink } from "./analyzer";

describe("analyzeErrorLog", () => {
  it("ポート競合(EADDRINUSE)を手順(task)として検出する", () => {
    const log = `Error: Port 1420 is already in use
    at httpServerStart (file:///C:/develop/node_modules/.pnpm/vite/dist/node/chunks/node.js:11681:10)
[ELIFECYCLE] Command failed with exit code 1.`;

    const result = analyzeErrorLog(log);

    expect(result.errorType).toContain("EADDRINUSE");
    expect(result.fixType).toBe("task");
    expect(result.taskSteps && result.taskSteps.length).toBeGreaterThan(0);
  });

  it("Python AttributeError('NoneType')から対象変数名と属性名を抽出する", () => {
    const log = `Traceback (most recent call last):
  File "/app/src/services/user_service.py", line 42, in get_user_profile
    user_data = fetch_from_database(user_id)
  File "/app/src/controllers/api_controller.py", line 15, in handle_request
    response = get_user_profile(request_id)
    print("User ID: " + response.user_id)
AttributeError: 'NoneType' object has no attribute 'user_id'`;

    const result = analyzeErrorLog(log);

    expect(result.errorType).toContain("AttributeError");
    // fixTypeは省略時"code"扱い(AnalysisResultの定義通り)
    expect(result.fixType ?? "code").toBe("code");
    // Pythonのトレースバックは末尾(最下部)のフレームが実際の発生箇所
    expect(result.filePath).toBe("/app/src/controllers/api_controller.py");
    expect(result.lineNumber).toBe("15行目");
    expect(result.diffCode).toContain("response.user_id");
  });

  it("依存パッケージ未検出(Cannot find module)を手順(task)として検出する", () => {
    const log = `Error: Cannot find module 'lodash'
    at src/utils/helper.ts:3:18`;

    const result = analyzeErrorLog(log);

    expect(result.errorType).toContain("ModuleNotFoundError");
    expect(result.fixType).toBe("task");
    expect(result.diffCode).toContain("lodash");
  });

  it("TypeError(undefinedのプロパティ参照)を検出する", () => {
    const log = `TypeError: Cannot read properties of undefined (reading 'map')
    at UserList (src/components/UserList.tsx:24:18)`;

    const result = analyzeErrorLog(log);

    expect(result.errorType).toContain("TypeError");
    // fixTypeは省略時"code"扱い(AnalysisResultの定義通り)
    expect(result.fixType ?? "code").toBe("code");
    expect(result.filePath).toBe("src/components/UserList.tsx");
    expect(result.lineNumber).toBe("24行目");
  });

  it("SyntaxErrorを検出する", () => {
    const log = `SyntaxError: Unexpected token '}'
    at compileSource (src/utils/parser.ts:42:15)`;

    const result = analyzeErrorLog(log);

    expect(result.errorType).toContain("SyntaxError");
  });

  it("ReferenceErrorから未定義の識別子名を抽出する", () => {
    const log = `ReferenceError: fetchUserData is not defined
    at handleSubmit (src/pages/Dashboard.tsx:18:7)`;

    const result = analyzeErrorLog(log);

    expect(result.errorType).toContain("ReferenceError");
    expect(result.diffCode).toContain("fetchUserData");
  });

  it("Network/CORS系エラーを検出する", () => {
    const log = `Access to fetch at 'https://api.example.com' from origin 'http://localhost:1420' has been blocked by CORS policy`;

    const result = analyzeErrorLog(log);

    expect(result.errorType).toContain("CORS");
  });

  it("npmのERESOLVE(peer dependency競合)を手順(task)として検出する", () => {
    const log = `npm ERR! code ERESOLVE
npm ERR! ERESOLVE unable to resolve dependency tree
npm ERR! Found: react@18.3.1
npm ERR! peer react@19.0.0 from some-lib@2.0.0`;

    const result = analyzeErrorLog(log);

    expect(result.errorType).toContain("ERESOLVE");
    expect(result.fixType).toBe("task");
    expect(result.summary).toContain("react@19.0.0");
  });

  it("EACCES/Permission deniedを手順(task)として検出する", () => {
    const log = `Error: EACCES: permission denied, open '/usr/local/lib/node_modules'`;

    const result = analyzeErrorLog(log);

    expect(result.errorType).toContain("EACCES");
    expect(result.fixType).toBe("task");
  });

  it("Dockerデーモン未起動エラーを検出する", () => {
    const log = `Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?`;

    const result = analyzeErrorLog(log);

    expect(result.errorType).toContain("デーモン未起動");
    expect(result.fixType).toBe("task");
  });

  it("Dockerのディスク容量不足エラーを検出する", () => {
    const log = `Error response from daemon: no space left on device`;

    const result = analyzeErrorLog(log);

    expect(result.errorType).toContain("ディスク容量不足");
  });

  it("Gitの未コミット変更による競合を検出する", () => {
    const log = `error: Your local changes to the following files would be overwritten by merge:
        src/App.tsx
Please commit your changes or stash them before you merge.`;

    const result = analyzeErrorLog(log);

    expect(result.errorType).toContain("未コミットの変更");
    expect(result.fixType).toBe("task");
  });

  it("Gitのマージコンフリクトを検出する", () => {
    const log = `Auto-merging src/App.tsx
CONFLICT (content): Merge conflict in src/App.tsx
Automatic merge failed; fix conflicts and then commit the result.`;

    const result = analyzeErrorLog(log);

    expect(result.errorType).toContain("マージコンフリクト");
  });

  it("TypeScriptコンパイルエラー(TSxxxx)からエラーコードを抽出する", () => {
    const log = `src/App.tsx(42,10): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`;

    const result = analyzeErrorLog(log);

    expect(result.errorType).toContain("TS2345");
    expect(result.summary).toContain("Argument of type");
  });

  it("JavaScriptヒープメモリ不足エラーを検出する", () => {
    const log = `<--- Last few GCs --->
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`;

    const result = analyzeErrorLog(log);

    expect(result.errorType).toContain("OutOfMemory");
    expect(result.fixType).toBe("task");
  });

  it("Java NullPointerExceptionを検出する", () => {
    const log = `Exception in thread "main" java.lang.NullPointerException
    at com.example.UserService.getName(UserService.java:15)`;

    const result = analyzeErrorLog(log);

    expect(result.errorType).toContain("NullPointerException");
  });

  it("JSON.parseの構文解析エラーを検出する", () => {
    const log = `SyntaxError: Unexpected token < in JSON at position 0`;

    const result = analyzeErrorLog(log);

    expect(result.errorType).toContain("JSON.parse");
  });

  it("未知のエラーは汎用フォールバックとして扱う", () => {
    const log = `Something completely unexpected happened in module Zeta`;

    const result = analyzeErrorLog(log);

    expect(result.errorType).toContain("Detected Runtime Exception");
    expect(result.summary).toContain("Something completely unexpected happened in module Zeta");
  });
});

describe("getOfficialDocLink", () => {
  it("EADDRINUSEにはNode.js公式ドキュメントを紐づける", () => {
    const link = getOfficialDocLink("EADDRINUSE", "Port 1420 is already in use");
    expect(link?.url).toContain("nodejs.org");
  });

  it("AttributeErrorにはPython公式ドキュメントを紐づける", () => {
    const link = getOfficialDocLink("AttributeError", "");
    expect(link?.url).toContain("docs.python.org");
  });

  it("TypeErrorにはMDNのTypeErrorリファレンスを紐づける", () => {
    const link = getOfficialDocLink("TypeError", "");
    expect(link?.url).toContain("TypeError");
  });

  it("該当が無い場合はnullを返す", () => {
    const link = getOfficialDocLink("SomeCustomError", "何の手がかりも無いログ");
    expect(link).toBeNull();
  });
});
