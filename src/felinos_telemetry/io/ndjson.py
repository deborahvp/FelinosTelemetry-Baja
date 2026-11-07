"""NDJSON stream backups: one JSON object per line, one file per Sensor Logger session.

Each line is a :class:`StreamRecord`::

    {"received_at": 1794032706100000000, "topic": "felinos/<deviceId>/<sessionId>",
     "message": {...raw Sensor Logger message...}}

If a payload was not valid JSON it is kept as text under ``"raw"`` with ``"message": null``
so nothing received is ever lost.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pandas as pd

from felinos_telemetry.io.sensorlogger import parse_messages

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class StreamRecord:
    received_at: int  # laptop clock, UTC ns
    topic: str
    message: dict[str, Any] | None
    raw: str | None = field(default=None)

    @classmethod
    def from_payload(cls, topic: str, payload: bytes, received_at: int) -> StreamRecord:
        try:
            obj = json.loads(payload)
        except (json.JSONDecodeError, UnicodeDecodeError):
            obj = None
        if isinstance(obj, dict):
            return cls(received_at=received_at, topic=topic, message=obj)
        return cls(
            received_at=received_at,
            topic=topic,
            message=None,
            raw=payload.decode("utf-8", errors="replace"),
        )

    @property
    def session_id(self) -> str | None:
        if self.message is not None and self.message.get("sessionId"):
            return str(self.message["sessionId"])
        parts = self.topic.split("/")
        return parts[2] if len(parts) >= 3 and parts[2] else None

    def to_json(self) -> str:
        obj: dict[str, Any] = {
            "received_at": self.received_at,
            "topic": self.topic,
            "message": self.message,
        }
        if self.raw is not None:
            obj["raw"] = self.raw
        return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)

    @classmethod
    def from_json(cls, line: str) -> StreamRecord:
        obj = json.loads(line)
        if not isinstance(obj, dict) or "received_at" not in obj:
            raise ValueError("not a stream record")
        message = obj.get("message")
        return cls(
            received_at=int(obj["received_at"]),
            topic=str(obj.get("topic", "")),
            message=message if isinstance(message, dict) else None,
            raw=obj.get("raw"),
        )


def iter_records(path: str | Path) -> Iterator[StreamRecord]:
    """Yield records, skipping blank or corrupt lines (e.g. a line cut by a power loss)."""
    with Path(path).open(encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, start=1):
            if not line.strip():
                continue
            try:
                yield StreamRecord.from_json(line)
            except (ValueError, TypeError) as exc:
                log.warning("%s:%d: skipping corrupt line (%s)", path, lineno, exc)


def write_records(path: str | Path, records: Iterable[StreamRecord]) -> None:
    with Path(path).open("a", encoding="utf-8", newline="\n") as fh:
        for rec in records:
            fh.write(rec.to_json() + "\n")


def read_stream(path: str | Path) -> pd.DataFrame:
    """Load an NDJSON backup into the long schema of :mod:`felinos_telemetry.io.sensorlogger`."""
    return parse_messages(r.message for r in iter_records(path) if r.message is not None)
