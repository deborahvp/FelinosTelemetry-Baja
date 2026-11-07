import json
import threading
from pathlib import Path
from typing import Any

import paho.mqtt.client as mqtt
import pytest

from felinos_telemetry.ingest import mqtt_logger
from felinos_telemetry.ingest.mqtt_logger import (
    IngestHandler,
    MqttSettings,
    build_client,
    default_data_dir,
)
from felinos_telemetry.ingest.sinks import NdjsonSink, safe_filename
from felinos_telemetry.io.ndjson import StreamRecord, iter_records


def _msg(text: str, message_id: int, session: str = "sess-A") -> bytes:
    obj = json.loads(text)
    obj["messageId"] = message_id
    obj["sessionId"] = session
    return json.dumps(obj).encode()


def test_ndjson_sink_rotates_by_session(stream_message_text: str, tmp_path: Path) -> None:
    with NdjsonSink(tmp_path) as sink:
        handler = IngestHandler([sink], clock=lambda: 42)
        handler.handle("felinos/d/sess-A", _msg(stream_message_text, 1, "sess-A"))
        handler.handle("felinos/d/sess-B", _msg(stream_message_text, 1, "sess-B"))
        handler.handle("felinos/d/sess-A", _msg(stream_message_text, 2, "sess-A"))
        # flushed per line: readable while still open
        assert len(list(iter_records(tmp_path / "sess-A.ndjson"))) == 2
    assert sorted(p.name for p in tmp_path.iterdir()) == ["sess-A.ndjson", "sess-B.ndjson"]
    recs = list(iter_records(tmp_path / "sess-A.ndjson"))
    assert [r.received_at for r in recs] == [42, 42]


def test_sink_appends_after_restart(stream_message_text: str, tmp_path: Path) -> None:
    for i in range(2):
        with NdjsonSink(tmp_path) as sink:
            sink.write(StreamRecord.from_payload("t", _msg(stream_message_text, i), 1))
    assert len(list(iter_records(tmp_path / "sess-A.ndjson"))) == 2


def test_invalid_payload_goes_to_unknown(tmp_path: Path) -> None:
    with NdjsonSink(tmp_path) as sink:
        handler = IngestHandler([sink])
        handler.handle("x", b"garbage")
    assert handler.stats.invalid == 1
    assert (tmp_path / "unknown.ndjson").exists()


@pytest.mark.parametrize(
    ("name", "expected"),
    [("abc-123", "abc-123"), ("../../etc/passwd", "etc_passwd"), ("", "unknown"), ("a b", "a_b")],
)
def test_safe_filename(name: str, expected: str) -> None:
    assert safe_filename(name) == expected


def test_stats_detect_missing_messages(stream_message_text: str) -> None:
    handler = IngestHandler([], clock=lambda: 1794032706_500_000_000)
    for mid in (1, 2, 5, 6):
        handler.handle("felinos/d/sess-A", _msg(stream_message_text, mid))
    s = handler.stats.sessions["sess-A"]
    assert s.messages == 4
    assert s.missing_ids == 2
    line = handler.stats.status_line(now_ns=1794032707_500_000_000)
    assert "missing msgs 2" in line
    assert "last 1.0 s ago" in line
    assert "lag ~0.4 s" in line  # newest sample 1794032706.067… vs received 1794032706.5


def test_status_line_before_messages() -> None:
    assert IngestHandler([]).stats.status_line().startswith("waiting")


class _BrokenSink:
    def write(self, record: StreamRecord) -> None:
        raise OSError("disk full")

    def close(self) -> None:
        pass


def test_failing_sink_does_not_stop_others(stream_message_text: str, tmp_path: Path) -> None:
    good = NdjsonSink(tmp_path)
    handler = IngestHandler([_BrokenSink(), good])
    handler.handle("t", _msg(stream_message_text, 1))
    handler.close()
    assert len(list(iter_records(tmp_path / "sess-A.ndjson"))) == 1


def test_settings_from_env() -> None:
    s = MqttSettings.from_env(
        {"MQTT_HOST": "abc.s1.eu.hivemq.cloud", "MQTT_USERNAME": "u", "MQTT_PASSWORD": "p"}
    )
    assert (s.port, s.transport, s.ws_path, s.topic, s.tls) == (
        8884,
        "websockets",
        "/mqtt",
        "felinos/#",
        True,
    )
    t = MqttSettings.from_env({"MQTT_HOST": "h", "MQTT_TRANSPORT": "tcp", "MQTT_PORT": "8883"})
    assert (t.transport, t.port) == ("tcp", 8883)


@pytest.mark.parametrize("env", [{}, {"MQTT_HOST": "h", "MQTT_TRANSPORT": "udp"}])
def test_settings_invalid(env: dict[str, str]) -> None:
    with pytest.raises(ValueError, match="MQTT_"):
        MqttSettings.from_env(env)


def test_default_data_dir() -> None:
    assert default_data_dir({}) == Path("data/stream")
    assert default_data_dir({"FELINOS_DATA_DIR": "x"}) == Path("x")


def test_build_client_wires_callbacks(stream_message_text: str, tmp_path: Path) -> None:
    handler = IngestHandler([NdjsonSink(tmp_path)])
    settings = MqttSettings(host="h", username="u", password="p")
    client = build_client(settings, handler)

    subscribed: list[tuple[str, int]] = []
    client.subscribe = lambda topic, qos=0, **kw: subscribed.append((topic, qos))  # type: ignore[assignment,method-assign]

    class _RC:
        is_failure = False

    client.on_connect(client, None, None, _RC(), None)  # type: ignore[misc]
    assert subscribed == [("felinos/#", 1)]

    msg = mqtt.MQTTMessage(topic=b"felinos/d/sess-A")
    msg.payload = _msg(stream_message_text, 1)
    client.on_message(client, None, msg)  # type: ignore[misc]
    assert handler.stats.total == 1
    handler.close()


def test_run_loop_stops(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    class _FakeClient:
        def connect_async(self, *a: Any, **k: Any) -> None:
            calls.append("connect")

        def loop_start(self) -> None:
            calls.append("loop_start")

        def disconnect(self) -> None:
            calls.append("disconnect")

        def loop_stop(self) -> None:
            calls.append("loop_stop")

    monkeypatch.setattr(mqtt_logger, "build_client", lambda s, h: _FakeClient())
    stop = threading.Event()
    lines: list[str] = []

    def echo(line: str) -> None:
        lines.append(line)
        stop.set()

    mqtt_logger.run(MqttSettings(host="h"), [], stats_interval=0.01, stop=stop, echo=echo)
    assert calls == ["connect", "loop_start", "disconnect", "loop_stop"]
    assert lines[0].startswith("waiting")
