/* sim.js —— 鱼群行为、涟漪、食物、岸边装饰的摆放 */
(function (global) {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;
  function angDiff(a, b) { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; }
  function rand(a, b) { return a + Math.random() * (b - a); }

  /* ---------------- 鱼群"帮派"锚点 ----------------
   * 光靠 boids 的弱聚集，鱼会均匀摊满整个池子，不像原图那样一撮一撮的。
   * 所以给每群鱼一个缓慢巡游的锚点，并且同一群鱼共享一个深度层——
   * 深水那群整体糊而小，浅水那群清晰大条，看起来才有纵深。 */
  const SCHOOL_N = 7;
  const LONER_RATIO = 0.22;      // 两成鱼不落群，独自满池子转，原图里也有这种散兵
  const schools = [];
  function ensureSchools(world) {
    while (schools.length < SCHOOL_N) {
      schools.push({
        x: rand(0.15, 0.85) * world.w, y: rand(0.15, 0.85) * world.h,
        a: rand(0, TAU), sp: rand(9, 20), wob: rand(0, TAU),
        r: rand(190, 340), depth: clamp(Math.pow(Math.random(), 0.85), 0, 0.95),
      });
    }
    return schools;
  }
  function updateSchools(dt, world) {
    for (const s of ensureSchools(world)) {
      s.wob += rand(-1, 1) * dt * 1.4;
      s.a += Math.sin(s.wob) * dt * 0.9;
      s.x += Math.cos(s.a) * s.sp * dt;
      s.y += Math.sin(s.a) * s.sp * dt * 0.85;
      const mx = world.w * 0.12, my = world.h * 0.14;
      if (s.x < mx || s.x > world.w - mx) { s.a = Math.PI - s.a; s.x = clamp(s.x, mx, world.w - mx); }
      if (s.y < my || s.y > world.h - my) { s.a = -s.a; s.y = clamp(s.y, my, world.h - my); }
    }
  }

  /* ---------------- 鱼 ---------------- */
  class Fish {
    constructor(world, kinds) {
      this.reset(world, kinds);
    }
    reset(world, kinds) {
      // "我的锦鲤"（画板捏的那些）不占内置 5 种花色的名额，单独给 9% 的登场概率。
      // 捏了好几条就从中随便挑一条 —— 它们在同一条鱼群里是不分主次的。
      const S = global.Sprites;
      let k = null;
      if (S && S.customKinds) {
        const ck = S.customKinds().filter(x => S.assets.koi[x]);
        if (ck.length && Math.random() < 0.09) k = ck[(Math.random() * ck.length) | 0];
      }
      const mine = !!k;
      if (!k) k = kinds[(Math.random() * kinds.length) | 0];
      this.kind = k;
      this.mine = mine;
      const sc = Math.random() < LONER_RATIO ? null
        : ensureSchools(world)[(Math.random() * SCHOOL_N) | 0];
      this.school = sc;
      // 深度 0=贴着水面(清晰大条) 1=池底(模糊小条)
      this.depth = clamp((sc ? sc.depth : Math.pow(Math.random(), 0.8)) + rand(-0.2, 0.2), 0, 1);
      /* 体长的两个端点先存着，实际体长每帧按"当前深度"插值（见 update）——
       * 这样拖动"池水深浅"滑杆时池里的鱼会立刻变大变小，不必重建鱼群。
       * sizeK 把"银鳞小一号"和"塘主压场"这两个乘子收在一起。 */
      this.lenSurf = rand(52, 86); this.lenBot = rand(22, 42);
      this.sizeK = (k === 'koi_silver' ? 0.66 : 1);
      /* 原图里总有几条特别大的锦鲤压场。池塘变浅之后体长区间整体压缩了
       * （最深的鱼也大了一圈），所以"塘主"要从本来就不小的那批里挑、并放大得更多，
       * 否则它跟中位数的差距会被压到 1.5 倍以内，看着就不"压场"了。 */
      if (Math.random() < 0.11 && this.depth < 0.45 && this.lenSurf > 62) this.sizeK *= rand(1.45, 1.85);
      this.depthNow = this.depth;                 // 叠了池塘深度和天气之后的实际深度
      this.lenBase = lerp(this.lenSurf, this.lenBot, this.depthNow) * this.sizeK;
      this.len = this.lenBase * (world.k || 1);
      /* 碰撞用的身体半轴（长 × 宽），单位是屏幅无关的比例 × 当前体长。
       * 鱼素材在 PNG 里通常略胖于一比，宽要再打 0.8 折才不至于把它们挤得过散。 */
      this.bodyAR = 0.38;
      this.x = (sc ? sc.x : rand(0.1, 0.9) * world.w) + rand(-110, 110);
      this.y = (sc ? sc.y : rand(0.1, 0.9) * world.h) + rand(-90, 90);
      this.angle = rand(0, TAU);
      this.baseSpeed = lerp(rand(30, 52), rand(14, 26), this.depth);
      this.speed = this.baseSpeed;
      this.burst = 0;
      this.phase = rand(0, TAU);
      this.wander = rand(0, TAU);
      this.turnNoise = rand(0.5, 1.4);
      this.side = Math.random() < 0.5 ? 1 : -1;      // 绕障碍时固定走哪一边
      this.dodgeSign = 0;                            // 躲鼠标时这次往哪一侧让（进圈时定）
      this.neighborRadius = lerp(215, 130, this.depth);
      /* 姿态三件套（见 update 末尾）：
       *   pose —— 渲染朝向。它追不上真正的运动朝向，转弯时身体还指着来路，
       *           那一瞬间的"斜着蹭过去"就是鱼味儿的来源；
       *   turn/bend —— 平滑后的角速度 → 体轴的弯曲量（画的时候对体轴做剪切）；
       *   gait —— 爆-滑步态的相位：抖一下尾给一股推力，然后身体伸直滑一段。 */
      this.pose = this.angle;
      this.turn = 0;
      this.bend = 0;
      this.gait = rand(0, TAU);
      this.gaitSp = rand(0.85, 1.45);                // 每条鱼节奏不同，免得齐步走
      this.kick = 0;
    }

    steer(target, weight) {
      const d = angDiff(this.angle, target);
      this.angle += clamp(d, -1, 1) * weight;
    }

    update(dt, world, ctxSim) {
      const { fishes, mouse, foods, cfg } = ctxSim;
      const K = world.k || 1;
      /* 当前深度 = 天生深度 × 池塘深浅 + 天气给的偏移。
       * cfg.pondDepth < 1 就是"池塘浅一点"：整列水被压扁，最深的鱼也离水面不远，
       * 于是它更小也更清晰一些（每帧算，所以拖滑杆能立刻看出来）。 */
      const envD = (ctxSim.env && ctxSim.env.fishDepth) || 0;
      const pond = clamp(cfg.pondDepth == null ? 1 : cfg.pondDepth, 0.25, 1);
      this.depthNow = clamp(this.depth * pond + envD, 0, 1);
      // 体长跟着屏幕宽度走，换分辨率不会变成"鲸鱼池"或"鱼苗池"
      this.lenBase = lerp(this.lenSurf, this.lenBot, this.depthNow) * this.sizeK;
      this.len = this.lenBase * K;
      // 碰撞体：沿体轴的椭圆，半长轴/半短轴都跟着当前体长走（cfg.size 会影响画出来的大小，也要算上）
      const myLen = this.len * (cfg.size || 1);
      const halfL = myLen * 0.42, halfW = Math.max(2.5, myLen * this.bodyAR * 0.42);

      /* --- 结群：分离 / 对齐 / 聚集，都按距离加权 --- */
      let sx = 0, sy = 0, ax = 0, ay = 0, cx = 0, cy = 0, cnt = 0, scnt = 0;
      let pushX = 0, pushY = 0, crowdAhead = false;
      const R = this.neighborRadius * K, R2 = R * R;
      // 软分离只负责"扎堆时让一让"，碰到一起由下面的硬碰撞兜底，所以半径可以收小，
      // 鱼群会比以前贴得近一点 —— 一群鱼贴着游才像鱼群
      const sepR = myLen * 1.15, sepR2 = sepR * sepR;
      const ux = Math.cos(this.angle), uy = Math.sin(this.angle);
      for (let j = 0; j < fishes.length; j++) {
        const o = fishes[j];
        if (o === this) continue;
        const dx = o.x - this.x, dy = o.y - this.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > R2) continue;
        const d = Math.sqrt(d2) || 0.001;
        // 只有深度相近的鱼才会游成一撮，深水鱼和浅水鱼各走各的
        if (Math.abs(o.depth - this.depth) < 0.34) {
          ax += Math.cos(o.angle); ay += Math.sin(o.angle);
          cx += o.x; cy += o.y; cnt++;
        }
        if (d2 < sepR2) { sx -= dx / d * (1 - d / sepR); sy -= dy / d * (1 - d / sepR); scnt++; }

        /* --- 硬碰撞：两条鱼的身体不许叠在一起 ---
         * 在"我自己的体坐标"里看这件事：along 是前后、lat 是左右，
         * 另一条鱼的身体也近似成同尺寸的椭圆，两个椭圆相加就是 (halfL*2, halfW*2)。
         * 选"更省力气"的那一轴推开：并排的横向让（最常见，真鱼也是这样擦身过去），
         * 顶牛的时候就顺着体轴前后分 —— 并且后面那条要减速，不然会一路顶着推过去。 */
        if (Math.abs((o.depthNow == null ? o.depth : o.depthNow) - this.depthNow) > 0.2) continue;
        const along = dx * ux + dy * uy, lat = -dx * uy + dy * ux;
        const oLen = (o.len || this.len) * (cfg.size || 1);
        const a = halfL + oLen * 0.42, b = halfW + Math.max(2.5, oLen * (o.bodyAR || this.bodyAR) * 0.42);
        const needA = a - Math.abs(along), needB = b - Math.abs(lat);
        if (needA <= 0 || needB <= 0) continue;
        // 椭圆判据（矩形近似会把两条斜着的鱼判成撞上，太胖）
        if ((along / a) * (along / a) + (lat / b) * (lat / b) >= 1) continue;
        if (needB <= needA) {                       // 横向擦身（lat>0：对方在我右手边 -> 我往左让）
          const s = (lat >= 0 ? 1 : -1) * needB * 0.5;
          pushX += uy * s; pushY += -ux * s;
        } else {                                    // 前后顶牛（along>0：对方在我前面 -> 我往后退）
          const s = (along >= 0 ? 1 : -1) * needA * 0.5;
          pushX += -ux * s; pushY += -uy * s;
          if (along > 0) crowdAhead = true;         // 对方在我前面 -> 收油排队
        }
      }
      let desired = null;
      if (scnt > 0) { desired = Math.atan2(sy, sx); }
      else if (cnt > 0) {
        const heading = Math.atan2(ay, ax);
        const toward = Math.atan2(cy / cnt - this.y, cx / cnt - this.x);
        desired = Math.abs(angDiff(this.angle, heading)) < 1.2 ? heading : toward;
      }

      /* --- 巡游噪声：让鱼不会永远直线 --- */
      this.wander += rand(-1, 1) * dt * 2.2 * this.turnNoise;
      let w = this.angle + Math.sin(this.wander) * 0.55;

      /* --- 边界：靠近池边往回拐，越近越急 --- */
      const m = 90 * K;
      let bound = null;
      if (this.x < m) bound = 0; else if (this.x > world.w - m) bound = Math.PI;
      if (this.y < m) bound = Math.PI / 2; else if (this.y > world.h - m) bound = -Math.PI / 2;

      /* --- 目标优先级：食物 > 受惊逃离 > 边界 > 回群 > 结群 > 巡游 --- */
      let target = w, weight = 1.6;
      if (desired !== null && cfg.schooling) { target = desired; weight = 1.1; }
      if (this.school && cfg.schooling) {
        const d = Math.hypot(this.school.x - this.x, this.school.y - this.y);
        if (d > this.school.r * K) {
          target = Math.atan2(this.school.y - this.y, this.school.x - this.x);
          weight = 1.9;
        }
      }
      if (bound !== null) { target = bound; weight = 2.6; }

      let food = null, bestD = 1e9;
      if (cfg.interact !== 'off') {
        for (const f of foods) {
          if (f.eaten) continue;
          const d = Math.hypot(f.x - this.x, f.y - this.y);
          const sense = lerp(200, 110, this.depth) * K;
          if (d < sense && d < bestD) { bestD = d; food = f; }
        }
      }
      if (food) {
        target = Math.atan2(food.y - this.y, food.x - this.x);
        weight = 3.4;
        this.burst = Math.max(this.burst, bestD < 120 * K ? 1.5 : 0.7);
        if (bestD < this.len * 0.28) { food.eaten = true; ctxSim.spawnRipple(food.x, food.y, 0.18, true); this.burst = 2.4; }
      }

      /* --- 鼠标：三档态度 ---
       *   dodge —— 绕行让路：进了警戒圈就斜着让开（远离分量 + 侧向分量），
       *            越近让得越急，贴到"内圈"才真的窜出去。像被手拨开的水，
       *            而不是一靠近就炸群 —— 这样鼠标在池子上划来划去也不会满屏乱窜。
       *   shy   —— 受惊猛逃，一进圈就背身跑。
       *   feed  —— 不理鼠标（点击投食由 foods 处理）。
       * 另外：光标划得越快，警戒圈越大（慢慢挪过去鱼只是让让，猛地划过去会惊到）。 */
      if (mouse.inside && (cfg.interact === 'dodge' || cfg.interact === 'shy')) {
        const dx = this.x - mouse.x, dy = this.y - mouse.y;
        const d = Math.hypot(dx, dy) || 0.001;
        const fast = mouse.speed || 0;
        const r0 = cfg.interact === 'shy' ? 150 : 118;
        const flee = r0 * K * (1 + Math.min(0.5, fast / 2600));
        if (d < flee) {
          const away = Math.atan2(dy, dx);
          const t01 = 1 - d / flee;                       // 0=刚到圈边，1=贴脸
          if (cfg.interact === 'shy' || d < flee * 0.42) {
            target = away;
            weight = 4.2;
            this.burst = Math.max(this.burst, 2.6 * t01);
            this.dodgeSign = 0;
          } else {
            /* 侧偏方向必须在"进圈那一刻"定一次，之后整段避让都不变：
             * 如果每帧按当前航向重选，鱼一偏头方向就翻转，两个方向互相抵消，
             * 结果是原地抖两下、距离还得靠近 —— 这是实测踩到的坑。 */
            if (!this.dodgeSign) this.dodgeSign = angDiff(this.angle, away) >= 0 ? 1 : -1;
            target = away + this.dodgeSign * (1 - t01) * 1.15;
            weight = 1.9 + 2.0 * t01;
            this.burst = Math.max(this.burst, 1.5 * t01 * t01);
          }
        } else if (this.dodgeSign) this.dodgeSign = 0;
      }

      /* --- 避开从水里长出来的东西（芦苇丛、岸边石头）：鱼撞在植物上最出戏 --- */
      const obs = ctxSim.obstacles;
      const aboutToEat = food && bestD < this.len * 0.7;
      if (obs && !aboutToEat) {
        for (const o of obs) {
          const dx = this.x - o.x, dy = this.y - o.y;
          const d = Math.hypot(dx, dy) || 0.001;
          const near = o.r + this.len * 0.75;
          if (d < near) {
            // 固定往自己这一侧绕，不然每帧换边会走出抖动的折线
            target = Math.atan2(dy, dx) + this.side * 0.7 * (1 - d / near);
            weight = 4.6;
            if (d < o.r) this.burst = Math.max(this.burst, 1.5);
          }
        }
      }

      /* --- 转向受限，游起来才像弧线而不是原地掉头 --- */
      const prevAng = this.angle;
      const maxTurn = (this.burst > 0.4 ? 2.6 : 1.15) * dt;
      const dAng = clamp(angDiff(this.angle, target), -maxTurn, maxTurn);
      this.angle += dAng;

      /* --- 姿态：朝向滞后 + 体轴弯曲 ---
       * bend 是"线性化的一阶模态"：真实鱼体是一条连续的后行波，头几乎不动、尾摆最大，
       * 而转向时整条鱼会先弯成一个弧形。这里就只用一次剪切（y' = y + bend·x）近似，
       * 尾巴那一端离原点最远，位移也就最大 —— 正好对得上弯曲的样子。
       * 符号：转向为正（航向角变大）时尾巴要往 -y 侧甩（留在弯道外侧），所以同号。 */
      const rate = (this.angle - prevAng) / Math.max(dt, 1e-4);
      this.turn = lerp(this.turn, rate, clamp(dt * 6, 0, 1));
      // 系数取的是"看着舒服"而不是物理精确：池子里 60px 的小鱼要以 1.15 rad/s 掉头
      // （不然半天转不过身），若真按 R=v/ω 换算曲率，半径比体长还短，鱼会弯成一个圈。
      // 所以只做线性的一阶近似，且量级压小：巡游时基本是直的，只有真的急（躲鼠标、抢食）
      // 才明显弯成弧。
      this.bend = lerp(this.bend, clamp(this.turn * 0.07, -0.34, 0.34), clamp(dt * 5, 0, 1));
      // 身体转得比航线慢：这个差值就是"侧滑"，是几条真实性改动里最省钱的一条
      // —— 只多一次标量加法，不需要额外绘制。
      const lag = clamp(angDiff(this.pose, this.angle), -Math.PI, Math.PI);
      this.pose += lag * clamp(dt * 5.5, 0, 1);

      /* --- 爆-滑步态：抖一下尾给一股推力，然后伸直身体滑一段 ---
       * 匀速前进是最"假"的地方。sin^6 半周期里只有约 3 成时间在给推力，
       * 剩下大半时间是滑行；平均值接近 1（5/16≈0.31），所以巡航速度不受影响，
       * 但速度曲线会像真鱼那样一鼓一鼓。 */
      this.gait += dt * this.gaitSp * (1.1 + this.speed * 0.012);
      this.kick = Math.pow(Math.max(0, Math.sin(this.gait)), 6);

      this.burst = Math.max(0, this.burst - dt * 1.35);
      // 天气也改游速：冷天犯懒、雨天活跃（系数由 weather.js 算，这里只管乘）
      const envK = (ctxSim.env && ctxSim.env.fishSpeed) || 1;
      const sp = this.baseSpeed * K * (1 + this.burst * 1.9) * cfg.speed * envK
        * (1 + 0.12 * Math.sin(this.wander * 1.7)) * (0.85 + this.kick * 0.5);
      this.speed = lerp(this.speed, sp, clamp(dt * 4, 0, 1));
      this.x += Math.cos(this.angle) * this.speed * dt;
      this.y += Math.sin(this.angle) * this.speed * dt * 0.92;   // 俯视略压 y，池子像被透视压扁一点
      // 前面有人就松油门：做得像"排队跟着游"，而不是一路顶着人家往前推
      if (crowdAhead) this.speed *= 0.94;
      if (pushX || pushY) { this.x += pushX; this.y += pushY; }
      this.x = clamp(this.x, -40 * K, world.w + 40 * K);
      this.y = clamp(this.y, -40 * K, world.h + 40 * K);

      // 硬约束：软转向偶尔还是会挤进植物里，直接沿法线推出去
      if (obs) for (const o of obs) {
        const dx = this.x - o.x, dy = this.y - o.y;
        const d = Math.hypot(dx, dy);
        const rr = o.r + this.len * 0.22;
        if (d < rr && d > 0.001) { this.x = o.x + dx / d * rr; this.y = o.y + dy / d * rr; }
      }

      // 摆尾：跟着步态走 —— 抖尾那一下甩得快，滑行时几乎停住（身体是伸直的）。
      // 平均值和原来的"匀速 3.4 + 0.115·v"接近，所以尾鳍的平均频率不变，只是不再均匀。
      this.phase += dt * (2.2 + this.speed * 0.075 + this.kick * 9);


    }
  }

  /* ---------------- 涟漪 ----------------
   * 真水面被点一下不是"一个圈放大"，而是：
   *   1. 一串同心环：环不断在内部生成、往外跑、到前缘消失（波列）；
   *   2. 前缘越跑越慢（能量耗散），整体振幅按 (1-t/T)^1.5 衰减；
   *   3. 中心先凹下去一个暗坑，回弹时填平；
   *   4. 环本身就是透镜，会把水底折射弯掉 —— 这条最影响真实感。
   *      用"背景按环形分带、每带绕中心做微小缩放"来近似径向位移
   *      （把一圈沿半径挪 d 像素 == 绕中心缩放 1 + d/r）。
   * 光照按左上方来：亮环用一条对角线性渐变描边，迎光半边亮、背光半边暗。 */
  class Ripple {
    constructor(x, y, strength, scale) {
      const s = clamp(strength == null ? 1 : strength, 0.15, 1.4);
      const k = scale || 1;
      this.x = x; this.y = y; this.k = k; this.s = s;
      this.life = (2.1 + 2.0 * s) * rand(0.9, 1.1);
      this.age = 0;
      this.Rmax = (66 + 140 * s) * k * rand(0.9, 1.1);
      this.tau = this.life * 0.3;
      // 自相似波列：环挂在归一化半径 u=r/R 上，跟着前缘一起长。
      // 之前给每个环一个固定相速，前缘却按指数减速，环全部追上前沿消失，
      // 到后期一圈都不剩。现在 u=(n+q)/N 再幂映射，q 循环 -> 中心不断生新环、
      // 前缘不断吞掉旧环，才是水滴落下去的样子。
      this.N = Math.max(2, Math.round(2 + 4.2 * s));   // 环数随强度走，小涟漪只有一两圈
      this.period = this.life / (this.N + 2);    // 生成下一环的间隔
      this.pow = 1.35;                            // >1 => 内密外疏
      this.bands = s > 0.5 ? 14 : 8;              // 实测一次折射 0.018ms，分带可以放心多给
    }
    front() { return this.Rmax * (1 - Math.exp(-this.age / this.tau)); }
    decay() { return Math.pow(Math.max(0, 1 - this.age / this.life), 1.5); }
    q() { return (this.age / this.period) % 1; }
    /* 包络峰值往外挪(u≈0.62)：前导波最强、往后拖弱 */
    env(r, R) { const u = clamp(r / Math.max(R, 1), 0, 1); return Math.sin(Math.PI * Math.pow(u, 1.45)); }
    crestR(n, R) {
      const u = (n + this.q()) / this.N;
      if (u <= 0.02 || u >= 1) return -1;
      return R * Math.pow(u, this.pow);
    }
    slope(r) {
      const R = this.front();
      if (r <= 0 || r > R) return 0;
      const u = r / R;
      return this.env(r, R) * Math.cos(TAU * (Math.pow(u, 1 / this.pow) * this.N - this.q()));
    }
    update(dt) { this.age += dt; return this.age < this.life; }

    /* 折射层：必须在画鱼之前调用，否则会把鱼盖掉 */
    drawRefraction(ctx, bg, g) {
      const R = this.front();
      if (R < 8 || !bg) return;
      const amp = 16 * this.s * this.k * this.decay();   // 位移 2~3px：池底一米深、波幅几毫米，量级是对的
      const box = R + 8;
      const sx = clamp((this.x - box + g.pad - g.dx) * g.dpr, 0, g.bw);
      const sy = clamp((this.y - box + g.pad - g.dy) * g.dpr, 0, g.bh);
      const sw = clamp(2 * box * g.dpr, 1, g.bw - sx);
      const sh = clamp(2 * box * g.dpr, 1, g.bh - sy);
      for (let i = 0; i < this.bands; i++) {
        const r0 = R * i / this.bands, r1 = R * (i + 1) / this.bands;
        const rm = (r0 + r1) / 2;
        const d = amp * this.slope(rm);
        if (Math.abs(d) < 0.5) continue;
        const sc = 1 + d / Math.max(rm, 12);
        ctx.save();
        ctx.beginPath();
        ctx.arc(this.x, this.y, r1, 0, TAU);
        ctx.arc(this.x, this.y, r0, 0, TAU, true);
        ctx.clip();
        ctx.drawImage(bg, sx, sy, sw, sh,
          this.x - box * sc, this.y - box * sc, box * 2 * sc, box * 2 * sc);
        ctx.restore();
      }
    }

    draw(ctx) {
      const R = this.front();
      if (R < 3) return;
      const D = this.decay();
      const light = ctx.createLinearGradient(this.x - R, this.y - R, this.x + R, this.y + R);
      const dark = ctx.createLinearGradient(this.x - R, this.y - R, this.x + R, this.y + R);
      light.addColorStop(0, 'rgba(255,255,255,' + (0.98 * D) + ')');
      light.addColorStop(0.45, 'rgba(226,255,247,' + (0.62 * D) + ')');
      light.addColorStop(1, 'rgba(178,242,226,' + (0.34 * D) + ')');
      dark.addColorStop(0, 'rgba(2,38,36,' + (0.34 * D) + ')');
      dark.addColorStop(0.6, 'rgba(2,38,36,' + (0.18 * D) + ')');
      dark.addColorStop(1, 'rgba(196,255,238,' + (0.26 * D) + ')');

      const hole = R * 0.30;
      if (hole > 2 && this.age < this.life * 0.7) {
        const a = 0.34 * D * clamp(1 - this.age / (this.life * 0.7), 0, 1);
        const hg = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, hole);
        hg.addColorStop(0, 'rgba(3,42,40,' + a + ')');
        hg.addColorStop(0.7, 'rgba(3,42,40,' + (a * 0.35) + ')');
        hg.addColorStop(1, 'rgba(3,42,40,0)');
        ctx.fillStyle = hg;
        ctx.beginPath(); ctx.arc(this.x, this.y, hole, 0, TAU); ctx.fill();
      }

      for (let n = 0; n < this.N + 1; n++) {
        const r = this.crestR(n, R);
        if (r < 0) continue;
        if (r > R) break;
        const e = this.env(r, R);
        if (e < 0.06) continue;
        const near = clamp(r / R, 0, 1);
        ctx.beginPath();
        ctx.arc(this.x, this.y, r, 0, TAU);
        ctx.strokeStyle = light;
        ctx.lineWidth = (2.8 - 1.5 * near) * this.k * (0.45 + 0.55 * e);
        ctx.globalAlpha = 0.4 + 0.5 * e;
        ctx.stroke();
        // 波峰外侧紧跟一条波谷暗线，才有起伏的立体感
        const gap = (this.crestR(n + 1, R) - r) > 0 ? (this.crestR(n + 1, R) - r) : R / this.N;
        const rt = r + gap * 0.5;
        if (rt < R && this.env(rt, R) > 0.06) {
          ctx.beginPath();
          ctx.arc(this.x, this.y, rt, 0, TAU);
          ctx.strokeStyle = dark;
          ctx.lineWidth = (1.6 - 0.9 * near) * this.k;
          ctx.globalAlpha = 0.55 * this.env(rt, R);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }
  }

  /* ---------------- 降水粒子：雨滴 / 雪花 ----------------
   * 俯视看下去整个屏幕都是水面，所以雨滴的"落点"就是它穿过屏幕下沿的那一刻；
   * update 返回 'hit'，主循环在那一处打一圈小涟漪。雨点真的打在水面上，
   * 比多画几条雨线有用得多 —— 这是整幅画里最便宜的"天气感"。
   * 风的影响直接加在水平速度上：大风天雨是斜着抽过来的。 */
  class RainDrop {
    constructor(world) { this.reset(world, true); }
    reset(world, initial) {
      this.x = rand(-40, world.w + 40);
      this.y = initial ? rand(0, world.h) : rand(-170, -10);
      this.len = rand(8, 21);
      this.sp = rand(700, 1250);
      this.a = rand(0.16, 0.5);
      this.slant = rand(0.05, 0.2);
    }
    update(dt, world, wind) {
      this.x += (18 + (wind || 0) * 300) * this.slant * dt * 3;
      this.y += this.sp * dt;
      if (this.x > world.w + 60) this.x -= world.w + 120;
      if (this.y > world.h + 6) { this.reset(world, false); return 'hit'; }
      return null;
    }
    draw(ctx) {
      ctx.strokeStyle = `rgba(226,244,255,${this.a})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(this.x, this.y);
      ctx.lineTo(this.x - this.len * this.slant, this.y - this.len);
      ctx.stroke();
    }
  }

  class SnowFlake {
    constructor(world) { this.reset(world, true); }
    reset(world, initial) {
      this.x = rand(-20, world.w + 20);
      this.y = initial ? rand(0, world.h) : rand(-90, -10);
      this.r = rand(1.1, 2.9);
      this.sp = rand(24, 62);
      this.a = rand(0.32, 0.85);
      this.wob = rand(0, TAU);
      this.ws = rand(0.6, 1.8);
    }
    update(dt, world, wind) {
      this.wob += dt * this.ws;
      this.x += (Math.sin(this.wob) * 16 + (wind || 0) * 110) * dt;
      this.y += this.sp * dt;
      if (this.x < -30) this.x += world.w + 60;
      if (this.x > world.w + 30) this.x -= world.w + 60;
      if (this.y > world.h + 6) { this.reset(world, false); return 'hit'; }
      return null;
    }
    draw(ctx) {
      ctx.fillStyle = `rgba(248,253,255,${this.a})`;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.r, 0, TAU);
      ctx.fill();
    }
  }

  /* ---------------- 食物颗粒 ---------------- */
  class Food {
    constructor(x, y) {
      this.x = x + rand(-16, 16); this.y = y + rand(-12, 12);
      this.vy = rand(6, 16); this.r = rand(2.2, 3.6);
      this.age = 0; this.life = rand(5.5, 9); this.eaten = false;
      this.sway = rand(0, TAU);
    }
    update(dt) {
      this.age += dt; this.sway += dt * 2.4;
      this.y += this.vy * dt; this.vy *= (1 - dt * 0.55);
      this.x += Math.sin(this.sway) * 5 * dt;
      return this.age < this.life && !this.eaten;
    }
    draw(ctx) {
      const a = clamp(1 - this.age / this.life, 0, 1) * 0.9;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.r, 0, TAU);
      ctx.fillStyle = `rgba(238,214,160,${a})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(this.x - this.r * 0.3, this.y - this.r * 0.3, this.r * 0.4, 0, TAU);
      ctx.fillStyle = `rgba(255,255,255,${a * 0.5})`;
      ctx.fill();
    }
  }

  /* ---------------- 场景（四种氛围） ----------------
   * 不重新生成底图，靠"调色 + 氛围粒子 + 全局罩色"切换：
   *   grade   烘进背景缓存的水色偏移（blend/颜色/强度）
   *   veil    画完装饰后盖一层全屏罩色，把鱼/荷叶/石头一起拉进同一个光环境
   *   mist/petals/fireflies 各自的氛围粒子数量 */
  const SCENES = {
    dawn:  { name: '清晨', grade: { blend: 'soft-light', rgb: [255, 226, 196], a: 0.34 },
             veil: { blend: 'soft-light', rgb: [214, 232, 255], a: 0.16 },
             mist: 3, petals: 4, fireflies: 0, caustic: 0.7 },
    noon:  { name: '正午', grade: null, veil: null,
             mist: 0, petals: 2, fireflies: 0, caustic: 1.0 },
    dusk:  { name: '黄昏', grade: { blend: 'multiply', rgb: [255, 176, 104], a: 0.40 },
             veil: { blend: 'multiply', rgb: [255, 170, 110], a: 0.26 },
             mist: 1, petals: 7, fireflies: 0, caustic: 0.8 },
    night: { name: '月夜', grade: { blend: 'multiply', rgb: [86, 128, 168], a: 0.62 },
             veil: { blend: 'multiply', rgb: [72, 108, 152], a: 0.40 }, moon: true,
             mist: 2, petals: 1, fireflies: 9, caustic: 1.5 },
  };
  function sceneForHour(h) {
    if (h < 5) return 'night';
    if (h < 8) return 'dawn';
    if (h < 17) return 'noon';
    if (h < 19) return 'dusk';
    return 'night';
  }
  function creatureHosts() {
    return {
      rocks: LAYOUT.filter(i => i.name === 'rocks'),
      pads: LAYOUT.filter(i => i.name === 'lotus_pad' && i.s >= 0.06),
      flowers: LAYOUT.filter(i => i.name === 'lotus_flower'),
    };
  }

  /* ---------------- 乌龟：趴在石头上晒背 ----------------
   * bask -> (指针靠近) alert -> slip(滑进水里,打两圈涟漪) -> gone -> 过一会儿再爬上来一只。
   * 也会自己悄悄爬走，隔几十秒换一只 —— 池子才像"有人住" */
  class Turtle {
    constructor(rock) {
      this.rock = rock;
      this.kind = Math.random() < 0.5 ? 'turtle_green' : 'turtle_brown';
      this.reset(true);
    }
    reset(initial) {
      const a = rand(0, TAU), rr = rand(0.10, 0.34);
      this.ox = Math.cos(a) * rr; this.oy = Math.sin(a) * rr * 0.8;
      this.angle = a + Math.PI + rand(-0.7, 0.7);     // 头朝外缘，滑下去的方向
      this.len = rand(52, 74);
      this.state = 'bask';
      this.t = initial ? rand(8, 45) : rand(24, 70);
      this.slip = 0;
      this.breath = rand(0, TAU);
    }
    pos(world) {
      const r = this.rock, w = r.s * world.w;
      return { x: r.x * world.w + this.ox * w, y: r.y * world.h + this.oy * w };
    }
    update(dt, world, ctx) {
      this.t -= dt; this.breath += dt * 1.3;
      const p = this.pos(world);
      if (this.state === 'bask') {
        const md = Math.hypot(ctx.mouse.x - p.x, ctx.mouse.y - p.y);
        if (ctx.mouse.inside && md < 66 * (world.k || 1)) { this.state = 'alert'; this.t = 0.45; }
        else if (this.t <= 0) { this.state = 'gone'; this.t = rand(35, 90); }
      } else if (this.state === 'alert') {
        if (this.t <= 0) { this.state = 'slip'; this.slip = 0; }
      } else if (this.state === 'slip') {
        this.slip += dt / 0.65;
        if (this.slip >= 1) {
          ctx.spawnRipple(p.x + Math.cos(this.angle) * 26 * (world.k || 1),
            p.y + Math.sin(this.angle) * 26 * (world.k || 1), 0.7);
          ctx.spawnRipple(p.x, p.y, 0.4, true);
          this.state = 'gone'; this.t = rand(45, 120);
        }
      } else if (this.state === 'gone' && this.t <= 0) {
        this.reset(false);
      }
    }
    startle() { if (this.state === 'bask') { this.state = 'alert'; this.t = 0.3; } }
  }

  /* ---------------- 蝌蚪：荷叶上的一小窝 ----------------
   * 程序化画（身子一个椭圆 + 三节摆尾），不用素材：太小了，素材反而糊。
   * 在盘内归一化坐标里游走，出界就掉头，偶尔窜一下 */
  class Tadpole {
    constructor() {
      const a = rand(0, TAU), rr = Math.sqrt(Math.random()) * 0.6;
      this.u = Math.cos(a) * rr; this.v = Math.sin(a) * rr * 0.86;
      this.a = rand(0, TAU); this.wig = rand(0, TAU);
      this.sp = rand(0.05, 0.13); this.size = rand(4.5, 7.5);
      this.dart = rand(1, 5);
    }
    update(dt) {
      this.wig += dt * 16;
      this.dart -= dt;
      if (this.dart <= 0) { this.dart = rand(1.5, 6); this.a += rand(-2.2, 2.2); this.sp = rand(0.14, 0.3); }
      this.sp = lerp(this.sp, 0.07, dt * 0.8);
      this.a += Math.sin(this.wig * 0.21) * dt * 1.5;
      this.u += Math.cos(this.a) * this.sp * dt;
      this.v += Math.sin(this.a) * this.sp * dt;
      const r = Math.hypot(this.u, this.v / 0.86);
      if (r > 0.7) this.a = Math.atan2(-this.v, -this.u) + rand(-0.6, 0.6);
    }
  }

  /* ---------------- 蝴蝶：乱飞、降落、停一会儿再走 ----------------
   * 俯视看蝴蝶，翅膀合拢 = 投影变窄，所以整张图沿身体轴做 scaleX 就是扇翅膀，
   * 不用把左右翅拆开。离水高度用影子的偏移和虚化程度表达 */
  class Butterfly {
    constructor(world) {
      this.kind = Math.random() < 0.55 ? 'butterfly_monarch' : 'butterfly_pale';
      this.size = rand(28, 42);
      this.reset(world, true);
    }
    reset(world, initial) {
      this.x = rand(0.1, 0.9) * world.w; this.y = rand(0.1, 0.9) * world.h;
      this.a = rand(0, TAU); this.sp = rand(44, 68);
      this.flap = rand(0, TAU); this.flapRate = rand(8.5, 12.5);
      this.h = rand(24, 50);
      this.state = 'fly'; this.t = initial ? rand(2, 8) : rand(5, 13);
      this.target = null; this.wob = rand(0, TAU);
    }
    update(dt, world, targets) {
      this.wob += dt * 2.1;
      const resting = this.state === 'rest';
      this.flap += dt * this.flapRate * (resting ? 0.22 : 1);
      if (this.state === 'fly') {
        this.t -= dt;
        this.a += Math.sin(this.wob) * dt * 2.4 + rand(-1, 1) * dt * 1.7;
        const sp = this.sp * (1 + 0.4 * Math.sin(this.wob * 1.6));
        this.x += Math.cos(this.a) * sp * dt;
        this.y += Math.sin(this.a) * sp * dt * 0.8;
        this.h = lerp(this.h, 32 + 12 * Math.sin(this.wob * 0.8), dt * 2);
        // 边界回转只在自由飞时生效：降落目标（角落的荷花）就在边界上，
        // 两种转向打架会让蝴蝶在角落永远盘旋落不下去
        const m = 60;
        if (this.x < m) this.a = lerp(this.a, 0, 0.2);
        if (this.x > world.w - m) this.a = lerp(this.a, Math.PI, 0.2);
        if (this.y < m) this.a = lerp(this.a, Math.PI / 2, 0.2);
        if (this.y > world.h - m) this.a = lerp(this.a, -Math.PI / 2, 0.2);
        if (this.t <= 0 && targets.length) {
          this.target = targets[(Math.random() * targets.length) | 0];
          this.state = 'approach';
        }
      } else if (this.state === 'approach') {
        const tx = this.target.x * world.w, ty = this.target.y * world.h;
        const d = Math.hypot(tx - this.x, ty - this.y);
        const want = Math.atan2(ty - this.y, tx - this.x);
        this.a += clamp(angDiff(this.a, want), -3.2 * dt, 3.2 * dt);
        const sp = Math.min(this.sp * 0.8, d * 2.4 + 8);
        this.x += Math.cos(this.a) * sp * dt;
        this.y += Math.sin(this.a) * sp * dt;
        this.h = lerp(this.h, Math.max(3, d * 0.22), dt * 3);
        if (d < 9) { this.state = 'rest'; this.t = rand(3.5, 10); this.x = tx; this.y = ty; }
      } else {
        this.t -= dt;
        this.h = lerp(this.h, 2, dt * 4);
        if (this.t <= 0) { this.state = 'fly'; this.t = rand(5, 13); this.a = rand(0, TAU); }
      }
    }
  }

  /* ---------------- 氛围粒子 ---------------- */
  class Petal {                       // 漂在水面的落花
    constructor(world) { this.reset(world, true); }
    reset(world, initial) {
      this.x = initial ? rand(0, 1) * world.w : -30;
      this.y = rand(0.05, 0.95) * world.h;
      this.rot = rand(0, TAU); this.vr = rand(-0.5, 0.5);
      this.vx = rand(6, 14); this.vy = rand(-2, 3);
      this.size = rand(5, 9); this.wob = rand(0, TAU);
    }
    update(dt, world) {
      this.wob += dt * 1.4;
      this.x += (this.vx + Math.sin(this.wob) * 3) * dt;
      this.y += (this.vy + Math.cos(this.wob * 0.7) * 2) * dt;
      this.rot += this.vr * dt;
      if (this.x > world.w + 30 || this.y < -30 || this.y > world.h + 30) this.reset(world, false);
    }
  }
  class Firefly {                     // 夜里的萤火虫：游走 + 明灭
    constructor(world) {
      this.x = rand(0.05, 0.95) * world.w; this.y = rand(0.1, 0.9) * world.h;
      this.a = rand(0, TAU); this.ph = rand(0, TAU); this.rate = rand(0.7, 1.6);
    }
    update(dt, world) {
      this.ph += dt * this.rate;
      this.a += rand(-1, 1) * dt * 1.8;
      this.x += Math.cos(this.a) * 14 * dt; this.y += Math.sin(this.a) * 10 * dt;
      if (this.x < 0) this.x += world.w; if (this.x > world.w) this.x -= world.w;
      if (this.y < 0) this.y += world.h; if (this.y > world.h) this.y -= world.h;
    }
    glow() { const s = Math.sin(this.ph); return s > 0.55 ? (s - 0.55) / 0.45 : 0; }
  }
  class Mist {                        // 清晨/夜里贴水面的薄雾
    constructor(world, i, n) {
      this.x = (i + 0.5) / n * world.w + rand(-80, 80);
      this.y = rand(0.15, 0.85) * world.h;
      this.r = rand(0.22, 0.4) * Math.max(world.w, world.h);
      this.vx = rand(4, 9); this.ph = rand(0, TAU);
    }
    update(dt, world) {
      this.ph += dt * 0.3; this.x += this.vx * dt;
      if (this.x - this.r > world.w) this.x = -this.r;
    }
  }

  /* ---------------- 岸边装饰（荷叶/荷花/芦苇/石头/浮萍） ---------------- */
  // s = 占屏幕宽度的比例。参照原图：四角压住装饰、中间留开阔水面，
  // 不然桌面图标和窗口会被挡住，也就不像"壁纸"了。
  //
  // kind='float' 浮在水面：(x,y) 是叶片中心，整片轻微起伏 + 缓慢自转，鱼可从底下经过
  // kind='bank'  从水里长出来：(x,y) 是 (ax,ay) 这个根部锚点落在的位置，绕根部摇曳，
  //              并且是实心障碍(hit)，鱼到跟前会绕开 —— 这一条是"真实感"的关键
  const LAYOUT = [
    { name: 'lotus_flower', x: 0.045, y: 0.050, s: 0.105, rot: -0.20, bob: 0.90, kind: 'float' },
    { name: 'lotus_pad', x: 0.135, y: 0.100, s: 0.075, rot: 0.80, bob: 0.50, kind: 'float' },
    { name: 'lotus_pad', x: 0.042, y: 0.185, s: 0.062, rot: 2.10, bob: 0.60, kind: 'float' },
    { name: 'lotus_pad', x: 0.105, y: 0.275, s: 0.048, rot: 4.20, bob: 0.70, kind: 'float' },
    { name: 'duckweed', x: 0.170, y: 0.205, s: 0.088, rot: 0.60, bob: 0.80, kind: 'float' },

    { name: 'lotus_flower', x: 0.962, y: 0.900, s: 0.095, rot: 1.10, bob: 0.80, kind: 'float' },
    { name: 'lotus_pad', x: 0.885, y: 0.815, s: 0.098, rot: 2.70, bob: 0.45, kind: 'float' },
    { name: 'lotus_pad', x: 0.968, y: 0.685, s: 0.062, rot: 0.30, bob: 0.60, kind: 'float' },
    { name: 'lotus_pad', x: 0.815, y: 0.955, s: 0.068, rot: 5.10, bob: 0.55, kind: 'float' },
    { name: 'duckweed', x: 0.790, y: 0.755, s: 0.078, rot: 2.40, bob: 0.70, kind: 'float' },

    // 岸边：两簇石头错开旋转叠成一条岸线，芦苇长在石头缝里
    { name: 'rocks', x: 0.042, y: 0.900, s: 0.140, rot: -0.25, bob: 0, kind: 'bank', ax: 0.50, ay: 0.52, hit: 0.36, sway: 0.004 },
    { name: 'rocks', x: 0.140, y: 0.972, s: 0.082, rot: 2.30, bob: 0, kind: 'bank', ax: 0.50, ay: 0.52, hit: 0.36, sway: 0.004 },
    { name: 'reeds', x: 0.185, y: 0.805, s: 0.115, rot: 0.08, bob: 0, kind: 'bank', ax: 0.50, ay: 0.90, hit: 0.20, sway: 0.030 },
    { name: 'reeds', x: 0.742, y: 0.238, s: 0.095, rot: 0.32, bob: 0, kind: 'bank', ax: 0.50, ay: 0.90, hit: 0.18, sway: 0.028 },
    { name: 'lotus_pad', x: 0.600, y: 0.035, s: 0.050, rot: 1.70, bob: 0.80, kind: 'float' },
  ];

  /* 水面上的实体障碍（世界坐标），鱼的避障用 */
  function obstacles(world) {
    const out = [];
    for (const it of LAYOUT) {
      if (it.kind !== 'bank' || !it.hit) continue;
      out.push({ x: it.x * world.w, y: it.y * world.h, r: it.s * world.w * it.hit });
    }
    return out;
  }

  global.Sim = {
    Fish, Ripple, Food, RainDrop, SnowFlake, LAYOUT, obstacles, updateSchools, schools,
    SCENES, sceneForHour, creatureHosts,
    Turtle, Tadpole, Butterfly, Petal, Firefly, Mist,
    clamp, lerp, rand, TAU,
  };
})(typeof window !== 'undefined' ? window : globalThis);
