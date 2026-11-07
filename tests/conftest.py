from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def export_dir() -> Path:
    return FIXTURES / "sample_export"


@pytest.fixture
def stream_message_text() -> str:
    return (FIXTURES / "stream_message_sample.json").read_text(encoding="utf-8")
