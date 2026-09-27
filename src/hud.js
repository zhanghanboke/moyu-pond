/* hud.js —— 右下角毛玻璃信息卡（时钟 / 日期 / 城市天气 / 三天预报 / 下班倒计时）
 *          + 设置面板 + 我的锦鲤画板挂载 + localStorage
 *
 * 版式参照给的参考图：卡片标题在左上、天气图标在右上、大号时间配"北京时间"、
 * 日期、城市 · 天气 · 温度、今天/明天/后天三列、底部一行是更新时刻与数据来源，
 * 最右下角是"设置"入口。整张卡片半透明 + 背景模糊，压在鱼池上。
 *
 * 注意：卡片里所有元素的 id 沿用旧版（clock/date/count/bar/panel/gear...），
 * 因为 tools/test.js 的自检断言直接 getElementById 取它们。
 */
(function (global) {
  'use strict';

  const KEY = 'moyu-pond:cfg:v1';
  const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

  const DEFAULTS = {
    fishCount: 170,
    speed: 1.0,
    size: 0.9,
    schooling: true,
    interact: 'dodge',         // feed 点击喂食 | dodge 靠近绕行让路 | shy 受惊猛逃 | off 关闭
    showClock: true,
    clockSize: 1.0,
    showDate: true,
    showCountdown: true,
    workStart: '09:00',
    workEnd: '18:00',
    lunchStart: '12:00',
    lunchEnd: '13:30',
    useLunch: true,
    workdaysOnly: true,
    caustics: 0.6,
    weed: 0.55,
    chop: 1.0,                 // 水面波动强度
    refract: true,
    scene: 'auto',
    quality: 'high',           // high | medium | low
    decor: true,
    pondDepth: 0.60,           // 池塘深浅：1=原来的深度，越小整池水越浅、鱼越大越清楚（滑杆步长 0.05）
    fishShadow: true,          // 池底投影（鱼身下方那团影子）
    weatherOn: true,           // 天气联动
    cityName: '武汉',
    cityAdmin: '湖北',
    cityLat: 30.5833,
    cityLon: 114.2667,
    customFish: true,          // 我的锦鲤（画板捏的那条）
  };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      const old = raw ? JSON.parse(raw) : {};
      const cfg = Object.assign({}, DEFAULTS, old);
      // 老配置里 interact 默认是 'feed'。点击投食在新档位里也保留，
      // 所以把没被显式改过的老默认值平移到 'dodge'，用户不会少任何东西。
      if (old.__v === undefined && old.interact === 'feed') cfg.interact = 'dodge';
      if (old.__v === undefined) cfg.__v = 2;
      return cfg;
    } catch (e) { return Object.assign({}, DEFAULTS, { __v: 2 }); }
  }
  function save(cfg) {
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { /* file:// 下可能不可用 */ }
  }
  function clear() { try { localStorage.removeItem(KEY); } catch (e) { } }

  const pad2 = n => (n < 10 ? '0' : '') + n;

  function toMin(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
    if (!m) return null;
    return clampNum(+m[1], 0, 23) * 60 + clampNum(+m[2], 0, 59);
  }
  function clampNum(v, a, b) { return v < a ? a : v > b ? b : v; }
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = (sec / 3600) | 0, m = ((sec % 3600) / 60) | 0, s = sec % 60;
    return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
  }

  /* 下班倒计时：支持午休时段不计入、周末不计时 */
  function countdown(cfg, now) {
    const start = toMin(cfg.workStart), end = toMin(cfg.workEnd);
    if (start === null || end === null || end <= start) return { text: '未设置工作时间', pct: 0 };
    const ls = cfg.useLunch ? toMin(cfg.lunchStart) : null;
    const le = cfg.useLunch ? toMin(cfg.lunchEnd) : null;
    const lunch = (ls !== null && le !== null && le > ls && ls > start && le < end) ? [ls, le] : null;
    const dayLen = (end - start) - (lunch ? lunch[1] - lunch[0] : 0);
    if (dayLen <= 0) return { text: '工作时间设置有误', pct: 0 };

    if (cfg.workdaysOnly && (now.getDay() === 0 || now.getDay() === 6)) {
      return { text: '今天不上班', pct: 1, rest: true };
    }
    const t = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    const worked = () => {
      let w = Math.max(0, Math.min(t, end) - start);
      if (lunch && t > lunch[0]) w -= Math.min(t, lunch[1]) - lunch[0];
      return w;
    };
    if (t < start) {
      return { text: `距上班 ${fmtDur((start - t) * 60)}`, pct: 0, pre: true };
    }
    if (t >= end) return { text: '已经下班啦', pct: 1, done: true };
    if (lunch && t >= lunch[0] && t < lunch[1]) {
      return { text: `午休中 · 还有 ${fmtDur((lunch[1] - t) * 60)}`, pct: clampNum((lunch[0] - start) / dayLen, 0, 1), rest: true };
    }
    const leftSec = (end - t) * 60 - (lunch && t < lunch[0] ? lunch[1] - lunch[0] : 0) * 60;
    return {
      text: `距下班 ${fmtDur(leftSec)}`,
      pct: clampNum(worked() / dayLen, 0, 1),
    };
  }

  /* ---------------- DOM ---------------- */
  function build(cfg, onChange, station) {
    const root = document.getElementById('hud');
    const icon = n => (global.Weather ? global.Weather.icon(n) : '');

    root.innerHTML = `
      <div class="card" id="card">
        <div class="card-main">
          <div class="card-head">
            <span class="card-title">池畔小记</span>
            <span class="wic" id="wic"></span>
          </div>

          <div class="clock-row">
            <span class="clock" id="clock">--:--</span>
            <span class="tz" id="tz">北京时间</span>
          </div>
          <div class="date" id="date"></div>

          <div class="wnow">
            <span class="city" id="city">—</span>
            <span class="wdot">·</span>
            <span class="wtext" id="wtext">天气加载中</span>
          </div>

          <div class="fc" id="fc"></div>

          <div class="count" id="countWrap">
            <span id="count"></span>
            <span class="bar"><i id="bar"></i></span>
          </div>

          <div class="wmeta" id="wmeta"></div>

          <div class="wfoot">
            <a class="wsrc" id="wsrc" href="https://open-meteo.com/" target="_blank" rel="noopener">天气数据 · Open-Meteo</a>
            <span class="wbtns">
              <button class="mini" id="wrefresh" title="立即刷新天气">刷新</button>
              <button class="gear" id="gear" title="设置 (Ctrl+,)">设置</button>
            </span>
          </div>
        </div>

        <!-- 面板自带顶栏：标签 + 关闭。
             以前"设置"按钮在卡片里，而面板一开卡片就 visibility:hidden，
             等于点了设置就再也点不回来 —— 必须有自己的返回入口。 -->
        <div class="panel" id="panel">
          <div class="ptop">
            <span class="ptitle">摸鱼鱼池</span>
            <span class="ptabs">
              <button class="ptab on" data-tab="set">鱼池</button>
              <button class="ptab" data-tab="koi">我的锦鲤</button>
            </span>
            <button class="pclose" id="pclose" title="返回 (Esc)" aria-label="返回">
              <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </div>

          <div class="pbody on" id="paneSet">
          <div class="sect">天气</div>
          <div class="row city-row"><label>城市</label>
            <input type="text" id="cityInput" placeholder="搜索城市，如 武汉" value="${cfg.cityName}">
            <button class="mini" id="cityGo">搜索</button>
          </div>
          <div class="citylist" id="cityList"></div>
          <div class="switches">
            <label><input type="checkbox" id="weatherOn">启用天气联动（雨雪 / 光照 / 风 / 温度）</label>
          </div>

          <!-- 画板自带标题（MY KOI / 画一条自己的锦鲤），所以这里不再加 .sect -->
          <div class="sect">画面</div>
          <div class="row"><label>鱼的数量</label><input type="range" id="fishCount" min="6" max="220" step="1"><b id="fishCountV"></b></div>
          <div class="row"><label>游速</label><input type="range" id="speed" min="0.3" max="2.2" step="0.05"><b id="speedV"></b></div>
          <div class="row"><label>体型</label><input type="range" id="size" min="0.5" max="1.8" step="0.05"><b id="sizeV"></b></div>
          <div class="row"><label>水面波动</label><input type="range" id="chop" min="0" max="1.6" step="0.05"><b id="chopV"></b></div>
          <div class="row"><label>池水深浅</label><input type="range" id="pondDepth" min="0.35" max="1" step="0.05"><b id="pondDepthV"></b></div>
          <div class="row"><label>水面光斑</label><input type="range" id="caustics" min="0" max="1" step="0.05"><b id="causticsV"></b></div>
          <div class="row"><label>水下植物</label><input type="range" id="weed" min="0" max="1" step="0.05"><b id="weedV"></b></div>
          <div class="switches">
            <label><input type="checkbox" id="fishShadow">鱼的影子（池底投影，越贴底越深）</label>
          </div>
          <div class="row"><label>场景氛围</label>
            <select id="scene">
              <option value="auto">跟随时间</option>
              <option value="dawn">清晨</option>
              <option value="noon">正午</option>
              <option value="dusk">黄昏</option>
              <option value="night">月夜</option>
            </select>
          </div>
          <div class="row"><label>鼠标互动</label>
            <select id="interact">
              <option value="dodge">靠近绕行（鱼让路）</option>
              <option value="shy">靠近惊散（鱼逃开）</option>
              <option value="feed">点击喂食</option>
              <option value="off">关闭</option>
            </select>
          </div>
          <div class="row"><label>画质</label>
            <select id="quality"><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select>
          </div>

          <div class="sect">桌面信息</div>
          <div class="row"><label>时钟大小</label><input type="range" id="clockSize" min="0.6" max="1.8" step="0.05"><b id="clockSizeV"></b></div>
          <div class="switches">
            <label><input type="checkbox" id="showClock">时钟</label>
            <label><input type="checkbox" id="showDate">日期</label>
            <label><input type="checkbox" id="showCountdown">下班倒计时</label>
            <label><input type="checkbox" id="schooling">结群</label>
            <label><input type="checkbox" id="decor">荷叶荷花</label>
            <label><input type="checkbox" id="refract">波纹折射</label>
            <label><input type="checkbox" id="customFish">我的锦鲤</label>
          </div>
          <div class="grid4">
            <label>上班<input type="time" id="workStart"></label>
            <label>下班<input type="time" id="workEnd"></label>
            <label>午休起<input type="time" id="lunchStart"></label>
            <label>午休止<input type="time" id="lunchEnd"></label>
          </div>
          <div class="switches">
            <label><input type="checkbox" id="useLunch">午休不计入</label>
            <label><input type="checkbox" id="workdaysOnly">周末不计时</label>
          </div>
          </div><!-- /paneSet -->

          <!-- 画板单独一页：它比设置高一倍，跟设置塞在一起就只能靠滚动条翻 -->
          <div class="pbody" id="paneKoi">
            <div id="paint" class="paint-host"></div>
          </div>

          <div class="foot">
            <span class="hint">Ctrl+, 开关面板 · Esc 关闭 · 点鱼池投食 · 数据只存本地</span>
            <button id="reset" class="btn">恢复默认</button>
          </div>
        </div>
      </div>`;

    const $ = id => document.getElementById(id);
    const ranges = ['fishCount', 'speed', 'size', 'clockSize', 'caustics', 'weed', 'chop', 'pondDepth'];
    const checks = ['showClock', 'showDate', 'showCountdown', 'schooling', 'decor', 'refract', 'useLunch', 'workdaysOnly', 'weatherOn', 'customFish', 'fishShadow'];
    const selects = ['interact', 'quality', 'scene'];
    const times = ['workStart', 'workEnd', 'lunchStart', 'lunchEnd'];

    function sync() {
      for (const k of ranges) { if ($(k)) { $(k).value = cfg[k]; $(k + 'V').textContent = (+cfg[k]).toFixed(k === 'fishCount' ? 0 : 2); } }
      for (const k of checks) if ($(k)) $(k).checked = !!cfg[k];
      for (const k of selects) $(k).value = cfg[k];
      for (const k of times) $(k).value = cfg[k];
      $('cityInput').value = cfg.cityName;
    }
    sync();

    const commit = k => () => {
      let v;
      if (ranges.includes(k)) v = parseFloat($(k).value);
      else if (checks.includes(k)) v = $(k).checked;
      else v = $(k).value;
      cfg[k] = v;
      if (ranges.includes(k)) $(k + 'V').textContent = v.toFixed(k === 'fishCount' ? 0 : 2);
      onChange(k, v);
      save(cfg);
    };
    for (const k of ranges.concat(checks, selects, times)) if ($(k)) $(k).addEventListener('input', commit(k));

    /* 城市搜索：走 Open-Meteo 的 geocoding，选中后经纬度存进 cfg 并立刻重拉 */
    async function citySearch() {
      const box = $('cityList');
      const q = $('cityInput').value.trim();
      if (!station || !q) { box.innerHTML = station ? '<div class="ci">输入城市名后点搜索</div>' : '<div class="ci">天气模块未加载</div>'; return; }
      box.innerHTML = '<div class="ci">搜索中…</div>';
      try {
        const list = await station.search(q);
        if (!list.length) { box.innerHTML = '<div class="ci">没找到这个城市</div>'; return; }
        box.innerHTML = list.map((c, i) =>
          `<button class="ci-btn" data-i="${i}">${c.name}<em>${c.admin} ${c.country}</em></button>`).join('');
        box.querySelectorAll('.ci-btn').forEach(b => b.addEventListener('click', () => {
          const c = list[+b.dataset.i];
          cfg.cityName = c.name; cfg.cityAdmin = c.admin; cfg.cityLat = c.lat; cfg.cityLon = c.lon;
          save(cfg);
          $('cityInput').value = c.name;
          box.innerHTML = `<div class="ci">已切到 ${c.name}，正在拉取天气…</div>`;
          onChange('city', c);
        }));
      } catch (e) {
        box.innerHTML = '<div class="ci">搜索失败（可能没联网）</div>';
      }
    }
    $('cityGo').addEventListener('click', citySearch);
    $('cityInput').addEventListener('keydown', e => { if (e.key === 'Enter') citySearch(); });
    $('wrefresh').addEventListener('click', () => { if (station) station.refresh(true); });

    /* 面板顶栏：返回 + 分页。
     * 返回 = 收起面板、把卡片主体重新放出来（去掉 .card 上的 setting 类）——
     * 这一步以前没法做：控制进面板的按钮就在卡片里，而面板一开卡片整个看不见了。 */
    $('pclose').addEventListener('click', () => togglePanel(false));
    document.querySelectorAll('.ptab').forEach(b => b.addEventListener('click', () => openTab(b.dataset.tab)));
    function openTab(name) {
      const on = name === 'koi' ? 'koi' : 'set';
      document.querySelectorAll('.ptab').forEach(b => b.classList.toggle('on', b.dataset.tab === on));
      $('paneSet').classList.toggle('on', on === 'set');
      $('paneKoi').classList.toggle('on', on === 'koi');
      return on;
    }
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && $('panel').classList.contains('open')) togglePanel(false);
    });

    $('reset').addEventListener('click', () => {
      Object.assign(cfg, DEFAULTS); sync(); onChange('reset', null); save(cfg);
    });
    /* 面板和卡片共用屏幕右下角这一块：打开面板时卡片主体淡出，
     * 否则面板往上长会顶出屏幕上沿（面板比卡片高得多）。 */
    function togglePanel(on) {
      const open = on == null ? !$('panel').classList.contains('open') : !!on;
      $('panel').classList.toggle('open', open);
      $('card').classList.toggle('setting', open);
      return open;
    }
    $('gear').addEventListener('click', () => togglePanel());
    global.HUD = { root: $, cfg, sync, togglePanel, openTab };

    // 画板由 paint.js 自渲染（它可能晚于 hud 加载）
    if (global.Paint && $('paint')) global.Paint.mount($('paint'), cfg, onChange);

    return { $, sync, togglePanel, openTab };
  }

  /* ---------------- 每 250ms 的刷新 ---------------- */
  function tick(ui, cfg, now, station) {
    const { $ } = ui;
    $('card').style.setProperty('--clock-size', cfg.clockSize);

    if (cfg.showClock) {
      $('clock').textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
      $('clock').style.display = '';
      $('tz').style.display = '';
    } else {
      $('clock').textContent = '';
      $('clock').style.display = 'none';
      $('tz').style.display = 'none';
    }
    $('date').textContent = cfg.showDate ? `${now.getMonth() + 1}月${now.getDate()}日  ${WEEK[now.getDay()]}` : '';

    const c = countdown(cfg, now);
    $('count').textContent = cfg.showCountdown ? c.text : '';
    $('bar').style.width = Math.round((c.pct || 0) * 100) + '%';
    $('countWrap').classList.toggle('done', !!c.done);
    // 午休/周末/已下班时进度条没有意义，只留文字
    $('countWrap').classList.toggle('nobar', !cfg.showCountdown || !!c.rest || !!c.done || !!c.pre);

    if (cfg.weatherOn === false || !station) {
      if (ui._wkey !== 'off') {
        ui._wkey = 'off';
        $('wic').innerHTML = '';
        $('wtext').textContent = cfg.weatherOn === false ? '天气联动已关闭' : '天气加载中…';
        $('fc').innerHTML = '';
        $('wmeta').textContent = '';
        $('city').textContent = cfg.weatherOn === false ? '' : cfg.cityName;
      }
      return;
    }

    const s = station.snapshot(now);
    const key = JSON.stringify([s.city, s.now && s.now.text, s.now && s.now.temp, s.now && s.now.icon,
      s.now && s.now.isDay, s.offline, s.tz, s.days.map(d => [d.text, d.min, d.max])]);
    if (key === ui._wkey) return;          // 天气没变就别重建 DOM
    ui._wkey = key;

    const ic = global.Weather ? global.Weather.icon : (() => '');
    $('city').textContent = s.city;
    $('tz').textContent = s.tz;
    $('wic').innerHTML = s.now
      ? `<span class="sic">${ic(s.now.icon)}</span><span class="sic dim">${ic(s.now.isDay ? 'sun' : 'moon')}</span>`
      : '';
    $('wtext').innerHTML = s.now ? `${s.now.text} <b>${s.now.temp}°C</b>` : '天气加载中…';

    $('fc').innerHTML = s.days.map(d => `
      <div class="fcol${d.label === '今天' ? ' on' : ''}">
        <div class="fl">${d.label}</div>
        <div class="fic">${ic(d.icon)}</div>
        <div class="ft">${d.text}</div>
        <div class="ftemp">${d.min == null ? '--' : d.min + '°'} / ${d.max == null ? '--' : d.max + '°'}</div>
      </div>`).join('');

    const up = s.updated ? `${pad2(s.updated.getHours())}:${pad2(s.updated.getMinutes())} 更新` : '尚未更新';
    $('wmeta').textContent = s.offline
      ? `${up} · 离线模拟，点"刷新"重试`
      : `${up} · 每半小时刷新`;
    $('wmeta').classList.toggle('offline', !!s.offline);
    $('wsrc').textContent = '天气数据 · Open-Meteo';
  }

  global.MoyuHUD = { build, tick, load, save, clear, DEFAULTS, countdown, fmtDur, WEEK };
})(typeof window !== 'undefined' ? window : globalThis);
