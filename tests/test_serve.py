import threading
import urllib.request
from pathlib import Path

from felinos_telemetry.serve import make_server

DASHBOARD = Path(__file__).resolve().parents[1] / "dashboard"


def test_dashboard_server_disables_caching() -> None:
    server = make_server(DASHBOARD, port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_address[1]
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/app.js") as resp:
            assert resp.status == 200
            assert resp.headers["Cache-Control"] == "no-cache"
            assert b"RunLog" in resp.read()
    finally:
        server.shutdown()
        server.server_close()
