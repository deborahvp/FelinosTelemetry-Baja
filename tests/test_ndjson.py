from pathlib import Path

from felinos_telemetry.io.ndjson import StreamRecord, iter_records, read_stream, write_records
from felinos_telemetry.io.sensorlogger import parse_message, pivot_sensor

TOPIC = "felinos/02a84114/c886864a-9bf3-4f12-bbaa-43443e3f1229"


def test_record_roundtrip(stream_message_text: str, tmp_path: Path) -> None:
    rec = StreamRecord.from_payload(TOPIC, stream_message_text.encode(), received_at=123)
    assert rec.session_id == "c886864a-9bf3-4f12-bbaa-43443e3f1229"
    path = tmp_path / "s.ndjson"
    write_records(path, [rec, rec])
    back = list(iter_records(path))
    assert back == [rec, rec]
    # big ns timestamps survive JSON exactly
    assert back[0].message is not None
    assert back[0].message["payload"][0]["time"] == 1794032705001959400


def test_invalid_payload_is_kept_raw(tmp_path: Path) -> None:
    rec = StreamRecord.from_payload("felinos/dev/sess", b"not json \xff", received_at=1)
    assert rec.message is None
    assert rec.raw is not None
    assert rec.raw.startswith("not json")
    assert rec.session_id == "sess"  # falls back to the topic
    path = tmp_path / "x.ndjson"
    write_records(path, [rec])
    assert list(iter_records(path)) == [rec]


def test_session_id_unknown() -> None:
    assert StreamRecord.from_payload("other", b"[]", received_at=1).session_id is None


def test_corrupt_lines_are_skipped(stream_message_text: str, tmp_path: Path) -> None:
    rec = StreamRecord.from_payload(TOPIC, stream_message_text.encode(), received_at=5)
    path = tmp_path / "s.ndjson"
    path.write_text(
        rec.to_json() + "\n\n" + '{"no": "received_at"}\n' + rec.to_json()[:50],
        encoding="utf-8",
    )
    assert list(iter_records(path)) == [rec]


def test_read_stream_matches_parser(stream_message_text: str, tmp_path: Path) -> None:
    rec = StreamRecord.from_payload(TOPIC, stream_message_text.encode(), received_at=5)
    path = tmp_path / "s.ndjson"
    write_records(path, [rec])
    df = read_stream(path)
    expected = parse_message(stream_message_text)
    assert len(df) == len(expected)
    assert len(pivot_sensor(df, "gyroscope")) == 107
