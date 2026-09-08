"""Main CLI entrypoint for Debug Buddy."""

import sys

# Windows 環境における絵文字・UTF-8文字の文字化け・UnicodeEncodeError防止
if sys.platform == "win32":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")

import typer
from typing_extensions import Annotated
from debug_buddy import __version__
from debug_buddy.config import settings
from debug_buddy.ui.banner import show_banner, console

app = typer.Typer(
    name="debug-buddy",
    help="AI-Powered Debugging & Error Log Analysis Assistant for Engineers 🚀",
    no_args_is_help=False,
)


@app.callback(invoke_without_command=True)
def main_callback(
    ctx: typer.Context,
    version: Annotated[
        bool,
        typer.Option(
            "--version",
            "-v",
            help="Show the version of Debug Buddy.",
            is_eager=True,
        ),
    ] = False,
) -> None:
    """Debug Buddy CLI Entry point."""
    if version:
        console.print(f"[bold cyan]Debug Buddy[/bold cyan] version [green]{__version__}[/green]")
        raise typer.Exit()

    # サブコマンドが指定されていない場合は起動バナーを表示
    if ctx.invoked_subcommand is None:
        show_banner(
            is_gemini_ready=settings.is_gemini_ready,
            is_db_ready=settings.is_db_ready,
            model_name=settings.gemini_model,
        )


@app.command()
def analyze(
    log_file: Annotated[str, typer.Argument(help="Path to the error log file to analyze.")],
) -> None:
    """Analyze an error log file with Gemini and learn root causes."""
    console.print(f"[bold green]🔍 Analyzing log file:[/bold green] {log_file}")
    console.print("[dim]※ 解析ロジックは次のフェーズで実装されます。[/dim]")


@app.command()
def fix(
    log_file: Annotated[str, typer.Argument(help="Path to the error log file to fix.")],
) -> None:
    """Analyze error log and interactively preview & apply code fixes."""
    console.print(f"[bold cyan]🛠️ Analyzing and preparing fix for:[/bold cyan] {log_file}")
    console.print("[dim]※ 修正適用ロジックは次のフェーズで実装されます。[/dim]")


@app.command()
def run(
    command: Annotated[str, typer.Argument(help="Command to run and monitor for errors.")],
) -> None:
    """Run a development command and automatically capture errors upon failure."""
    console.print(f"[bold yellow]▶️ Running command:[/bold yellow] {command}")
    console.print("[dim]※ 実行監視ロジックは次のフェーズで実装されます。[/dim]")


@app.command()
def history() -> None:
    """List and review past debugging sessions and learning notes."""
    console.print("[bold magenta]📚 Debugging History[/bold magenta]")
    console.print("[dim]※ 履歴管理ロジックは次のフェーズで実装されます。[/dim]")


if __name__ == "__main__":
    app()

