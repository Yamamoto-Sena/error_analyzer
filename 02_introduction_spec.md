# CLI起動時イントロダクション仕様書 (UI/UXデザイン)

**対象ファイル**: `src/cli/banner.ts` / `src/index.ts`  
**目的**: 初めてCLIを触る新人エンジニアでも安心でき、開発のモチベーションが高まる「かっこよくて親しみやすい」起動画面を定義する。

---

## 1. ターミナル起動時 画面イメージ（完全プレビュー）

```text
  ____       _                    ____            _     _       
 |  _ \  ___| |__  _   _  __ _   | __ ) _   _  __| | __| |_   _ 
 | | | |/ _ \ '_ \| | | |/ _` |  |  _ \| | | |/ _` |/ _` | | | |
 | |_| |  __/ |_) | |_| | (_| |  | |_) | |_| | (_| | (_| | |_| |
 |____/ \___|_.__/ \__,_|\__, |  |____/ \__,_|\__,_|\__,_|\__, |
                         |___/                            |___/ 
                     AI-Powered Debugging Assistant for Engineers 🚀

 ┌────────────────────────────────────────────────────────────────────────┐
 │                                                                        │
 │   👋 ようこそ、Debug Buddy へ！                                        │
 │   エラーログの解析から原因の学習、修正案の提案までをサポートします。     │
 │                                                                        │
 │   💡 今日の合言葉: 「エラーは成長のチャンス！」                         │
 │                                                                        │
 └────────────────────────────────────────────────────────────────────────┘

 📖 クイックスタートガイド:
  1. ログを解析して原因を学ぶ:
     $ debug-buddy analyze <ログファイル>

  2. 修正案のプレビューと自動適用:
     $ debug-buddy fix <ログファイル>

  3. コマンドを実行して失敗時に自動解析:
     $ debug-buddy run "<実行コマンド>"

  4. 過去に学んだエラー履歴を振り返る:
     $ debug-buddy history list

 ⚙️ ステータス:
  ● Gemini API: 接続完了 (モデル: gemini-2.5-flash)
  ● SQLite DB : 準備完了 (~/.debug-buddy/history.db)

 コマンド一覧を確認するには [ debug-buddy --help ] を実行してください。
```

---

## 2. デザイン・演出要素の仕様

### 2.1 ASCIIアートロゴ (FIGlet形式)
- **フォントスタイル**: `Standard` または `Slant`（視認性が高く、どのターミナルでも崩れにくい王道スタイル）
- **カラーリング**:
  - `DEBUG`: シアン（Cyan / 水色）または ブルー（Blue）のグラデーション
  - `BUDDY`: グリーン（Green）または イエロー（Yellow）の明るいアクセントカラー
  - ライブラリ: `chalk` または `gradient-string` を使用

```typescript
// ASCIIアート定義（chalkでカラー装飾）
export const ASCII_LOGO = `
  ____       _                    ____            _     _       
 |  _ \\  ___| |__  _   _  __ _   | __ ) _   _  __| | __| |_   _ 
 | | | |/ _ \\ '_ \\| | | |/ _\` |  |  _ \\| | | |/ _\` |/ _\` | | | |
 | |_| |  __/ |_) | |_| | (_| |  | |_) | |_| | (_| | (_| | |_| |
 |____/ \\___|_.__/ \\__,_|\\__, |  |____/ \\__,_|\\__,_|\\__,_|\\__, |
                         |___/                            |___/ 
`;
```

### 2.2 ウェルカムボックス (Boxen)
新人エンジニアが気負わずに使えるよう、親しみやすいメッセージとポジティブなワンフレーズを枠線で囲んで表示します。

- **ライブラリ**: `boxen`
- **スタイル仕様**:
  - 枠線タイプ: `round`（丸角で柔らかい印象）
  - パディング: 左右 `2`、上下 `1`
  - 枠線カラー: `cyan`（シアン）
  - タイトル: `Welcome to Debug Buddy`

### 2.3 クイックスタートガイド
「次に何を打てばいいか」が迷わないよう、代表的なユースケースを箇条書きで示します。

- **コマンド表示**: `chalk.yellow('$ debug-buddy ...')` でコマンド部分を強調。
- **説明文**: シンプルで直感的な日本語（例: 「ログを解析して原因を学ぶ」）。

### 2.4 システム診断ステータス表示
CLIツールで初心者が最も躓きやすいのが「APIキーの設定忘れ」や「DB初期化エラー」です。起動時にステータスをアイコン付きで明示します。

| 項目 | 正常時（緑） | 異常時（赤/黄） | 異常時の親切なガイダンス |
| :--- | :--- | :--- | :--- |
| **Gemini API** | `● Gemini API: 接続完了` | `▲ Gemini API: キー未設定` | `ヒント: .env に GEMINI_API_KEY を設定してください` |
| **SQLite DB** | `● SQLite DB : 準備完了` | `▲ SQLite DB : 初期化未完了` | 自動作成処理を裏で実行し、エラー時は分かりやすいパスを提示 |

---

## 3. 実装サンプルコード (`src/cli/banner.ts`)

TypeScript + Chalk + Boxen を用いた実装例です。

```typescript
import chalk from 'chalk';
import boxen from 'boxen';

export function showBanner(isGeminiReady: boolean, isDbReady: boolean): void {
  // 1. ASCIIロゴ
  const logo = chalk.cyan.bold(`
  ____       _                    ____            _     _       
 |  _ \\  ___| |__  _   _  __ _   | __ ) _   _  __| | __| |_   _ 
 | | | |/ _ \\ '_ \\| | | |/ _\` |  |  _ \\| | | |/ _\` |/ _\` | | | |
 | |_| |  __/ |_) | |_| | (_| |  | |_) | |_| | (_| | (_| | |_| |
 |____/ \\___|_.__/ \\__,_|\\__, |  |____/ \\__,_|\\__,_|\\__,_|\\__, |
                         |___/                            |___/ 
  `) + chalk.gray('             AI-Powered Debugging Assistant for Engineers 🚀\n');

  console.log(logo);

  // 2. ウェルカムメッセージボックス
  const welcomeText = `
${chalk.bold('👋 ようこそ、Debug Buddy へ！')}
エラーログの解析から原因の学習、修正案の提案までをサポートします。

${chalk.dim('💡 今日の合言葉:')} ${chalk.green.bold('「エラーは成長のチャンス！」')}
`.trim();

  console.log(
    boxen(welcomeText, {
      padding: { top: 0, bottom: 0, left: 2, right: 2 },
      margin: { top: 0, bottom: 1 },
      borderStyle: 'round',
      borderColor: 'cyan',
    })
  );

  // 3. クイックスタートガイド
  console.log(chalk.bold.white(' 📖 クイックスタートガイド:'));
  console.log(`  1. ログを解析して原因を学ぶ:`);
  console.log(`     ${chalk.yellow('$ debug-buddy analyze <ログファイル>')}`);
  console.log(`  2. 修正案のプレビューと自動適用:`);
  console.log(`     ${chalk.yellow('$ debug-buddy fix <ログファイル>')}`);
  console.log(`  3. コマンドを実行して失敗時に自動解析:`);
  console.log(`     ${chalk.yellow('$ debug-buddy run "<実行コマンド>"')}`);
  console.log(`  4. 過去に学んだエラー履歴を振り返る:`);
  console.log(`     ${chalk.yellow('$ debug-buddy history list')}\n`);

  // 4. システム診断ステータス
  console.log(chalk.bold.white(' ⚙️ ステータス:'));
  const geminiStatus = isGeminiReady
    ? chalk.green('● Gemini API: 接続完了 (gemini-2.5-flash)')
    : chalk.red('▲ Gemini API: キー未設定 (.env に GEMINI_API_KEY を設定してください)');

  const dbStatus = isDbReady
    ? chalk.green('● SQLite DB : 準備完了 (~/.debug-buddy/history.db)')
    : chalk.red('▲ SQLite DB : 接続エラー');

  console.log(`  ${geminiStatus}`);
  console.log(`  ${dbStatus}\n`);
  console.log(chalk.gray(' コマンド一覧を確認するには [ debug-buddy --help ] を実行してください。\n'));
}
```

