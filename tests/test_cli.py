from typer.testing import CliRunner

from felinos_telemetry import __version__
from felinos_telemetry.cli import app


def test_version_command() -> None:
    result = CliRunner().invoke(app, ["version"])
    assert result.exit_code == 0
    assert __version__ in result.stdout
