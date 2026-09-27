#!/usr/bin/env python3
"""无头浏览器截图，用来自检画面。
用法: python tools/shot.py 输出.png [宽] [高] [url]
"""
import os
import subprocess
import sys

BROWSERS = [
    r"C:/Program Files/Google/Chrome/Application/chrome.exe",
    r"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
]


def shot(out, w=1920, h=1080, url="http://127.0.0.1:8765/?debug=1", budget=9000):
    exe = next((b for b in BROWSERS if os.path.exists(b)), None)
    if not exe:
        sys.exit("找不到 Chrome / Edge")
    tmp_profile = os.path.join(os.environ.get("TEMP", "."), "moyu-shot-profile")
    cmd = [
        exe, "--headless=new", "--disable-gpu", "--no-sandbox",
        "--force-device-scale-factor=1", "--hide-scrollbars",
        f"--user-data-dir={tmp_profile}",
        f"--window-size={w},{h}",
        f"--virtual-time-budget={budget}",
        "--enable-logging=stderr", "--log-level=0",
        f"--screenshot={os.path.abspath(out)}",
        url,
    ]
    p = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=180)
    logs = (p.stderr or "") + (p.stdout or "")
    bad = [ln for ln in logs.splitlines()
           if any(k in ln for k in ("ERROR", "error", "Uncaught", "failed", "CONSOLE"))]
    print("saved ->", out, os.path.getsize(out) if os.path.exists(out) else "MISSING")
    for ln in bad[:25]:
        print("  ", ln.strip()[:220])
    return out


if __name__ == "__main__":
    a = sys.argv[1:]
    shot(a[0] if a else ".tmp_shot.png",
         int(a[1]) if len(a) > 1 else 1920,
         int(a[2]) if len(a) > 2 else 1080,
         a[3] if len(a) > 3 else "http://127.0.0.1:8765/?debug=1")
