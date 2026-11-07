"""Parse Sensor Logger data — live MQTT messages and the CSV export — into one schema.

Both sources produce a *long* DataFrame with columns ``time_ns, sensor, field, value``:

- ``time_ns``: int64, UTC nanoseconds since the Unix epoch.
- ``sensor``: lowercase streaming name (``accelerometer``, ``location``…). CSV file names are
  mapped to the same names so analysis does not depend on the source.
- ``field``: value name as sent by the app (``x``, ``latitude``, ``pressure``…).
- ``value``: float64, in the app's units (m/s², rad/s, rad, m, m/s, hPa).

Message structure confirmed against a real capture (``tests/fixtures/stream_message_sample.json``)::

    {"messageId": 9, "sessionId": "...", "deviceId": "...",
     "payload": [{"name": "accelerometer", "time": 1794032705001959400,
                  "values": {"x": -1.05, "y": 1.57, "z": 1.45}}, ...]}

If the app changes the message format, only :func:`parse_message` needs to change.
"""

from __future__ import annotations

import io
import json
import logging
import math
import zipfile
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)

LONG_COLUMNS = ["time_ns", "sensor", "field", "value"]

#: Sensors we understand. Anything else (annotations, unknown future sensors) is ignored.
KNOWN_SENSORS: frozenset[str] = frozenset(
    {
        "accelerometer",
        "accelerometeruncalibrated",
        "totalacceleration",
        "gravity",
        "gyroscope",
        "gyroscopeuncalibrated",
        "orientation",
        "magnetometer",
        "magnetometeruncalibrated",
        "compass",
        "barometer",
        "location",
        "battery",
        "pedometer",
    }
)

#: CSV columns that are not sensor values.
_CSV_META_COLUMNS = {"time", "seconds_elapsed"}


def _empty_long() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "time_ns": pd.Series(dtype="int64"),
            "sensor": pd.Series(dtype="object"),
            "field": pd.Series(dtype="object"),
            "value": pd.Series(dtype="float64"),
        }
    )


def _to_time_ns(raw: Any) -> int | None:
    """Accept int, float or numeric string timestamps (ns). Return None if unusable."""
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw
    if isinstance(raw, float):
        return int(raw) if math.isfinite(raw) else None
    if isinstance(raw, str):
        try:
            return int(raw)
        except ValueError:
            try:
                return _to_time_ns(float(raw))
            except ValueError:
                return None
    return None


def _to_float(raw: Any) -> float | None:
    if isinstance(raw, bool):
        return float(raw)
    if isinstance(raw, int | float):
        return float(raw)
    if isinstance(raw, str):
        try:
            return float(raw)
        except ValueError:
            return None
    return None


# --------------------------------------------------------------------------- streaming


@dataclass(frozen=True)
class MessageHeader:
    message_id: int | None
    session_id: str | None
    device_id: str | None


def decode_message(raw: str | bytes | Mapping[str, Any]) -> dict[str, Any]:
    """Decode a raw MQTT payload into a dict. Raises ``ValueError`` if it is not a JSON object."""
    if isinstance(raw, Mapping):
        return dict(raw)
    try:
        obj = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ValueError(f"message is not valid JSON: {exc}") from exc
    if not isinstance(obj, dict):
        raise ValueError("message must be a JSON object")
    return obj


def message_header(raw: str | bytes | Mapping[str, Any]) -> MessageHeader:
    msg = decode_message(raw)
    mid = msg.get("messageId")
    sid = msg.get("sessionId")
    did = msg.get("deviceId")
    return MessageHeader(
        message_id=mid if isinstance(mid, int) and not isinstance(mid, bool) else None,
        session_id=str(sid) if sid is not None else None,
        device_id=str(did) if did is not None else None,
    )


def parse_message(raw: str | bytes | Mapping[str, Any]) -> pd.DataFrame:
    """Parse one Sensor Logger MQTT/HTTP message into the long schema.

    Tolerant by design: unknown sensors, entries without ``name``/``time`` and non-numeric
    values are skipped; missing fields are simply absent.
    """
    msg = decode_message(raw)
    payload = msg.get("payload")
    if not isinstance(payload, list):
        return _empty_long()

    times: list[int] = []
    sensors: list[str] = []
    fields: list[str] = []
    values: list[float] = []
    for entry in payload:
        if not isinstance(entry, Mapping):
            continue
        name = entry.get("name")
        if not isinstance(name, str):
            continue
        sensor = name.strip().lower()
        if sensor not in KNOWN_SENSORS:
            continue
        t = _to_time_ns(entry.get("time"))
        vals = entry.get("values")
        if t is None or not isinstance(vals, Mapping):
            continue
        for field, raw_value in vals.items():
            v = _to_float(raw_value)
            if v is None:
                continue
            times.append(t)
            sensors.append(sensor)
            fields.append(str(field))
            values.append(v)

    if not times:
        return _empty_long()
    return pd.DataFrame(
        {
            "time_ns": np.asarray(times, dtype="int64"),
            "sensor": pd.Series(sensors, dtype="object"),
            "field": pd.Series(fields, dtype="object"),
            "value": np.asarray(values, dtype="float64"),
        }
    )


def parse_messages(messages: Iterable[str | bytes | Mapping[str, Any]]) -> pd.DataFrame:
    """Parse many messages, skipping ones that are not valid JSON objects."""
    frames = []
    for raw in messages:
        try:
            frames.append(parse_message(raw))
        except ValueError as exc:
            log.warning("skipping message: %s", exc)
    frames = [f for f in frames if not f.empty]
    if not frames:
        return _empty_long()
    return pd.concat(frames, ignore_index=True)


# --------------------------------------------------------------------------- CSV export


@dataclass(frozen=True)
class ExportMetadata:
    """Selected fields from ``Metadata.csv``."""

    version: str | None
    device_name: str | None
    recording_epoch_ms: int | None
    recording_time: str | None
    timezone: str | None
    platform: str | None
    app_version: str | None
    device_id: str | None
    sensors: tuple[str, ...]


def _sensor_name_from_csv(filename: str) -> str:
    return Path(filename).stem.strip().lower()


def _parse_metadata(text: str) -> ExportMetadata | None:
    if not text.strip():
        return None
    df = pd.read_csv(io.StringIO(text), dtype=str, keep_default_na=False)
    if df.empty:
        return None
    row = {str(k).strip().lower(): str(v).strip() for k, v in df.iloc[0].items()}

    def get(key: str) -> str | None:
        return row.get(key) or None

    epoch = get("recording epoch time")
    return ExportMetadata(
        version=get("version"),
        device_name=get("device name"),
        recording_epoch_ms=int(float(epoch)) if epoch else None,
        recording_time=get("recording time"),
        timezone=get("recording timezone"),
        platform=get("platform"),
        app_version=get("appversion"),
        device_id=get("device id"),
        sensors=tuple(s for s in (get("sensors") or "").split("|") if s),
    )


def _read_sensor_csv(text: str, sensor: str, epoch_ms: int | None) -> pd.DataFrame:
    if not text.strip():
        return _empty_long()
    df = pd.read_csv(io.StringIO(text))
    if df.empty or "time" not in df.columns:
        return _empty_long()

    time_ns = _csv_time_ns(df, sensor, epoch_ms)
    value_cols = [c for c in df.columns if c not in _CSV_META_COLUMNS]
    wide = df[value_cols].apply(pd.to_numeric, errors="coerce")
    wide.insert(0, "time_ns", time_ns)
    wide = wide[wide["time_ns"].notna()]
    wide["time_ns"] = wide["time_ns"].astype("int64")

    long = wide.melt(id_vars="time_ns", var_name="field", value_name="value").dropna(
        subset=["value"]
    )
    long.insert(1, "sensor", sensor)
    out: pd.DataFrame = long[LONG_COLUMNS].reset_index(drop=True)
    return out


def _csv_time_ns(df: pd.DataFrame, sensor: str, epoch_ms: int | None) -> pd.Series:
    """Return exact int64 ns timestamps.

    If the file was opened and saved in a spreadsheet, ``time`` gets rounded to scientific
    notation (``1.79342E+18``) and is useless. In that case rebuild it from the recording
    epoch in ``Metadata.csv`` plus ``seconds_elapsed`` (accurate to well under 1 µs).
    """
    if pd.api.types.is_integer_dtype(df["time"]):
        return df["time"].astype("int64")
    if epoch_ms is not None and "seconds_elapsed" in df.columns:
        log.warning("%s: 'time' column lost precision; rebuilding from seconds_elapsed", sensor)
        elapsed = pd.to_numeric(df["seconds_elapsed"], errors="coerce")
        rebuilt = epoch_ms * 1_000_000 + (elapsed * 1e9).round()
        return rebuilt.astype("Int64").astype("float64")
    log.warning("%s: 'time' column lost precision and no epoch available", sensor)
    return pd.to_numeric(df["time"], errors="coerce").round()


def _iter_export_files(path: Path) -> Iterable[tuple[str, str]]:
    """Yield ``(basename, text)`` for every CSV in a folder or zip export."""
    if path.is_dir():
        for csv in sorted(path.glob("*.csv")):
            yield csv.name, csv.read_text(encoding="utf-8-sig")
    elif zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as zf:
            for info in sorted(zf.infolist(), key=lambda i: i.filename):
                name = Path(info.filename).name
                if info.is_dir() or not name.lower().endswith(".csv") or name.startswith("._"):
                    continue
                yield name, zf.read(info).decode("utf-8-sig")
    else:
        raise ValueError(f"{path} is neither a folder nor a zip file")


def read_export_metadata(path: str | Path) -> ExportMetadata | None:
    for name, text in _iter_export_files(Path(path)):
        if name.lower() == "metadata.csv":
            return _parse_metadata(text)
    return None


def read_export(path: str | Path) -> pd.DataFrame:
    """Read a Sensor Logger CSV export (folder or ``.zip``) into the long schema."""
    path = Path(path)
    files = dict(_iter_export_files(path))
    meta_text = next((t for n, t in files.items() if n.lower() == "metadata.csv"), "")
    meta = _parse_metadata(meta_text)
    epoch_ms = meta.recording_epoch_ms if meta else None

    frames = []
    for name, text in files.items():
        sensor = _sensor_name_from_csv(name)
        if sensor not in KNOWN_SENSORS:
            if sensor != "metadata":
                log.debug("ignoring %s", name)
            continue
        frame = _read_sensor_csv(text, sensor, epoch_ms)
        if not frame.empty:
            frames.append(frame)
    if not frames:
        return _empty_long()
    out = pd.concat(frames, ignore_index=True)
    return out.sort_values(["time_ns", "sensor", "field"], kind="stable").reset_index(drop=True)


# --------------------------------------------------------------------------- helpers


def pivot_sensor(long: pd.DataFrame, sensor: str) -> pd.DataFrame:
    """Return one sensor as a wide, time-sorted table: ``time_ns`` plus one column per field.

    Duplicate ``(time_ns, field)`` pairs (e.g. overlapping MQTT batches) keep the first value.
    """
    sub = long[long["sensor"] == sensor]
    if sub.empty:
        return pd.DataFrame({"time_ns": pd.Series(dtype="int64")})
    wide = sub.pivot_table(index="time_ns", columns="field", values="value", aggfunc="first")
    wide = wide.sort_index().reset_index()
    wide.columns.name = None
    return wide


def sensors_in(long: pd.DataFrame) -> list[str]:
    return sorted(long["sensor"].unique().tolist())
