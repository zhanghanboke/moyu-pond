/* paint.js —— "我的锦鲤"画板：捏一条真正会游进池子里的鱼
 *
 * 几个决定：
 * 1) 鱼形不用现成素材，而是**程序化画**（贝塞尔描出俯视锦鲤）。原因是 file:// 下用
 *    assets/*.png 画过的 canvas 会被跨域污染，toDataURL 直接抛 SecurityError —— 那样
 *    "存到本地"就废了。程序化轮廓不碰任何外部像素，存/取都自由。
 * 2) 鱼形是**参数化**的：身体轮廓（胖瘦）和尾部长度两个滑杆直接改贝塞尔控制点，
 *    所以"轮廓"是画出来的而不是拉抻位图。
 * 3) 涂色层分两层：raw 离屏画布存用户真正画下的东西，显示用的 ink 由 raw ∩ 鱼形
 *    mask 合成。这样出界的笔迹不会脏在预览上（所见即所得），改了轮廓也能重裁。
 * 4) 可以存**多条**设计（最多 MAX 条），每条一个名字、一套几何参数、一张涂色图。
 *    真正进池的只有一张图集/条，所以关掉/删掉时会连图集一起释放（见 Sprites.dropCustom）。
 */
(function (global) {
  'use strict';

  const KEY = 'moyu-pond:koi:v2';
  const KEY_V1 = 'moyu-pond:koi:v1';
  const CW = 560, CH = 200;                        // 内部署分辨率（显示时按比例缩到卡片宽）
  const MAX = 8;                                   // 最多存几条自定义鱼
  const TAU = Math.PI * 2;

  // 画笔色：前 4 个就是参考图里那四个
  const COLORS = ['#1f3a3d', '#d93a2b', '#e8b44a', '#a9c0c6',
    '#f6ecd8', '#8b1f10', '#2b2b30', '#f4b8c4'];
  // 鱼身底色：锦鲤多半是白底/奶白/金/银，最后一个当墨色
  const BASES = ['#f7f0e0', '#ffffff', '#efd7a4', '#dfe3e2', '#6f7478'];
  // 随机花纹的色池：只用有对比的颜色，别生成看不见的浅斑
  const PATTERN = ['#d93a2b', '#8b1f10', '#e8b44a', '#2b2b30', '#1f3a3d', '#f4b8c4'];
  const NAMES = ['小旦', '粉饼', '千树', '粉黛', '白露', '明月', '绯月', '雪见', '水墨',
    '金鳞', '澄江', '拾光', '青玉', '半盏', '听雨', '煮雪', '晚风', '星河', '衔月', '木鱼'];

  /* -------- 编辑器状态 --------
   * designs 是"我自定义的锦鲤"列表，cur 是正在编辑的那条。
   * fresh=true 表示当前画布还没落到任何一条设计上（点了"＋ 新的一条"）。 */
  let designs = [];
  let curId = null;
  let fresh = true;
  let curName = '';
  let curBase = BASES[0];
  let curFat = 0.70, curTail = 0.45;

  // 画布仍是模块级单例：设置面板没打开时也要能恢复上次画的鱼（启动时 main.js 要用）
  let ref = null, ref2d = null;        // 参考层：鱼形本身
  let ink = null, ink2d = null;        // 涂色层的**显示**画布（= raw ∩ mask）
  let raw = null, raw2d = null;        // 涂色层的**原始**画布（出界的笔迹也在这）
  let host = null, cfg = null, change = null;

  let tool = 'brush', color = COLORS[1], brush = 18;
  let drawing = false, last = null;
  let booted = null;

  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /* ---------------- 参数化鱼形 ----------------
   * 头朝右（和素材的朝向约定一致）。fax/tail 都归一化到 0~1：
   *   fat  0 → 细长，1 → 圆胖
   *   tail 0 → 短尾，1 → 长尾（画布长度固定，所以尾长了身体自然短一点）
   * ts（尾鳍张开半高）跟 fat 有下限绑定，否则瘦鱼配大尾会像根扫帚。 */
  function geom(o) {
    const fat = clamp01(o.fat == null ? 0.70 : o.fat);
    const tail = clamp01(o.tail == null ? 0.45 : o.tail);
    const cy = CH * 0.5;
    const bh = CH * 0.28 * (0.42 + 0.72 * fat);            // 身体最宽处半高
    // 尾鳍张开半高跟着体高走（真锦鲤的尾鳍差不多就是体高那个量级）。
    // 如果只按绝对像素给，瘦鱼配出来就是"一根细棍顶着把大扇子"。
    const ts = clamp(bh * (0.72 + 0.55 * tail), CH * 0.12, CH * 0.42);
    return {
      fat, tail, cy, bh, ts,
      nose: CW * 0.985,                                     // 吻端
      jx: CW * (0.10 + 0.28 * tail),                        // 尾柄（身体与尾鳍交界）
      tip: CW * 0.015,                                      // 尾鳍后缘最左
    };
  }

  /* 半高剖面：u=0 尾柄、u=1 吻端，返回 0~1 的相对半高。
   * 用"采样剖面再连线"而不是几段贝塞尔：贝塞尔实际撑不到控制点的高度，
   * 想调"肩最宽在哪、头收得多快"就得反复试参数；剖面是查表，所见即所得。
   * k 决定最宽处在 u≈0.62（锦鲤的肩在身体偏前的位置），p 决定胖得有多"满"。 */
  const PROFILE_K = 1.45, PROFILE_P = 0.65, PEDUNCLE = 0.26;
  function profile(u) {
    if (u <= 0) return PEDUNCLE;
    if (u >= 1) return 0;
    const w = Math.pow(Math.max(0, Math.sin(Math.PI * Math.pow(u, PROFILE_K))), PROFILE_P);
    // 尾柄段给个下限：身体末端收成尖的话，尾鳍就没地方接了
    return u < 0.62 ? PEDUNCLE + (1 - PEDUNCLE) * w : w;
  }
  // 某个 u 处的实际半高（px）。眼睛、胸鳍都按它定位，才不会被"胖瘦"甩到身外去。
  function halfAt(g, u) { return profile(u) * g.bh; }
  function uOfX(g, x) { return (x - g.jx) / Math.max(1, g.nose - g.jx); }

  function bodyPath(g) {
    const y = g.cy, N = 48, L = g.nose - g.jx;
    const p = new Path2D();
    for (let i = 0; i <= N; i++) {                 // 上缘：尾柄 → 吻
      const u = i / N;
      const px = g.jx + u * L, py = y - halfAt(g, u);
      i ? p.lineTo(px, py) : p.moveTo(px, py);
    }
    for (let i = N; i >= 0; i--) {                 // 下缘：吻 → 尾柄（对称）
      const u = i / N;
      p.lineTo(g.jx + u * L, y + halfAt(g, u));
    }
    p.closePath();
    return p;
  }

  function tailPath(g) {
    const y = g.cy, ped = g.bh * 0.26;
    const p = new Path2D();
    p.moveTo(g.jx, y - ped);
    // 上叶外缘
    p.bezierCurveTo(g.jx - CW * 0.045, y - g.ts * 0.62, g.tip + CW * 0.055, y - g.ts * 0.90, g.tip, y - g.ts);
    // 后缘内凹 → 分叉
    p.bezierCurveTo(g.tip + CW * 0.085, y - g.ts * 0.34, g.tip + CW * 0.085, y + g.ts * 0.34, g.tip, y + g.ts);
    // 下叶外缘
    p.bezierCurveTo(g.tip + CW * 0.055, y + g.ts * 0.90, g.jx - CW * 0.045, y + g.ts * 0.62, g.jx, y + ped);
    p.closePath();
    return p;
  }

  /* 胸鳍：从鳃后向外后方甩，用旋转椭圆近似。
   * 尺寸按**当地的**半高算，并且压在身体边缘内侧一点 —— 直接按最宽处算、
   * 中心又放到身体外，瘦鱼身上就会长出两片大叶子。 */
  function finsPath(g) {
    const fx = CW * 0.715;
    const lh = Math.max(6, halfAt(g, uOfX(g, fx)));
    const major = Math.min(lh * 0.80, CW * 0.062);
    const minor = major * 0.30;
    const p = new Path2D();
    for (const s of [-1, 1]) {
      p.ellipse(fx, g.cy + s * (lh * 0.72 + minor * 0.5), major, minor, s * (Math.PI - 0.66), 0, TAU);
    }
    return p;
  }

  // 整个鱼（身体 + 尾鳍 + 胸鳍）：涂色裁形用它，所以鳍也要在里面
  function maskPath(g) {
    const p = new Path2D();
    p.addPath(bodyPath(g));
    p.addPath(tailPath(g));
    p.addPath(finsPath(g));
    return p;
  }

  /* 眼睛按当地半高定位：固定按最宽处的一半放，瘦鱼的头收窄后眼睛就会挂到身外 */
  function drawEyes(x, g) {
    const ex = g.nose - CW * 0.082;
    const lh = Math.max(5, halfAt(g, uOfX(g, ex)));
    const r = Math.min(CW * 0.0115, lh * 0.26);
    x.save();
    x.fillStyle = 'rgba(36,50,48,.88)';
    for (const s of [-1, 1]) {
      x.beginPath();
      x.ellipse(ex, g.cy + s * lh * 0.52, r, r * 0.84, 0, 0, TAU);
      x.fill();
    }
    x.restore();
  }

  function drawTailRays(x, g) {
    x.save();
    x.strokeStyle = 'rgba(58,88,84,.30)';
    x.lineWidth = 1.05;
    x.lineCap = 'round';
    const N = 7;
    for (let i = 0; i < N; i++) {
      const t = (i / (N - 1)) * 2 - 1;                     // -1..1
      const ey = g.cy + t * g.ts * 0.90;
      const ex = g.tip + CW * 0.030 + Math.abs(t) * CW * 0.014;
      x.beginPath();
      x.moveTo(g.jx - CW * 0.008, g.cy);
      x.quadraticCurveTo(g.jx - CW * 0.052, g.cy + (ey - g.cy) * 0.40, ex, ey);
      x.stroke();
    }
    x.restore();
  }

  /* 把鱼画成"最终会长成的样子"（底色 + 半透明鳍 + 鳍条 + 眼睛）。
   * 抽成函数是因为每条设计都有自己的底色和几何 —— 画廊缩略图要按各自的参数重画，
   * 不能都套用"正在编辑的那条"。 */
  function paintFishOn(x, base, g) {
    // 尾鳍和胸鳍先画（半透明），身体再压上去，尾柄交界看着才自然
    x.save();
    x.fillStyle = base;
    x.globalAlpha = 0.58; x.fill(tailPath(g));
    x.globalAlpha = 0.42; x.fill(finsPath(g));
    x.restore();

    x.save();
    x.fillStyle = base;
    x.fill(bodyPath(g));
    x.restore();

    // 胸鳍描一圈淡边，不然一片米白的鳍糊在米白的身上看不出形状
    x.save();
    x.strokeStyle = 'rgba(52,84,80,.26)';
    x.lineWidth = 1.1;
    x.stroke(finsPath(g));
    x.restore();

    drawTailRays(x, g);
    drawEyes(x, g);

    // 轮廓线：很淡的一圈，提示"涂到这里为止"
    x.save();
    x.strokeStyle = 'rgba(30,58,54,.22)';
    x.lineWidth = 1.2;
    x.stroke(bodyPath(g));
    x.restore();
  }

  function paintRef() {
    if (!ref2d) return;
    ref2d.setTransform(1, 0, 0, 1, 0, 0);
    ref2d.clearRect(0, 0, CW, CH);
    paintFishOn(ref2d, curBase, geom({ fat: curFat, tail: curTail }));
  }

  // 别的设计的涂色图：按它自己的鱼形裁一刀（正在编辑的那条直接用已裁好的 ink）
  function clippedRaw(design, g) {
    if (!design.__raw) return null;
    const t = makeCanvas(CW, CH);
    const tx = t.getContext('2d');
    tx.drawImage(design.__raw, 0, 0);
    tx.globalCompositeOperation = 'destination-in';
    tx.fillStyle = '#fff';
    tx.fill(maskPath(g));
    tx.globalCompositeOperation = 'source-over';
    return t;
  }

  /* 把 raw 按当前鱼形裁一遍，结果写进显示用的 ink。
   * 每次落笔和改轮廓都要重来一次 —— 这是"涂出界的部分不会脏在预览上"的代价。 */
  function reclip() {
    if (!ink2d) return;
    ink2d.setTransform(1, 0, 0, 1, 0, 0);
    ink2d.clearRect(0, 0, CW, CH);
    ink2d.drawImage(raw, 0, 0);
    ink2d.globalCompositeOperation = 'destination-in';
    ink2d.fillStyle = '#fff';
    ink2d.fill(maskPath(geom({ fat: curFat, tail: curTail })));
    ink2d.globalCompositeOperation = 'source-over';
  }

  function ensure() {
    if (ink) return;
    raw = makeCanvas(CW, CH);
    raw2d = raw.getContext('2d');
    ink = makeCanvas(CW, CH);
    ink2d = ink.getContext('2d');
    ref = makeCanvas(CW, CH);
    ref2d = ref.getContext('2d');
    // 这两个 class 决定"两层叠在一起"（position:absolute），漏了就变成上下排列，
    // 涂色层会被挤到画板外面去 —— 看起来像"花纹没画上"
    ref.className = 'paint-ref';
    ink.className = 'paint-ink';
    paintRef();
  }

  /* 合成一条设计的最终 sprite：鱼 → 图案 → 鳍/鳍条/眼睛再盖一层。
   * 最后那层"再盖"是关键：图案是整片裁进鱼形里的，不盖回去的话鳍上的颜色会是
   * 实心的一坨，看着像贴纸；盖一层半透明底色加回鳍条，才有鳍的通透感。 */
  function spriteOf(design) {
    ensure();
    const base = design.base || BASES[0];
    const g = geom(design);
    const out = makeCanvas(CW, CH);
    const o = out.getContext('2d');

    paintFishOn(o, base, g);
    // __live = "还没落成设计的草稿"，它的图案就在实时画布上
    const pat = (design.__live || design === current()) ? ink : clippedRaw(design, g);
    if (pat) o.drawImage(pat, 0, 0);

    o.save();
    o.fillStyle = base;
    o.globalAlpha = 0.42;
    o.fill(tailPath(g));
    o.fill(finsPath(g));
    o.restore();
    drawTailRays(o, g);
    drawEyes(o, g);
    return out;
  }

  const current = () => designs.find(d => d.id === curId) || null;

  /* ---------------- 存档 ----------------
   * 图标是 dataURL。一条 560×200 且大部分透明，通常几 KB，8 条也远不到 localStorage 上限。 */
  function packOne(d) {
    return { id: d.id, name: d.name, base: d.base, fat: d.fat, tail: d.tail, ink: d.ink || '' };
  }
  /* 把实时画布写回"正在编辑的那条"。注意 __raw 永远是**独立的一张**，
   * 不引用实时画布 —— 否则切到下一条时一次 clearRect 就把上一条擦掉了。 */
  function snapshot() {
    const d = current();
    if (!d) return;
    d.ink = raw.toDataURL('image/png');
    d.base = curBase; d.fat = curFat; d.tail = curTail;
    if (!d.__raw) d.__raw = makeCanvas(CW, CH);
    const x = d.__raw.getContext('2d');
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.clearRect(0, 0, CW, CH);
    x.drawImage(raw, 0, 0);
  }
  function save() {
    snapshot();
    const list = designs.map(packOne);
    try { localStorage.setItem(KEY, JSON.stringify({ v: 2, list, cur: curId })); } catch (e) { }
  }
  function readStore() {
    try {
      const raw2 = localStorage.getItem(KEY);
      if (raw2) {
        const o = JSON.parse(raw2);
        if (o && Array.isArray(o.list)) return { list: o.list, cur: o.cur };
      }
      // v1 只有一条 { ink, base }，平移过来，别让老用户白画
      const old = localStorage.getItem(KEY_V1);
      if (old) {
        const o = JSON.parse(old);
        if (o && o.ink) {
          return {
            list: [{ id: newId(), name: randName(), base: o.base || BASES[0], fat: 0.70, tail: 0.45, ink: o.ink }],
            cur: null,
          };
        }
      }
    } catch (e) { /* 坏了就当没有 */ }
    return { list: [], cur: null };
  }
  function hasSaved() {
    try { return !!localStorage.getItem(KEY) || !!localStorage.getItem(KEY_V1); } catch (e) { return false; }
  }

  let idSeq = 0;
  function newId() { return 'k' + Date.now().toString(36) + (idSeq++).toString(36); }
  function randName() {
    const used = designs.map(d => d.name);
    const pool = NAMES.filter(n => used.indexOf(n) < 0);
    const arr = pool.length ? pool : NAMES;
    return arr[(Math.random() * arr.length) | 0];
  }

  /* ---------------- 涂色 ----------------
   * 落笔画在 raw 上，然后 reclip() 把显示层刷一遍。 */
  function pos(e) {
    const r = ink.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (CW / r.width), y: (e.clientY - r.top) * (CH / r.height) };
  }
  function stroke(a, b) {
    const x = raw2d;
    x.lineCap = 'round'; x.lineJoin = 'round';
    x.globalCompositeOperation = tool === 'erase' ? 'destination-out' : 'source-over';
    x.strokeStyle = color;
    x.lineWidth = brush;
    x.beginPath();
    if (a) { x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); }
    else { x.moveTo(b.x, b.y); x.lineTo(b.x + 0.01, b.y); }
    x.stroke();
    x.globalCompositeOperation = 'source-over';
    reclip();
  }

  /* 事件只绑一次：画布是单例，反复开关面板不该叠加监听 */
  function bindOnce() {
    if (ink.__bound) return;
    ink.__bound = true;
    const down = e => {
      drawing = true;
      try { ink.setPointerCapture(e.pointerId); } catch (err) { }
      last = pos(e);
      stroke(null, last);
      dirty();
    };
    const move = e => {
      if (!drawing) return;
      const p = pos(e);
      stroke(last, p); last = p;
    };
    const up = () => {
      if (!drawing) return;
      drawing = false; last = null;
      dirty();
    };
    ink.addEventListener('pointerdown', down);
    ink.addEventListener('pointermove', move);
    ink.addEventListener('pointerup', up);
    ink.addEventListener('pointercancel', up);
    ink.addEventListener('pointerleave', up);
  }

  let dirtyTimer = 0;
  function dirty() {
    if (dirtyTimer) return;
    dirtyTimer = setTimeout(() => { dirtyTimer = 0; save(); if (change) change('koiPaint', null); }, 500);
  }

  /* ---------------- 随机花纹 ----------------
   * 画粗笔触而不是圆点：圆点看着像雨点，一笔带弧度的粗线才像锦鲤的红斑/墨斑。 */
  function randomPattern() {
    ensure();
    const g = geom({ fat: curFat, tail: curTail });
    const t = g.nose - g.jx;
    raw2d.clearRect(0, 0, CW, CH);
    raw2d.save();
    raw2d.lineCap = 'round'; raw2d.lineJoin = 'round';

    // 先来一笔"主斑"：横跨肩部的大弧，学参考图里那道 C 形红斑。
    // 平直的一笔看着像根香肠，所以给足弯曲量（bend 可以到半个体高）。
    const mainColor = PATTERN[(Math.random() * 3) | 0];
    const y0 = g.cy + (Math.random() - 0.5) * g.bh * 0.5;
    const x0 = g.jx + t * (0.34 + Math.random() * 0.16);
    const x1 = x0 + t * (0.26 + Math.random() * 0.14);
    const bend = (Math.random() < 0.5 ? -1 : 1) * g.bh * (0.45 + Math.random() * 0.35);
    raw2d.strokeStyle = mainColor;
    raw2d.globalAlpha = 0.95;
    raw2d.lineWidth = Math.max(12, g.bh * (0.34 + Math.random() * 0.18));
    raw2d.beginPath();
    raw2d.moveTo(x0, y0);
    raw2d.bezierCurveTo(x0 + t * 0.12, y0 + bend, x1 - t * 0.12, y0 + bend, x1, y0 + bend * 0.18);
    raw2d.stroke();

    // 再补 1~3 笔小的，颜色跟在主斑后面选，保证有对比
    const small = 1 + (Math.random() * 3 | 0);
    for (let i = 0; i < small; i++) {
      const sx = g.jx + t * (0.12 + Math.random() * 0.72);
      const sy = g.cy + (Math.random() - 0.5) * g.bh * 1.5;
      const len = t * (0.10 + Math.random() * 0.18) * (Math.random() < 0.5 ? 1 : -1);
      const bd = (Math.random() - 0.5) * g.bh * 1.2;
      raw2d.strokeStyle = PATTERN[(Math.random() * PATTERN.length) | 0];
      raw2d.globalAlpha = 0.92;
      raw2d.lineWidth = Math.max(8, g.bh * (0.16 + Math.random() * 0.2));
      raw2d.beginPath();
      raw2d.moveTo(sx, sy);
      raw2d.quadraticCurveTo(sx + len * 0.5, sy + bd, sx + len, sy + bd * 0.35);
      raw2d.stroke();
    }
    raw2d.restore();
    raw2d.globalAlpha = 1;
    // 头部留一块空白，不然涂满看不出鱼头在哪
    raw2d.save();
    raw2d.globalCompositeOperation = 'destination-out';
    raw2d.beginPath();
    raw2d.ellipse(CW * 0.935, g.cy, CW * 0.040, g.bh * 0.34, 0, 0, TAU);
    raw2d.fill();
    raw2d.restore();
    reclip();
    save();
    if (change) change('koiPaint', null);
  }

  function flip() {
    ensure();
    const t = makeCanvas(CW, CH);
    const tx = t.getContext('2d');
    tx.translate(CW, 0); tx.scale(-1, 1);
    tx.drawImage(raw, 0, 0);
    raw2d.clearRect(0, 0, CW, CH);
    raw2d.drawImage(t, 0, 0);
    reclip();
    save();
    if (change) change('koiPaint', null);
  }

  function clearInk() {
    ensure();
    raw2d.clearRect(0, 0, CW, CH);
    reclip();
    save();
    if (change) change('koiPaint', null);
  }

  /* ---------------- 设计列表 ---------------- */
  function loadInto(d) {
    ensure();
    curId = d ? d.id : null;
    fresh = !d;
    curName = d ? d.name : randName();
    curBase = d ? (d.base || BASES[0]) : BASES[0];
    curFat = d ? (d.fat == null ? 0.70 : d.fat) : 0.70;
    curTail = d ? (d.tail == null ? 0.45 : d.tail) : 0.45;
    raw2d.clearRect(0, 0, CW, CH);
    if (d && d.__raw) raw2d.drawImage(d.__raw, 0, 0);
    paintRef();
    reclip();
  }

  function decodeInk(d) {
    if (d.__raw || !d.ink) return Promise.resolve();
    d.__raw = makeCanvas(CW, CH);
    return new Promise(res => {
      const im = new Image();
      im.onload = () => { d.__raw.getContext('2d').drawImage(im, 0, 0, CW, CH); res(); };
      im.onerror = () => res();
      im.src = d.ink;
    });
  }

  /* 把列表里所有设计注册进素材表：第一条用 koi_custom（约定俗成的"我的锦鲤"），
   * 后面的加后缀。换过 kind 的、或图集被释放过的，重新注册一次。 */
  function syncSprites() {
    const S = global.Sprites;
    if (!S || !S.registerCustom) return 0;
    const kinds = [];
    designs.forEach((d, i) => kinds.push(i === 0 ? S.CUSTOM : S.CUSTOM + '_' + d.id));
    for (const k of S.customKinds()) if (kinds.indexOf(k) < 0) S.dropCustom(k);
    designs.forEach((d, i) => {
      const k = kinds[i];
      if (d.__kind === k && S.hasKind(k)) return;
      if (d.__kind && d.__kind !== k) S.dropCustom(d.__kind);
      d.__kind = k;
      S.registerCustom(spriteOf(d), k);
    });
    return designs.length;
  }

  /* "放入鱼池"：把当前画布提交成一条（新设计就新建，否则更新它），然后重建图集 */
  function apply() {
    ensure();
    if (fresh || !current()) {
      const d = {
        id: newId(), name: (curName || '').trim() || randName(),
        base: curBase, fat: curFat, tail: curTail,
        ink: '',
      };
      designs.push(d);
      curId = d.id;
      fresh = false;
      curName = d.name;
    }
    save();
    syncSprites();
    if (change) change('koiCustom', true);
    renderGallery();
    return spriteOf(current());
  }

  function remove(id) {
    const i = designs.findIndex(d => d.id === id);
    if (i < 0) return;
    const d = designs[i];
    const S = global.Sprites;
    if (S && d.__kind) S.dropCustom(d.__kind);
    designs.splice(i, 1);
    if (curId === id) loadInto(designs[0] || null);
    save();
    syncSprites();
    if (change) change('koiCustom', true);
    renderGallery();
    syncEditorFields();
  }

  /* 启动时用：读出存档、解码所有涂色图、注册成 sprite。面板这时可能还没建 DOM。 */
  function boot() {
    if (booted) return booted;
    const st = readStore();
    designs = st.list.map(o => ({
      id: o.id || newId(), name: o.name || '锦鲤',
      base: o.base || BASES[0],
      fat: o.fat == null ? 0.70 : o.fat,
      tail: o.tail == null ? 0.45 : o.tail,
      ink: o.ink || '',
    }));
    booted = Promise.all(designs.map(decodeInk)).then(() => {
      curId = designs.some(d => d.id === st.cur) ? st.cur : (designs[0] ? designs[0].id : null);
      loadInto(designs.find(d => d.id === curId) || null);
      syncSprites();
      // hud.js 的 build() 早于这里跑（面板 DOM 先建、素材后加载），所以恢复完必须
      // 主动把界面刷一遍，否则画廊会是空的 —— 用户得点一下才看得到自己存的鱼
      syncEditorFields();
      return designs.length;
    });
    return booted;
  }

  /* ---------------- UI ---------------- */
  function renderGallery() {
    const box = host && host.querySelector('#pGal');
    if (!box) return;
    box.innerHTML = designs.map(d => `
      <div class="p-item${d.id === curId ? ' on' : ''}" data-id="${d.id}">
        <div class="p-thumb" data-id="${d.id}"></div>
        <span class="p-nm">${esc(d.name)}<button class="p-del" data-del="${d.id}" title="从池中删除">×</button></span>
      </div>`).join('')
      + (designs.length < MAX ? `<div class="p-item p-new" id="pNew"><div class="p-thumb p-plus">＋</div><span class="p-nm">新的一条</span></div>` : '');

    for (const d of designs) {
      const holder = box.querySelector(`.p-thumb[data-id="${d.id}"]`);
      if (!holder) continue;
      const c = makeCanvas(168, 60);
      const x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(spriteOf(d), 0, 0, 168, 60);
      holder.appendChild(c);
    }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  }

  function syncEditorFields() {
    if (!host) return;
    const set = (id, v) => { const el = host.querySelector('#' + id); if (el) el.value = v; };
    set('pFat', curFat); set('pTail', curTail); set('pSize', brush); set('pName', curName);
    const fatV = host.querySelector('#pFat'); if (fatV) fatV.__sync && fatV.__sync();
    const colors = host.querySelector('#pColors');
    if (colors) colors.querySelectorAll('.sw').forEach(s => s.classList.toggle('on', s.dataset.c === color));
    const bases = host.querySelector('#pBases');
    if (bases) bases.querySelectorAll('.sw').forEach(s => s.classList.toggle('on', s.dataset.c === curBase));
    const nm = host.querySelector('#pApply');
    if (nm) nm.textContent = fresh ? '放入鱼池' : '保存改动';
    renderGallery();
  }

  function mount(hostEl, cfgRef, onChange) {
    ensure();
    host = hostEl; cfg = cfgRef; change = onChange;

    host.innerHTML = `
      <div class="paint-box">
        <div class="p-head">
          <div class="p-eyebrow">MY KOI</div>
          <div class="p-title">画一条自己的锦鲤</div>
          <p class="p-sub">在鱼身上画出颜色和花纹。放入池中后，它会和其他锦鲤一样结群、避让和抢食。</p>
        </div>

        <div class="paint-stage" id="pStage"></div>

        <div class="p-sliders">
          <div class="p-slot"><span>身体轮廓</span><input type="range" id="pFat" min="0" max="1" step="0.02"><i></i></div>
          <div class="p-slot"><span>尾部长度</span><input type="range" id="pTail" min="0" max="1" step="0.02"><i></i></div>
        </div>

        <div class="p-row">
          <span class="p-lab">画笔</span>
          <span class="p-colors" id="pColors"></span>
        </div>

        <div class="p-row">
          <span class="p-lab">笔头</span>
          <input type="range" class="p-brush" id="pSize" min="4" max="46" step="2">
          <button class="p-txt" id="pErase">橡皮</button>
          <button class="p-txt" id="pFlip">翻转</button>
          <button class="p-txt" id="pClear">清空</button>
        </div>

        <div class="p-row">
          <span class="p-lab">底色</span>
          <span class="p-colors p-bases" id="pBases"></span>
          <button class="p-txt" id="pRandom">随机花纹</button>
        </div>

        <div class="p-name">
          <div class="p-lab">给他起个名字</div>
          <div class="p-name-row">
            <input type="text" id="pName" maxlength="16" placeholder="锦鲤">
            <button class="p-txt" id="pRandName">随机起名</button>
          </div>
          <div class="p-hint">最多 16 个字，留空时自动挑一个名字。</div>
        </div>

        <div class="p-actions"><button class="btn pill" id="pApply">放入鱼池</button></div>

        <div class="p-gal-head">
          <div class="p-gal-title">我自定义的锦鲤</div>
          <div class="p-hint">点一条继续改，× 就把它从池中删掉。最多 ${MAX} 条。</div>
        </div>
        <div class="p-gal" id="pGal"></div>
      </div>`;

    const stage = host.querySelector('#pStage');
    stage.appendChild(ref);
    stage.appendChild(ink);
    bindOnce();

    const colors = host.querySelector('#pColors');
    colors.innerHTML = COLORS.map(c => sw(c, c === color)).join('');
    colors.addEventListener('click', e => {
      const b = e.target.closest('.sw'); if (!b) return;
      color = b.dataset.c;
      tool = 'brush';
      host.querySelector('#pErase').classList.remove('on');
      colors.querySelectorAll('.sw').forEach(s => s.classList.toggle('on', s === b));
    });

    const bases = host.querySelector('#pBases');
    bases.innerHTML = BASES.map(c => sw(c, c === curBase)).join('');
    bases.addEventListener('click', e => {
      const b = e.target.closest('.sw'); if (!b) return;
      curBase = b.dataset.c;
      bases.querySelectorAll('.sw').forEach(s => s.classList.toggle('on', s === b));
      paintRef(); reclip(); save();
      if (change) change('koiPaint', null);
    });

    // 两个几何滑杆：拖动时重画参考层 + 重裁图案，所以预览是即时的
    for (const [id, key] of [['pFat', 'fat'], ['pTail', 'tail']]) {
      const el = host.querySelector('#' + id);
      el.value = key === 'fat' ? curFat : curTail;
      el.addEventListener('input', () => {
        const v = +el.value;
        if (key === 'fat') curFat = v; else curTail = v;
        paintRef(); reclip();
        const d = current();
        if (d) { d[key] = v; }
        dirty();
      });
    }
    host.querySelector('#pSize').value = brush;
    host.querySelector('#pSize').addEventListener('input', e => { brush = +e.target.value; });
    host.querySelector('#pErase').addEventListener('click', e => {
      tool = tool === 'erase' ? 'brush' : 'erase';
      e.currentTarget.classList.toggle('on', tool === 'erase');
    });
    host.querySelector('#pFlip').addEventListener('click', flip);
    host.querySelector('#pClear').addEventListener('click', clearInk);
    host.querySelector('#pRandom').addEventListener('click', randomPattern);

    host.querySelector('#pName').value = curName;
    host.querySelector('#pName').addEventListener('input', e => {
      curName = e.target.value.slice(0, 16);
      const d = current(); if (d) { d.name = curName; renderGallery(); }
      dirty();
    });
    host.querySelector('#pRandName').addEventListener('click', () => {
      curName = randName();
      host.querySelector('#pName').value = curName;
      const d = current(); if (d) { d.name = curName; renderGallery(); }
      dirty();
    });

    host.querySelector('#pApply').addEventListener('click', e => {
      apply();
      const b = e.currentTarget;
      b.textContent = '已放进池子';
      setTimeout(() => { b.textContent = fresh ? '放入鱼池' : '保存改动'; }, 1200);
    });

    const gal = host.querySelector('#pGal');
    gal.addEventListener('click', e => {
      const del = e.target.closest('[data-del]');
      if (del) { remove(del.dataset.del); return; }
      if (e.target.closest('#pNew')) {
        save();
        loadInto(null);
        syncEditorFields();
        return;
      }
      const item = e.target.closest('.p-item[data-id]') || e.target.closest('.p-thumb[data-id]');
      const id = item && item.dataset.id;
      if (!id || id === curId) return;
      save();
      loadInto(designs.find(d => d.id === id) || null);
      syncEditorFields();
    });

    syncEditorFields();
    return api;
  }

  const sw = (c, on) => `<button class="sw${on ? ' on' : ''}" data-c="${c}" style="--c:${c}" title="${c}"></button>`;

  function compose() {
    const d = current();
    return spriteOf(d || { base: curBase, fat: curFat, tail: curTail, __live: true });
  }

  const api = {
    mount, apply, flip, clearInk, boot, syncSprites, remove,
    compose, randomPattern, hasSaved,
    designs: () => designs, current: () => current(),
    CW, CH, COLORS, BASES, MAX,
  };
  global.Paint = api;
})(typeof window !== 'undefined' ? window : globalThis);
