import json
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from felinos_telemetry.io.sensorlogger import (
    LONG_COLUMNS,
    message_header,
    parse_message,
    parse_messages,
    pivot_sensor,
    read_export,
    read_export_metadata,
    sensors_in,
)

# ---------------------------------------------------------------- streaming (real message)


def test_parse_real_message(stream_message_text: str) -> None:
    df = parse_message(stream_message_text)
    assert list(df.columns) == LONG_COLUMNS
    assert df["time_ns"].dtype == np.int64
    assert df["value"].dtype == np.float64
    assert sensors_in(df) == [
        "accelerometer",
        "accelerometeruncalibrated",
        "barometer",
        "gravity",
        "gyroscope",
        "gyroscopeuncalibrated",
        "orientation",
    ]
    accel = pivot_sensor(df, "accelerometer")
    assert len(accel) == 107
    assert list(accel.columns) == ["time_ns", "x", "y", "z"]
    first = accel.iloc[0]
    assert first["time_ns"] == 1794032705001959400
    assert first["x"] == pytest.approx(-1.0524036053299903)
    assert accel["time_ns"].is_monotonic_increasing
    orientation = pivot_sensor(df, "orientation")
    assert {"qw", "qx", "qy", "qz", "roll", "pitch", "yaw"} <= set(orientation.columns)


def test_message_header(stream_message_text: str) -> None:
    header = message_header(stream_message_text)
    assert header.message_id == 9
    assert header.session_id == "c886864a-9bf3-4f12-bbaa-43443e3f1229"
    assert header.device_id == "02a84114-8fa4-453e-8cf3-3abc28748936"


def test_parse_bytes_and_dict(stream_message_text: str) -> None:
    from_bytes = parse_message(stream_message_text.encode())
    from_dict = parse_message(json.loads(stream_message_text))
    pd.testing.assert_frame_equal(from_bytes, from_dict)


def test_parse_location_from_assumed_structure() -> None:
    # Location was not in the captured message; structure from the app docs (brief §6.3).
    msg = {
        "messageId": 1,
        "payload": [
            {
                "name": "location",
                "time": 1731050000000000000,
                "values": {"latitude": 21.1471535, "longitude": -101.6887185, "speed": 3.2},
            }
        ],
    }
    loc = pivot_sensor(parse_message(msg), "location")
    assert loc.iloc[0]["latitude"] == pytest.approx(21.1471535)
    assert loc.iloc[0]["speed"] == pytest.approx(3.2)


def test_parser_is_tolerant() -> None:
    msg = {
        "payload": [
            {"name": "Accelerometer", "time": "1000", "values": {"x": 1, "y": "2.5"}},
            {"name": "annotation", "time": 1, "values": {"text": "lap"}},  # unknown sensor
            {"name": "mysterysensor", "time": 1, "values": {"a": 1}},
            {"name": "gyroscope", "values": {"x": 1}},  # no time
            {"time": 5, "values": {"x": 1}},  # no name
            {"name": "battery", "time": 7, "values": {"batteryLevel": 0.74, "batteryState": "x"}},
            "garbage",
            {"name": "gravity", "time": 9, "values": None},
        ]
    }
    df = parse_message(msg)
    assert sensors_in(df) == ["accelerometer", "battery"]
    accel = pivot_sensor(df, "accelerometer")
    assert accel.iloc[0].to_dict() == {"time_ns": 1000, "x": 1.0, "y": 2.5}
    assert "z" not in accel.columns  # missing field accepted
    assert pivot_sensor(df, "battery")["batteryLevel"].iloc[0] == pytest.approx(0.74)


@pytest.mark.parametrize("raw", ["not json", "[1, 2]", b"\xff\xfe"])
def test_invalid_message_raises(raw: str | bytes) -> None:
    with pytest.raises(ValueError, match="JSON"):
        parse_message(raw)


@pytest.mark.parametrize("msg", [{}, {"payload": "x"}, {"payload": []}])
def test_empty_payload_gives_empty_frame(msg: dict[str, object]) -> None:
    df = parse_message(msg)
    assert df.empty
    assert list(df.columns) == LONG_COLUMNS


def test_parse_messages_skips_bad_ones(stream_message_text: str) -> None:
    df = parse_messages([stream_message_text, "broken", stream_message_text])
    single = parse_message(stream_message_text)
    assert len(df) == 2 * len(single)
    # pivot de-duplicates repeated samples from overlapping batches
    assert len(pivot_sensor(df, "accelerometer")) == 107
    assert parse_messages([]).empty


def test_pivot_missing_sensor() -> None:
    assert list(pivot_sensor(parse_message({"payload": []}), "location").columns) == ["time_ns"]


# ---------------------------------------------------------------- CSV export (real export)


def test_read_export_folder(export_dir: Path) -> None:
    df = read_export(export_dir)
    assert list(df.columns) == LONG_COLUMNS
    assert df["time_ns"].dtype == np.int64
    assert sensors_in(df) == [
        "accelerometer",
        "accelerometeruncalibrated",
        "barometer",
        "compass",
        "gravity",
        "gyroscope",
        "gyroscopeuncalibrated",
        "location",
        "orientation",
        "totalacceleration",
    ]
    accel = pivot_sensor(df, "accelerometer")
    assert len(accel) == 5978
    assert accel.iloc[0]["time_ns"] == 1793420456673332500
    assert accel.iloc[0]["z"] == pytest.approx(6.307119369506836, rel=1e-9)
    duration_s = (accel["time_ns"].iloc[-1] - accel["time_ns"].iloc[0]) / 1e9
    assert 59 < duration_s < 60
    loc = pivot_sensor(df, "location")
    assert len(loc) == 22
    assert {"latitude", "longitude", "speed", "horizontalAccuracy"} <= set(loc.columns)
    assert loc["latitude"].between(21.1, 21.2).all()


def test_stream_and_csv_share_sensor_and_field_names(
    export_dir: Path, stream_message_text: str
) -> None:
    csv = read_export(export_dir)
    stream = parse_message(stream_message_text)
    for sensor in sensors_in(stream):
        stream_fields = set(pivot_sensor(stream, sensor).columns)
        csv_fields = set(pivot_sensor(csv, sensor).columns)
        assert stream_fields == csv_fields, sensor


def test_read_export_zip_with_subfolder(export_dir: Path, tmp_path: Path) -> None:
    zpath = tmp_path / "export.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as zf:
        for csv in export_dir.glob("*.csv"):
            zf.write(csv, f"2026-10-31_04-20-56/{csv.name}")
    pd.testing.assert_frame_equal(read_export(zpath), read_export(export_dir))


def test_read_export_metadata(export_dir: Path) -> None:
    meta = read_export_metadata(export_dir)
    assert meta is not None
    assert meta.device_name == "SM-N975F"
    assert meta.platform == "android"
    assert meta.recording_epoch_ms == 1793420456445
    assert meta.timezone == "America/Mexico_City"
    assert "Location" in meta.sensors


def test_spreadsheet_damaged_time_is_rebuilt(export_dir: Path, tmp_path: Path) -> None:
    """A CSV saved by Excel has time as 1.79342E+18; rebuild it from seconds_elapsed."""
    damaged = tmp_path / "export"
    damaged.mkdir()
    (damaged / "Metadata.csv").write_bytes((export_dir / "Metadata.csv").read_bytes())
    original = pd.read_csv(export_dir / "Accelerometer.csv")
    broken = original.copy()
    broken["time"] = broken["time"].map(lambda t: f"{t:.5E}")
    broken.to_csv(damaged / "Accelerometer.csv", index=False)

    rebuilt = pivot_sensor(read_export(damaged), "accelerometer")
    error_ns = (rebuilt["time_ns"].to_numpy() - original["time"].to_numpy()).astype(float)
    assert np.abs(error_ns).max() < 1_000  # < 1 µs


def test_damaged_time_without_metadata_still_parses(export_dir: Path, tmp_path: Path) -> None:
    damaged = tmp_path / "export"
    damaged.mkdir()
    original = pd.read_csv(export_dir / "Gyroscope.csv")
    original["time"] = original["time"].astype(float)
    original.to_csv(damaged / "Gyroscope.csv", index=False)
    gyro = pivot_sensor(read_export(damaged), "gyroscope")
    assert len(gyro) == len(original)


def test_read_export_rejects_other_files(tmp_path: Path) -> None:
    bogus = tmp_path / "x.txt"
    bogus.write_text("hi")
    with pytest.raises(ValueError, match="neither"):
        read_export(bogus)


def test_read_export_empty_folder(tmp_path: Path) -> None:
    assert read_export(tmp_path).empty
    assert read_export_metadata(tmp_path) is None
