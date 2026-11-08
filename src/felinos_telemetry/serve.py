"""Tiny static server for the dashboard (``felinos dashboard``).

Sends ``Cache-Control: no-cache`` so the browser always revalidates: after ``git pull`` the
dashboard picks up new JavaScript instead of running a stale cached copy.
"""

from __future__ import annotations

import functools
import http.server
from pathlib import Path
from typing import Any


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        pass  # keep the terminal quiet


def make_server(
    folder: Path, port: int, host: str = "127.0.0.1"
) -> http.server.ThreadingHTTPServer:
    handler = functools.partial(NoCacheHandler, directory=str(folder))
    return http.server.ThreadingHTTPServer((host, port), handler)
