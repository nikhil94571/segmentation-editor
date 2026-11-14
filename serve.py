"""Local QA viewer + segmentation editor.  python serve.py
    QA viewer   http://127.0.0.1:8765
    Editor      http://127.0.0.1:8765/editor

Serves viewer/index.html and the images in out/, and saves each Approve/Decline + comment to
qa/decisions.json (one entry per case, overwritten when you change your mind).
"""
import json
import os
import posixpath
import re
import tempfile
import uuid
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, parse_qs, urlparse

import editor_backend as eb

ROOT = Path(__file__).resolve().parent
DECISIONS = ROOT / "qa" / "decisions.json"
PORT = int(os.environ.get("PORT", 8765))
HOST = os.environ.get("HOST") or ("0.0.0.0" if eb.HOSTED else "127.0.0.1")
MAX_BODY = 300 * 1024 * 1024                                    # largest single upload accepted


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

    def end_headers(self):
        # always serve the current page and code; the tutorial clips never change, so let the browser keep them
        clip = self.path.startswith("/viewer/editor/tutorial/")
        self.send_header("Cache-Control", "public, max-age=86400" if clip else "no-store")
        if getattr(self, "_new_ws", None):
            self.send_header("Set-Cookie", f"ws={self._new_ws}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax")
            self._new_ws = None
        super().end_headers()

    def _enter(self):
        """Hosted: every browser works in its own workspace, named by a cookie."""
        self._new_ws = None
        if not eb.HOSTED:
            return eb.set_workspace("")
        m = re.search(r"(?:^|;\s*)ws=([0-9a-f]{32})(?:;|$)", self.headers.get("Cookie", ""))
        ws = m.group(1) if m else uuid.uuid4().hex
        if not m:
            self._new_ws = ws
        eb.set_workspace(ws)

    def _send(self, f, ctype, download=None):
        data = Path(f).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if download:
            self.send_header("Content-Disposition", f'attachment; filename="{download}"')
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        if n > MAX_BODY:
            raise ValueError("That file is too large for this server.")
        return self.rfile.read(n)

    def _editor(self, fn, *a):
        """Run an editor backend call; user-facing problems come back as {error} with a 400."""
        try:
            return self._json(fn(*a))
        except (ValueError, FileNotFoundError, KeyError) as e:
            return self._json({"error": str(e)}, 400)

    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        path = posixpath.normpath(unquote(url.path))             # "/viewer/../x" must not get past the folder check below
        self._enter()
        if path == "/healthz":
            return self._json({"ok": True})
        if eb.HOSTED and (path in ("/", "/index.html", "/api/cases") or path.startswith(("/out/", "/exports/"))):
            path = "/editor" if path in ("/", "/index.html") else "/404"      # the link opens the editor; no QA viewer
        if path in ("/", "/index.html"):
            self.path = "/viewer/index.html"
        elif path == "/editor":
            self.path = "/viewer/editor.html"
        elif path == "/api/cases":
            cases = json.loads((ROOT / "out" / "cases.json").read_text())
            return self._json({"cases": cases, "decisions": load_decisions()})
        elif path == "/api/editor/progress":
            return self._json(eb.progress(q.get("job", [""])[0]))
        elif path == "/api/editor/settings":
            return self._editor(eb.get_settings)
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
                return self._send(eb.score_png(q.get("id", [""])[0]), "image/png")
            except (ValueError, FileNotFoundError):
                return self.send_error(404)
        elif path == "/api/editor/tissue.jpg":
            try:
                return self._send(eb.tissue_view(q.get("id", [""])[0]), "image/jpeg")
            except (ValueError, FileNotFoundError):
                return self.send_error(404)
        elif path == "/api/editor/download":
            try:
                f = eb.download_path(q.get("name", [""])[0])
            except ValueError:
                return self.send_error(404)
            return self._send(f, "application/zip", f.name)
        elif path == "/api/editor/rethreshold":
            return self._editor(eb.rethreshold, q.get("id", [""])[0], int(q.get("label", ["0"])[0]),
                                float(q.get("t", ["0.5"])[0]))
        elif not path.startswith(("/out/", "/viewer/", "/exports/")) or "/." in path:
            return self.send_error(404)
        else:
            self.path = path
        if path.endswith(".mp4") and self.headers.get("Range"):
            return self._ranged(path)
        return super().do_GET()

    def _ranged(self, path):
        """Part of a video file (Safari will not play a video unless byte ranges work)."""
        f = (ROOT / unquote(path).lstrip("/")).resolve()
        m = re.match(r"bytes=(\d*)-(\d*)$", self.headers["Range"].strip())
        if not m or ROOT not in f.parents or not f.is_file() or not (m.group(1) or m.group(2)):
            return self.send_error(404)
        size = f.stat().st_size
        if m.group(1):
            a, b = int(m.group(1)), min(size - 1, int(m.group(2))) if m.group(2) else size - 1
        else:
            a, b = max(0, size - int(m.group(2))), size - 1
        if a > b:
            return self.send_error(416)
        self.send_response(206)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {a}-{b}/{size}")
        self.send_header("Content-Length", str(b - a + 1))
        self.end_headers()
        with open(f, "rb") as fh:
            fh.seek(a)
            self.wfile.write(fh.read(b - a + 1))

    def do_POST(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        self._enter()
        try:
            return self._post(url, q)
        except ValueError as e:                                  # e.g. an upload over the size limit
            return self._json({"error": str(e)}, 413)

    def _post(self, url, q):
        if eb.HOSTED and url.path in ("/api/editor/selftest", "/api/editor/choose-folder", "/api/editor/reveal", "/api/decision"):
            return self.send_error(404)
        if url.path == "/api/editor/library/put":       # one file of a library being imported (raw body)
            return self._editor(eb.library_put, q.get("id", [""])[0], q.get("path", [""])[0], self._body())
        if url.path == "/api/editor/upload":            # raw file body -> a token for the import call
            name = re.sub(r"[^a-zA-Z0-9._-]+", "_", q.get("name", ["file"])[0])[-80:]
            eb.uploads().mkdir(parents=True, exist_ok=True)
            token = f"{uuid.uuid4().hex[:12]}__{name}"
            (eb.uploads() / token).write_bytes(self._body())
            return self._json({"token": token})
        body = json.loads(self._body() or b"{}")
        if url.path == "/api/editor/import":
            files = {}
            for role, token in (body.get("files") or {}).items():
                f = eb.uploads() / Path(str(token)).name
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
        if url.path == "/api/editor/library/done":
            return self._editor(eb.set_done, body.get("id", ""), int(body.get("index", 0)), bool(body.get("done")))
        if url.path == "/api/editor/library/export":
            return self._editor(eb.export_library, body.get("id", ""), None if eb.HOSTED else body.get("dest"),
                                body.get("formats"), body.get("job"))
        if url.path == "/api/editor/library/open":
            return self._editor(eb.open_library_case, body.get("id", ""), int(body.get("index", 0)))
        if url.path == "/api/editor/selftest":            # results of viewer/editor/selftest.js
            (ROOT / "scratch").mkdir(exist_ok=True)
            (ROOT / "scratch" / "selftest.json").write_text(json.dumps(body, indent=1))
            return self._json({"ok": True})
        if url.path == "/api/editor/save":
            return self._editor(eb.save_state, body.get("id", ""), body.get("state"))
        if url.path == "/api/editor/export":
            return self._editor(eb.export, body.get("id", ""), body.get("regions", []), body.get("stem"),
                                None if eb.HOSTED else body.get("dest"), body.get("formats"), body.get("job"), True)
        if url.path == "/api/editor/choose-folder":
            return self._editor(eb.choose_folder)
        if url.path == "/api/editor/reveal":
            return self._editor(eb.reveal, body.get("path", ""))
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
    if eb.HOSTED:
        print(f"Hosted editor on {HOST}:{PORT} (data in {eb.DATA}); removed {eb.sweep_workspaces()} old workspaces", flush=True)
    else:
        print(f"QA viewer: http://127.0.0.1:{PORT}   Editor: http://127.0.0.1:{PORT}/editor   (Ctrl+C to stop)")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
