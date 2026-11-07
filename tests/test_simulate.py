from pathlib import Path

import pandas as pd
from typer.testing import CliRunner

from felinos_telemetry.cli import app
from felinos_telemetry.io.ndjson import iter_records, read_stream
from felinos_telemetry.io.sensorlogger import parse_message, pivot_sensor, read_export
from felinos_telemetry.simulate import export_to_messages, pace, to_records


def test_messages_roundtrip_through_parser(export_dir: Path) -> None:
    long = read_export(export_dir)
    msgs = list(export_to_messages(long, session_id="S", sensors=None))
    assert 59 <= len(msgs) <= 61
    assert [m["messageId"] for m in msgs] == list(range(1, len(msgs) + 1))
    assert all(m["sessionId"] == "S" for m in msgs)
    back = pd.concat([parse_message(m) for m in msgs], ignore_index=True)
    for sensor in ("accelerometer", "location"):
        a = pivot_sensor(long, sensor)
        b = pivot_sensor(back, sensor)
        pd.testing.assert_frame_equal(a, b)


def test_default_sensor_subset_and_batch_span(export_dir: Path) -> None:
    msgs = list(export_to_messages(read_export(export_dir)))
    names = {e["name"] for m in msgs for e in m["payload"]}
    assert names <= {"accelerometer", "gravity", "gyroscope", "location", "barometer", "battery"}
    for m in msgs:
        times = [e["time"] for e in m["payload"]]
        assert max(times) - min(times) < 1_000_000_000


def test_empty_input_yields_nothing(export_dir: Path) -> None:
    long = read_export(export_dir)
    assert list(export_to_messages(long, sensors=["nope"])) == []


def test_pace_keeps_rhythm() -> None:
    msgs = [
        {"payload": [{"time": 0}]},
        {"payload": [{"time": 1_000_000_000}]},
        {"payload": [{"time": 3_000_000_000}]},
    ]
    now = [0.0]
    sleeps: list[float] = []

    def sleep(s: float) -> None:
        sleeps.append(s)
        now[0] += s

    sent: list[object] = []
    pace(msgs, sent.append, speed=2.0, sleep=sleep, clock=lambda: now[0])
    assert len(sent) == 3
    assert sleeps == [0.5, 1.0]
    pace([], sent.append)


def test_cli_simulate_writes_ndjson(export_dir: Path, tmp_path: Path) -> None:
    out = tmp_path / "demo" / "demo.ndjson"
    result = CliRunner().invoke(app, ["simulate", str(export_dir), "--out", str(out)])
    assert result.exit_code == 0, result.output
    recs = list(iter_records(out))
    assert recs[0].topic.startswith("felinos/simulator/")
    assert recs == to_records([r.message for r in recs if r.message], "felinos")
    assert len(pivot_sensor(read_stream(out), "location")) == 22


def test_cli_simulate_needs_an_output(export_dir: Path) -> None:
    assert CliRunner().invoke(app, ["simulate", str(export_dir)]).exit_code == 2
