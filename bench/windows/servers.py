# Bench servers, started by bench.py:
#   :8899  fake OpenAI-compatible streaming endpoint (N chunks at RATE chunks/s, CORS on) + /files/<name> for seeding
#   :4173  static server for the web build (explicit MIME types; the Windows registry can map .js to text/plain)
# usage: python servers.py <files_dir> <web_dir> <log_file>
import json, os, re, sys, threading, time
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer

FILES_DIR, WEB_DIR, LOG = sys.argv[1], sys.argv[2], sys.argv[3]
N = int(os.environ.get('FAKE_N', '1500'))
RATE = float(os.environ.get('FAKE_RATE', '300'))
log_lock = threading.Lock()


def log(obj):
    with log_lock, open(LOG, 'a') as f:
        f.write(json.dumps(obj) + '\n')


class Fake(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Private-Network', 'true')

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        name = self.path.split('?')[0]
        if not name.startswith('/files/'):
            self.send_response(404); self.cors(); self.send_header('Content-Length', '0'); self.end_headers()
            return
        p = os.path.join(FILES_DIR, *[x for x in name[len('/files/'):].split('/') if x not in ('', '..')])
        if not os.path.isfile(p):
            self.send_response(404); self.cors(); self.send_header('Content-Length', '0'); self.end_headers()
            return
        data = open(p, 'rb').read()
        self.send_response(200)
        self.cors()
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        ln = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(ln)
        try:
            req = json.loads(body)
        except Exception:
            req = {}
        # the harness types "hello <k>"; the newest one in the prompt names this response's end marker
        ks = re.findall(rb'hello (\d+)', body)
        marker = 'ZZEND%sZZ' % (ks[-1].decode() if ks else 'X')
        t0 = time.time()
        if not req.get('stream'):
            out = json.dumps({'choices': [{'message': {'role': 'assistant', 'content': 'ok ' + marker}, 'finish_reason': 'stop'}]}).encode()
            self.send_response(200); self.cors()
            self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(out)))
            self.end_headers(); self.wfile.write(out)
            log({'kind': 'plain', 'req_bytes': ln, 'at': t0})
            return
        self.send_response(200)
        self.cors()
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Transfer-Encoding', 'chunked')
        self.end_headers()

        def w(s):
            b = s.encode()
            self.wfile.write(b'%x\r\n' % len(b) + b + b'\r\n')
            self.wfile.flush()

        interval = 1.0 / RATE
        for i in range(N):
            word = f'w{i} ' if i < N - 1 else marker
            if i % 120 == 119:
                word += '\n\n'
            w('data: ' + json.dumps({'choices': [{'delta': {'content': word}, 'index': 0}]}) + '\n\n')
            d = t0 + (i + 1) * interval - time.time()
            if d > 0:
                time.sleep(d)
        w('data: [DONE]\n\n')
        self.wfile.write(b'0\r\n\r\n')
        self.wfile.flush()
        log({'kind': 'stream', 'marker': marker, 'req_bytes': ln, 'stream_s': round(time.time() - t0, 3), 'n': N, 'at': t0})


class Web(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    extensions_map = {
        '': 'application/octet-stream', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
        '.css': 'text/css', '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm',
        '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
        '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.txt': 'text/plain',
        '.webmanifest': 'application/manifest+json',
    }

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB_DIR, **kw)

    def log_message(self, *a):
        pass


class Server(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        # a browser dropping a keep-alive connection is routine; anything else still gets a traceback
        if not isinstance(sys.exc_info()[1], (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            super().handle_error(request, client_address)


def serve(port, handler):
    Server(('127.0.0.1', port), handler).serve_forever()  # loopback only: no firewall prompt on the runner


threading.Thread(target=serve, args=(4173, Web), daemon=True).start()
serve(8899, Fake)
