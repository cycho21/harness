from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "target" / ".pi" / "sbadr" / "cli.py"


def test_sbadr_cli_module_invokes_typer_app():
    src = CLI.read_text(encoding="utf-8")
    assert 'if __name__ == "__main__"' in src
    assert "app()" in src
