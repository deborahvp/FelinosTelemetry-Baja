"""Turn a recording back into Sensor Logger MQTT messages.

Used to rehearse without the car: write an NDJSON file for the dashboard's ``?demo=`` mode, or
publish to the broker in real time so the whole chain (phone → broker → ingest + dashboard)
can be tested from a laptop.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Callable, Iterator, Sequence
from typing import Any

import pandas as pd

from felinos_telemetry.io.ndjson import StreamRecord

#: Sensors the live dashboard uses.
DASHBOARD_SENSORS = ("accelerometer", "gravity", "gyroscope", "location", "barometer", "battery")


def export_to_messages(
    long: pd.DataFrame,
    *,
    session_id: str | None = None,
    device_id: str = "simulator",
    batch_s: float = 1.0,
    sensors: Sequence[str] | None = DASHBOARD_SENSORS,
) -> Iterator[dict[str, Any]]:
    """Yield messages shaped like Sensor Logger's, one per ``batch_s`` of data."""
    session_id = session_id or str(uuid.uuid4())
    df = long if sensors is None else long[long["sensor"].isin(list(sensors))]
    if df.empty:
        return
    wide = df.pivot_table(
        index=["time_ns", "sensor"], columns="field", values="value", aggfunc="first"
    ).reset_index()
    wide = wide.sort_values(["time_ns", "sensor"], kind="stable")
    t0 = int(wide["time_ns"].iloc[0])
    batch_ns = int(batch_s * 1e9)
    fields = [c for c in wide.columns if c not in ("time_ns", "sensor")]
    for message_id, (_, group) in enumerate(
        wide.groupby((wide["time_ns"] - t0) // batch_ns, sort=True), start=1
    ):
        payload = []
        for rec in group.to_dict("records"):
            values = {f: float(rec[f]) for f in fields if pd.notna(rec[f])}
            payload.append({"name": rec["sensor"], "time": int(rec["time_ns"]), "values": values})
        yield {
            "messageId": message_id,
            "sessionId": session_id,
            "deviceId": device_id,
            "payload": payload,
        }


def batch_end_ns(message: dict[str, Any]) -> int:
    return max(int(e["time"]) for e in message["payload"])


def to_records(messages: Sequence[dict[str, Any]], topic_prefix: str) -> list[StreamRecord]:
    """Records as the ingest service would have written them (received = end of batch)."""
    return [
        StreamRecord(
            received_at=batch_end_ns(m) + 50_000_000,
            topic=f"{topic_prefix}/{m['deviceId']}/{m['sessionId']}",
            message=m,
        )
        for m in messages
    ]


def pace(
    messages: Sequence[dict[str, Any]],
    send: Callable[[dict[str, Any]], None],
    speed: float = 1.0,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> None:
    """Call ``send`` for each message at its original rhythm (scaled by ``speed``)."""
    if not messages:
        return
    t_first = batch_end_ns(messages[0])
    start = clock()
    for m in messages:
        due = (batch_end_ns(m) - t_first) / 1e9 / speed
        wait = due - (clock() - start)
        if wait > 0:
            sleep(wait)
        send(m)
