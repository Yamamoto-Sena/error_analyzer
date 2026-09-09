# Debug Buddy — IDE拡張 (エディタプラグイン) PoC

`02_introduction_spec.md` / `01_requirements_definition.md` で定義されている Debug Buddy の
「修正案の提示」体験を、**VS Code拡張機能**として実装した場合の動作サンプルです。

## これは何か

開発者のPC内（VS Codeなどのエディタアプリの画面の中）で完結する挙動を再現します。

- コード上の該当箇所に **赤波線（Diagnostics）** を表示
- カーソルを合わせると **ホバー（吹き出し）** で「要約 / 根本原因 / 学習メモ」を教育的フォーマットで表示
- 電球アイコンの **Quick Fix** を押すと、その場でファイルを書き換えて安全なコードに修正

検知パターンは1つだけの最小プロトタイプです:
`foo.map(...)` のようにオプショナルチェーンなしで配列メソッドを呼んでいる箇所を検知し、
要件定義書のサンプルエラー「`TypeError`: 未定義オブジェクトへのプロパティアクセス (`reading 'map'`)」に対応します。
Gemini連携や `src/analyzer.ts`（本体アプリの解析エンジン）との統合は行っていません。

## 試し方

```bash
cd vscode-extension
npm install
npm run compile
```

その後 VS Code でこの `vscode-extension` フォルダを開き、`F5` を押すと
「拡張機能開発ホスト」という別ウィンドウが起動します。そのウィンドウで
`sample/risky-example.ts` を開くと、`items.map(` の部分に赤波線が出るはずです。

1. 赤波線にカーソルを合わせる → ホバーで説明が出る
2. 赤波線の行にカーソルを置き、電球アイコン（💡）または `Cmd+.` / `Ctrl+.` → Quick Fix候補が出る
3. Quick Fixを適用 → `items.map(` が `items?.map(` に書き換わる

## いつでも戻せるようにする方針

このPoCは **`feature/ide-extension-poc` ブランチ上でのみ** 作業しています。
`main` ブランチには一切影響を与えていません。

- 採用しない場合: このブランチを削除するだけで元通りです。
  ```bash
  git checkout main
  git branch -D feature/ide-extension-poc
  ```
- 採用する場合: 通常通り `main` にマージ、または PR を作成してください。

## 既知の制約（PoCゆえの割り切り）

- 正規表現ベースの簡易検知のみ。実際のASTを解析していないため誤検知/見逃しがあり得ます。
- 検知パターンは `.map` `.filter` `.forEach` `.reduce` `.find` の5メソッドのみ。
- Debug Buddy本体（Tauriアプリ）の解析エンジンやGemini APIとは未連携。
- テストコードは未整備（動作確認は手動での `F5` 起動のみ）。
