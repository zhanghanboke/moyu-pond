#!/usr/bin/env python3
"""qa.py —— 拿截图和参考图做量化对比：水色、鱼群密度/体长、装饰占比。

参考图由调用方给（不写死在代码里，免得把本机路径带进仓库）：
    python tools/qa.py 截图.png 参考图.png
    MOYU_REF=参考图.png python tools/qa.py 截图.png

参考图就是你想对齐的那张图（一般是原版壁纸截图或设计稿）。
要装的包：numpy opencv-python pillow
"""
import os
import sys
import numpy as np
import cv2
from PIL import Image

# 参考图里避开桌面图标、任务栏、字幕的"纯水"区域。
# 坐标按 1065×615 归一化，换一张参考图要按同比例重新框一块没有装饰的纯水面。
REF_BOX = (120, 40, 940, 520)


def load(path, box=None):
    im = Image.open(path).convert('RGB')
    w, h = im.size
    if box:
        x0, y0, x1, y1 = box
        im = im.crop((int(x0 / 1065 * w), int(y0 / 615 * h), int(x1 / 1065 * w), int(y1 / 615 * h)))
    return np.array(im).astype(np.int32)


def water_stats(a, nm):
    hsv = cv2.cvtColor(np.clip(a, 0, 255).astype(np.uint8), cv2.COLOR_RGB2HSV_FULL).astype(float)
    h, s, v = hsv[..., 0] * 360 / 255, hsv[..., 1] / 255, hsv[..., 2] / 255
    m = (v > 0.2) & (v < 0.85) & (s > 0.15)
    g = cv2.cvtColor(np.clip(a, 0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(float)
    hi = (g - cv2.GaussianBlur(g, (0, 0), 12)).std()
    lo = cv2.GaussianBlur(g, (0, 0), 40).std()
    return dict(nm=nm, H=np.median(h[m]), S=np.median(s[m]), V=np.median(v[m]),
                mean=a.mean(axis=(0, 1)), hi=hi, lo=lo)


def fish_stats(a, nm):
    h, w = a.shape[:2]
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    lum = (r + g + b) / 3
    warm = (r - b > 55) & (r > 140)
    pale = (lum > 175) & (np.abs(r - g) < 40) & (b < g + 25)
    m = (warm | pale).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    L, areas = [], []
    for i in range(1, n):
        ar = st[i, cv2.CC_STAT_AREA]
        bw, bh = st[i, cv2.CC_STAT_WIDTH], st[i, cv2.CC_STAT_HEIGHT]
        if ar < 40 or ar > 0.004 * w * h:
            continue
        if max(bw, bh) < 8 or max(bw, bh) > 0.09 * w:
            continue
        L.append(max(bw, bh) / w * 100)   # 体长占屏宽 %
        areas.append(ar)
    L = np.array(L)
    return dict(nm=nm, n=len(L), med=np.median(L) if len(L) else 0,
                p95=np.percentile(L, 95) if len(L) else 0,
                dens=len(L) / (w * h) * 1e6)   # 条/百万像素


def report(ref_path, shot_path):
    ref = load(ref_path)
    # 两边都取同一块相对区域（避开暗角、装饰和 HUD），否则整帧对比会把 V 拉低
    refw = ref[40:520, 120:940]
    shotw = load(shot_path, box=(120, 40, 940, 520))
    rw, sw = water_stats(refw, '参考'), water_stats(shotw, '截图')
    print('=== 水色（越接近越好）===')
    print(f"{'':6s}{'H(度)':>8s}{'S':>7s}{'V':>7s}{'meanRGB':>20s}{'高频':>7s}{'低频':>7s}")
    for d in (rw, sw):
        print(f"{d['nm']:6s}{d['H']:8.1f}{d['S']:7.2f}{d['V']:7.2f}"
              f"{'(%d,%d,%d)' % tuple(d['mean'].astype(int)):>20s}{d['hi']:7.1f}{d['lo']:7.1f}")
    dH = abs(rw['H'] - sw['H']); dS = abs(rw['S'] - sw['S']); dV = abs(rw['V'] - sw['V'])
    dm = np.abs(rw['mean'] - sw['mean']).mean()
    print(f"  偏差: ΔH={dH:.1f}°  ΔS={dS:.2f}  ΔV={dV:.2f}  平均通道差={dm:.1f}")

    # 鱼是成群的，只取中间一小块会因为采样位置而严重失真；
    # 鱼群密度改用整幅（参考图去掉左侧图标列和底部字幕带）统计
    reff = ref[20:545, 30:1065]
    shotf = load(shot_path, box=(30, 20, 1065, 545))
    rf, sf = fish_stats(reff, '参考'), fish_stats(shotf, '截图')
    print('=== 鱼群（检出=亮色连通块，深水鱼检不出，所以是下限）===')
    print(f"{'':6s}{'检出条数':>9s}{'体长中位(%宽)':>15s}{'体长p95':>9s}{'密度(条/百万px)':>17s}")
    for d in (rf, sf):
        print(f"{d['nm']:6s}{d['n']:9d}{d['med']:15.2f}{d['p95']:9.2f}{d['dens']:17.1f}")
    print(f"  -> 密度比 截图/参考 = {sf['dens']/max(rf['dens'],1e-6):.2f}   体长比 = {sf['med']/max(rf['med'],1e-6):.2f}")


if __name__ == '__main__':
    args = sys.argv[1:]
    shot = args[0] if args else '.tmp_shot.png'
    ref = args[1] if len(args) > 1 else os.environ.get('MOYU_REF')
    if not ref:
        sys.exit('用法: python tools/qa.py <截图.png> <参考图.png>\n'
                 '      （参考图也可以用环境变量 MOYU_REF 指定）')
    if not os.path.exists(ref):
        sys.exit(f'找不到参考图: {ref}')
    if not os.path.exists(shot):
        sys.exit(f'找不到截图: {shot}')
    report(ref, shot)
