"""Banner and welcome screen rendering using Rich."""

from rich.console import Console
from rich.panel import Panel
from rich.text import Text
from rich.table import Table

console = Console()

ASCII_LOGO = r"""
  ____       _                    ____            _     _       
 |  _ \  ___| |__  _   _  __ _   | __ ) _   _  __| | __| |_   _ 
 | | | |/ _ \ '_ \| | | |/ _` |  |  _ \| | | |/ _` |/ _` | | | |
 | |_| |  __/ |_) | |_| | (_| |  | |_) | |_| | (_| | (_| | |_| |
 |____/ \___|_.__/ \__,_|\__, |  |____/ \__,_|\__,_|\__,_|\__, |
                         |___/                            |___/ 
"""


def show_banner(is_gemini_ready: bool, is_db_ready: bool, model_name: str = "gemini-2.5-flash") -> None:
    """Display the welcome banner, introduction, quickstart, and system diagnostics."""
    # 1. ASCIIアートロゴ
    logo_text = Text(ASCII_LOGO, style="bold cyan")
    subtitle = Text("         AI-Powered Debugging & Error Log Analysis Assistant 🚀\n", style="dim italic white")
    console.print(logo_text)
    console.print(subtitle)

    # 2. ウェルカムメッセージ (Panel)
    welcome_content = Text()
    welcome_content.append("👋 ようこそ、Debug Buddy へ！\n", style="bold white")
    welcome_content.append(
        "エラーログの解析から根本原因の学習、安全な修正案の適用までをサポートします。\n\n",
        style="dim white",
    )
    welcome_content.append("💡 今日の合言葉: ", style="bold yellow")
    welcome_content.append("「エラーは成長のチャンス！」\n", style="bold green")

    welcome_panel = Panel(
        welcome_content,
        title="[bold cyan]Welcome to Debug Buddy[/bold cyan]",
        border_style="cyan",
        padding=(1, 2),
    )
    console.print(welcome_panel)
    console.print()

    # 3. クイックスタートガイド (テーブルレイアウトでスッキリ表示)
    guide_table = Table(
        title="📖 クイックスタートガイド",
        title_style="bold underline white",
        show_header=False,
        box=None,
        padding=(0, 1),
    )
    guide_table.add_column("No", style="dim cyan", width=4)
    guide_table.add_column("Command", style="bold yellow")
    guide_table.add_column("Description", style="white")

    guide_table.add_row(
        "1.",
        "debug-buddy analyze <log_file>",
        "ログファイルを解析して根本原因と学習メモを表示",
    )
    guide_table.add_row(
        "2.",
        "debug-buddy fix <log_file>",
        "ログ解析に加えて修正Diffをプレビューし、対話形式で適用",
    )
    guide_table.add_row(
        "3.",
        'debug-buddy run "<command>"',
        "開発コマンドを実行し、エラー発生時に自動で解析を開始",
    )
    guide_table.add_row(
        "4.",
        "debug-buddy history list",
        "過去に解決したエラーの履歴と学んだ知見を振り返る",
    )

    console.print(guide_table)
    console.print()

    # 4. システム診断ステータス
    status_table = Table(
        title="⚙️ システム診断ステータス",
        title_style="bold underline white",
        show_header=False,
        box=None,
        padding=(0, 1),
    )
    status_table.add_column("Icon", width=3)
    status_table.add_column("Service", style="bold white", width=16)
    status_table.add_column("Detail")

    if is_gemini_ready:
        status_table.add_row(
            "[green]●[/green]",
            "Gemini API",
            f"[green]接続可能[/green] (モデル: {model_name})",
        )
    else:
        status_table.add_row(
            "[yellow]▲[/yellow]",
            "Gemini API",
            "[yellow]APIキー未設定[/yellow] [dim](.env または環境変数 GEMINI_API_KEY を設定してください)[/dim]",
        )

    if is_db_ready:
        status_table.add_row(
            "[green]●[/green]",
            "SQLite DB",
            "[green]準備完了[/green] [dim](~/.debug-buddy/history.db)[/dim]",
        )
    else:
        status_table.add_row(
            "[red]✕[/red]",
            "SQLite DB",
            "[red]アクセスエラー[/red] [dim](ディレクトリ権限を確認してください)[/dim]",
        )

    console.print(status_table)
    console.print()
    console.print("[dim]※ 詳細なコマンドヘルプを見るには [bold white]debug-buddy --help[/bold white] を実行してください。[/dim]\n")

