# Debug Buddy 🚀
**AI-Powered Debugging & Error Log Analysis Assistant for Engineers**

新人エンジニアがトラブルシューティングの思考法を学びながら、実務でのデバッグ作業を効率化・自立化できるCLIアシスタントツールです。

---

## 🛠️ 技術スタック
- **開発言語**: Python 3.11+ (Python 3.14 対応)
- **CLIフレームワーク**: Typer
- **ターミナルUI・装飾**: Rich
- **バリデーション**: Pydantic v2
- **設定管理**: python-dotenv
- **LLMエンジン**: Google GenAI SDK (Gemini 2.5 Flash)
- **データベース**: SQLite

---

## 📂 ディレクトリ構成

```text
debug-buddy/
├── .env.example              # 環境変数のサンプル (APIキー設定)
├── .gitignore
├── pyproject.toml            # パッケージ・依存関係定義
├── README.md
├── 01_requirements_definition.md
├── 02_introduction_spec.md
├── src/
│   └── debug_buddy/
│       ├── __init__.py
│       ├── main.py           # CLIエントリーポイント
│       ├── config.py         # 設定・環境変数管理
│       ├── core/             # コア解析・修正ロジック
│       ├── storage/          # SQLite・履歴保存モジュール
│       └── ui/               # RichターミナルUI・バナー
│           ├── __init__.py
│           └── banner.py     # 起動バナー・ウェルカム画面
└── tests/                    # テストコード
```

---

## 🚀 クイックスタート

### 1. 仮想環境のセットアップとインストール
```bash
# 仮想環境の作成
python -m venv .venv

# 仮想環境の有効化 (Windows PowerShell)
.\.venv\Scripts\Activate.ps1

# パッケージのインストール (開発モード)
pip install -e .
```

### 2. 環境変数の設定
`.env.example` をコピーして `.env` を作成し、Gemini APIキーを設定します。
```bash
cp .env.example .env
```
`.env` ファイルを開き、`GEMINI_API_KEY` を入力してください。

### 3. ツールの起動確認
```bash
# バナーとステータスの表示
debug-buddy

# ヘルプとコマンド一覧
debug-buddy --help
```

