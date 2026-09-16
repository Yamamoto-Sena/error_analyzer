import * as vscode from 'vscode';

/**
 * Debug Buddy — IDE拡張 (エディタプラグイン) 方式の動作サンプル。
 *
 * 「01_requirements_definition.md」で定義された教育的アプローチ（要約 / 根本原因 / 学習メモ）を
 * VS Code のネイティブ機能（Diagnostics = 赤波線 / Hover = 吹き出し / CodeAction = Quick Fix）
 * だけで再現できるかを検証するための最小プロトタイプです。
 *
 * 検知パターンは1つだけ:
 *   `foo.map(` のように、undefined かもしれない値に対して
 *   オプショナルチェーン (`?.`) なしで配列メソッドを呼んでいる箇所。
 *   → 要件定義書のサンプルエラー「TypeError: 未定義オブジェクトへのプロパティアクセス (reading 'map')」に対応。
 *
 * Gemini連携や src/analyzer.ts との統合は行っていません（PoCのため範囲外）。
 */

const DIAGNOSTIC_SOURCE = 'Debug Buddy (PoC)';
const DIAGNOSTIC_CODE = 'debug-buddy/possible-undefined-array-method';

// data.map( / data.filter( / data.forEach( / data.reduce( のような、
// オプショナルチェーンを伴わない配列メソッド呼び出しを検知する。
// 直前が `?` の場合（=既に `?.` になっている場合）はマッチしない。
const RISKY_CALL_PATTERN = /\b([A-Za-z_$][\w$]*)\.(map|filter|forEach|reduce|find)\(/g;

const TARGET_LANGUAGES = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'];

interface RiskyMatch {
  range: vscode.Range;
  variableName: string;
  methodName: string;
}

function findRiskyMatches(document: vscode.TextDocument): RiskyMatch[] {
  const text = document.getText();
  const matches: RiskyMatch[] = [];
  let m: RegExpExecArray | null;
  RISKY_CALL_PATTERN.lastIndex = 0;

  while ((m = RISKY_CALL_PATTERN.exec(text)) !== null) {
    const [, variableName, methodName] = m;
    const startOffset = m.index;
    const endOffset = m.index + variableName.length + 1 + methodName.length; // 変数名 + "." + メソッド名 まで
    matches.push({
      range: new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset)),
      variableName,
      methodName,
    });
  }

  return matches;
}

function buildDiagnostic(match: RiskyMatch): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(
    match.range,
    `"${match.variableName}" が undefined の可能性があります。このまま .${match.methodName}() を呼ぶと ` +
      `"Cannot read properties of undefined (reading '${match.methodName}')" になるかもしれません。`,
    vscode.DiagnosticSeverity.Warning
  );
  diagnostic.source = DIAGNOSTIC_SOURCE;
  diagnostic.code = DIAGNOSTIC_CODE;
  return diagnostic;
}

function updateDiagnostics(document: vscode.TextDocument, collection: vscode.DiagnosticCollection): void {
  if (!TARGET_LANGUAGES.includes(document.languageId)) {
    collection.delete(document.uri);
    return;
  }

  const diagnostics = findRiskyMatches(document).map(buildDiagnostic);
  collection.set(document.uri, diagnostics);
}

/** ホバー時に表示する、Debug Buddy 本体の3タブ構成（要約/根本原因/学習メモ）を模した説明文。 */
function buildHoverMarkdown(diagnostic: vscode.Diagnostic): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = false;
  md.appendMarkdown(`### 🐛 Debug Buddy 解析結果\n\n`);
  md.appendMarkdown(`**要約**: ${diagnostic.message}\n\n`);
  md.appendMarkdown(
    `**根本原因**: API応答や非同期処理の結果が期待通りに配列で返らず、` +
      `\`undefined\` や \`null\` のままプロパティアクセスされている可能性があります。\n\n`
  );
  md.appendMarkdown(
    `**学習メモ**: オプショナルチェーン \`?.\` を使うと、左辺が \`undefined\`/\`null\` の場合は` +
      `例外を投げずに式全体が \`undefined\` になります。配列の初期値を \`[]\` にしておくのも有効です。\n\n`
  );
  md.appendMarkdown(`💡 電球アイコン（Quick Fix）から \`?.\` を自動追加できます。`);
  return md;
}

class DebugBuddyHoverProvider implements vscode.HoverProvider {
  constructor(private readonly collection: vscode.DiagnosticCollection) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
    const diagnostics = this.collection.get(document.uri) ?? [];
    const hit = diagnostics.find((d) => d.range.contains(position) && d.code === DIAGNOSTIC_CODE);
    if (!hit) {
      return undefined;
    }
    return new vscode.Hover(buildHoverMarkdown(hit), hit.range);
  }
}

class DebugBuddyQuickFixProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.ProviderResult<vscode.CodeAction[]> {
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics) {
      if (diagnostic.code !== DIAGNOSTIC_CODE) {
        continue;
      }

      const original = document.getText(diagnostic.range); // 例: "data.map"
      const dotIndex = original.indexOf('.');
      if (dotIndex === -1) {
        continue;
      }
      const fixed = `${original.slice(0, dotIndex)}?${original.slice(dotIndex)}`; // "data?.map"

      const action = new vscode.CodeAction(
        `"?." を追加して安全にする → ${fixed}(...)`,
        vscode.CodeActionKind.QuickFix
      );
      action.diagnostics = [diagnostic];
      action.isPreferred = true;
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(document.uri, diagnostic.range, fixed);
      actions.push(action);
    }

    return actions;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection('debug-buddy-poc');
  context.subscriptions.push(collection);

  // 起動時に開いているエディタを解析
  if (vscode.window.activeTextEditor) {
    updateDiagnostics(vscode.window.activeTextEditor.document, collection);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => updateDiagnostics(doc, collection)),
    vscode.workspace.onDidChangeTextDocument((e) => updateDiagnostics(e.document, collection)),
    vscode.workspace.onDidSaveTextDocument((doc) => updateDiagnostics(doc, collection)),
    vscode.languages.registerHoverProvider(TARGET_LANGUAGES, new DebugBuddyHoverProvider(collection)),
    vscode.languages.registerCodeActionsProvider(TARGET_LANGUAGES, new DebugBuddyQuickFixProvider(), {
      providedCodeActionKinds: DebugBuddyQuickFixProvider.providedCodeActionKinds,
    })
  );
}

export function deactivate(): void {
  // 特に後処理は不要（DiagnosticCollectionはsubscriptionsでdispose済み）
}
