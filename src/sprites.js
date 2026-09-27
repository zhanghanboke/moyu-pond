/* sprites.js —— 素材加载、摆尾切片绘制、水波焦散贴图
 *
 * 约定：所有锦鲤素材的"头朝右"，即 sprite 的 +x 方向就是鱼前进方向，
 * 渲染时按航向角旋转即可。 */
(function (global) {
  'use strict';

  const KOI = ['koi_kohaku', 'koi_orange', 'koi_gold', 'koi_panda', 'koi_silver'];
  const DECOR = ['lotus_pad', 'lotus_flower', 'reeds', 'rocks', 'duckweed'];
  const CREATURES = ['turtle_green', 'turtle_brown', 'butterfly_monarch', 'butterfly_pale'];
  const DEPTH_VARIANTS = ['', '_soft', '_mid', '_deep'];

  const assets = {
    base: null,
    koi: {},      // name -> { variants, atlas, w, h }
    decor: {},    // name -> Image
    creatures: {},// 乌龟/蝴蝶
    weed: null,   // 水下植物层（透明底，烘进背景缓存）
    caustics: null,
    customRecs: {},   // kind -> rec：画板捏的每条鱼一份图集
    customOn: true,   // "我的锦鲤"总开关：关掉只是不让鱼群选中，图集还留着
    ready: false,
  };

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('加载失败: ' + src));
      im.src = src;
    });
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  /* 焦散光网：ridged value noise，画成一张可平铺的灰度贴图。
   * 运行时用 overlay 混合 + 缓慢双向平移，就是水面流动的光。 */
  function buildCaustics(size) {
    const c = makeCanvas(size, size);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const d = img.data;

    const perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    let seed = 20260926;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 255; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; const t = p[i]; p[i] = p[j]; p[j] = t; }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

    function grad(ix, iy, x, y) {
      const h = perm[(perm[ix & 255] + (iy & 255)) & 511] & 7;
      const u = h < 4 ? x : y;
      const v = h < 4 ? y : x;
      return ((h & 1) ? -u : u) + ((h & 2) ? -2 * v : 2 * v);
    }
    function noise(x, y) {
      const X = Math.floor(x), Y = Math.floor(y);
      const xf = x - X, yf = y - Y;
      const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
      const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
      const a = grad(X, Y, xf, yf), b = grad(X + 1, Y, xf - 1, yf);
      const cc = grad(X, Y + 1, xf, yf - 1), dd = grad(X + 1, Y + 1, xf - 1, yf - 1);
      return (a + u * (b - a) + v * (cc - a + u * (dd - cc - b + a))) * 0.32;
    }
    // 平铺：把频率对齐到整数个周期
    const S = size;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        let sum = 0, amp = 1, freq = 4 / S;
        for (let o = 0; o < 3; o++) {
          const n = noise(x * freq * 64, y * freq * 64);
          sum += (1 - Math.abs(n)) * amp;   // ridged -> 细亮脉络
          amp *= 0.5; freq *= 2.03;
        }
        let v = Math.pow(Math.max(0, sum / 1.75), 3.4);
        v = Math.min(1, v);
        const i = (y * S + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = 255;
        d[i + 3] = (v * 255) | 0;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  async function load(onProgress) {
    const jobs = [];
    jobs.push(loadImage('assets/pond_base.png').then(im => { assets.base = im; }));
    jobs.push(loadImage('assets/weed_layer.png').then(im => { assets.weed = im; })
      .catch(() => { assets.weed = null; }));
    for (const k of KOI) {
      const variants = {};
      for (const v of DEPTH_VARIANTS) {
        jobs.push(loadImage(`assets/${k}${v}.png`).then(im => { variants[v] = im; }));
      }
      assets.koi[k] = { variants };
    }
    for (const name of DECOR) {
      jobs.push(loadImage(`assets/${name}.png`).then(im => { assets.decor[name] = im; }));
    }
    for (const name of CREATURES) {
      jobs.push(loadImage(`assets/${name}.png`).then(im => { assets.creatures[name] = im; }));
    }
    await Promise.all(jobs);

    // 派生缓存
    for (const k of KOI) {
      const rec = assets.koi[k];
      const sharp = rec.variants[''];
      rec.w = sharp.width; rec.h = sharp.height;
      // 切片：把 sprite 沿 x 切成 N 条，摆尾时逐条横向偏移
      const N = 16;
      rec.strips = [];
      for (let i = 0; i < N; i++) {
        const sx = (i * sharp.width) / N;
        const sw = sharp.width / N + 1;
        const cx = sx + sw / 2;
        rec.strips.push({ sx, sw, t: 1 - cx / sharp.width });  // t: 0=头 1=尾
      }
      rec.n = N;
      buildAtlas(rec);
      // 图集和剪影都烘好了，原图再留着就是白占显存（壁纸是常驻进程）
      rec.variants = null;
      rec.strips = null;
    }
    // 影子预烘：软件渲染下每帧 ctx.filter 是灾难（14fps 的元凶），
    // 所以乌龟的贴地影和氛围光斑都提前烘成位图
    for (const name of CREATURES) {
      const im = assets.creatures[name];
      const c = makeCanvas(im.width + 16, im.height + 16);
      const x = c.getContext('2d');
      x.filter = 'blur(4px)';
      x.drawImage(im, 8, 8);
      x.filter = 'none';
      x.globalCompositeOperation = 'source-in';
      x.fillStyle = '#062824';
      x.fillRect(0, 0, c.width, c.height);
      assets.creatures[name + '_shadow'] = c;
    }
    const glow = makeCanvas(96, 96);
    {
      const x = glow.getContext('2d');
      const g = x.createRadialGradient(48, 48, 0, 48, 48, 48);
      g.addColorStop(0, 'rgba(255,246,180,0.9)');
      g.addColorStop(0.25, 'rgba(214,255,150,0.38)');
      g.addColorStop(1, 'rgba(214,255,150,0)');
      x.fillStyle = g; x.fillRect(0, 0, 96, 96);
    }
    assets.glow = glow;
    const mistC = makeCanvas(256, 256);
    {
      const x = mistC.getContext('2d');
      const g = x.createRadialGradient(128, 128, 0, 128, 128, 128);
      g.addColorStop(0, 'rgba(236,246,250,0.5)');
      g.addColorStop(0.7, 'rgba(236,246,250,0.22)');
      g.addColorStop(1, 'rgba(236,246,250,0)');
      x.fillStyle = g; x.fillRect(0, 0, 256, 256);
    }
    assets.mist = mistC;
    assets.caustics = buildCaustics(384);
    assets.ready = true;
    if (onProgress) onProgress(1);
  }

  /* ---------- 池底投影用的剪影 ----------
   * 只烘一张中等模糊的深色剪影，运行时靠"缩放 + 偏移 + 透明度"去表达远近：
   * 鱼贴着底（离底近）→ 影子几乎在正下方、小而深；
   * 鱼在水面（离底远）→ 影子被水层摊开，更大、更淡、偏得更远。
   * 为什么不每帧 ctx.filter：软件渲染下那是 14fps 的元凶；也为什么不烘三档：
   * 缩放本身就会按比例改变模糊程度，一张够了，省下来的内存是两条鱼的量。 */
  /* 烘的尺寸刻意比摆尾图集（CANON=140）小得多：软件渲染下 drawImage 的开销按**源**面积走，
   * 源图烘成 174×104 而实际只画到 46×26 时，等于每帧替每条鱼读 1.8 万像素再缩掉 ——
   * 实测这一层就吃掉 35% 的帧率（48 → 31 fps）。影子本来就是一团糊的，不需要那个分辨率。
   * 80 是"中等体长"：小鱼缩、大鱼放，两头都不浪费。 */
  const SIL_CANON = 80;
  function makeSilhouette(sharp) {
    const blur = SIL_CANON * 0.05;
    const w = SIL_CANON, h = Math.max(1, Math.round(sharp.height * (SIL_CANON / sharp.width)));
    const pad = Math.ceil(blur * 2.4);
    const c = makeCanvas(w + pad * 2, h + pad * 2);
    const x = c.getContext('2d');
    x.filter = `blur(${blur}px)`;
    x.drawImage(sharp, pad, pad, w, h);
    x.filter = 'none';
    x.globalCompositeOperation = 'source-in';       // 只留形状，颜色统一压成池底的暗调
    x.fillStyle = 'rgb(3, 24, 22)';
    x.fillRect(0, 0, c.width, c.height);
    return { canvas: c, pad, w, h };
  }

  /* 摆尾绘制：整条鱼沿长度方向做行波横向位移，尾部振幅大、头部几乎不动。
   * phase 每条鱼不同，速度不同 -> 不会出现"齐步走"。 */
  function drawFishShape(ctx, rec, img, len, amp, phase, alpha, composite) {
    const s = len / rec.w;
    const h = rec.h * s;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (composite) ctx.globalCompositeOperation = composite;
    const N = rec.n;
    for (let i = 0; i < N; i++) {
      const st = rec.strips[i];
      const a = amp * (0.10 + 0.90 * st.t * st.t);
      const dy = a * Math.sin(phase - st.t * 2.7);
      ctx.drawImage(img, st.sx, 0, st.sw, rec.h,
        (st.sx - rec.w / 2) * s, dy - h / 2, st.sw * s, h);
    }
    ctx.restore();
  }

  /* ---------------- 摆尾动画图集 ----------------
   * 逐帧切片要 16 次 drawImage/条，78 条鱼就是 1200 多次，软件渲染直接掉到 3fps。
   * 改成预烘：每种鱼 × 3 个水层 × 16 个摆尾相位，烘到一张图集上，
   * 运行时每条鱼只要 1 次 drawImage。 */
  const PHASES = 16;
  const CANON = 140;                 // 图集里的标准体长(px)：最大的"塘主"鱼约 146px，几乎不用放大
  const VARIANT_ORDER = ['_soft', '_mid', '_deep'];

  function buildAtlas(rec) {
    const amp = CANON * 0.075;
    const bodyH = rec.h * (CANON / rec.w);
    const cellW = Math.ceil(CANON + amp * 2 + 6);
    const cellH = Math.ceil(bodyH + amp * 2 + 6);
    const c = makeCanvas(cellW * PHASES, cellH * VARIANT_ORDER.length);
    const x = c.getContext('2d');
    for (let vi = 0; vi < VARIANT_ORDER.length; vi++) {
      const img = rec.variants[VARIANT_ORDER[vi]] || rec.variants[''];
      for (let p = 0; p < PHASES; p++) {
        x.save();
        x.translate(cellW * p + cellW / 2, cellH * vi + cellH / 2);
        drawFishShape(x, rec, img, CANON, amp, (p / PHASES) * Math.PI * 2, 1, null);
        x.restore();
      }
    }
      rec.atlas = { canvas: c, cellW, cellH, n: PHASES };
      rec.sil = makeSilhouette(rec.variants[''] || rec.variants[Object.keys(rec.variants)[0]]);
    }

  /* 按深度取图集行号 + 按相位取列号，返回图集里的源矩形 */
  function atlasCell(rec, depth, phase) {
    const a = rec.atlas;
    const vi = depth > 0.70 ? 2 : depth > 0.36 ? 1 : 0;
    let p = Math.round((phase / (Math.PI * 2)) * a.n);
    p = ((p % a.n) + a.n) % a.n;
    return [p * a.cellW, vi * a.cellH, a.cellW, a.cellH];
  }

  /* ---------------- 自定义鱼（画板捏出来的） ----------------
   * 走和内置素材完全一样的派生流程：sharp 图 → 3 档水层变体 → 摆尾图集。
   * 水层变体现场用 canvas filter 生成（内置素材是 matting.py 离线做的），
   * 这样画板不需要预处理脚本也能立刻上场。
   *
   * 可以注册**多条**：kind 就是它们的鱼种名。第一条用 CUSTOM（约定俗成的"我的锦鲤"），
   * 后面的用 CUSTOM + '_xxx'。每条的图集约 2.5MB，所以 dropCustom 会真的把图集释放掉
   * —— 删掉一条就该还回那份内存，不然攒 8 条就是 20MB。 */
  const CUSTOM = 'koi_custom';
  function isCustomKind(k) { return k === CUSTOM || k.indexOf(CUSTOM + '_') === 0; }

  function depthVariant(sharp, level) {
    const c = makeCanvas(sharp.width, sharp.height);
    const x = c.getContext('2d');
    // 越深越糊越淡，和素材里 _soft/_mid/_deep 的观感对齐
    x.filter = `blur(${(level * 0.9).toFixed(2)}px) saturate(${(1 - 0.14 * level).toFixed(2)}) brightness(${(1 - 0.05 * level).toFixed(2)})`;
    x.drawImage(sharp, 0, 0);
    return c;
  }

  function registerCustom(src, kind) {
    if (!src || !src.width) return null;
    kind = kind || CUSTOM;
    if (!assets.customRecs) assets.customRecs = {};
    // 统一到素材的尺度（体长 340px），不然自定义鱼会比别的鱼大一圈或小一圈
    const targetW = 340;
    const h = Math.max(1, Math.round(targetW * src.height / src.width));
    const sharp = makeCanvas(targetW, h);
    const sx = sharp.getContext('2d');
    sx.imageSmoothingQuality = 'high';
    sx.drawImage(src, 0, 0, targetW, h);

    const variants = { '': sharp };
    for (let i = 1; i < DEPTH_VARIANTS.length; i++) variants[DEPTH_VARIANTS[i]] = depthVariant(sharp, i);

    const rec = { variants, w: sharp.width, h: sharp.height };
    const N = 16;
    rec.strips = [];
    for (let i = 0; i < N; i++) {
      const x0 = (i * sharp.width) / N;
      const sw = sharp.width / N + 1;
      rec.strips.push({ sx: x0, sw, t: 1 - (x0 + sw / 2) / sharp.width });
    }
    rec.n = N;
    buildAtlas(rec);
    rec.variants = null;      // 和内置素材一样：烘完就释放源图
    rec.strips = null;
    assets.customRecs[kind] = rec;
    if (assets.customOn !== false) assets.koi[kind] = rec;
    return rec;
  }

  /* 删掉一条自定义鱼：连图集一起放掉。留存的是画板里的 dataURL，随时能重建。 */
  function dropCustom(kind) {
    if (!kind) return false;
    if (assets.customRecs) delete assets.customRecs[kind];
    if (assets.koi[kind] && isCustomKind(kind)) delete assets.koi[kind];
    return true;
  }

  /* 开关"我的锦鲤"时不必重烘焙，图集留着，只是让不让鱼群选中它们 */
  function setCustomVisible(on) {
    assets.customOn = !!on;
    const recs = assets.customRecs || {};
    for (const k of Object.keys(recs)) {
      if (on) assets.koi[k] = recs[k];
      else if (assets.koi[k] && isCustomKind(k)) delete assets.koi[k];
    }
  }

  function hasCustom() { return Object.keys(assets.customRecs || {}).length > 0; }
  function hasKind(kind) { return !!(assets.koi && assets.koi[kind]); }
  function customKinds() { return Object.keys(assets.customRecs || {}); }
  function customCount() { return customKinds().length; }

  global.Sprites = {
    assets, load, atlasCell, KOI, DECOR, CREATURES, CANON,
    registerCustom, dropCustom, setCustomVisible, hasCustom, hasKind,
    customKinds, customCount, isCustomKind, CUSTOM,
  };
})(typeof window !== 'undefined' ? window : globalThis);
