from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from felinos_telemetry import __version__
from felinos_telemetry.cli import app
from felinos_telemetry.ingest import mqtt_logger
from felinos_telemetry.io.ndjson import StreamRecord, write_records

runner = CliRunner()


def test_version_command() -> None:
    result = runner.invoke(app, ["version"])
    assert result.exit_code == 0
    assert __version__ in result.stdout


def test_check_export(export_dir: Path) -> None:
    result = runner.invoke(app, ["check", str(export_dir)])
    assert result.exit_code == 0, result.output
    assert "accelerometer" in result.stdout
    assert "location" in result.stdout


def test_check_ndjson(stream_message_text: str, tmp_path: Path) -> None:
    path = tmp_path / "s.ndjson"
    write_records(path, [StreamRecord.from_payload("t", stream_message_text.encode(), 1)])
    result = runner.invoke(app, ["check", str(path)])
    assert result.exit_code == 0, result.output
    assert "gyroscope" in result.stdout


def test_check_missing_and_empty(tmp_path: Path) -> None:
    assert runner.invoke(app, ["check", str(tmp_path / "nope")]).exit_code == 2
    assert runner.invoke(app, ["check", str(tmp_path)]).exit_code == 1


def test_ingest_requires_host(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MQTT_HOST", raising=False)
    result = runner.invoke(app, ["ingest", "--env-file", str(tmp_path / "missing.env")])
    assert result.exit_code == 2
    assert "MQTT_HOST" in result.output


def test_ingest_runs_with_env_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    env = tmp_path / ".env"
    env.write_text("MQTT_HOST=broker.example\nMQTT_TOPIC=felinos/#\n", encoding="utf-8")
    monkeypatch.delenv("MQTT_HOST", raising=False)
    seen: dict[str, Any] = {}

    def fake_run(settings: Any, sinks: Any, **kw: Any) -> None:
        seen["settings"] = settings
        seen["sinks"] = sinks

    monkeypatch.setattr(mqtt_logger, "run", fake_run)
    out = tmp_path / "out"
    result = runner.invoke(
        app,
        ["ingest", "--env-file", str(env), "--data-dir", str(out), "--topic", "felinos/x/#"],
    )
    assert result.exit_code == 0, result.output
    assert seen["settings"].host == "broker.example"
    assert seen["settings"].topic == "felinos/x/#"
    assert out.is_dir()
