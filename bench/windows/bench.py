#!/usr/bin/env python3
# Windows benchmark harness for the RisuAI desktop build (see .github/workflows/windows-perf-bench.yml).
#
# The Tauri app is driven through WebView2's remote debugging port and the web build through Edge's, both with
# Playwright over CDP, so the same page-level script runs against the local builds, the shipped release and the
# web build on the same Chromium engine. Each result is one JSON object per line in $BENCH_WORK/results.jsonl
# (also printed with a "RESULT " prefix).
#
# usage: python bench.py suite <stream|tick|micro> [--quick]
#        python bench.py summarize
#
# Every desktop run starts from an empty profile by deleting the app's data folders (%APPDATA% and %LOCALAPPDATA%
# \co.aiclient.risu). Outside GitHub Actions the harness refuses to start while they exist; BENCH_WIPE_APPDATA=1 overrides.
import argparse, json, os, re, shutil, socket, statistics, subprocess, sys, tempfile, threading, time, traceback, urllib.request

import psutil

IS_WIN = os.name == 'nt'
HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.environ.get('BENCH_WORK') or os.path.join(HERE, 'work')
DATA = os.environ.get('BENCH_DATA') or os.path.join(WORK, 'data')
WEB_DIR = os.environ.get('BENCH_WEB_DIR') or os.path.join(WORK, 'web')
IDENT = 'co.aiclient.risu'
WEB_URL = 'http://127.0.0.1:4173/'
FILES_URL = 'http://fakellm.test:8899/files/'
EDGE = os.environ.get('BENCH_EDGE') or next((p for p in (r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
                                                       r'C:\Program Files\Microsoft\Edge\Application\msedge.exe') if os.path.isfile(p)), 'msedge.exe')
EXTRA_ARGS = os.environ.get('BENCH_EXTRA_BROWSER_ARGS', '').split()
# wry's default WebView2 flags; repeated because WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS may replace the app's own list
WV2_FEATURES = 'msWebOOUI,msPdfOOUI,msSmartScreenProtection'
# keep a covered/unfocused window rendering normally, for both the WebView2 and the Edge window
NO_OCCLUSION = ['--disable-backgrounding-occluded-windows']
NOPROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def elevated():
    # WebView2 150+ ignores WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS when the host process is elevated (GitHub's Windows runners are)
    if not IS_WIN:
        return False
    import ctypes
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def emit(obj):
    os.makedirs(WORK, exist_ok=True)
    line = json.dumps(obj)
    print('RESULT ' + line, flush=True)
    with open(os.path.join(WORK, 'results.jsonl'), 'a') as f:
        f.write(line + '\n')


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_port(port, timeout):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            socket.create_connection(('127.0.0.1', port), timeout=2).close()
            return
        except OSError:
            time.sleep(0.3)
    raise TimeoutError(f'port {port}')


def wait_http(url, timeout):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with NOPROXY.open(url, timeout=2) as r:
                return r.read()
        except Exception:
            time.sleep(0.3)
    raise TimeoutError(url)


def rmtree(path):
    for _ in range(20):
        if not os.path.exists(path):
            return
        shutil.rmtree(path, ignore_errors=True)
        if not os.path.exists(path):
            return
        time.sleep(0.5)


def kill_tree(pid):
    if not pid:
        return
    try:
        root = psutil.Process(pid)
        ps = root.children(recursive=True) + [root]
    except psutil.NoSuchProcess:
        return
    for p in ps:
        try:
            p.kill()
        except psutil.NoSuchProcess:
            pass
    psutil.wait_procs(ps, timeout=15)


def is_app_wv2(cmdline):
    # the WebView2 browser runs with --webview-exe-name=RisuAI_*.exe and a user data dir under the app identifier
    return 'RisuAI' in cmdline or IDENT in cmdline


def kill_strays():
    ps = []
    for p in psutil.process_iter(['name', 'cmdline']):
        try:
            n = (p.info['name'] or '').lower()
            cl = ' '.join(p.info['cmdline'] or [])
            if n.startswith('risuai') or (n == 'msedgewebview2.exe' and is_app_wv2(cl)) or (n == 'msedge.exe' and 'bench-edge-' in cl):
                p.kill()
                ps.append(p)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    psutil.wait_procs(ps, timeout=15)


def proc_dump():
    out = []
    for p in psutil.process_iter(['ppid', 'name', 'cmdline']):
        try:
            n = (p.info['name'] or '').lower()
            if n.startswith('risuai') or n in ('msedgewebview2.exe', 'msedge.exe', 'werfault.exe'):
                out.append({'pid': p.pid, 'ppid': p.info['ppid'], 'name': n, 'cmdline': ' '.join(p.info['cmdline'] or [])[:600]})
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    return out[:40]


def listening(pids):
    try:
        return sorted({c.laddr.port for c in psutil.net_connections('tcp') if c.pid in pids and c.status == psutil.CONN_LISTEN})
    except Exception as e:
        return str(e)[:200]


def win_windows():
    """Visible top-level windows; shows a dialog an app is stuck on before its webview comes up."""
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.windll.user32
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.GetWindowTextW.argtypes = user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    out = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            title = ctypes.create_unicode_buffer(256)
            user32.GetWindowTextW(hwnd, title, 256)
            cls = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, cls, 256)
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            out.append({'title': title.value[:120], 'class': cls.value, 'pid': pid.value})
        return True

    user32.EnumWindows(cb, 0)
    return out[:60]


def edge_policies():
    import winreg
    out = {}

    def walk(hive, hname, path, depth):
        try:
            with winreg.OpenKey(hive, path) as k:
                i = 0
                while True:
                    try:
                        n, v, _ = winreg.EnumValue(k, i)
                    except OSError:
                        break
                    out[f'{hname}\\{path}\\{n}'] = str(v)[:200]
                    i += 1
                if depth:
                    j = 0
                    while True:
                        try:
                            sub = winreg.EnumKey(k, j)
                        except OSError:
                            break
                        walk(hive, hname, path + '\\' + sub, depth - 1)
                        j += 1
        except OSError:
            pass

    for hive, hname in ((winreg.HKEY_LOCAL_MACHINE, 'HKLM'), (winreg.HKEY_CURRENT_USER, 'HKCU')):
        walk(hive, hname, r'SOFTWARE\Policies\Microsoft\Edge', 2)
    return out


def desktop_shot(name):
    try:
        from PIL import ImageGrab
        os.makedirs(os.path.join(WORK, 'shots'), exist_ok=True)
        ImageGrab.grab(all_screens=True).save(os.path.join(WORK, 'shots', name + '_desktop.png'))
    except Exception as e:
        log('desktop screenshot failed', e)


def tail(path, n=4000):
    try:
        with open(path, 'rb') as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - n))
            return f.read().decode('utf-8', 'replace')
    except OSError as e:
        return str(e)


def asset_files():
    d = os.path.join(DATA, 'assets')
    return [os.path.join(d, f) for f in sorted(os.listdir(d)) if f.endswith('.png')]


def mb(x):
    return round(x / 1048576, 1)


# ---------------------------------------------------------------- page scripts

FRAME_START = """
window.__frames = []; window.__mon = true;
let last = performance.now();
const f = (t) => { window.__frames.push(t - last); last = t; if (window.__mon) requestAnimationFrame(f); };
requestAnimationFrame(f);
return 1;
"""

FRAME_STOP = """
window.__mon = false;
const f = (window.__frames || []).slice(1);
const long = f.filter(x => x > 50);
return {n: f.length, long50: long.length, long200: f.filter(x => x > 200).length, max: Math.round(Math.max(0, ...f)), jank_ms: Math.round(long.reduce((a, b) => a + b, 0))};
"""

# Tauri IPC goes through fetch('http://ipc.localhost/<cmd>') (ipc-protocol.js looks fetch up at call time), and the
# web build saves through IndexedDB put(); log both so saves can be counted and timed without touching the app.
MON_INSTALL = """
if (window.__ipcMon) return 'already';
window.__ipcMon = []; window.__idbMon = [];
const of = window.fetch;
window.fetch = function (input, init) {
  let url = '';
  try { url = typeof input === 'string' ? input : (input && input.url) || String(input); } catch (e) {}
  const m = /^(?:https?:\\/\\/ipc\\.localhost|ipc:\\/\\/localhost)\\/(.*)$/.exec(url);
  if (!m) return of.apply(this, arguments);
  let cmd = m[1];
  try { cmd = decodeURIComponent(cmd); } catch (e) {}
  const b = init && init.body;
  const size = b ? (b.byteLength !== undefined ? b.byteLength : (typeof b === 'string' ? b.length : 0)) : 0;
  let path = null;
  try {
    // ipc-protocol.js spreads the command's headers into a plain object (plugin-fs puts the file path there)
    const h = init && init.headers;
    path = h ? (typeof h.get === 'function' ? h.get('path') : (h.path || null)) : null;
    if (path) path = decodeURIComponent(path);
  } catch (e) {}
  const t0 = performance.now();
  const p = of.apply(this, arguments);
  const rec = (ok) => window.__ipcMon.push({cmd, size, path, t0: Math.round(t0), dt: +(performance.now() - t0).toFixed(1), ok});
  p.then(() => rec(true), () => rec(false));
  return p;
};
const op = IDBObjectStore.prototype.put;
IDBObjectStore.prototype.put = function (value, key) {
  try { window.__idbMon.push({store: this.name, key: String(key), size: (value && (value.byteLength || value.length)) || 0, t: Math.round(performance.now())}); } catch (e) {}
  return op.apply(this, arguments);
};
return 'installed';
"""

MON_READ = "const r = {ipc: window.__ipcMon || [], idb: window.__idbMon || []}; window.__ipcMon = []; window.__idbMon = []; return r;"

PAGE_INFO = """
const fps = await new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else r(n); }; requestAnimationFrame(f); });
return {ua: navigator.userAgent, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, vis: document.visibilityState, focus: document.hasFocus(), raf_per_s: fps};
"""

SEED_WEB = """
const [files] = args;
const db = await new Promise((res, rej) => { const r = indexedDB.open('risuai'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const stores = [...db.objectStoreNames];
for (const [key, url] of files) {
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  await new Promise((res, rej) => { const tx = db.transaction('keyvaluepairs', 'readwrite'); tx.objectStore('keyvaluepairs').put(buf, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
db.close();
return stores;
"""

MICRO_SETUP = """
const inv = window.__TAURI_INTERNALS__.invoke;
await inv('plugin:fs|mkdir', {path: 'bench', options: {baseDir: 14, recursive: true}}).catch(() => {});
window.__mk = (size) => { const a = new Uint8Array(size); let x = 2463534242; for (let i = 0; i < size; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; a[i] = x & 255; } return a; };
window.__idb = await new Promise((res, rej) => { const r = indexedDB.open('benchdb', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
window.__appdata = await inv('plugin:path|resolve_directory', {directory: 14});
window.__join = (...p) => inv('plugin:path|join', {paths: p});
window.__ping = (ms, work) => (async () => {
  // a trivial IPC command every 5 ms: its latency is how available the native UI thread is
  const lat = []; let stop = false; const frames = []; let last = performance.now();
  const raf = (t) => { frames.push(t - last); last = t; if (!stop) requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
  const pinger = (async () => { while (!stop) { const t = performance.now(); await inv('plugin:path|resolve_directory', {directory: 14}); lat.push(performance.now() - t); await new Promise(r => setTimeout(r, 5)); } })();
  const t0 = performance.now();
  let out = null;
  if (work) out = await work(); else await new Promise(r => setTimeout(r, ms));
  const dur = performance.now() - t0;
  stop = true; await pinger;
  lat.sort((a, b) => a - b); const f = frames.slice(1).sort((a, b) => a - b);
  return {out, dur_ms: Math.round(dur), pings: lat.length, ping_p50: +(lat[Math.floor(lat.length / 2)] || 0).toFixed(1), ping_max: Math.round(lat[lat.length - 1] || 0),
          frame_max: Math.round(f[f.length - 1] || 0), frames_over_50: f.filter(v => v > 50).length};
})();
performance.setResourceTimingBufferSize(100000);
return {appdata: window.__appdata, ua: navigator.userAgent};
"""

MICRO_IPC = """
const [sizeMb] = args;
const inv = window.__TAURI_INTERNALS__.invoke;
const buf = window.__mk(sizeMb * 1048576);
const out = {sizeMb};
let t = performance.now();
await inv('plugin:fs|write_file', buf, {headers: {path: encodeURIComponent('bench/w.bin'), options: JSON.stringify({baseDir: 14})}});
out.tauri_write_ms = Math.round(performance.now() - t);
t = performance.now();
const arr = await inv('plugin:fs|read_file', {path: 'bench/w.bin', options: {baseDir: 14}});
const rb = arr instanceof ArrayBuffer ? new Uint8Array(arr) : Uint8Array.from(arr);
out.tauri_read_ms = Math.round(performance.now() - t);
out.read_type = arr instanceof ArrayBuffer ? 'ArrayBuffer' : (Array.isArray(arr) ? 'Array' : typeof arr);
out.read_ok = rb.length === buf.length && rb[12345 % rb.length] === buf[12345 % rb.length];
t = performance.now();
const url = window.__TAURI_INTERNALS__.convertFileSrc(await window.__join(window.__appdata, 'bench', 'w.bin'), 'asset');
const ab = await (await fetch(url)).arrayBuffer();
out.asset_fetch_ms = Math.round(performance.now() - t); out.asset_len = ab.byteLength;
t = performance.now();
await new Promise((res, rej) => { const tx = window.__idb.transaction('s', 'readwrite'); tx.objectStore('s').put(buf, 'k'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
out.idb_put_ms = Math.round(performance.now() - t);
t = performance.now();
const v = await new Promise((res, rej) => { const tx = window.__idb.transaction('s', 'readonly'); const rq = tx.objectStore('s').get('k'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
out.idb_get_ms = Math.round(performance.now() - t); out.idb_len = v.length;
return out;
"""

# what saveDb() does on Tauri per save: database.bin + a new dbbackup-*.bin, then readDir
MICRO_SAVE = """
const [sizeMb] = args;
const inv = window.__TAURI_INTERNALS__.invoke;
const buf = window.__mk(sizeMb * 1048576);
const idle = await window.__ping(1500, null);
const save = await window.__ping(0, async () => {
  const t = [];
  let t0 = performance.now();
  await inv('plugin:fs|write_file', buf, {headers: {path: encodeURIComponent('bench/database.bin'), options: JSON.stringify({baseDir: 14})}});
  t.push(Math.round(performance.now() - t0)); t0 = performance.now();
  await inv('plugin:fs|write_file', buf, {headers: {path: encodeURIComponent('bench/dbbackup-' + Date.now() + '.bin'), options: JSON.stringify({baseDir: 14})}});
  t.push(Math.round(performance.now() - t0)); t0 = performance.now();
  await inv('plugin:fs|read_dir', {path: 'bench', options: {baseDir: 14}});
  t.push(Math.round(performance.now() - t0));
  return t;
});
const idb = await window.__ping(0, async () => {
  const t0 = performance.now();
  await new Promise((res, rej) => { const tx = window.__idb.transaction('s', 'readwrite'); tx.objectStore('s').put(buf, 'db'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  return Math.round(performance.now() - t0);
});
return {sizeMb, idle, save, idb_same_size: idb};
"""

# plugin-http request bodies: @tauri-apps/plugin-http 2.5.5 sends them as Array.from(bytes) inside JSON
MICRO_HTTP = """
const [sizeMb] = args;
const inv = window.__TAURI_INTERNALS__.invoke;
const body = JSON.stringify({messages: [{role: 'user', content: 'x'.repeat(sizeMb * 1048576)}], stream: false});
const bytes = new TextEncoder().encode(body);
const t0 = performance.now();
const data = Array.from(bytes);
const t1 = performance.now();
const rid = await inv('plugin:http|fetch', {clientConfig: {method: 'POST', url: 'http://fakellm.test:8899/v1/chat/completions', headers: [['content-type', 'application/json']], data, maxRedirections: undefined, connectTimeout: undefined, proxy: undefined, danger: undefined}});
const t2 = performance.now();
const r = await inv('plugin:http|fetch_send', {rid});
const t3 = performance.now();
const t4 = performance.now();
let plain = null;
try {
  await (await fetch('http://fakellm.test:8899/v1/chat/completions', {method: 'POST', headers: {'content-type': 'application/json'}, body})).text();
  plain = Math.round(performance.now() - t4);
} catch (e) { plain = 'error: ' + String(e).slice(0, 120); }
return {sizeMb, body_bytes: bytes.length, array_from_ms: Math.round(t1 - t0), ipc_fetch_ms: Math.round(t2 - t1), send_ms: Math.round(t3 - t2), status: r.status, plain_fetch_ms: plain};
"""

ASSET_PREP = """
const [names] = args;
const conv = (p) => window.__TAURI_INTERNALS__.convertFileSrc(p, 'asset');
window.__assetUrls = [];
for (const n of names) window.__assetUrls.push(conv(await window.__join(window.__appdata, 'assets', 'bench', n)));
window.__dataUrls = []; window.__blobUrls = [];
for (const u of window.__assetUrls) {
  const b = await (await fetch(u)).blob();
  window.__blobUrls.push(URL.createObjectURL(b));
  window.__dataUrls.push(await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); }));
}
let c = document.getElementById('__bench');
if (!c) { c = document.createElement('div'); c.id = '__bench'; document.body.appendChild(c); }
c.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:400px;overflow:hidden;z-index:999999;background:#000';
return {n: window.__assetUrls.length, sample: window.__assetUrls[0]};
"""

# re-render the same markup (what a {@html} refresh does) and count how many requests actually reach the asset
# protocol, while pinging the native UI thread
ASSET_RERENDER = """
const [variant, iters, kind] = args;
const urls = variant === 'asset' ? window.__assetUrls : variant === 'data' ? window.__dataUrls : window.__blobUrls;
const c = document.getElementById('__bench');
performance.clearResourceTimings();
const times = [];
const r = await window.__ping(0, async () => {
  for (let k = 0; k < iters; k++) {
    const t0 = performance.now();
    if (kind === 'img') {
      c.innerHTML = urls.map(u => `<img src="${u}" style="width:90px;height:90px;float:left">`).join('');
      await Promise.all([...c.querySelectorAll('img')].map(i => i.decode().catch(() => {})));
    } else {
      c.innerHTML = urls.map(u => `<div style="width:90px;height:90px;float:left;background-image:url(${u});background-size:cover"></div>`).join('');
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    times.push(performance.now() - t0);
    await new Promise(r => setTimeout(r, 30));
  }
});
c.innerHTML = '';
const fetches = performance.getEntriesByType('resource').filter(e => e.name.includes('asset.localhost') || e.name.startsWith('asset:')).length;
times.sort((a, b) => a - b);
return {variant, kind, iters, median_ms: Math.round(times[Math.floor(times.length / 2)]), p90_ms: Math.round(times[Math.floor(times.length * 0.9)]),
        total_ms: Math.round(times.reduce((a, b) => a + b, 0)), asset_requests: fetches, ping_p50: r.ping_p50, ping_max: r.ping_max, frame_max: r.frame_max};
"""


def ev(page, body, *args):
    return page.evaluate('async (args) => {\n' + body + '\n}', list(args))


# ---------------------------------------------------------------- sessions

class Session:
    """One running app (Tauri exe) or browser (Edge + web build) with a Playwright page attached over CDP."""

    def __init__(self, pw, target, db=None, bench_assets=False):
        self.pw, self.target, self.db, self.bench_assets = pw, target, db, bench_assets
        self.kind = 'web' if target == 'web' else 'tauri'
        self.port = free_port()
        self.proc = self.browser = self.page = self.cdp = None
        self.udd = self.app_out = self.app_log = self.wv2_log = None
        self.console = []
        self.crashed = False

    @staticmethod
    def appdata():
        return os.path.join(os.environ['APPDATA'], IDENT)

    def start(self):
        if self.kind == 'tauri':
            rmtree(self.appdata())
            rmtree(os.path.join(os.environ['LOCALAPPDATA'], IDENT))  # WebView2 profile (EBWebView): fresh every run
            if self.db:
                os.makedirs(os.path.join(self.appdata(), 'database'))
                shutil.copy(os.path.join(DATA, self.db), os.path.join(self.appdata(), 'database', 'database.bin'))
                os.makedirs(os.path.join(self.appdata(), 'assets'), exist_ok=True)
                for i, f in enumerate(asset_files()):
                    shutil.copy(f, os.path.join(self.appdata(), 'assets', f'bench_img{i:02d}.png'))
            if self.bench_assets:
                os.makedirs(os.path.join(self.appdata(), 'assets', 'bench'), exist_ok=True)
                for f in asset_files():
                    shutil.copy(f, os.path.join(self.appdata(), 'assets', 'bench'))
            env = dict(os.environ)
            self.wv2_log = os.path.join(WORK, f'wv2_{self.target}_{self.port}.log')
            args = ' '.join([f'--disable-features={WV2_FEATURES},CalculateNativeWinOcclusion', *NO_OCCLUSION, f'--remote-debugging-port={self.port}',
                             '--enable-logging', f'--log-file={self.wv2_log}'])
            env['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = args
            env['RUST_BACKTRACE'] = '1'
            exe = os.environ['BENCH_EXE_' + self.target.upper()]
            # a release build has no console; its panic message still reaches an inherited stderr handle
            self.app_log = os.path.join(WORK, f'app_{self.target}_{self.port}.log')
            self.app_out = open(self.app_log, 'w')
            self.proc = subprocess.Popen([exe], env=env, cwd=os.path.dirname(exe), stdout=self.app_out, stderr=subprocess.STDOUT)
            prefix = ('http://tauri.localhost', 'https://tauri.localhost')
        else:
            self.udd = tempfile.mkdtemp(prefix='bench-edge-')
            self.proc = subprocess.Popen([EDGE, f'--remote-debugging-port={self.port}', f'--user-data-dir={self.udd}', '--no-first-run',
                                          '--no-default-browser-check', '--disable-features=CalculateNativeWinOcclusion', *NO_OCCLUSION,
                                          '--window-size=1040,808', *EXTRA_ARGS, f'--app={WEB_URL}'])
            prefix = (WEB_URL.rstrip('/'),)
        self._wait_cdp()
        self.browser = self.pw.chromium.connect_over_cdp(f'http://127.0.0.1:{self.port}')
        self.page = self._find_page(prefix)
        self.page.on('console', self._on_console)
        self.page.on('crash', self._on_crash)
        self.cdp = self.page.context.new_cdp_session(self.page)
        return self

    def _wait_cdp(self, timeout=90):
        url = f'http://127.0.0.1:{self.port}/json/version'
        t0 = time.time()
        while time.time() - t0 < timeout:
            rc = self.proc.poll()
            if rc is not None and self.kind == 'tauri':
                raise RuntimeError(f'{self.target} exited with code {rc} before its debugging port opened')
            try:
                with NOPROXY.open(url, timeout=2) as r:
                    return r.read()
            except Exception:
                time.sleep(0.3)
        raise TimeoutError(url)

    def diag(self):
        """Why a session did not come up: process state, browser command lines, listening ports, windows, logs."""
        d = {'returncode': self.proc.poll() if self.proc else 'not started', 'port': self.port, 'elevated': elevated()}
        if IS_WIN:
            for k, f in (('procs', proc_dump), ('windows', win_windows), ('edge_policies', edge_policies)):
                try:
                    d[k] = f()
                except Exception as e:
                    d[k] = f'{type(e).__name__}: {e}'[:300]
            d['listening'] = listening({p['pid'] for p in d['procs']} if isinstance(d.get('procs'), list) else set())
        if self.kind == 'tauri':
            prof = os.path.join(os.environ.get('LOCALAPPDATA', ''), IDENT, 'EBWebView')
            d['profile_files'] = sorted(os.listdir(prof))[:40] if os.path.isdir(prof) else None
            port_file = os.path.join(prof, 'DevToolsActivePort')
            d['devtools_active_port'] = tail(port_file, 200) if os.path.exists(port_file) else None
            if self.app_out:
                self.app_out.flush()
            d['app_log'] = tail(self.app_log) if self.app_log else None
            d['wv2_log'] = tail(self.wv2_log) if self.wv2_log and os.path.exists(self.wv2_log) else None
        return d

    def _on_console(self, msg):
        if msg.type in ('error', 'warning') and len(self.console) < 40:
            self.console.append(f'{msg.type}: {msg.text[:300]}')

    def _on_crash(self, *_):
        self.crashed = True
        log('!! renderer crashed')

    def _find_page(self, prefix, timeout=120):
        t0 = time.time()
        while time.time() - t0 < timeout:
            pages = [p for c in self.browser.contexts for p in c.pages]
            for p in pages:
                if p.url.startswith(prefix):
                    return p
            try:
                if pages:
                    pages[0].wait_for_timeout(300)  # lets Playwright process navigation events
                else:
                    self.browser.contexts[0].wait_for_event('page', timeout=1000)
            except Exception:
                time.sleep(0.3)
        raise TimeoutError(f'no page starting with {prefix}: {[p.url for c in self.browser.contexts for p in c.pages]}')

    def stop(self):
        try:
            if self.browser:
                self.browser.close()
        except Exception:
            pass
        kill_tree(self.proc.pid if self.proc else None)
        if IS_WIN:
            kill_strays()
        if self.app_out:
            self.app_out.close()
        if self.udd:
            rmtree(self.udd)

    def procs(self):
        out = []
        try:
            root = psutil.Process(self.proc.pid)
            out = [root] + root.children(recursive=True)
        except psutil.NoSuchProcess:
            pass
        if self.kind == 'tauri' and IS_WIN:
            seen = {p.pid for p in out}
            for p in psutil.process_iter(['name', 'cmdline']):
                try:
                    if p.pid not in seen and (p.info['name'] or '').lower() == 'msedgewebview2.exe' and is_app_wv2(' '.join(p.info['cmdline'] or [])):
                        out.append(p)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
        return out

    def mem(self):
        """Private bytes (commit) and working set of the whole process tree, split by Chromium process type."""
        by = {}
        tot_priv = tot_ws = 0
        for p in self.procs():
            try:
                name = p.name().lower()
                cl = p.cmdline()
                role = 'host' if name.startswith('risuai') else next((a.split('=', 1)[1] for a in cl if a.startswith('--type=')), 'browser')
                mi = p.memory_info()
                priv = getattr(mi, 'private', mi.rss)
                d = by.setdefault(role, {'n': 0, 'private_mb': 0.0, 'ws_mb': 0.0})
                d['n'] += 1
                d['private_mb'] += priv / 1048576
                d['ws_mb'] += mi.rss / 1048576
                tot_priv += priv
                tot_ws += mi.rss
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        for d in by.values():
            d['private_mb'] = round(d['private_mb'], 1)
            d['ws_mb'] = round(d['ws_mb'], 1)
        return {'private_mb': mb(tot_priv), 'ws_mb': mb(tot_ws), 'by_role': by}

    def heap(self):
        try:
            h = self.cdp.send('Runtime.getHeapUsage')
            return {'used_mb': mb(h['usedSize']), 'total_mb': mb(h['totalSize'])}
        except Exception as e:
            return {'error': str(e)[:200]}

    def info(self):
        try:
            i = ev(self.page, PAGE_INFO)
        except Exception as e:
            i = {'error': str(e)[:200]}
        if self.kind == 'tauri':
            for p in self.procs():
                try:
                    cl = p.cmdline()
                    if p.name().lower() == 'msedgewebview2.exe' and not any(a.startswith('--type=') for a in cl):
                        i['wv2_browser_cmdline'] = ' '.join(cl)[:700]
                        break
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
        return i

    def screenshot(self, name):
        try:
            os.makedirs(os.path.join(WORK, 'shots'), exist_ok=True)
            self.page.screenshot(path=os.path.join(WORK, 'shots', name + '.png'), timeout=30000)
        except Exception as e:
            log('screenshot failed', e)


class Sampler:
    """Peak private bytes / working set of a session's process tree, sampled every 250 ms in a background thread."""

    def __init__(self, s):
        self.s = s
        self.peak_priv = self.peak_ws = 0.0
        self.peak_by = {}
        self._stop = False
        self.t = threading.Thread(target=self.run, daemon=True)

    def run(self):
        while not self._stop:
            m = self.s.mem()
            self.peak_priv = max(self.peak_priv, m['private_mb'])
            self.peak_ws = max(self.peak_ws, m['ws_mb'])
            for k, v in m['by_role'].items():
                self.peak_by[k] = max(self.peak_by.get(k, 0), v['private_mb'])
            time.sleep(0.25)

    def __enter__(self):
        self.t.start()
        return self

    def __exit__(self, *a):
        self._stop = True
        self.t.join()

    def result(self):
        return {'private_mb': self.peak_priv, 'ws_mb': self.peak_ws, 'private_by_role_mb': self.peak_by}


# ---------------------------------------------------------------- app flows

def click_text(page, text):
    return page.evaluate("t => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t); if (b) { b.click(); return true; } return false; }", text)


UPDATE_PROMPT = "document.body && document.body.innerText.includes('Update found')"
MAIN_READY = "document.querySelectorAll('button').length > 3"
# an empty web profile boots into the welcome chat with the TOS prompt (3 buttons); localforage is initialised by then
FIRST_READY = "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Accept') || document.querySelectorAll('button').length > 3"


def boot(s, ready=MAIN_READY, timeout=180):
    t0 = time.time()
    s.page.wait_for_function(f"({ready}) || ({UPDATE_PROMPT})", timeout=timeout * 1000, polling=500)
    if ev(s.page, f'return !!({UPDATE_PROMPT})'):
        # Tauri builds check GitHub for a newer release while booting and wait on this prompt; answer NO, then Ignore
        log('   dismissing update prompt')
        click_text(s.page, 'NO')
        s.page.wait_for_function("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Ignore')", timeout=30000, polling=200)
        click_text(s.page, 'Ignore')
        s.page.wait_for_function(ready, timeout=timeout * 1000, polling=500)
    s.page.wait_for_timeout(3000)
    click_text(s.page, 'Accept')
    s.page.wait_for_timeout(1000)
    return round(time.time() - t0, 1)


def load_save(s):
    """Boot; for the web build, put the save + assets into IndexedDB like the Tauri files and reload."""
    out = {'boot_s': boot(s, FIRST_READY if s.kind == 'web' else MAIN_READY)}
    if s.kind == 'web' and s.db:
        # seed from a same-origin page that does not run the app, so its save loop cannot overwrite the seeded save
        s.page.goto(WEB_URL + 'favicon.png', timeout=60000)
        ev(s.page, "localStorage.setItem('tos4', 'true'); return 1")
        files = [['database/database.bin', FILES_URL + s.db]] + [[f'assets/bench_img{i:02d}.png', FILES_URL + 'assets/' + os.path.basename(f)] for i, f in enumerate(asset_files())]
        out['idb_stores'] = ev(s.page, SEED_WEB, files)
        s.page.goto(WEB_URL, timeout=180000)
        out['boot2_s'] = boot(s)
    return out


# an app alert (error popup) covers the chat; report its text and press OK so the run can go on
ALERT = """
const o = [...document.querySelectorAll('div.absolute.w-full.h-full.z-50')].find(d => d.offsetParent !== null && d.querySelector('button'));
if (!o) return null;
const text = o.innerText.slice(0, 300);
const ok = [...o.querySelectorAll('button')].find(b => b.textContent.trim() === 'OK');
if (ok) ok.click();
return text;
"""


def dismiss_alert(s, res):
    t = ev(s.page, ALERT)
    if t:
        log('!! app alert:', t.replace('\n', ' | ')[:200])
        res.setdefault('alerts', []).append(t)
        s.page.wait_for_timeout(500)


def open_bot(s, wait_js="document.querySelectorAll('.chattext').length >= 3"):
    s.page.wait_for_timeout(2000)
    n = ev(s.page, "const a = [...document.querySelectorAll('span.avatar[role=button]')]; a[0] && a[0].click(); return a.length;")
    t0 = time.time()
    s.page.wait_for_function(wait_js, timeout=180000, polling=200)
    return {'avatars': n, 'open_s': round(time.time() - t0, 2)}


def mon_summary(mon):
    """Aggregate IPC (Tauri) and IndexedDB put (web) activity; DB saves are what saveDb() writes."""
    ipc, idb = mon['ipc'], mon['idb']
    writes = [x for x in ipc if x['cmd'] == 'plugin:fs|write_file']
    db_writes = [x for x in writes if x.get('path') and 'database/' in x['path'].replace('\\', '/')]
    by_cmd = {}
    for x in ipc:
        d = by_cmd.setdefault(x['cmd'], {'n': 0, 'bytes': 0, 'ms_sum': 0.0, 'ms_max': 0.0})
        d['n'] += 1
        d['bytes'] += x['size']
        d['ms_sum'] = round(d['ms_sum'] + x['dt'], 1)
        d['ms_max'] = max(d['ms_max'], x['dt'])
    idb_db = [x for x in idb if 'database' in x['key']]
    return {
        'tauri_db_writes': len(db_writes), 'tauri_db_write_mb': mb(sum(x['size'] for x in db_writes)),
        'tauri_db_write_ms_max': max([x['dt'] for x in db_writes], default=0), 'tauri_db_write_ms_sum': round(sum(x['dt'] for x in db_writes)),
        'ipc_by_cmd': by_cmd,
        'idb_db_puts': len(idb_db), 'idb_db_put_mb': mb(sum(x['size'] for x in idb_db)), 'idb_puts_total': len(idb),
    }


def run_test(pw, kind, fn, target, db=None, tag='', bench_assets=False, **kw):
    res = {'test': kind, 'target': target, 'db': db, 'tag': tag, **kw}
    log(f'== {kind} {target} {db or ""} {kw}')
    s = Session(pw, target, db, bench_assets)
    try:
        s.start()
        with Sampler(s) as samp:
            fn(s, res, **kw)
        res['mem_peak'] = samp.result()
        res['info'] = s.info()
        s.screenshot(f'{kind}_{target}_{tag}')
    except Exception as e:
        res['error'] = f'{type(e).__name__}: {e}'[:1500]
        res['trace'] = traceback.format_exc()[-2500:]
        log('!! error', res['error'])
        if s.page is None:
            res['diag'] = s.diag()
            log('   diag', json.dumps(res['diag'])[:6000])
            if IS_WIN:
                desktop_shot(f'{kind}_{target}_{tag}_error')
        else:
            s.screenshot(f'{kind}_{target}_{tag}_error')
    finally:
        res['renderer_crashed'] = s.crashed
        res['console'] = s.console[:20]
        s.stop()
    emit(res)
    return res


# ---------------------------------------------------------------- tests

def t_idle(s, res, wait_s=15):
    res['load'] = load_save(s)
    s.page.wait_for_timeout(wait_s * 1000)
    res['mem'] = s.mem()
    res['heap'] = s.heap()


def t_stream(s, res, sends=2):
    res['load'] = load_save(s)
    res['open'] = open_bot(s)
    ev(s.page, MON_INSTALL)
    s.page.wait_for_timeout(3000)
    res['mem_after_open'] = s.mem()
    res['heap_after_open'] = s.heap()
    runs = []
    for k in range(sends):
        dismiss_alert(s, res)
        ev(s.page, MON_READ)
        ev(s.page, FRAME_START)
        ev(s.page, "const t = document.querySelector('textarea.text-input-area'); t.focus(); return 1")
        s.page.keyboard.type(f'hello {k}')
        mark = f'ZZEND{k}ZZ'
        t0 = time.time()
        ev(s.page, "document.querySelector('.button-icon-send').click(); return 1")
        ok = True
        try:
            s.page.wait_for_function("m => [...document.querySelectorAll('.chattext')].some(e => e.textContent.includes(m))", arg=mark, timeout=900000, polling=100)
        except Exception as e:
            ok = False
            log('!! stream wait failed', str(e)[:200])
        dt = time.time() - t0
        fr = ev(s.page, FRAME_STOP)
        s.page.wait_for_timeout(3000)  # let triggers/saves settle
        run = {'k': k, 'send_to_end_s': round(dt, 2) if ok else None, 'frames': fr, 'mon': mon_summary(ev(s.page, MON_READ)), 'mem': s.mem(), 'heap': s.heap()}
        runs.append(run)
        log(f'   send {k}: {run["send_to_end_s"]}s frames={fr} private={run["mem"]["private_mb"]}MB')
    res['runs'] = runs


def t_tick(s, res, ticks=12):
    res['load'] = load_save(s)
    res['open'] = open_bot(s, "document.querySelectorAll('.x-risu-status-card').length >= 3")
    t0 = time.time()
    # off-screen images may be lazy and never complete; wait for the ones in view
    s.page.wait_for_function("""(() => {
      const im = [...document.querySelectorAll('.x-risu-status-card img, .x-risu-hud img')].filter(i => { const r = i.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight; });
      return im.length > 0 && im.every(i => i.complete);
    })()""", timeout=120000, polling=200)
    res['imgs_settle_s'] = round(time.time() - t0, 2)
    res['imgs'] = ev(s.page, "const im = [...document.querySelectorAll('.x-risu-status-card img, .x-risu-hud img')]; return {n: im.length, complete: im.filter(i => i.complete).length, lazy: im.filter(i => i.loading === 'lazy').length}")
    s.page.wait_for_timeout(3000)
    res['status_cards'] = ev(s.page, "return document.querySelectorAll('.x-risu-status-card').length")
    res['mem_after_open'] = s.mem()
    dismiss_alert(s, res)
    ev(s.page, MON_INSTALL)
    ev(s.page, FRAME_START)
    times = []
    for k in range(ticks):
        before = ev(s.page, "const h = document.querySelector('.x-risu-hud'); return h ? h.textContent : ''")
        t0 = time.time()
        ev(s.page, "const b = [...document.querySelectorAll('button.x-risu-tickbtn')]; b[b.length - 1].click(); return b.length")
        try:
            s.page.wait_for_function("b => { const h = document.querySelector('.x-risu-hud'); return h && h.textContent !== b; }", arg=before, timeout=60000, polling=50)
            times.append(round(time.time() - t0, 3))
        except Exception:
            times.append(None)
        s.page.wait_for_timeout(1000)
    s.page.wait_for_timeout(5000)  # let the save loop drain
    res['frames'] = ev(s.page, FRAME_STOP)
    res['tick_s'] = times
    valid = sorted(t for t in times if t is not None)
    res['tick_median_s'] = valid[len(valid) // 2] if valid else None
    res['mon'] = mon_summary(ev(s.page, MON_READ))
    res['mem_end'] = s.mem()
    res['heap_end'] = s.heap()


def micro_step(s, res, section, script, *args, sample=False):
    """One micro measurement; a failure is recorded under micro_errors and the remaining steps still run."""
    try:
        if sample:
            with Sampler(s) as smp:
                r = ev(s.page, script, *args)
            r['peak_private_mb'] = smp.result()['private_mb']
            r['peak_by_role_mb'] = smp.result()['private_by_role_mb']
        else:
            r = ev(s.page, script, *args)
    except Exception as e:
        log(f'!! {section} {args}: {str(e)[:300]}')
        res.setdefault('micro_errors', []).append(f'{section} {args}: {str(e)[:500]}')
        return None
    log(f'   {section}', json.dumps(r))
    if section in res:
        res[section].append(r)
    return r


def t_micro(s, res, quick=False):
    res['load'] = load_save(s)
    res['setup'] = ev(s.page, MICRO_SETUP)
    res['ipc'], res['save_stall'], res['http_body'], res['assets'] = [], [], [], []
    for size in ([1, 10] if quick else [1, 10, 50, 100]):
        micro_step(s, res, 'ipc', MICRO_IPC, size, sample=True)
    for size in ([25] if quick else [25, 75, 150]):
        micro_step(s, res, 'save_stall', MICRO_SAVE, size)
    for size in ([1] if quick else [1, 5, 20]):
        micro_step(s, res, 'http_body', MICRO_HTTP, size, sample=True)
    names = [os.path.basename(f) for f in asset_files()]
    res['asset_prep'] = micro_step(s, res, 'asset_prep', ASSET_PREP, names)
    if res['asset_prep'] is None:
        return
    for kind in ('img', 'cssbg'):
        for variant in ('asset', 'data', 'blob'):
            r = micro_step(s, res, 'assets', ASSET_RERENDER, variant, 10 if quick else 30, kind)
            if r is not None:
                r['mem'] = s.mem()['private_mb']


# ---------------------------------------------------------------- suites

def targets(*names):
    out = []
    for n in names:
        if n == 'web' or os.path.isfile(os.environ.get('BENCH_EXE_' + n.upper(), '')):
            out.append(n)
        else:
            log(f'(skipping {n}: no exe)')
    return out


PROBED = {}


def probe(pw, target):
    """Start a Tauri build once on an empty profile. A build that never opens its debugging port is reported once
    (with diagnostics) and left out of the suite instead of timing out in every test."""
    if target in PROBED:
        return PROBED[target]
    log(f'== probe {target}')
    s = Session(pw, target)
    res = {'test': 'probe', 'target': target}
    t0 = time.time()
    try:
        s.start()
        res['start_s'] = round(time.time() - t0, 1)
        res['url'] = s.page.url
        res['ok'] = True
        res['info'] = s.info()
    except Exception as e:
        res['ok'] = False
        res['error'] = f'{type(e).__name__}: {e}'[:1500]
        if elevated():
            res['error'] += ' (this process is elevated, and WebView2 ignores WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS for elevated hosts)'
        res['diag'] = s.diag()
        log('!! probe failed', res['error'])
        log('   diag', json.dumps(res['diag'])[:6000])
        if IS_WIN:
            desktop_shot(f'probe_{target}')
    finally:
        s.stop()
    emit(res)
    PROBED[target] = res['ok']
    return PROBED[target]


def usable(pw, *names):
    return [t for t in targets(*names) if t == 'web' or probe(pw, t)]


def start_servers():
    os.makedirs(WORK, exist_ok=True)
    p = subprocess.Popen([sys.executable, os.path.join(HERE, 'servers.py'), DATA, WEB_DIR, os.path.join(WORK, 'servers.log')])
    wait_http(WEB_URL, 30)
    wait_port(8899, 30)
    return p


def env_info():
    info = {'python': sys.version.split()[0], 'cpu_count': psutil.cpu_count(), 'ram_gb': round(psutil.virtual_memory().total / 2**30, 1),
            'elevated': elevated()}
    if IS_WIN:
        import winreg
        for name, key in [('webview2', r'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'),
                          ('edge', r'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}')]:
            try:
                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key) as k:
                    info[name] = winreg.QueryValueEx(k, 'pv')[0]
            except OSError:
                info[name] = None
    pat = re.compile(rb'[\\/]((?:tauri|wry|tauri-runtime-wry|tauri-plugin-fs|tauri-plugin-http|webview2-com|tao)-\d+\.\d+\.\d+)[\\/]')
    for n in ('patched', 'unpatched', 'shipped'):
        exe = os.environ.get('BENCH_EXE_' + n.upper(), '')
        if os.path.isfile(exe):
            blob = open(exe, 'rb').read()
            info['crates_' + n] = sorted({m.decode() for m in pat.findall(blob)})
            info['exe_mb_' + n] = mb(len(blob))
    return info


def guard_appdata():
    """Keep a real installation's data safe: the desktop runs delete the app's data folders."""
    if os.environ.get('GITHUB_ACTIONS') == 'true' or os.environ.get('BENCH_WIPE_APPDATA') == '1':
        return
    if not any(os.path.isfile(os.environ.get('BENCH_EXE_' + n.upper(), '')) for n in ('patched', 'unpatched', 'shipped')):
        return
    dirs = [d for d in (os.path.join(os.environ.get('APPDATA', ''), IDENT), os.path.join(os.environ.get('LOCALAPPDATA', ''), IDENT))
            if os.path.isdir(d)]
    if dirs:
        raise SystemExit('the desktop runs delete ' + ' and '.join(dirs) + ' (RisuAI data on this machine). '
                         'Back them up or move them away first, or set BENCH_WIPE_APPDATA=1 to let the harness delete them.')


def suite(name, quick=False):
    from playwright.sync_api import sync_playwright
    guard_appdata()
    if IS_WIN:
        kill_strays()
    emit({'test': 'env', 'suite': name, **env_info()})
    srv = start_servers()
    try:
        with sync_playwright() as pw:
            if name == 'stream':
                heavy_sends, simple_sends = (1, 2) if quick else (2, 6)
                for t in usable(pw, 'web', 'patched', 'unpatched', 'shipped'):
                    run_test(pw, 'stream', t_stream, t, 'db_small.bin', 'heavy', sends=heavy_sends)
                for t in usable(pw, 'web', 'patched', 'unpatched', 'shipped'):
                    run_test(pw, 'stream', t_stream, t, 'db_simple.bin', 'simple', sends=simple_sends if t in ('web', 'patched') else min(2, simple_sends))
            elif name == 'tick':
                for t in usable(pw, 'web', 'patched', 'shipped'):
                    run_test(pw, 'idle', t_idle, t, 'db_simple.bin', 'idle')
                for db, tag in (('db_small.bin', 'small'), ('db_big.bin', 'big')):
                    for t in usable(pw, 'web', 'patched', 'shipped'):
                        run_test(pw, 'tick', t_tick, t, db, tag, ticks=4 if quick else 12)
            elif name == 'micro':
                for t in usable(pw, 'patched', 'shipped'):
                    run_test(pw, 'micro', t_micro, t, 'db_simple.bin', 'micro', bench_assets=True, quick=quick)
            else:
                raise SystemExit('unknown suite ' + name)
    finally:
        kill_tree(srv.pid)
    summarize()


# ---------------------------------------------------------------- summary

def med(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 2) if xs else None


def summarize():
    path = os.path.join(WORK, 'results.jsonl')
    if not os.path.exists(path):
        print('no results')
        return
    rows = [json.loads(l) for l in open(path) if l.strip()]
    out = []
    p = out.append
    for r in rows:
        if r.get('test') == 'env':
            p(f"**env** `{json.dumps({k: v for k, v in r.items() if k != 'test'})}`\n")
    for r in rows:
        if r.get('test') == 'probe':
            p(f"**probe {r['target']}**: " + (f"ok, debugging port + page in {r.get('start_s')} s" if r.get('ok') else f"failed: `{r.get('error')}`"))
    p('')
    errs = [r for r in rows if r.get('error') and r.get('test') != 'probe']
    for r in rows:
        for m in r.get('micro_errors', []):
            errs.append({'test': 'micro', 'target': r['target'], 'tag': '', 'error': m})
    if errs:
        p('### errors')
        for r in errs:
            p(f"- {r['test']} {r['target']} {r.get('tag')}: `{r['error'][:300]}`")
        p('')
    st = [r for r in rows if r.get('test') == 'stream' and not r.get('error')]
    if st:
        p('### stream: send -> last chunk rendered (1500 chunks @300/s = 5 s stream)')
        p('| bot | target | sends (s) | long frames >200ms | max frame ms | DB saves (tauri/idb) | private MB after open -> end | peak private MB | heap MB end | crashed |')
        p('|---|---|---|---|---|---|---|---|---|---|')
        for r in st:
            runs = r.get('runs', [])
            p('| {} | {} | {} | {} | {} | {} | {} -> {} | {} | {} | {} |'.format(
                r['tag'], r['target'], ', '.join(str(x['send_to_end_s']) for x in runs),
                ', '.join(str(x['frames']['long200']) for x in runs), ', '.join(str(x['frames']['max']) for x in runs),
                ', '.join(f"{x['mon']['tauri_db_writes']}/{x['mon']['idb_db_puts']}" for x in runs),
                r.get('mem_after_open', {}).get('private_mb'), runs[-1]['mem']['private_mb'] if runs else None,
                r.get('mem_peak', {}).get('private_mb'), runs[-1]['heap'].get('used_mb') if runs else None, r.get('renderer_crashed')))
        p('')
    tk = [r for r in rows if r.get('test') == 'tick' and not r.get('error')]
    if tk:
        p('### Lua button tick (reloadDisplay + chat vars): HUD update latency')
        p('| db | target | tick median s | ticks (s) | long frames >200ms | jank ms | DB writes (tauri) | written MB | write ms max / sum | idb DB puts | peak private MB |')
        p('|---|---|---|---|---|---|---|---|---|---|---|')
        for r in tk:
            m = r.get('mon', {})
            p('| {} | {} | {} | {} | {} | {} | {} | {} | {} / {} | {} | {} |'.format(
                r['tag'], r['target'], r.get('tick_median_s'), ' '.join(str(x) for x in r.get('tick_s', [])),
                r.get('frames', {}).get('long200'), r.get('frames', {}).get('jank_ms'), m.get('tauri_db_writes'), m.get('tauri_db_write_mb'),
                m.get('tauri_db_write_ms_max'), m.get('tauri_db_write_ms_sum'), m.get('idb_db_puts'), r.get('mem_peak', {}).get('private_mb')))
        p('')
    idle = [r for r in rows if r.get('test') == 'idle' and not r.get('error')]
    if idle:
        p('### idle after boot (small save)')
        p('| target | private MB | working set MB | by role (private MB) | JS heap MB |')
        p('|---|---|---|---|---|')
        for r in idle:
            m = r.get('mem', {})
            p('| {} | {} | {} | {} | {} |'.format(r['target'], m.get('private_mb'), m.get('ws_mb'),
                                                 ', '.join(f"{k}:{v['private_mb']}" for k, v in m.get('by_role', {}).items()), r.get('heap', {}).get('used_mb')))
        p('')
    mi = [r for r in rows if r.get('test') == 'micro' and not r.get('error')]
    for r in mi:
        t = r['target']
        p(f'### micro ({t})')
        p('| MB | tauri write ms | tauri read ms | asset fetch ms | idb put ms | idb get ms | peak private MB |')
        p('|---|---|---|---|---|---|---|')
        for x in r.get('ipc', []):
            p(f"| {x['sizeMb']} | {x['tauri_write_ms']} | {x['tauri_read_ms']} | {x['asset_fetch_ms']} | {x['idb_put_ms']} | {x['idb_get_ms']} | {x.get('peak_private_mb')} |")
        p('')
        p('| save MB | 2x write_file + read_dir ms | per call ms | UI-thread ping max ms (idle max) | frame max ms | IndexedDB put ms (ping max) |')
        p('|---|---|---|---|---|---|')
        for x in r.get('save_stall', []):
            p(f"| {x['sizeMb']} | {x['save']['dur_ms']} | {x['save']['out']} | {x['save']['ping_max']} ({x['idle']['ping_max']}) | {x['save']['frame_max']} | {x['idb_same_size']['out']} ({x['idb_same_size']['ping_max']}) |")
        p('')
        p('| body MB | Array.from ms | invoke fetch ms | send ms | plain fetch ms | peak private MB |')
        p('|---|---|---|---|---|---|')
        for x in r.get('http_body', []):
            p(f"| {x['sizeMb']} | {x['array_from_ms']} | {x['ipc_fetch_ms']} | {x['send_ms']} | {x['plain_fetch_ms']} | {x.get('peak_private_mb')} |")
        p('')
        p('| kind | variant | median ms | p90 ms | requests | ping max ms | frame max ms |')
        p('|---|---|---|---|---|---|---|')
        for x in r.get('assets', []):
            p(f"| {x['kind']} | {x['variant']} | {x['median_ms']} | {x['p90_ms']} | {x['asset_requests']} | {x['ping_max']} | {x['frame_max']} |")
        p('')
    text = '\n'.join(out)
    print(text)
    with open(os.path.join(WORK, 'summary.md'), 'w') as f:
        f.write(text + '\n')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['suite', 'summarize'])
    ap.add_argument('name', nargs='?')
    ap.add_argument('--quick', action='store_true')
    a = ap.parse_args()
    if a.cmd == 'suite':
        suite(a.name, a.quick)
    else:
        summarize()
