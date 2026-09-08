"""Application configuration management."""

import os
from pathlib import Path
from dotenv import load_dotenv

# .env ファイルの読み込み
load_dotenv()

class Settings:
    """Debug Buddy configuration settings."""

    def __init__(self) -> None:
        self.gemini_api_key: str | None = os.getenv("GEMINI_API_KEY")
        self.gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
        self.db_path: Path = Path(
            os.getenv("DEBUG_BUDDY_DB_PATH", "~/.debug-buddy/history.db")
        ).expanduser()
        self.env: str = os.getenv("DEBUG_BUDDY_ENV", "development")

    @property
    def is_gemini_ready(self) -> bool:
        """Return True if a non-empty Gemini API key is configured."""
        return bool(self.gemini_api_key and self.gemini_api_key != "your_gemini_api_key_here")

    @property
    def is_db_ready(self) -> bool:
        """Check if SQLite directory is accessible/ready."""
        try:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            return True
        except Exception:
            return False


settings = Settings()

