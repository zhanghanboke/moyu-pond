#!/usr/bin/env python3
"""
matting.py -- 把 AI 生成的品红底素材抠成透明 PNG，并派生"深水"变体。

抠图思路（对渐变背景鲁棒）：
  1. 品红/粉色背景的特征是 G 通道远低于 R 和 B。用 score = min(R,B) - G 做色键，
     比"到某个固定键色的距离"更能容忍生成图里的背景渐变。
  2. 只从图像边界向内做连通区域生长（region growing），避免把荷花花瓣这类
     偏粉的像素误抠掉——被前景包住的相似色不会被删。
  3. 边界用 smoothstep 做软 alpha + 1px 羽化，再做去色溢(despill)去掉品红毛边。
  4. 最后按面积丢弃小的孤立前景块（右下角 "Qoder AI 生成" 水印就是这种）。
  5. 底图 pond_base 是满幅图，水印用 cv2.inpaint 修复。
"""
import os
import sys
import glob
import numpy as np
import cv2
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(os.path.dirname(ROOT), "vibe_images")
OUT = os.path.join(ROOT, "assets")

# score 阈值：> T_HI 判定为背景，[T_LO, T_HI] 之间做软过渡
T_LO, T_HI = 20.0, 58.0
GROW_TOL = 14.0          # 区域生长时允许的背景相似度（宽松，保证边缘那圈渐变被吃掉）
BORDER_FORCE = 5         # 最外 5px 直接判为背景：生成图的背景在边角总会变暗/退饱和
MIN_COMP_AREA_RATIO = 0.02  # 前景孤立块面积 < 最大块的 2% 则丢弃
MAX_W = {'fish': 340, 'decor': 420, 'creature': 200}   # 素材最长边上限：屏幕上鱼只有 22~150px，
                                      # 900px 的原图除了白白吃内存没有任何用处


def load_rgb(path):
    return np.array(Image.open(path).convert("RGB"), dtype=np.float32)


def key_score(rgb):
    """越大越像品红背景。"""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return np.minimum(r, b) - g


def grow_from_border(similar):
    """在 similar 掩膜内，从所有边界像素向内做 8 邻域连通生长。"""
    region = np.zeros_like(similar)
    region[0, :] = similar[0, :]
    region[-1, :] = similar[-1, :]
    region[:, 0] = similar[:, 0]
    region[:, -1] = similar[:, -1]
    kernel = np.ones((3, 3), np.uint8)
    prev = -1
    while True:
        grown = cv2.dilate(region.astype(np.uint8), kernel, iterations=1).astype(bool) & similar
        region = grown
        n = int(region.sum())
        if n == prev:
            break
        prev = n
    return region


def despill(rgba, alpha):
    """去掉半透明边缘上的品红色溢。前景像素若 min(R,B) 明显高于 G，把 R/B 拉向 G。"""
    r, g, b = rgba[..., 0], rgba[..., 1], rgba[..., 2]
    excess = np.minimum(r, b) - g
    band = (excess > 6) & (alpha > 0.02) & (alpha < 250)
    pull = np.clip(excess * 0.85, 0, 90)
    # 以 G 为基准把 R 和 B 一起往下拉（保持色相不偏绿）
    ref = np.maximum(g, np.minimum(r, b) - pull)
    rgba[..., 0] = np.where(band, np.minimum(r, ref + 12), r)
    rgba[..., 2] = np.where(band, np.minimum(b, ref + 12), b)
    return rgba


def fix_magenta_hue(rgba):
    """芦苇那种半透明叶片会被品红底"浸"进本体颜色里，边缘抠不掉。
    做法：把落在品红/洋红色相区间的像素整体搬到绿色相，饱和度收一半。
    只对 reeds 这类绿色素材用，荷花那种合法的粉色不能走这里。"""
    a = rgba[..., 3:4]
    rgb = np.clip(rgba[..., :3], 0, 255).astype(np.uint8)
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV_FULL).astype(np.int32)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    hit = ((h > 186) | (h < 6)) & (s > 34)
    hsv[..., 0] = np.where(hit, 92 + (h % 24), hsv[..., 0])
    hsv[..., 1] = np.where(hit, (s * 0.5).astype(np.int32), s)
    out = cv2.cvtColor(np.clip(hsv, 0, 255).astype(np.uint8), cv2.COLOR_HSV2RGB_FULL).astype(np.float32)
    rgba[..., :3] = out
    rgba[..., 3] = a[..., 0]
    return rgba


def unify_water(rgba, ref=(38.0, 135.0, 118.0), sat_max=0.30, ramp=0.12, vmax=0.62, fade=0.0):
    """把素材里"被画出来的水"换成真实池水色。
    芦苇自带一圈水盘，AI 画成灰绿色：亮度 120 和池水(117)几乎一样，但饱和度只有
    0.19（池水 0.72），红通道高出一截 —— 所以看起来是淡紫灰的一坨。

    做法：保持像素自己的明度(V=max 通道)，只把三通道的比例换成池水的比例。
    V 还要封顶，否则涟漪高光的 0.84 会被放大成荧光青 —— 之前就是这么翻车的。
    fade>0 时再把这部分 alpha 降下来，让真实池底透出来：光换色还会留一圈
    圆形轮廓，透明掉才真的看不出来。"""
    rgb = rgba[..., :3]
    mx = np.maximum(np.maximum(rgb[..., 0], rgb[..., 1]), rgb[..., 2])
    mn = np.minimum(np.minimum(rgb[..., 0], rgb[..., 1]), rgb[..., 2])
    sat = (mx - mn) / np.maximum(mx, 1.0)
    wgt = np.clip((sat_max - sat) / ramp, 0.0, 1.0)
    ratio = np.array(ref, np.float32) / max(ref)
    target = (np.clip(mx / 255.0, 0, vmax) * 255.0)[..., None] * ratio
    rgba[..., :3] = np.clip(rgb * (1 - wgt[..., None]) + target * wgt[..., None], 0, 255)
    if fade > 0:
        rgba[..., 3] = rgba[..., 3] * (1.0 - fade * wgt)
    return rgba


def tint(rgba, sat=1.0, val=1.0, water=0.0, jade=(28.0, 128.0, 114.0), hue=0, hue_band=None):
    """把素材往水色里拉一点，别像"贴纸"浮在水面上。
    hue + hue_band=(lo,hi)：只在指定色相区间(HSV_FULL 0-255 对应 0-360°)内转色相，
    用来把浮萍里 AI 画的枯黄碎叶掰成绿色，而不动荷花那种合法的粉色。"""
    a = rgba[..., 3:4].copy()
    rgb = np.clip(rgba[..., :3], 0, 255).astype(np.uint8)
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV_FULL).astype(np.float32)
    hsv[..., 1] = np.clip(hsv[..., 1] * sat, 0, 255)
    hsv[..., 2] = np.clip(hsv[..., 2] * val, 0, 255)
    if hue and hue_band:
        h = hsv[..., 0]
        m = (h >= hue_band[0]) & (h <= hue_band[1])
        hsv[..., 0] = np.where(m, np.clip(h + hue, 0, 255), h)
    rgb = cv2.cvtColor(np.clip(hsv, 0, 255).astype(np.uint8), cv2.COLOR_HSV2RGB_FULL).astype(np.float32)
    if water > 0:
        rgb = rgb * (1 - water) + np.array(jade) * water
    rgba[..., :3] = rgb
    rgba[..., 3] = a[..., 0]
    return rgba


def drop_small_components(alpha_u8, min_ratio=MIN_COMP_AREA_RATIO):
    """只保留主体：与最大连通块的包围盒（外扩 24px）相交的才算主体的一部分。
    右下角水印离鱼身很远，会被这一步干掉；荷叶/芦苇那种互相搭着的叶片会保留。"""
    n, lab, stats, _ = cv2.connectedComponentsWithStats(alpha_u8, connectivity=8)
    if n <= 2:
        return alpha_u8, 0
    areas = stats[1:, cv2.CC_STAT_AREA]
    main = int(np.argmax(areas)) + 1
    mx, my, mw, mh = stats[main, cv2.CC_STAT_LEFT], stats[main, cv2.CC_STAT_TOP], \
        stats[main, cv2.CC_STAT_WIDTH], stats[main, cv2.CC_STAT_HEIGHT]
    pad = 24
    x0, x1 = mx - pad, mx + mw + pad
    y0, y1 = my - pad, my + mh + pad
    keep = np.zeros(n, np.uint8)
    removed = 0
    for i in range(1, n):
        a = stats[i, cv2.CC_STAT_AREA]
        bx, by = stats[i, cv2.CC_STAT_LEFT], stats[i, cv2.CC_STAT_TOP]
        bw, bh = stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT]
        overlaps = not (bx + bw < x0 or bx > x1 or by + bh < y0 or by > y1)
        if i == main or (overlaps and a >= areas.max() * min_ratio):
            keep[i] = 255
        else:
            removed += 1
    lut = keep[lab]
    return np.where(lut > 0, alpha_u8, 0).astype(np.uint8), removed


def matte(path, out_path, deep_paths=(), post=None, max_w=None):
    rgb = load_rgb(path)
    h, w = rgb.shape[:2]
    score = key_score(rgb)
    similar = score > GROW_TOL
    k = BORDER_FORCE
    similar[:k, :] = similar[-k:, :] = True
    similar[:, :k] = similar[:, -k:] = True
    bg = grow_from_border(similar)

    # 软 alpha：背景连通区内按 score 平滑衰减到 0
    soft = np.clip((score - T_LO) / (T_HI - T_LO), 0.0, 1.0)
    alpha = 1.0 - np.where(bg, soft, 0.0)
    # 生长区之外一律不透明，避免前景内部出现半透明洞
    alpha[~bg & (score > T_HI)] = 1.0
    alpha = cv2.GaussianBlur(alpha.astype(np.float32), (0, 0), 0.9)

    rgba = np.dstack([rgb, alpha * 255.0]).astype(np.float32)
    rgba = despill(rgba, rgba[..., 3])
    if post:
        rgba = post(rgba)
    a_u8 = np.clip(rgba[..., 3], 0, 255).astype(np.uint8)
    a_u8, removed = drop_small_components(a_u8)
    rgba[..., 3] = a_u8

    # 裁到内容包围盒（留 2px 余量）
    ys, xs = np.where(a_u8 > 8)
    if len(xs) == 0:
        print(f"!! {os.path.basename(path)} 抠完是空的")
        return None
    x0, x1 = max(xs.min() - 2, 0), min(xs.max() + 3, w)
    y0, y1 = max(ys.min() - 2, 0), min(ys.max() + 3, h)
    crop = rgba[y0:y1, x0:x1]
    scale = 1.0
    if max_w and crop.shape[1] > max_w:
        # 带 alpha 的降采样要先转预乘，否则透明像素会把边缘染黑一圈
        scale = max_w / crop.shape[1]
        nw = int(round(crop.shape[1] * scale)); nh = int(round(crop.shape[0] * scale))
        pre = crop.copy()
        pre[..., :3] *= pre[..., 3:4] / 255.0
        big = cv2.resize(pre, (nw, nh), interpolation=cv2.INTER_AREA)
        a = big[..., 3:4]
        big[..., :3] = np.where(a > 1.0, big[..., :3] * 255.0 / np.maximum(a, 1.0), 0.0)
        crop = np.clip(big, 0, 255)
    img = Image.fromarray(np.dstack([np.clip(crop[..., :3], 0, 255).astype(np.uint8),
                                     crop[..., 3].astype(np.uint8)]), "RGBA")
    img.save(out_path)
    fg_pct = 100.0 * (a_u8 > 128).mean()
    print(f"  {os.path.basename(out_path):22s} {img.size[0]}x{img.size[1]:<5d} "
          f"前景 {fg_pct:4.1f}%  丢弃孤立块 {removed}  降采样 x{scale:.2f}")

    # 派生"深水"变体：模糊 + 往水色压暗（模糊半径跟着降采样比例缩）
    for dp, blur, tint, amul in deep_paths:
        arr = crop.copy()
        b = blur * scale
        arr[..., :3] = cv2.GaussianBlur(arr[..., :3], (0, 0), b)
        arr[..., 3] = cv2.GaussianBlur(arr[..., 3], (0, 0), b)
        jade = np.array([30.0, 130.0, 116.0])
        arr[..., :3] = arr[..., :3] * (1 - tint) + jade * tint
        arr[..., 3] = arr[..., 3] * amul
        Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA").save(dp)
        print(f"      -> {os.path.basename(dp)}")
    return img.size


def find(pattern):
    hits = sorted(glob.glob(os.path.join(SRC, pattern)))
    if not hits:
        sys.exit(f"找不到素材: {pattern}")
    return hits[-1]  # 取时间戳最新的


def flatten_field(rgb, strength=0.6, sigma_frac=0.09):
    """平场校正：把大尺度的明暗不均（露白斑 / 死黑团）压掉，只留中频的斑驳纹理。
    生成图的水彩洗色总是有几块特别白或特别暗，直接当壁纸会很难看。
    strength=1 完全抹平，0 不动；0.6 保留一点自然起伏。"""
    h, w = rgb.shape[:2]
    sigma = max(6.0, w * sigma_frac)
    out = rgb.copy()
    for c in range(3):
        ch = rgb[..., c].astype(np.float32)
        field = cv2.GaussianBlur(ch, (0, 0), sigma)
        target = np.median(field)
        gain = np.power(np.clip(target / np.maximum(field, 1e-2), 0.55, 1.8), strength)
        out[..., c] = np.clip(ch * gain, 0, 255)
    return out


def soften(rgb, sigma=5.0, hf_keep=0.28):
    """压掉高频细节：生成图爱画"阳光照在圆石头上的高光"，那种立体感会让池底
    看起来像一堆鹅卵石，而参考图只是柔和的藻斑。保留 (1-hf_keep) 的低频就够了。"""
    arr = rgb.astype(np.float32)
    smooth = cv2.GaussianBlur(arr, (0, 0), sigma)
    return np.clip(smooth + (arr - smooth) * hf_keep, 0, 255).astype(np.uint8)


def grade_water(rgb, scale=(0.60, 1.16, 1.32)):
    """把生成图的"橄榄绿"推到参考图那种"青蓝翡翠"。
    实测参考图水面 meanRGB=(41,139,120)、H=169°、S=0.73、B/R=3.2；
    生成图是 (72,126,97)、H=151°、S=0.43、B/R=1.3 —— 差在红通道太重、蓝太轻。
    所以按通道乘一遍就能对上，不用碰色相。"""
    f = np.array(scale, np.float32)
    return np.clip(rgb.astype(np.float32) * f, 0, 255).astype(np.uint8)


def rolloff_highlights(rgb, knee=0.70, ratio=0.42):
    """压高光：平场校正会把大片浅滩提亮成"奶白"，看着像过曝而不像水。
    超过 knee 的亮度只保留 ratio 倍的增量，柔和地压回去。"""
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV_FULL).astype(np.float32)
    v = hsv[..., 2] / 255.0
    over = v > knee
    v2 = np.where(over, knee + (v - knee) * ratio, v)
    hsv[..., 2] = np.clip(v2 * 255.0, 0, 255)
    return cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2RGB_FULL)


def fix_base(path, out_path, crop=0.06):
    """满幅底图：先 inpaint 掉右下角水印，再把四周那圈露白的纸边裁掉
    （生成图的水彩洗色不会正好铺满画布，留边会在桌面上显成一道框）。"""
    rgb = load_rgb(path).astype(np.uint8)
    h, w = rgb.shape[:2]
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.int32)
    rect = np.zeros((h, w), np.uint8)
    rect[int(h * 0.86):, int(w * 0.62):] = 1
    ys, xs = np.where(rect > 0)
    med = int(np.median(gray[ys, xs]))
    badge = ((gray < med - 45) & (rect > 0)).astype(np.uint8)
    n_px = int(badge.sum())
    if 200 < n_px < len(ys) * 0.15:
        badge = cv2.dilate(badge, np.ones((5, 5), np.uint8), iterations=2)
        rgb = cv2.inpaint(rgb, badge, 6, cv2.INPAINT_TELEA)
        print(f"  水印 {n_px}px -> inpaint")
    else:
        print(f"  !! 水印检测可疑 ({n_px}px/{len(ys)}px, 中位亮度 {med})，跳过")
    cx, cy = int(w * crop), int(h * crop)
    rgb = rgb[cy:h - cy, cx:w - cx]
    before = rgb.astype(np.float32)
    rgb = flatten_field(before, strength=0.62).astype(np.uint8)
    rgb = soften(rgb, sigma=8.0, hf_keep=0.32)
    rgb = grade_water(rgb)
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV_FULL).astype(np.float32)
    hsv[..., 1] = np.clip(hsv[..., 1] * 1.10, 0, 255)
    rgb = cv2.cvtColor(np.clip(hsv, 0, 255).astype(np.uint8), cv2.COLOR_HSV2RGB_FULL)
    # 高光压制放在最后：调色会把浅滩再提亮一档，得在它之后收
    rgb = rolloff_highlights(rgb, knee=0.66, ratio=0.40)
    Image.fromarray(rgb, "RGB").save(out_path)
    # 报告校正前后的均匀度（标准差越小越平）
    g0 = cv2.cvtColor(before.astype(np.uint8), cv2.COLOR_RGB2GRAY)
    g1 = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    print(f"  {os.path.basename(out_path)} {rgb.shape[1]}x{rgb.shape[0]}  "
          f"明暗波动 std {g0.std():.1f} -> {g1.std():.1f} (裁掉四周 {int(crop*100)}% 纸边)")


FISH = {
    "koi_kohaku": "koi_kohaku_*.png",
    "koi_orange": "koi_orange_*.png",
    "koi_gold": "koi_gold_*.png",
    "koi_panda": "koi_panda_*.png",
    "koi_silver": "koi_silver_*.png",
}
PLANTS = {
    "lotus_pad": "lotus_pad_*.png",
    "lotus_flower": "lotus_flower_*.png",
    "reeds": "reeds_v3_*.png",
    "rocks": "rocks_v3_*.png",
    "duckweed": "duckweed_*.png",
}


CREATURES = {
    "turtle_green": "turtle_green_*.png",
    "turtle_brown": "turtle_brown_*.png",
    "butterfly_monarch": "butterfly_monarch_*.png",
    "butterfly_pale": "butterfly_pale_*.png",
}


def build_weed(path, out_path):
    """水下植物层。这张是满幅的（没有品红底可抠），所以换个思路：
    把"比局部背景更暗"的量当成 alpha，颜色压成暗橄榄绿 —— 得到一张
    只有植物、背景全透明的图层，之后烘进背景缓存，每帧零开销。"""
    rgb = load_rgb(path)
    h, w = rgb.shape[:2]
    # 裁掉四周：右下角有水印，边缘色调也不稳
    rgb = rgb[int(h * 0.05):int(h * 0.92), int(w * 0.05):int(w * 0.90)]
    lum = rgb.mean(axis=2)
    bg = cv2.GaussianBlur(lum, (0, 0), 45)
    dark = bg - lum
    span = max(1e-2, float(np.percentile(dark, 98.5)))
    alpha = np.clip(dark / span, 0, 1) ** 1.35
    alpha = cv2.GaussianBlur(alpha.astype(np.float32), (0, 0), 1.2)
    jade = np.array([14.0, 70.0, 58.0], np.float32)
    col = np.clip(rgb * 0.34 + jade * 0.66, 0, 255)
    out = np.dstack([col, alpha * 255.0]).astype(np.uint8)
    Image.fromarray(out, "RGBA").save(out_path)
    print(f"  {os.path.basename(out_path)} {out.shape[1]}x{out.shape[0]}  "
          f"覆盖 {100 * (alpha > 0.15).mean():.0f}%  峰值 alpha {alpha.max():.2f}")


if __name__ == "__main__":
    # --only=reeds,rocks 只重跑指定素材，调参时省几分钟（区域生长很慢）
    only = None
    for arg in sys.argv[1:]:
        if arg.startswith('--only='):
            only = set(arg[7:].split(','))
    os.makedirs(OUT, exist_ok=True)
    if not only or "pond_base" in only:
        print("== 底图 ==")
        cands = [glob.glob(os.path.join(SRC, f"pond_base_v{n}_*.png")) for n in (3, 4, 2)]
        base = next((sorted(c)[-1] for c in cands if c), find("pond_base_*.png"))
        print("  使用", os.path.basename(base))
        fix_base(base, os.path.join(OUT, "pond_base.png"))

    if not only or any(n in only for n in FISH):
        print("== 锦鲤 ==")
        for name, pat in FISH.items():
            if only and name not in only: continue
            # _soft/_mid/_deep 是三档"水层"：越深越糊、越往水色偏、越透明。
            # 浅水鱼也用 _soft（只糊 1px、混 12% 水色），不然会像贴纸浮在上面。
            matte(find(pat), os.path.join(OUT, name + ".png"),
                  deep_paths=[(os.path.join(OUT, name + "_soft.png"), 1.0, 0.12, 0.96),
                              (os.path.join(OUT, name + "_mid.png"), 2.2, 0.30, 0.80),
                              (os.path.join(OUT, name + "_deep.png"), 4.5, 0.54, 0.52)],
                  max_w=MAX_W['fish'])

    if not only or any(n in only for n in PLANTS):
        print("== 植物/石头 ==")
        POST = {
            # 荷叶/石头要"泡"在水里：压饱和、压亮度、混一点水色；
            # 芦苇和浮萍的半透明叶片会被品红底浸染，先把品红色相整体搬到绿色相。
            "reeds": lambda a: tint(unify_water(fix_magenta_hue(a), fade=0.62), sat=0.94, val=0.99, water=0.02),
            "lotus_pad": lambda a: tint(a, sat=0.82, val=0.90, water=0.11),
            "lotus_flower": lambda a: tint(a, sat=0.88, val=0.95, water=0.06),
            "rocks": lambda a: tint(fix_magenta_hue(a), sat=0.80, val=0.78, water=0.16),
            "duckweed": lambda a: tint(fix_magenta_hue(a), sat=0.90, val=0.88, water=0.14,
                                       hue=34, hue_band=(0, 24)),   # 枯黄碎叶 -> 黄绿
        }
        for name, pat in PLANTS.items():
            if only and name not in only: continue
            matte(find(pat), os.path.join(OUT, name + ".png"), post=POST.get(name), max_w=MAX_W['decor'])

    if not only or any(n in only for n in CREATURES):
        print("== 小动物 ==")
        CPOST = {
            # 乌龟趴在石头上、蝴蝶在空中，都不该被水色染，只轻微收一点饱和
            "turtle_green": lambda a: tint(a, sat=0.92, val=0.94, water=0.03),
            "turtle_brown": lambda a: tint(a, sat=0.92, val=0.94, water=0.03),
            "butterfly_monarch": lambda a: tint(a, sat=0.96, val=1.0, water=0.0),
            "butterfly_pale": lambda a: tint(a, sat=0.96, val=1.0, water=0.0),
        }
        for name, pat in CREATURES.items():
            if only and name not in only: continue
            matte(find(pat), os.path.join(OUT, name + ".png"),
                  post=CPOST.get(name), max_w=MAX_W['creature'])

    if not only or "weed_layer" in only:
        print("== 水下植物层 ==")
        build_weed(find("weed_sub_*.png"), os.path.join(OUT, "weed_layer.png"))
    print("done ->", OUT)
