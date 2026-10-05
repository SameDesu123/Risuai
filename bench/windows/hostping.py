#!/usr/bin/env python3
# How long a window's UI thread is unavailable: sends WM_NULL with SendMessageTimeout every 20 ms to the largest visible
# top-level window of a process and records the round trips. On the desktop build that window belongs to the thread
# wry runs IPC and custom-protocol handlers on. Runs in its own process so the harness's threads cannot skew it.
# Started by bench.py; prints "ready" once it pings (or gave up finding the window), then one JSON line after a line on
# stdin (or EOF).
# usage: python hostping.py <pid>
import ctypes, json, sys, threading, time
from ctypes import wintypes

user32 = ctypes.WinDLL('user32', use_last_error=True)
WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = [WNDENUMPROC, wintypes.LPARAM]
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.SendMessageTimeoutW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM, wintypes.UINT, wintypes.UINT,
                                       ctypes.POINTER(ctypes.c_size_t)]
user32.SendMessageTimeoutW.restype = ctypes.c_ssize_t
ERROR_INVALID_WINDOW_HANDLE = 1400


def find_window(pid):
    best, area = None, 0

    @WNDENUMPROC
    def cb(hwnd, _):
        nonlocal best, area
        p = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
        if p.value == pid and user32.IsWindowVisible(hwnd):
            r = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r))
            a = (r.right - r.left) * (r.bottom - r.top)
            if a > area:
                best, area = hwnd, a
        return True

    user32.EnumWindows(cb, 0)
    return best


def main():
    pid = int(sys.argv[1])
    stop = threading.Event()
    threading.Thread(target=lambda: (sys.stdin.readline(), stop.set()), daemon=True).start()
    hwnd, t0 = None, time.time()
    while not stop.is_set() and hwnd is None and time.time() - t0 < 30:
        hwnd = find_window(pid)
        if hwnd is None:
            time.sleep(0.2)
    lat, stalls, timeouts, err = [], [], 0, None
    res = ctypes.c_size_t()
    print('ready', flush=True)  # bench.py waits for this before starting what it measures
    start = time.time()
    while hwnd and not stop.is_set():
        t = time.perf_counter()
        ok = user32.SendMessageTimeoutW(hwnd, 0, 0, 0, 0, 10000, ctypes.byref(res))  # WM_NULL, SMTO_NORMAL, 10 s
        dt = (time.perf_counter() - t) * 1000
        if not ok:
            if ctypes.get_last_error() == ERROR_INVALID_WINDOW_HANDLE:
                err = 'window gone'
                break
            timeouts += 1
        lat.append(dt)
        if dt > 100:
            stalls.append([round(time.time() - start - dt / 1000, 2), round(dt)])  # [start, s after ping start], [length ms]
        time.sleep(0.02)
    lat.sort()

    def q(f):
        return round(lat[min(len(lat) - 1, int(len(lat) * f))], 1) if lat else None

    print(json.dumps({'window': bool(hwnd), 'n': len(lat), 'p50_ms': q(0.5), 'p99_ms': q(0.99), 'max_ms': round(lat[-1]) if lat else None,
                      'over_100': sum(x > 100 for x in lat), 'over_500': sum(x > 500 for x in lat), 'over_1000': sum(x > 1000 for x in lat),
                      'blocked_s': round(sum(x for x in lat if x > 50) / 1000, 2), 'timeouts': timeouts, 'stalls': stalls[:60],
                      'start_epoch': round(start, 3), 'err': err}), flush=True)


if __name__ == '__main__':
    main()
