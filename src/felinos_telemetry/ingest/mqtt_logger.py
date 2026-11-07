"""MQTT subscriber that writes every Sensor Logger message to one or more sinks.

The handling logic (:class:`IngestHandler`) is independent of paho so it can be tested
without a broker; :func:`run` wires it to a paho-mqtt v2 client over WebSocket + TLS with
automatic reconnection and exponential backoff.
"""

from __future__ import annotations

import logging
import os
import ssl
import threading
import time
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import paho.mqtt.client as mqtt
from paho.mqtt.enums import CallbackAPIVersion

from felinos_telemetry.ingest.sinks import Sink
from felinos_telemetry.io.ndjson import StreamRecord

log = logging.getLogger(__name__)

Transport = Literal["websockets", "tcp"]


@dataclass(frozen=True)
class MqttSettings:
    host: str
    username: str = ""
    password: str = ""
    port: int = 8884
    transport: Transport = "websockets"
    ws_path: str = "/mqtt"
    topic: str = "felinos/#"
    tls: bool = True
    client_id: str = field(default_factory=lambda: f"felinos-ingest-{uuid.uuid4().hex[:8]}")

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> MqttSettings:
        env = dict(os.environ) if env is None else env
        host = env.get("MQTT_HOST", "").strip()
        if not host:
            raise ValueError("MQTT_HOST is not set (copy .env.example to .env and fill it in)")
        transport = env.get("MQTT_TRANSPORT", "websockets").strip() or "websockets"
        if transport not in ("websockets", "tcp"):
            raise ValueError("MQTT_TRANSPORT must be 'websockets' or 'tcp'")
        return cls(
            host=host,
            username=env.get("MQTT_USERNAME", ""),
            password=env.get("MQTT_PASSWORD", ""),
            port=int(env.get("MQTT_PORT", "8884") or 8884),
            transport=transport,  # type: ignore[arg-type]
            ws_path=env.get("MQTT_WS_PATH", "/mqtt") or "/mqtt",
            topic=env.get("MQTT_TOPIC", "felinos/#") or "felinos/#",
            tls=env.get("MQTT_TLS", "true").lower() not in ("0", "false", "no"),
        )


@dataclass
class SessionStats:
    messages: int = 0
    last_message_id: int | None = None
    missing_ids: int = 0
    last_received_ns: int = 0
    last_sample_ns: int | None = None


@dataclass
class IngestStats:
    """Running counters used for the console status line."""

    total: int = 0
    invalid: int = 0
    window_count: int = 0
    window_start: float = field(default_factory=time.monotonic)
    sessions: dict[str, SessionStats] = field(default_factory=dict)
    last_session: str | None = None
    last_received_ns: int | None = None

    def record(self, rec: StreamRecord) -> None:
        self.total += 1
        self.window_count += 1
        self.last_received_ns = rec.received_at
        if rec.message is None:
            self.invalid += 1
            return
        sid = rec.session_id or "unknown"
        self.last_session = sid
        s = self.sessions.setdefault(sid, SessionStats())
        s.messages += 1
        s.last_received_ns = rec.received_at
        mid = rec.message.get("messageId")
        if isinstance(mid, int) and not isinstance(mid, bool):
            if s.last_message_id is not None and mid > s.last_message_id + 1:
                s.missing_ids += mid - s.last_message_id - 1
            s.last_message_id = mid
        times = [
            e["time"]
            for e in rec.message.get("payload") or []
            if isinstance(e, dict) and isinstance(e.get("time"), int)
        ]
        if times:
            s.last_sample_ns = max(times)

    def status_line(self, now_ns: int | None = None) -> str:
        now_ns = time.time_ns() if now_ns is None else now_ns
        elapsed = max(time.monotonic() - self.window_start, 1e-9)
        rate = self.window_count / elapsed
        self.window_count = 0
        self.window_start = time.monotonic()
        if self.last_received_ns is None:
            return f"waiting for messages | {rate:.1f} msg/s"
        ago = (now_ns - self.last_received_ns) / 1e9
        parts = [f"{rate:.1f} msg/s", f"last {ago:.1f} s ago", f"total {self.total}"]
        if self.last_session is not None:
            s = self.sessions[self.last_session]
            parts.append(f"session {self.last_session[:8]}")
            parts.append(f"missing msgs {s.missing_ids}")
            if s.last_sample_ns is not None:
                lag = (s.last_received_ns - s.last_sample_ns) / 1e9
                parts.append(f"lag ~{lag:.1f} s")
        if self.invalid:
            parts.append(f"invalid {self.invalid}")
        return " | ".join(parts)


class IngestHandler:
    """Turns raw MQTT payloads into records and fans them out to sinks."""

    def __init__(self, sinks: Sequence[Sink], clock: Callable[[], int] = time.time_ns) -> None:
        self.sinks = list(sinks)
        self.clock = clock
        self.stats = IngestStats()
        self._lock = threading.Lock()

    def handle(self, topic: str, payload: bytes) -> StreamRecord:
        rec = StreamRecord.from_payload(topic, payload, received_at=self.clock())
        with self._lock:
            for sink in self.sinks:
                try:
                    sink.write(rec)
                except Exception:
                    log.exception("sink %s failed", type(sink).__name__)
            self.stats.record(rec)
        return rec

    def close(self) -> None:
        for sink in self.sinks:
            sink.close()


def build_client(settings: MqttSettings, handler: IngestHandler) -> mqtt.Client:
    """Create a configured (not yet connected) paho client."""
    client = mqtt.Client(
        callback_api_version=CallbackAPIVersion.VERSION2,
        client_id=settings.client_id,
        transport=settings.transport,
        protocol=mqtt.MQTTv311,
    )
    if settings.transport == "websockets":
        client.ws_set_options(path=settings.ws_path)
    if settings.tls:
        client.tls_set(cert_reqs=ssl.CERT_REQUIRED, tls_version=ssl.PROTOCOL_TLS_CLIENT)
    if settings.username:
        client.username_pw_set(settings.username, settings.password)
    client.reconnect_delay_set(min_delay=1, max_delay=30)

    def on_connect(
        client: mqtt.Client, userdata: Any, flags: Any, reason_code: Any, properties: Any
    ) -> None:
        if reason_code.is_failure:
            log.error("connection refused: %s", reason_code)
            return
        log.info("connected to %s, subscribing to %s", settings.host, settings.topic)
        client.subscribe(settings.topic, qos=1)

    def on_disconnect(
        client: mqtt.Client, userdata: Any, flags: Any, reason_code: Any, properties: Any
    ) -> None:
        if reason_code.is_failure:
            log.warning("connection lost (%s); reconnecting with backoff", reason_code)
        else:
            log.info("disconnected")

    def on_message(client: mqtt.Client, userdata: Any, msg: mqtt.MQTTMessage) -> None:
        handler.handle(msg.topic, bytes(msg.payload))

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    return client


def run(
    settings: MqttSettings,
    sinks: Sequence[Sink],
    stats_interval: float = 5.0,
    stop: threading.Event | None = None,
    echo: Callable[[str], None] = print,
) -> IngestHandler:
    """Connect and log until ``stop`` is set or Ctrl+C. Returns the handler (for its stats)."""
    stop = stop or threading.Event()
    handler = IngestHandler(sinks)
    client = build_client(settings, handler)
    client.connect_async(settings.host, settings.port, keepalive=30)
    client.loop_start()
    try:
        while not stop.wait(stats_interval):
            echo(handler.stats.status_line())
    except KeyboardInterrupt:
        echo("stopping...")
    finally:
        client.disconnect()
        client.loop_stop()
        handler.close()
    return handler


def default_data_dir(env: dict[str, str] | None = None) -> Path:
    env = dict(os.environ) if env is None else env
    return Path(env.get("FELINOS_DATA_DIR") or "data/stream")
