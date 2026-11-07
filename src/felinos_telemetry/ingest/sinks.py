"""Storage back-ends for the ingest service.

A :class:`Sink` receives every :class:`StreamRecord`. Today: :class:`NdjsonSink`. Later a
``PostgresSink`` can implement the same interface without touching the MQTT code.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import IO, Protocol

from felinos_telemetry.io.ndjson import StreamRecord

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


class Sink(Protocol):
    def write(self, record: StreamRecord) -> None: ...

    def close(self) -> None: ...


def safe_filename(name: str) -> str:
    cleaned = _UNSAFE.sub("_", name).strip("._")
    return cleaned[:120] or "unknown"


class NdjsonSink:
    """Append each record to ``<base_dir>/<sessionId>.ndjson``, flushing every line.

    A new Sensor Logger session (new ``sessionId``) starts a new file automatically; restarting
    the logger appends to the existing file of that session.
    """

    def __init__(self, base_dir: str | Path) -> None:
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self._files: dict[str, IO[str]] = {}

    def path_for(self, session_id: str | None) -> Path:
        return self.base_dir / f"{safe_filename(session_id or 'unknown')}.ndjson"

    def write(self, record: StreamRecord) -> None:
        key = record.session_id or "unknown"
        fh = self._files.get(key)
        if fh is None:
            fh = self.path_for(key).open("a", encoding="utf-8", newline="\n")
            self._files[key] = fh
        fh.write(record.to_json() + "\n")
        fh.flush()

    @property
    def open_sessions(self) -> list[str]:
        return list(self._files)

    def close(self) -> None:
        for fh in self._files.values():
            fh.close()
        self._files.clear()

    def __enter__(self) -> NdjsonSink:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
