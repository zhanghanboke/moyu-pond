/* main.js —— 启动、渲染循环、输入、水面波动、天气联动、性能自适应
 *
 * 性能策略（壁纸是 7×24 常驻的，必须便宜）：
 *   1. 底图 + 水色 + 暗角 + 天气光照 烘成一张 bgCache，每帧只 1 次 drawImage；
 *   2. 荷叶荷花的模糊投影烘进 decorCache，每帧每样 1 次 drawImage，不用 ctx.filter；
 *   3. 鱼的摆尾用 sprites.js 预烘的相位图集，每条鱼 1 次本体；
 *   4. 焦散和波纹都是预烘 tile 平移平铺，不做逐像素运算。
 * 水面波动（见 waveSlope / drawWaterWarp / drawChop）跟画质档和 autoDrop 联动：
 * 一掉帧就先砍波动，再砍折射和焦散，最后才考虑减少数量。
 * 用普通 script 标签加载（不用 ES module），双击 index.html 走 file:// 也能跑。 */
(function (global) {
  'use strict';
  const { assets, atlasCell, KOI, CANON } = global.Sprites;
  const { Fish, Ripple, Food, RainDrop, SnowFlake, LAYOUT, obstacles, updateSchools, SCENES, sceneForHour,
    creatureHosts, Turtle, Tadpole, Butterfly, Petal, Firefly, Mist, clamp, lerp, rand, TAU } = global.Sim;
  const { build: buildHUD, tick: hudTick, load: loadCfg, clear: clearCfg } = global.MoyuHUD;

  const canvas = document.getElementById('pond');
  const ctx = canvas.getContext('2d', { alpha: false });
  if (/[?&]fresh=1/.test(location.search)) clearCfg();     // ?fresh=1 回到默认设置
  const cfg = loadCfg();

  const world = { w: 0, h: 0, dpr: 1, k: 1 };
  const mouse = { x: -999, y: -999, px: -999, py: -999, inside: false, down: false, speed: 0, t: 0 };
  const state = {
    fishes: [], ripples: [], foods: [], breachT: 4,
    turtles: [], tadpoleNests: [], butterflies: [], bflyTargets: [],
    petals: [], fireflies: [], mists: [], rain: [], snow: [],
    scene: 'noon', sceneCheck: 0,
    t: 0, last: 0, fps: 60, autoDrop: 0, ambient: 0,
    bg: null, decor: [], overscan: 18,
    waveAmp: 0, waveTile: null, waveSize: 512, warpRows: 26,
  };

  /* ---------------- 天气 ----------------
   * station.env 是 weather.js 算好的一组乘子；关掉天气联动、或模块没加载时
   * 一律用这份"什么都不改"的默认值，主循环里就不用到处写 if。
   * 拿到新数据要重烘背景：光照是烘进缓存的（每帧零开销的代价）。 */
  const NO_ENV = { light: 1, causticK: 1, rippleRate: 1, swayK: 1, chopK: 1, fishSpeed: 1, fishDepth: 0, rain: 0, snow: 0, fog: 0, wind: 0 };
  let station = null;
  function env() {
    if (!cfg.weatherOn || !station || !station.env) return NO_ENV;
    return station.env;
  }

  /* 场景：auto 跟时钟走（上班=清晨/正午，傍晚=黄昏，加班=月夜），也可手动指定 */
  function resolveScene(now) {
    return cfg.scene === 'auto' ? sceneForHour(now.getHours()) : cfg.scene;
  }
  function applyScene(name) {
    if (state.scene === name) return;
    state.scene = name;
    syncAmbient();
    if (assets.ready) bakeBg();
  }

  function fitArr(arr, Ctor, n) {
    while (arr.length > n) arr.pop();
    while (arr.length < n) arr.push(new Ctor(world, arr.length, n));
  }
  function syncAmbient() {
    const sc = SCENES[state.scene] || SCENES.noon;
    const e = env();
    // 雾天不管什么时辰都该有薄雾 —— 这是天气对氛围最直观的一处影响
    const fogN = e.fog > 0.35 ? (e.fog > 0.7 ? 3 : 2) : 0;
    fitArr(state.petals, Petal, sc.petals);
    fitArr(state.fireflies, Firefly, sc.fireflies);
    fitArr(state.mists, Mist, (sc.mist || 0) + fogN);
  }
  function syncPrecip() {
    const e = env();
    const q = cfg.quality === 'high' ? 1 : cfg.quality === 'medium' ? 0.72 : 0.45;
    fitArr(state.rain, RainDrop, Math.round(230 * e.rain * q));
    fitArr(state.snow, SnowFlake, Math.round(130 * e.snow * q));
  }
  function buildCreatures() {
    const hosts = creatureHosts();
    state.turtles = [];
    for (const rock of hosts.rocks) {
      const n = rock.s > 0.12 ? 2 : 1;
      for (let i = 0; i < n; i++) state.turtles.push(new Turtle(rock));
    }
    state.tadpoleNests = [0, 3, 5].map(i => hosts.pads[i]).filter(Boolean).map(pad => ({
      pad, list: Array.from({ length: 6 + (Math.random() * 5 | 0) }, () => new Tadpole()),
    }));
    state.butterflies = Array.from({ length: 3 }, () => new Butterfly(world));
    state.bflyTargets = hosts.flowers.concat(hosts.pads.slice(0, 4));
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    return c;
  }

  /* ---------------- 静态层烘焙 ---------------- */
  function bakeBg() {
    const img = assets.base;
    const pad = state.overscan;
    const cw = world.w + pad * 2, ch = world.h + pad * 2;
    const c = makeCanvas(cw * world.dpr, ch * world.dpr);
    const x = c.getContext('2d');
    x.setTransform(world.dpr, 0, 0, world.dpr, 0, 0);
    if (img) {
      const s = Math.max(cw / img.width, ch / img.height) * 1.02;
      const w = img.width * s, h = img.height * s;
      x.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
      // 水下植物：静态、在鱼下面，所以直接烘进背景，每帧零开销。
      // 平铺着画而不是整张拉伸 —— 拉满屏会让每一株都变成 400px 的"水底松树"，
      // 缩到 1/3 尺寸才像池底的一片片水草。
      if (assets.weed && cfg.weed > 0.01) {
        const tsz = Math.max(cw, ch) * 0.34;
        x.globalAlpha = 0.30 * cfg.weed;
        // 相邻格镜像翻转：直接平铺能看出重复周期，翻一下就看不出来了
        for (let ty = -tsz * 0.35, j = 0; ty < ch; ty += tsz, j++) {
          for (let tx = -tsz * 0.3, i = 0; tx < cw; tx += tsz, i++) {
            x.save();
            x.translate(tx + (i % 2 ? tsz : 0), ty + (j % 2 ? tsz : 0));
            x.scale(i % 2 ? -1 : 1, j % 2 ? -1 : 1);
            x.drawImage(assets.weed, 0, 0, tsz, tsz);
            x.restore();
          }
        }
        x.globalAlpha = 1;
      }
      // 场景调色：清晨偏暖白、黄昏偏金、月夜压成深蓝，都烘进缓存
      const sc = SCENES[state.scene] || SCENES.noon;
      if (sc.grade) {
        x.globalCompositeOperation = sc.grade.blend;
        x.globalAlpha = sc.grade.a;
        x.fillStyle = `rgb(${sc.grade.rgb.join(',')})`;
        x.fillRect(0, 0, cw, ch);
        x.globalCompositeOperation = 'source-over';
        x.globalAlpha = 1;
      }
      if (sc.moon) {                       // 月夜：一汪斜打进来的月光
        const mg = x.createRadialGradient(cw * 0.74, ch * 0.16, 0, cw * 0.74, ch * 0.16, Math.max(cw, ch) * 0.55);
        mg.addColorStop(0, 'rgba(206,228,255,0.20)');
        mg.addColorStop(0.5, 'rgba(180,210,246,0.08)');
        mg.addColorStop(1, 'rgba(180,210,246,0)');
        x.save();
        x.globalCompositeOperation = 'screen';
        x.fillStyle = mg;
        x.fillRect(0, 0, cw, ch);
        x.restore();
      }
      // 深水压一层冷绿，浅水留亮 —— 拉开纵深
      x.globalCompositeOperation = 'multiply';
      x.globalAlpha = 0.08;
      x.fillStyle = '#39a08d';
      x.fillRect(0, 0, cw, ch);
      x.globalCompositeOperation = 'source-over';
      x.globalAlpha = 1;
      const g = x.createRadialGradient(cw / 2, ch * 0.45, Math.min(cw, ch) * 0.3,
        cw / 2, ch / 2, Math.max(cw, ch) * 0.75);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(3,38,36,0.30)');
      x.fillStyle = g; x.fillRect(0, 0, cw, ch);

      /* 天气的光照：云量、雨雪雾都把池子压暗，晴天略微提亮。
       * 烘进缓存而不是每帧罩一层全屏色 —— 后者正是第一版掉到 2.9fps 的原因。 */
      const e = env();
      if (Math.abs(e.light - 1) > 0.015) {
        const d = Math.min(0.5, Math.abs(1 - e.light));
        x.globalCompositeOperation = e.light < 1 ? 'multiply' : 'screen';
        x.globalAlpha = d * 0.62;
        x.fillStyle = e.light < 1 ? 'rgb(104,118,126)' : 'rgb(255,244,222)';
        x.fillRect(0, 0, cw, ch);
        x.globalCompositeOperation = 'source-over';
        x.globalAlpha = 1;
      }
    } else {
      x.fillStyle = '#0d5a54'; x.fillRect(0, 0, cw, ch);
    }
    state.bg = c;
  }

  /* 装饰：把"投影 + 本体"烘成一张缓存，并且记住旋转支点。
   * 浮在水面的（荷叶/浮萍）支点在中心，整片轻轻起伏；
   * 从水里长出来的（芦苇/岸边石头）支点在根部，风来了绕根部摇，
   * 投影也更散更大 —— 光从左上方来，所以影子落在右下。 */
  function bakeDecor() {
    state.decor = [];
    if (!cfg.decor) return;
    for (const it of LAYOUT) {
      const src = assets.decor[it.name];
      if (!src) continue;
      const w = world.w * it.s, h = w * (src.height / src.width);
      const bank = it.kind === 'bank';
      const pad = Math.max(28, w * 0.18);
      const c = makeCanvas((w + pad * 2) * world.dpr, (h + pad * 2) * world.dpr);
      const x = c.getContext('2d');
      x.setTransform(world.dpr, 0, 0, world.dpr, 0, 0);
      x.globalAlpha = bank ? 0.17 : 0.20;
      x.filter = `blur(${(bank ? 7 : 5) * Math.max(0.6, world.k)}px)`;
      if (bank) {                       // 水下的影子会被放大散开，浮叶的影子紧贴边缘
        x.translate(pad + w / 2, pad + h / 2); x.scale(1.03, 1.07); x.translate(-pad - w / 2, -pad - h / 2);
      }
      x.drawImage(src, pad + w * (bank ? 0.055 : 0.022), pad + h * (bank ? 0.06 : 0.03), w, h);
      x.filter = 'none';
      x.globalAlpha = 1;
      x.drawImage(src, pad, pad, w, h);
      state.decor.push({
        c, pad, it, w: w + pad * 2, h: h + pad * 2,
        pivX: pad + w * (it.ax == null ? 0.5 : it.ax),
        pivY: pad + h * (it.ay == null ? 0.5 : it.ay),
      });
    }
  }

  function resize() {
    const dprCap = cfg.quality === 'high' ? 1.5 : cfg.quality === 'medium' ? 1.15 : 1;
    const ow = world.w || innerWidth, oh = world.h || innerHeight;
    world.w = innerWidth; world.h = innerHeight;
    // k = 相对 1080p 的线性缩放；鱼的大小/速度/作用半径乘 k，数量按面积缩放
    world.k = clamp(world.w / 1920, 0.6, 1.7);
    world.dpr = Math.min(devicePixelRatio || 1, dprCap);
    canvas.width = Math.round(world.w * world.dpr);
    canvas.height = Math.round(world.h * world.dpr);
    canvas.style.width = world.w + 'px';
    canvas.style.height = world.h + 'px';
    ctx.setTransform(world.dpr, 0, 0, world.dpr, 0, 0);
    if (ow && oh && (ow !== world.w || oh !== world.h)) {
      const rx = world.w / ow, ry = world.h / oh;
      for (const f of state.fishes) { f.x *= rx; f.y *= ry; }
    }
    state.obstacles = cfg.decor ? obstacles(world) : [];
    // 扫描线折射的行数：行越多越细腻也越贵，跟着画质档走；低画质直接不做
    state.warpRows = cfg.quality === 'high' ? 26 : cfg.quality === 'medium' ? 14 : 0;
    if (assets.ready) {
      bakeBg(); bakeDecor(); bakeCausticTile();
      if (!state.waveTile) bakeWaveTile();
      buildCreatures(); syncAmbient(); syncPrecip();
    }
    syncPopulation();
  }

  /* 焦散平铺图预放大到实际使用尺寸：每帧就只剩位图拷贝，不再做双线性缩放 */
  function bakeCausticTile() {
    if (!assets.caustics) return;
    const sz = state.causticSize = Math.round(Math.min(world.w, world.h) * 0.62);
    const c = makeCanvas(sz * world.dpr, sz * world.dpr);
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(assets.caustics, 0, 0, c.width, c.height);
    state.causticTile = c;
  }

  /* 波纹明暗的平铺图：整数频率的正弦叠加，所以四边天然接得上。
   * 只留"亮带"（白色 alpha），暗部交给焦散和暗角 —— 这样一层 source-over 就够，
   * 不必做全屏 soft-light（那玩意儿在软渲染下是帧率杀手）。 */
  function bakeWaveTile() {
    const S = state.waveSize = 512;
    const c = makeCanvas(S, S);
    const x = c.getContext('2d');
    const img = x.createImageData(S, S);
    const d = img.data;
    for (let y = 0; y < S; y++) {
      for (let xx = 0; xx < S; xx++) {
        const u = xx / S, v = y / S;
        const a = 0.62 * Math.sin((u * 2 + v * 3) * TAU) + 0.38 * Math.sin((u * 3 - v * 1) * TAU);
        const i = (y * S + xx) * 4;
        d[i] = d[i + 1] = d[i + 2] = 255;
        d[i + 3] = (Math.pow(Math.max(0, a), 2.0) * 210) | 0;
      }
    }
    x.putImageData(img, 0, 0);
    state.waveTile = c;
    wavePat = null;                      // 换砖就换 pattern，别拿旧 tile 的 pattern 去填
  }

  /* 画板点了"放入鱼池"、删了一条、或改了"我的锦鲤"开关之后：
   * 不重建鱼群（重建会让满池鱼瞬移），只把其中约 9% 换成自定义鱼，
   * 观感上就是"新鱼入池"。自定义鱼总占比固定 9%，捏了好几条就在它们之间均分
   * —— 这样再加一条不会把池子慢慢变成"全是自己画的"。 */
  function reassignCustom() {
    const S = global.Sprites;
    const isMine = f => !!f.mine || (S.isCustomKind && S.isCustomKind(f.kind));
    const kinds = (S.customKinds ? S.customKinds() : []).filter(k => S.assets.koi[k]);
    const toBuiltin = f => { f.kind = KOI[(Math.random() * KOI.length) | 0]; f.mine = false; };

    // 没有可用的自定义花色（开关关了 / 全删了）：整群换回内置
    if (!kinds.length) {
      for (const f of state.fishes) if (isMine(f)) toBuiltin(f);
      return;
    }
    // 被删掉的那一条：池子里还有它的鱼就先换回内置
    for (const f of state.fishes) if (f.mine && kinds.indexOf(f.kind) < 0) toBuiltin(f);

    const total = Math.max(1, Math.round(state.fishes.length * 0.09));
    const per = Math.max(1, Math.floor(total / kinds.length));
    for (const k of kinds) {
      let n = 0;
      for (const f of state.fishes) if (f.kind === k) n++;
      for (const f of state.fishes) {
        if (n >= per) break;
        if (f.mine) continue;
        f.kind = k; f.mine = true; n++;
      }
    }
  }

  function syncPopulation() {
    // 滑杆上的数字是"1080p 下的条数"，其他分辨率按屏幕面积换算，
    // 否则 2K 屏看着稀、笔记本屏看着挤。
    const area = (world.w * world.h) / (1920 * 1080);
    const want = Math.max(4, Math.round(cfg.fishCount * clamp(area, 0.3, 3)));
    while (state.fishes.length > want) state.fishes.pop();
    while (state.fishes.length < want) state.fishes.push(new Fish(world, KOI));
    // 抽"塘主"是个概率事件，一池 100 条也有几个百分点的概率一条都抽不中，
    // 那就没有压场的大鱼了。所以这里兜一下：一条都没有时，把最靠水面、底子最大的那条提成塘主。
    if (!state.fishes.some(f => f.sizeK > 1.2)) {
      const cand = state.fishes.filter(f => f.depth < 0.5).sort((a, b) => b.lenSurf - a.lenSurf)[0];
      if (cand) cand.sizeK *= 1.55;
    }
    state.wantCount = want;
  }

  /* 涟漪总量控制：同屏最多 8 圈，小的排队进不来；
   * quiet=true 的小涟漪（鱼吃饵、雨点落水）附近已经有圈就不再叠，否则饵点会糊成一片。 */
  const RIPPLE_MAX = 8;
  function spawnRipple(x, y, strength, quiet) {
    if (quiet && state.ripples.some(r => Math.hypot(r.x - x, r.y - y) < 55 * world.k)) return;
    if (state.ripples.length >= RIPPLE_MAX) {
      // 只让明显更强的挤掉当前最弱的一个，否则直接忽略
      let wi = -1, wv = 1e9;
      state.ripples.forEach((r, i) => { if (r.s < wv) { wv = r.s; wi = i; } });
      if (wi < 0 || strength <= wv || wv > 0.4) return;
      state.ripples.splice(wi, 1);
    }
    state.ripples.push(new Ripple(x, y, strength, world.k));
  }
  const rippleRoom = () => state.ripples.length < RIPPLE_MAX;

  /* ---------------- 水面波动 ----------------
   * 真实波面是高度场，但逐像素算太贵（壁纸要 7×24 常驻）。这里用三层便宜的近似叠起来：
   *   1) 扫描线折射 —— 把烘好的背景按行分带、每带横向错位：水下景物随波缓缓扭动；
   *   2) 波纹光带   —— 预烘正弦 tile 两层不同速度平铺：亮带慢慢淌过水面；
   *   3) 物体随波   —— 鱼和浮叶按同一高度场做几像素的位移，跟水一起动。
   * 关键在"波长比屏幕还长"：按行错位时相邻带的位移差极小，看不出阶梯，只有整体涌动。 */
  function waveSlope(y, t) {
    const H = world.h || 1080;
    const b = TAU / H;
    return 0.55 * Math.sin(y * b / 1.15 - t * 0.55)
      + 0.30 * Math.sin(y * b / 0.62 + t * 0.83 + 1.7)
      + 0.15 * Math.sin(y * b / 0.37 - t * 1.21 + 3.1);
  }

  function drawWaterWarp(t, dx, dy, amp, rows) {
    const bg = state.bg;
    const pad = state.overscan;
    const cw = world.w + pad * 2, ch = world.h + pad * 2;
    const bandH = ch / rows;
    const perWorld = bg.height / ch;
    for (let i = 0; i < rows; i++) {
      const wy = -pad + dy + i * bandH;
      const off = amp * waveSlope(wy, t);
      const sy = i * bandH * perWorld;
      const sh = Math.max(1, Math.min(bg.height - sy, bandH * perWorld));
      // 多给 0.7px 高度，避免分带之间出现 1px 的缝
      ctx.drawImage(bg, 0, sy, bg.width, sh, -pad + dx + off, wy, cw, bandH + 0.7);
    }
  }

  /* 用 pattern 一次铺满，而不是自己 for 循环贴砖：
   * 手动平铺要画满"屏幕 + 一块砖"的范围，1920×1080 下两层合计约 1180 万像素/帧
   * （5.7 个屏幕），软件渲染实测 51→33 fps。pattern 只填屏幕本身，省掉全部外扩。
   * 两层同尺寸、速度和方向不同，够打破周期感，也就不需要缩放 tile。 */
  let wavePat = null;
  function fillWave(ox, oy) {
    if (!wavePat) wavePat = ctx.createPattern(state.waveTile, 'repeat');
    ctx.save();
    ctx.translate(ox, oy);
    ctx.fillStyle = wavePat;
    ctx.fillRect(-ox, -oy, world.w, world.h);
    ctx.restore();
  }

  function drawChop(t) {
    const e = env();
    // 掉帧时整层淡出（不是留 1/4），并且先砍到单层：水面波动是锦上添花，鱼不能卡
    const a = cfg.chop * (e.chopK || 1) * (1 - state.autoDrop);
    if (a < 0.06 || !state.waveTile) return;
    const S = state.waveSize;
    const layers = state.autoDrop > 0.35 ? 1 : 2;
    ctx.save();
    for (let L = 0; L < layers; L++) {
      const sp = L ? 13 : 6;
      const dir = L ? -1 : 1;
      ctx.globalAlpha = (L ? 0.085 : 0.11) * a;
      const ox = ((t * sp) % S + S) % S - S;
      const oy = ((t * sp * 0.62 * dir) % S + S) % S - S;
      fillWave(ox, oy);
    }
    ctx.restore();
  }

  /* ---------------- 每帧绘制 ---------------- */
  function drawCaustics(t) {
    const a = cfg.caustics * (1 - state.autoDrop) * (SCENES[state.scene] || SCENES.noon).caustic * (env().causticK || 1);
    if (a < 0.12 || !state.causticTile) return;          // 掉帧时整层直接不画
    const sz = state.causticSize;
    ctx.save();
    ctx.globalAlpha = 0.085 * a;
    const ox = ((t * 9) % sz + sz) % sz - sz;
    const oy = ((t * 5.5) % sz + sz) % sz - sz;
    // 平铺图已经按屏幕尺寸预放大过，这里全是 1:1 拷贝，不做双线性缩放
    for (let X = ox; X < world.w; X += sz)
      for (let Y = oy; Y < world.h; Y += sz) ctx.drawImage(state.causticTile, X, Y, sz, sz);
    ctx.restore();
  }

  /* ---------- 小动物与氛围的画法 ---------- */
  function drawTurtle(t) {
    if (t.state === 'gone') return;
    const img = assets.creatures[t.kind];
    if (!img) return;
    const p = t.pos(world), k = world.k || 1;
    const len = t.len * k * cfg.size, h = len * (img.height / img.width);
    let ox = 0, oy = 0, al = 1;
    if (t.state === 'slip') {                       // 滑进水里：往前窜 + 逐渐没入
      const e = t.slip * t.slip;
      ox = Math.cos(t.angle) * e * 34 * k;
      oy = Math.sin(t.angle) * e * 34 * k;
      al = 1 - t.slip * 0.55;
    }
    ctx.save();
    ctx.translate(p.x + ox, p.y + oy);
    ctx.rotate(t.angle + (t.state === 'slip' ? Math.sin(t.slip * 22) * 0.06 : 0));
    ctx.globalAlpha = 0.30 * al;                    // 趴在石头上的贴地影（预烘位图）
    ctx.drawImage(assets.creatures[t.kind + '_shadow'], -len / 2 - 4 + 3, -h / 2 - 4 + 4, len + 8, h + 8);
    const breath = 1 + 0.012 * Math.sin(t.breath);  // 呼吸的微小起伏
    ctx.globalAlpha = al;
    ctx.scale(breath, breath);
    ctx.drawImage(img, -len / 2, -h / 2, len, h);
    ctx.restore();
  }

  /* 蝌蚪在荷叶的局部坐标系里画（继承叶片的平移/旋转/起伏） */
  function drawTadpole(td, w, hgt) {
    const k = world.k || 1;
    const s = td.size * k;
    ctx.save();
    ctx.translate(td.u * w / 2, td.v * hgt / 2);
    ctx.rotate(td.a);
    ctx.fillStyle = 'rgba(22,26,22,0.88)';
    ctx.beginPath(); ctx.ellipse(0, 0, s * 0.62, s * 0.44, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(22,26,22,0.68)';
    ctx.lineWidth = Math.max(0.8, s * 0.16);
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-s * 0.5, 0);
    for (let i = 1; i <= 3; i++) {                  // 三节摆尾
      const tt = i / 3;
      ctx.lineTo(-s * (0.5 + tt * 1.5), Math.sin(td.wig - tt * 2.4) * s * 0.5 * tt);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawButterfly(b) {
    const img = assets.creatures[b.kind];
    if (!img) return;
    const k = world.k || 1;
    const size = b.size * k, hgt = size * (img.height / img.width);
    const sh = clamp(b.h / 60, 0, 1);               // 离水越高影子越偏越淡
    ctx.save();
    ctx.translate(b.x + b.h * 0.30, b.y + b.h * 0.42);
    ctx.globalAlpha = 0.20 * (1 - sh * 0.55);
    ctx.rotate(b.a + Math.PI / 2);                  // 素材头朝上，和身体同一个朝向
    const shImg = assets.creatures[b.kind + '_shadow'];
    const sw2 = size * (0.9 + sh * 0.5);            // 越高影子越大越散
    ctx.drawImage(shImg, -sw2 / 2, -sw2 * shImg.height / shImg.width / 2,
      sw2, sw2 * shImg.height / shImg.width);
    ctx.restore();
    const resting = b.state === 'rest';
    // 俯视扇翅 = 沿身体轴把投影压窄；停着的时候只是慢慢开合
    const fl = resting ? 0.82 + 0.18 * Math.sin(b.flap * 0.5)
      : 0.42 + 0.58 * Math.abs(Math.sin(b.flap));
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.a + Math.PI / 2);                  // 素材头朝上，航向 0 = 右
    ctx.scale(fl, 1);
    ctx.drawImage(img, -size / 2, -hgt / 2, size, hgt);
    ctx.restore();
  }

  function drawPetal(p) {
    const s = p.size * (world.k || 1);
    ctx.save();
    ctx.translate(p.x, p.y); ctx.rotate(p.rot);
    ctx.globalAlpha = 0.88;
    ctx.fillStyle = 'rgb(240,178,194)';
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.quadraticCurveTo(s * 0.8, -s * 0.2, 0, s);
    ctx.quadraticCurveTo(-s * 0.8, -s * 0.2, 0, -s);
    ctx.fill();
    ctx.globalAlpha = 0.30;
    ctx.fillStyle = 'rgb(255,255,255)';
    ctx.beginPath(); ctx.ellipse(-s * 0.15, -s * 0.25, s * 0.26, s * 0.42, 0.3, 0, TAU); ctx.fill();
    ctx.restore();
  }

  function drawFirefly(f) {
    const g = f.glow();
    if (g <= 0.03) return;
    const r = (2.2 + g * 2.2) * (world.k || 1) * 5;
    ctx.globalAlpha = g;
    ctx.drawImage(assets.glow, f.x - r, f.y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
  }

  function drawMist(m) {
    const e = env();
    ctx.globalAlpha = (0.11 + 0.06 * Math.sin(m.ph)) * (1 + e.fog * 0.8);
    ctx.drawImage(assets.mist, m.x - m.r, m.y - m.r * 0.42, m.r * 2, m.r * 0.84);
    ctx.globalAlpha = 1;
  }

  function drawVeil() {
    const sc = SCENES[state.scene] || SCENES.noon;
    if (sc.veil) {
      ctx.save();
      ctx.globalCompositeOperation = sc.veil.blend;
      ctx.globalAlpha = sc.veil.a;
      ctx.fillStyle = `rgb(${sc.veil.rgb.join(',')})`;
      ctx.fillRect(0, 0, world.w, world.h);
      ctx.restore();
    }
    // 雾天再压一层乳白：远处的荷叶会显得发灰，像隔着水汽看
    const e = env();
    if (e.fog > 0.05) {
      ctx.save();
      ctx.globalAlpha = Math.min(0.32, e.fog * 0.22);
      ctx.fillStyle = 'rgb(232,240,238)';
      ctx.fillRect(0, 0, world.w, world.h);
      ctx.restore();
    }
  }

  function drawRain() {
    const step = state.autoDrop > 0.5 ? 2 : 1;      // 掉帧时雨丝画一半就够看了
    for (let i = 0; i < state.rain.length; i += step) state.rain[i].draw(ctx);
  }
  function drawSnow() {
    const step = state.autoDrop > 0.5 ? 2 : 1;
    for (let i = 0; i < state.snow.length; i += step) state.snow[i].draw(ctx);
  }

  /* ---------- 池底投影 ----------
   * 三个量都由"离池底多远"决定，量级取自俯视看池子的常识：
   *   贴着底（gap→0）—— 影子几乎在正下方、小而深，像贴着蹭出来的一团；
   *   贴着水面（gap→1）—— 中间隔着整个水层，光被摊开，影子更大更淡、也偏得更远。
   * 偏移量 ×0.62/0.86 是右下方向：光从左上来（见 bakeDecor 里装饰投影的注释）。
   * 旋转和弯曲都跟本体一致（同一个 pose / bend），不然转身时影子和鱼会脱开。 */
  function drawFishShadow(f) {
    const rec = assets.koi[f.kind];
    if (!rec || !rec.sil) return;
    const S = rec.sil;
    const pond = clamp(cfg.pondDepth == null ? 1 : cfg.pondDepth, 0.25, 1);
    const d = f.depthNow == null ? f.depth : f.depthNow;
    const gap = clamp((pond - d) / Math.max(pond, 1e-3), 0, 1);
    const len = f.len * cfg.size;
    const sc = (len / S.w) * (1.04 + gap * 0.30);   // S.w 是剪影烘培时的体长（不是 CANON）
    const off = (2.5 + gap * 30) * (world.k || 1);
    ctx.save();
    ctx.translate(f.x + off * 0.62, f.y + off * 0.86);
    ctx.rotate(f.pose == null ? f.angle : f.pose);
    const bend = f.bend || 0;
    if (bend) ctx.transform(1, bend, 0, 1, 0, 0);
    ctx.globalAlpha = lerp(0.26, 0.05, gap);
    ctx.drawImage(S.canvas, -(S.canvas.width * sc) / 2, -(S.canvas.height * sc) / 2,
      S.canvas.width * sc, S.canvas.height * sc);
    ctx.restore();
  }

  function drawFish(f) {
    const rec = assets.koi[f.kind];
    if (!rec || !rec.atlas) return;
    const e = env();
    const len = f.len * cfg.size;
    // 冷天整池鱼沉一点 —— 这层已经在 sim 里叠进 depthNow 了，这里别再加一遍
    const depth = clamp(f.depthNow == null ? f.depth : f.depthNow, 0, 1);
    const a = rec.atlas;
    const s = len / CANON;
    const dw = a.cellW * s, dh = a.cellH * s;
    const amp = state.waveAmp;
    const wob = amp > 0.05 ? waveSlope(f.y, state.t) : 0;   // 鱼跟着水面一起晃

    // 影子叠在本体下面（本体另外有位移是给它跟水面一起晃用的）
    ctx.save();
    ctx.translate(f.x + wob * amp * 0.5, f.y + wob * amp * 0.3);
    ctx.rotate(f.pose == null ? f.angle : f.pose);
    /* 身体的弯曲与横滚：transform(1, bend, 0, 1, 0, 0) 把 (x,y) 映成 (x, y + bend·x)，
     * 也就是沿体轴的垂直剪切 —— 头在原点不动、越往尾巴挪得越多，正是一条 I 形变弧形。
     * 一次矩阵乘法就够，不用切片也不用多画；横滚只是把侧影压窄一点。 */
    const bend = f.bend || 0;
    if (bend) {
      ctx.transform(1, bend, 0, 1, 0, 0);
      ctx.scale(1, 1 - Math.min(0.16, Math.abs(bend) * 0.42));
    }
    ctx.globalAlpha = depth > 0.7 ? 0.9 : 1;
    const [sx, sy, sw, shh] = atlasCell(rec, depth, f.phase);
    ctx.drawImage(a.canvas, sx, sy, sw, shh, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!assets.ready) return;
    const dtRaw = state.last ? (now - state.last) / 1000 : 0.016;
    state.last = now;
    const dt = Math.min(dtRaw, 1 / 20);          // 切标签页回来不要瞬移
    state.t += dt;
    state.fps = lerp(state.fps, 1 / Math.max(dtRaw, 1e-4), 0.05);
    if (mouse.speed > 0) mouse.speed = Math.max(0, mouse.speed - dt * 2000);   // 光标停下就不再算"划得快"

    // 掉帧就先砍最贵的效果，再考虑砍数量
    if (state.fps < 45) state.autoDrop = Math.min(1, state.autoDrop + dt * 0.5);
    else if (state.fps > 56) state.autoDrop = Math.max(0, state.autoDrop - dt * 0.25);

    const e = env();

    // ---- 物理 ----
    updateSchools(dt, world);
    state.ambient -= dt;
    if (state.ambient <= 0) {
      // 天气越糟，环境涟漪越密（雨点、风把水面搅起来）
      state.ambient = rand(1.4, 4.2) / (e.rippleRate || 1);
      spawnRipple(rand(0.06, 0.94) * world.w, rand(0.06, 0.94) * world.h, rand(0.22, 0.42));
    }
    // 浮头由全局节奏驱动：以前每条鱼自己计时，144 条鱼叠起来每秒好几圈，
    // 满屏靶子。现在跟鱼群数量无关，平均 3~7 秒一次。
    state.breachT -= dt;
    if (state.breachT <= 0) {
      state.breachT = rand(3, 7);
      const shallow = state.fishes.filter(f => f.depth < 0.45);
      if (shallow.length) {
        const f = shallow[(Math.random() * shallow.length) | 0];
        spawnRipple(f.x, f.y, 0.5);
        f.burst = Math.max(f.burst, 0.8);
      }
    }
    const sim = {
      fishes: state.fishes, mouse, foods: state.foods, cfg,
      obstacles: state.obstacles, rippleRoom, env: e,
      spawnRipple: (x, y, s, quiet) => spawnRipple(x, y, s, quiet),
    };
    // 芦苇丛根部不时自己泛起一圈小涟漪 —— 说明水底下有茎在动
    state.baseRip = (state.baseRip || 0) - dt;
    if (state.baseRip <= 0) {
      state.baseRip = rand(1.8, 5.0) / (e.rippleRate || 1);
      const reeds = LAYOUT.filter(i => i.name === 'reeds');
      if (reeds.length && cfg.decor) {
        const it = reeds[(Math.random() * reeds.length) | 0];
        spawnRipple(it.x * world.w, it.y * world.h + 6 * world.k, 0.34);
      }
    }
    for (const f of state.fishes) f.update(dt, world, sim);
    for (const t of state.turtles) t.update(dt, world, sim);
    // 蝴蝶是日行的：月夜收翅不飞，池子交给萤火虫。下雨天它们也不出来
    const flyable = state.scene !== 'night' && e.rain < 0.35 && e.snow < 0.35;
    if (flyable) for (const b of state.butterflies) b.update(dt, world, state.bflyTargets || []);
    for (const nest of state.tadpoleNests) for (const td of nest.list) td.update(dt);
    for (const p of state.petals) { p.update(dt, world); if (e.wind > 0.2) p.x += e.wind * 26 * dt; }
    for (const f of state.fireflies) f.update(dt, world);
    for (const m of state.mists) m.update(dt, world);
    // 降水：落到屏幕下沿 = 打在水面上，在那里补一圈小涟漪（有总量上限兜着）
    for (const d of state.rain) {
      if (d.update(dt, world, e.wind) === 'hit' && e.rain > 0.04 && Math.random() < 0.14) {
        spawnRipple(d.x, d.y, rand(0.14, 0.3), true);
      }
    }
    for (const s of state.snow) {
      if (s.update(dt, world, e.wind) === 'hit' && Math.random() < 0.05) {
        spawnRipple(s.x, s.y, 0.13, true);
      }
    }
    // auto 场景每 20 秒对一次时钟
    state.sceneCheck -= dt;
    if (state.sceneCheck <= 0) {
      state.sceneCheck = 20;
      if (cfg.scene === 'auto') applyScene(resolveScene(new Date()));
    }
    state.foods = state.foods.filter(fd => fd.update(dt));
    state.ripples = state.ripples.filter(r => r.update(dt));
    if (state.ripples.length > 60) state.ripples.splice(0, state.ripples.length - 60);

    // ---- 绘制 ----
    const pad = state.overscan;
    const dx = Math.sin(state.t * 0.05) * pad * 0.5, dy = Math.cos(state.t * 0.041) * pad * 0.5;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    /* 水面波动第 1 层：扫描线折射。
     * 分带数 = 画质档，掉帧或把"水面波动"拉到 0 时退回一次整张拷贝。 */
    const amp = 5.4 * cfg.chop * (e.chopK || 1);
    state.waveAmp = amp * 0.55;
    const rows = (state.autoDrop > 0.4 || cfg.chop < 0.05) ? 0 : state.warpRows;
    if (state.bg) {
      if (rows > 1 && amp > 0.5) drawWaterWarp(state.t, dx, dy, amp, rows);
      else ctx.drawImage(state.bg, -pad + dx, -pad + dy, world.w + pad * 2, world.h + pad * 2);
    }

    // 折射必须在鱼之前：它弯的是"水底"，鱼本来就该画在弯过的底上
    if (cfg.refract !== false && state.autoDrop < 0.55) {
      const g = { pad: state.overscan, dx, dy, dpr: world.dpr,
        bw: state.bg ? state.bg.width : 0, bh: state.bg ? state.bg.height : 0 };
      for (const r of state.ripples) r.drawRefraction(ctx, state.bg, g);
    }
    /* 影子单独一趟先画完：池底的影子本来就在所有鱼的下面（它们是投影在"最底下的那一层"上）。
     * 混在逐条鱼里画的话，先出现的鱼会把后一条鱼的影子压住，深浅关系就乱了。 */
    const sorted = state.fishes.slice()
      .sort((a, b) => (b.depthNow == null ? b.depth : b.depthNow) - (a.depthNow == null ? a.depth : a.depthNow));
    /* 影子是一整层氛围，不是主体：低画质档直接不做，掉帧到一定程度也整层拿掉
     * （迟滞：>0.6 关、<0.45 再开，避免在阈值附近忽有忽无）。
     * 软件渲染 1920×1080 / 144 条鱼下这一层要吃 ~25% 的帧率，而它本来就是最先该让位的。 */
    if (state.shadowOff) { if (state.autoDrop <= 0.45) state.shadowOff = false; }
    else if (state.autoDrop > 0.6) state.shadowOff = true;
    if (cfg.fishShadow !== false && cfg.quality !== 'low' && !state.shadowOff) {
      for (const f of sorted) drawFishShadow(f);
    }
    for (const f of sorted) drawFish(f);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    drawCaustics(state.t);
    drawChop(state.t);                                   // 水面波动第 2 层：起伏的光带
    for (const r of state.ripples) r.draw(ctx);
    for (const fd of state.foods) fd.draw(ctx);
    for (const p of state.petals) drawPetal(p);          // 落花浮在水面，会被荷叶盖住
    for (const d of state.decor) {
      const it = d.it;
      const bank = it.kind === 'bank';
      const ph = state.t * (bank ? 0.62 : 0.5) + it.x * 9 + it.y * 5;
      // 风越大摆得越厉害（swayK 由天气给）；岸边的植物绕根部摆两个频率叠加，
      // 单正弦看起来像钟摆
      const sway = bank
        ? (Math.sin(ph) * it.sway + Math.sin(ph * 0.41 + 1.7) * it.sway * 0.45) * e.swayK
        : Math.sin(ph * 0.8) * 0.014 * (0.7 + 0.3 * e.swayK);
      const bob = bank ? 0 : Math.sin(ph) * it.bob * (0.55 + 0.45 * e.swayK);
      ctx.save();
      ctx.translate(it.x * world.w + bob, it.y * world.h + (bank ? 0 : bob * 0.6));
      ctx.rotate((it.rot || 0) + sway);
      ctx.drawImage(d.c, -d.pivX, -d.pivY, d.w, d.h);
      const nest = state.tadpoleNests.find(n => n.pad === it);   // 蝌蚪跟着叶片一起动
      if (nest) for (const td of nest.list) drawTadpole(td, d.w - d.pad * 2, d.h - d.pad * 2);
      ctx.restore();
    }
    for (const t of state.turtles) drawTurtle(t);
    drawVeil();
    for (const m of state.mists) drawMist(m);
    if (flyable) for (const b of state.butterflies) drawButterfly(b);
    for (const f of state.fireflies) drawFirefly(f);
    drawSnow();                                          // 降水压在最上层
    drawRain();

    if (global.__moyuDebug) {
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.font = '13px monospace';
      const w = e.text ? ` · ${e.text}${e.temp != null ? ' ' + e.temp + '°' : ''}${e.offline ? '(模拟)' : ''}` : '';
      ctx.fillText(`${state.fps.toFixed(0)} fps · ${state.fishes.length} 条(设定 ${cfg.fishCount}) · k ${world.k.toFixed(2)} · dpr ${world.dpr} · drop ${state.autoDrop.toFixed(2)}${w}`, 10, world.h - 12);
    }
  }

  /* ---------------- 输入 ---------------- */
  function bindInput() {
    addEventListener('resize', resize);
    addEventListener('mousemove', e => {
      const t = performance.now();
      const dtms = Math.max(1, t - (mouse.t || t));
      // 光标速度：鱼群用它判断"是慢慢挪过来还是猛地划过去"
      mouse.speed = Math.hypot(e.clientX - mouse.x, e.clientY - mouse.y) / (dtms / 1000);
      mouse.t = t;
      mouse.px = mouse.x; mouse.py = mouse.y;
      mouse.x = e.clientX; mouse.y = e.clientY; mouse.inside = true;
    });
    addEventListener('mouseleave', () => { mouse.inside = false; mouse.speed = 0; });
    canvas.addEventListener('pointerdown', e => {
      if (cfg.interact === 'off') return;
      mouse.down = true;
      const n = 4 + (Math.random() * 3 | 0);
      for (let i = 0; i < n; i++) state.foods.push(new Food(e.clientX, e.clientY));
      spawnRipple(e.clientX, e.clientY, 1.0);
    });
    addEventListener('pointerup', () => { mouse.down = false; });
    addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        if (global.HUD && global.HUD.togglePanel) global.HUD.togglePanel();
        else document.getElementById('panel').classList.toggle('open');
      }
      if (e.key === 'F9') { e.preventDefault(); global.__moyuDebug = !global.__moyuDebug; }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
      else if (!raf) { state.last = 0; raf = requestAnimationFrame(frame); }
    });
  }

  let raf = 0;
  async function boot() {
    if (/[?&]debug=1/.test(location.search)) global.__moyuDebug = true;

    // 天气站先建起来：断网时它自己会给一份本地模拟值，所以后面所有取用都不用判空
    if (global.Weather) {
      station = new global.Weather.Station({
        name: cfg.cityName, admin: cfg.cityAdmin, lat: cfg.cityLat, lon: cfg.cityLon,
      });
    }

    const ui = buildHUD(cfg, (k) => {
      if (k === 'quality' || k === 'reset') resize();
      else if (k === 'fishCount') syncPopulation();
      else if (k === 'decor' || k === 'weed') { state.obstacles = cfg.decor ? obstacles(world) : []; bakeBg(); bakeDecor(); }
      else if (k === 'scene') applyScene(resolveScene(new Date()));
      else if (k === 'city') { if (station) station.setCity({ name: cfg.cityName, admin: cfg.cityAdmin, lat: cfg.cityLat, lon: cfg.cityLon }); }
      else if (k === 'weatherOn') { syncPrecip(); syncAmbient(); if (assets.ready) bakeBg(); }
      else if (k === 'customFish') { global.Sprites.setCustomVisible(cfg.customFish !== false); reassignCustom(); }
      else if (k === 'koiCustom') { reassignCustom(); }
    }, station);

    await global.Sprites.load();

    // 画板捏过的鱼：读存档 → 解码 → 每条烘一份图集注册进素材表，鱼群里就会有它们
    if (global.Paint && global.Paint.boot) {
      try { await global.Paint.boot(); } catch (err) { /* 画坏了也不能拦住池塘 */ }
    }
    // 注意顺序：先注册再切可见性，否则"开关是关的"这条会漏掉刚注册进去的
    global.Sprites.setCustomVisible(cfg.customFish !== false);

    state.scene = resolveScene(new Date());   // 先定场景再烘背景，省一次重烘
    syncAmbient();
    resize();
    bindInput();
    // 天气站自己会去拉数据（拉不到就用本地模拟值）；一有新数据就重烘背景
    // —— 光照是烘进缓存的，不重烘就对不上。
    if (station) station.start(() => { syncPrecip(); syncAmbient(); if (assets.ready) bakeBg(); });
    hudTick(ui, cfg, new Date(), station);
    setInterval(() => hudTick(ui, cfg, new Date(), station), 250);
    raf = requestAnimationFrame(frame);
    document.body.classList.add('ready');
    global.__moyu = {
      cfg, state, world, mouse, ui, station, env,
      setCount: n => { cfg.fishCount = n; syncPopulation(); },
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);
