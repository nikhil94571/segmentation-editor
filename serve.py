"""Local QA viewer + segmentation editor.  python serve.py
    QA viewer   http://127.0.0.1:8765
    Editor      http://127.0.0.1:8765/editor

Serves viewer/index.html and the images in out/, and saves each Approve/Decline + comment to
qa/decisions.json (one entry per case, overwritten when you change your mind).
"""
import json
import os
import re
import tempfile
import uuid
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import editor_backend as eb

ROOT = Path(__file__).resolve().parent
DECISIONS = ROOT / "qa" / "decisions.json"
PORT = int(os.environ.get("PORT", 8765))


def load_decisions():
    return json.loads(DECISIONS.read_text()) if DECISIONS.exists() else {}


def save_decisions(d):
    DECISIONS.parent.mkdir(exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=DECISIONS.parent, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(d, f, indent=1)
    os.replace(tmp, DECISIONS)  # atomic: never leaves a half-written file


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):                              # always serve the current files (no stale editor code)
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", 0)))

    def _editor(self, fn, *a):
        """Run an editor backend call; user-facing problems come back as {error} with a 400."""
        try:
            return self._json(fn(*a))
        except (ValueError, FileNotFoundError, KeyError) as e:
            return self._json({"error": str(e)}, 400)

    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        path = url.path
        if path in ("/", "/index.html"):
            self.path = "/viewer/index.html"
        elif path == "/editor":
            self.path = "/viewer/editor.html"
        elif path == "/api/cases":
            cases = json.loads((ROOT / "out" / "cases.json").read_text())
            return self._json({"cases": cases, "decisions": load_decisions()})
        elif path == "/api/editor/libraries":
            return self._editor(eb.list_libraries)
        elif path == "/api/editor/library/preview":
            try:
                data = eb.case_preview(q.get("id", [""])[0], int(q.get("index", ["0"])[0]))
            except (ValueError, FileNotFoundError, KeyError) as e:
                return self._json({"error": str(e)}, 400)
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            return self.wfile.write(data)
        elif path == "/api/editor/library":
            return self._editor(eb.get_library, q.get("id", [""])[0])
        elif path == "/api/editor/session":
            return self._editor(eb.load_session, q.get("id", [""])[0])
        elif path == "/api/editor/score.png":
            try:
                self.path = "/" + str(eb.score_png(q.get("id", [""])[0]).relative_to(ROOT))
            except (ValueError, FileNotFoundError):
                return self.send_error(404)
        elif path == "/api/editor/rethreshold":
            return self._editor(eb.rethreshold, q.get("id", [""])[0], int(q.get("label", ["0"])[0]),
                                float(q.get("t", ["0.5"])[0]))
        elif not path.startswith(("/out/", "/viewer/", "/sessions/")) or "/_uploads/" in path:
            return self.send_error(404)
        return super().do_GET()

    def do_POST(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        if url.path == "/api/editor/library/put":       # one file of a library being imported (raw body)
            return self._editor(eb.library_put, q.get("id", [""])[0], q.get("path", [""])[0], self._body())
        if url.path == "/api/editor/upload":            # raw file body -> a token for the import call
            name = re.sub(r"[^a-zA-Z0-9._-]+", "_", q.get("name", ["file"])[0])[-80:]
            eb.UPLOADS.mkdir(parents=True, exist_ok=True)
            token = f"{uuid.uuid4().hex[:12]}__{name}"
            (eb.UPLOADS / token).write_bytes(self._body())
            return self._json({"token": token})
        body = json.loads(self._body() or b"{}")
        if url.path == "/api/editor/import":
            files = {}
            for role, token in (body.get("files") or {}).items():
                f = eb.UPLOADS / Path(str(token)).name
                if f.exists():
                    files[role] = f
            return self._editor(lambda: eb.add_single(eb.import_session(
                body.get("route"), files, body.get("name"), float(body.get("threshold", 0.5)))))
        if url.path == "/api/editor/library/begin":
            return self._editor(eb.library_begin, body.get("name", ""))
        if url.path == "/api/editor/library/finish":
            return self._editor(eb.library_finish, body.get("id", ""))
        if url.path == "/api/editor/library/rename":
            return self._editor(eb.rename_library, body.get("id", ""), body.get("name", ""))
        if url.path == "/api/editor/library/delete":
            return self._editor(eb.delete_library, body.get("id", ""))
        if url.path == "/api/editor/library/open":
            return self._editor(eb.open_library_case, body.get("id", ""), int(body.get("index", 0)))
        if url.path == "/api/editor/selftest":            # results of viewer/editor/selftest.js
            (ROOT / "scratch").mkdir(exist_ok=True)
            (ROOT / "scratch" / "selftest.json").write_text(json.dumps(body, indent=1))
            return self._json({"ok": True})
        if url.path == "/api/editor/save":
            return self._editor(eb.save_state, body.get("id", ""), body.get("state"))
        if url.path == "/api/editor/export":
            return self._editor(eb.export, body.get("id", ""), body.get("regions", []), body.get("stem"))
        if url.path != "/api/decision":
            return self.send_error(404)
        case, status, comment = body.get("case"), body.get("status"), body.get("comment", "")
        if not isinstance(case, str) or status not in ("approved", "declined", None):
            return self._json({"error": "bad request"}, 400)
        d = load_decisions()
        d[case] = {"status": status, "comment": comment, "updated": datetime.now().isoformat(timespec="seconds")}
        save_decisions(d)
        return self._json({"ok": True, "saved": d[case]})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"QA viewer: http://127.0.0.1:{PORT}   Editor: http://127.0.0.1:{PORT}/editor   (Ctrl+C to stop)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
