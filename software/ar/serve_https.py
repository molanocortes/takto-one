#!/usr/bin/env python3
"""serve_https.py - serve the AR page to a Quest over HTTPS, stdlib only.

WebXR needs a secure origin, and a page on https can only open wss:// sockets.
This one process gives the headset both behind ONE certificate:

  GET  /...      static files from this folder (software/ar)
  GET  /ws       (WebSocket upgrade) raw byte tunnel to the bridge's plain
                 ws://127.0.0.1:8765/ws, so the page's default
                 wss://<this host>/ws reaches the bridge and the bridge itself
                 needs no TLS and can stay bound to 127.0.0.1
  POST /diag     appends the AR page's diagnostic beacon to
                 ~/.sensoryhand_diag.log (the same file the bridge writes)

Usage (see README.md, "Option C"):
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
      -keyout key.pem -out cert.pem -subj "/CN=takto-ar" \
      -addext "subjectAltName=IP:<PC-LAN-IP>"
  python3 software/bridge/teensy_bridge.py            # plain ws on 127.0.0.1:8765
  python3 software/ar/serve_https.py --cert cert.pem --key key.pem
  -> on the Quest: https://<PC-LAN-IP>:8443/  (accept the certificate once)

No third-party packages. Not a production server: one trusted LAN, one owner.
"""

import argparse
import http.server
import json
import os
import socket
import ssl
import sys
import threading
import time
from functools import partial

# same place the bridge keeps its diag log (SENSORYHAND_STATE_DIR, else home)
DIAG_LOG = os.path.join(os.environ.get("SENSORYHAND_STATE_DIR") or os.path.expanduser("~"),
                        ".sensoryhand_diag.log")
DIAG_MAX_BYTES = 2_000_000
_diag_lock = threading.Lock()


class Handler(http.server.SimpleHTTPRequestHandler):
    bridge = ("127.0.0.1", 8765)
    protocol_version = "HTTP/1.1"

    def setup(self):
        # the listening socket defers the TLS handshake to this worker thread
        try:
            self.request.do_handshake()
        except (ssl.SSLError, OSError):
            self.request.close()
            raise
        super().setup()

    def end_headers(self):
        # the headset caches aggressively; a stale module graph is a silent bug
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("[https] %s %s\n" % (self.address_string(), fmt % args))

    # ---- /diag ---------------------------------------------------------------
    def do_POST(self):
        if self.path.split("?", 1)[0] != "/diag":
            self.send_error(404)
            return
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > DIAG_MAX_BYTES:
            self.send_error(413 if n > DIAG_MAX_BYTES else 400)
            return
        body = self.rfile.read(n)
        try:
            msg = json.loads(body)
        except ValueError:
            msg = {"raw": body[:2000].decode("utf-8", "replace")}
        line = json.dumps({"via": "serve_https", "t_wall": time.time(),
                           "client": self.client_address[0], "msg": msg})
        with _diag_lock, open(DIAG_LOG, "a") as f:
            f.write(line + "\n")
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---- /ws tunnel ----------------------------------------------------------
    def do_GET(self):
        if (self.path.split("?", 1)[0] == "/ws"
                and self.headers.get("Upgrade", "").lower() == "websocket"):
            self._tunnel()
            return
        super().do_GET()

    def _tunnel(self):
        host, port = self.bridge
        try:
            up = socket.create_connection((host, port), timeout=5)
        except OSError as e:
            self.send_error(502, "bridge not reachable at %s:%d (%s)" % (host, port, e))
            return
        up.settimeout(None)
        # replay the client's handshake to the bridge verbatim (Host rewritten);
        # the bridge's 101 answer and every frame after it flow back untouched
        head = ["GET /ws HTTP/1.1", "Host: %s:%d" % (host, port)]
        head += ["%s: %s" % (k, v) for k, v in self.headers.items() if k.lower() != "host"]
        up.sendall(("\r\n".join(head) + "\r\n\r\n").encode("latin-1"))
        client = self.connection
        self.close_connection = True
        done = threading.Event()

        def up_to_client():
            try:
                while True:
                    data = up.recv(65536)
                    if not data:
                        break
                    client.sendall(data)
            except OSError:
                pass
            finally:
                done.set()

        t = threading.Thread(target=up_to_client, daemon=True)
        t.start()
        try:
            while not done.is_set():
                data = self.rfile.read1(65536)
                if not data:
                    break
                up.sendall(data)
        except (OSError, ValueError):
            pass
        finally:
            for s in (up,):
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                s.close()
            done.set()


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--cert", required=True, help="PEM certificate")
    ap.add_argument("--key", required=True, help="PEM private key")
    ap.add_argument("--host", default="0.0.0.0", help="bind address (LAN: 0.0.0.0)")
    ap.add_argument("--port", type=int, default=8443)
    ap.add_argument("--bridge", default="127.0.0.1:8765", help="plain ws bridge host:port")
    ap.add_argument("--root", default=here, help="folder to serve (default: software/ar)")
    args = ap.parse_args()
    if args.port in (8096, 8097):
        sys.exit("ports 8096/8097 are reserved for the TAKTO console/AR test suites")

    bh, _, bp = args.bridge.rpartition(":")
    Handler.bridge = (bh or "127.0.0.1", int(bp))
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(args.cert, args.key)
    httpd = http.server.ThreadingHTTPServer((args.host, args.port),
                                            partial(Handler, directory=args.root))
    # handshake lazily in the handler thread, so one slow client cannot stall accept()
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True,
                                   do_handshake_on_connect=False)
    print("[https] serving %s on https://%s:%d/  (ws tunnel -> %s:%d, diag -> %s)"
          % (args.root, args.host, args.port, Handler.bridge[0], Handler.bridge[1], DIAG_LOG))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
