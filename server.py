import io
import os
import sys
import threading
import time
import webbrowser
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse


PORT = 8765

# PyInstaller --onefile 환경: 정적 파일이 sys._MEIPASS 안에 풀림
if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    ROOT = sys._MEIPASS
else:
    ROOT = os.path.dirname(os.path.abspath(__file__))

_sessions = {}


def _get_session(model_name):
    from rembg import new_session
    if model_name not in _sessions:
        _sessions[model_name] = new_session(model_name)
    return _sessions[model_name]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        return

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if urlparse(self.path).path == "/api/remove-bg":
            self._handle_remove_bg()
        else:
            self.send_error(404)

    def _handle_remove_bg(self):
        length = int(self.headers.get("Content-Length", 0))
        data = self.rfile.read(length)
        mode = self.headers.get("X-RemoveBg-Mode", "default")
        try:
            from PIL import Image
            from rembg import remove
            img = Image.open(io.BytesIO(data)).convert("RGBA")
            if mode == "precise":
                session = _get_session("isnet-general-use")
                out = remove(
                    img,
                    session=session,
                    alpha_matting=True,
                    alpha_matting_foreground_threshold=240,
                    alpha_matting_background_threshold=20,
                    alpha_matting_erode_size=5,
                )
            else:
                out = remove(img)
            if out.mode != "RGBA":
                out = out.convert("RGBA")
            buf = io.BytesIO()
            out.save(buf, "PNG")
            payload = buf.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as e:
            msg = str(e).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)


def _open_browser():
    time.sleep(1.0)
    try:
        webbrowser.open(f"http://127.0.0.1:{PORT}/")
    except Exception:
        pass


def main() -> None:
    addr = ("127.0.0.1", PORT)
    url = f"http://127.0.0.1:{PORT}/"
    print(f"PixelMotion: {url}")
    print("브라우저가 자동으로 열립니다. 안 열리면 위 주소로 접속하세요.")
    print("종료: 콘솔 창 닫거나 Ctrl+C")
    threading.Thread(target=_open_browser, daemon=True).start()
    try:
        HTTPServer(addr, Handler).serve_forever()
    except KeyboardInterrupt:
        print("\n종료")


if __name__ == "__main__":
    main()
