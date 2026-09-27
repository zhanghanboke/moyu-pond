/* weather.js —— Open-Meteo 天气：城市检索 + 当前天气 + 三天预报 + WMO 码翻译成视觉参数
 *
 * 选 Open-Meteo 的理由：免注册、不要 key、浏览器能直连（CORS 开放），中文城市名也能搜。
 *
 * 对外就三样东西：
 *   Weather.info(code) / Weather.icon(name) —— 码和图标翻译，HUD 和主循环都用它；
 *   Weather.simulate(date, place)           —— 断网兜底：按节气和纬度编一份合理的天气；
 *   new Weather.Station(place)              —— 一台"气象站"：自己去拉数据，拉不到就用模拟值，
 *                                              算出 env（一组乘子）交给主循环，HUD 只管读
 *                                              snapshot()。主循环里就不用到处写 if 判空。
 * env 是烘进背景缓存的，所以每次拿到新数据都要重烘一次（见 main.js 的 station.start 回调）。 */
(function (global) {
  'use strict';

  const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
  const FC = 'https://api.open-meteo.com/v1/forecast';
  const CACHE = 'moyu-pond:weather:v1';
  const TTL = 30 * 60 * 1000;          // 半小时刷一次：天气不需要更快，壁纸也不该勤快
  const FETCH_MS = 8000;               // 8 秒拉不到就当断网，别让池塘干等

  /* WMO 天气码 -> 中文说法 + 各视觉层强度（0..1）。
   * 只有"档位"在这里；实际降水量（毫米）在 buildEnv 里再叠一层密度。 */
  const CODES = {
    0: ['晴', {}], 1: ['晴间多云', { cloud: .25 }], 2: ['多云', { cloud: .55 }], 3: ['阴', { cloud: .92 }],
    45: ['有雾', { fog: .8, cloud: .5 }], 48: ['雾凇', { fog: 1, cloud: .5 }],
    51: ['毛毛雨', { rain: .18, cloud: .8 }], 53: ['毛毛雨', { rain: .3, cloud: .85 }],
    55: ['浓毛毛雨', { rain: .42, cloud: .9 }],
    56: ['冻毛毛雨', { rain: .3, sleet: .3, cloud: .9 }], 57: ['冻毛毛雨', { rain: .45, sleet: .4, cloud: .95 }],
    61: ['小雨', { rain: .4, cloud: .9 }], 63: ['中雨', { rain: .68, cloud: .95 }],
    65: ['大雨', { rain: 1, cloud: 1 }],
    66: ['冻雨', { rain: .6, sleet: .4, cloud: .95 }], 67: ['强冻雨', { rain: .85, sleet: .5, cloud: 1 }],
    71: ['小雪', { snow: .4, cloud: .9 }], 73: ['中雪', { snow: .68, cloud: .95 }],
    75: ['大雪', { snow: 1, cloud: 1 }], 77: ['雪粒', { snow: .45, cloud: .9 }],
    80: ['阵雨', { rain: .5, cloud: .9 }], 81: ['强阵雨', { rain: .75, cloud: .95 }],
    82: ['暴阵雨', { rain: 1, cloud: 1 }],
    85: ['阵雪', { snow: .55, cloud: .95 }], 86: ['强阵雪', { snow: .9, cloud: 1 }],
    95: ['雷阵雨', { rain: .8, storm: 1, cloud: 1 }],
    96: ['雷雨伴冰雹', { rain: .9, storm: 1, hail: .5, cloud: 1 }],
    99: ['强雷雨伴冰雹', { rain: 1, storm: 1, hail: .8, cloud: 1 }],
  };

  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

  /* 由强度组合反推图标名：雪 > 雷 > 雨 > 雾 > 云量 */
  function iconOf(v) {
    if (v.snow || v.sleet) return 'snow';
    if (v.storm || v.hail) return 'storm';
    if (v.rain) return 'rain';
    if (v.fog) return 'fog';
    if ((v.cloud || 0) >= 0.8) return 'cloudy';
    if ((v.cloud || 0) > 0.3) return 'partly';
    return 'sun';
  }

  /* 码 -> {text, icon, 各层强度}。给的是"档位"，不带降水量修正。 */
  function info(code) {
    const hit = CODES[code] || ['未知天气', {}];
    const v = hit[1] || {};
    return {
      code: code, text: hit[0], icon: iconOf(v),
      rain: v.rain || 0, snow: v.snow || 0, sleet: v.sleet || 0, hail: v.hail || 0,
      fog: v.fog || 0, storm: v.storm || 0, cloud: v.cloud || 0,
    };
  }

  /* 24×24 的线描图标，跟着文字颜色走（CSS 里 stroke: currentColor）。
   * 不用 emoji：emoji 在不同平台上形状差太多，而且没法调粗细。 */
  const SVG = {
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"/>',
    moon: '<path d="M20 14.2A8.4 8.4 0 1 1 9.8 4.2a6.9 6.9 0 0 0 10.2 10z"/>',
    cloud: '<path d="M6.8 18.2h10.4a3.4 3.4 0 0 0 .3-6.8 5.2 5.2 0 0 0-9.8-1.3 3.5 3.5 0 0 0-.9 8.1z"/>',
    partly: '<circle cx="8.2" cy="8" r="3.1"/><path d="M8.2 2.5v1.4M3.4 8H2M4.7 4.5l1 1M12.7 4.5l-1 1"/><path d="M10.5 19.5h7.3a2.8 2.8 0 0 0 .2-5.6 4.3 4.3 0 0 0-8-1 2.9 2.9 0 0 0 .5 6.6z"/>',
    cloudy: '<path d="M6.6 17.6h10.6a3.5 3.5 0 0 0 .3-7 5.3 5.3 0 0 0-10-1.3 3.6 3.6 0 0 0-.9 8.3z"/><path d="M17.4 8.4a3.4 3.4 0 0 0 3.2 3.4"/>',
    rain: '<path d="M6.8 14.6h10.4a3.4 3.4 0 0 0 .3-6.8 5.2 5.2 0 0 0-9.8-1.3 3.5 3.5 0 0 0-.9 8.1z"/><path d="M8.6 17.4l-1 3.2M12.4 17.4l-1 3.2M16.2 17.4l-1 3.2"/>',
    snow: '<path d="M6.8 14.4h10.4a3.4 3.4 0 0 0 .3-6.8 5.2 5.2 0 0 0-9.8-1.3 3.5 3.5 0 0 0-.9 8.1z"/><path d="M8.4 17.6v.1M12 19v.1M15.6 17.6v.1M10.2 21v.1M13.8 21v.1"/>',
    storm: '<path d="M6.8 14h10.4a3.4 3.4 0 0 0 .3-6.8 5.2 5.2 0 0 0-9.8-1.3 3.5 3.5 0 0 0-.9 8.1z"/><path d="M13.2 16.2l-2.6 3.6h2.6l-1.6 3.2"/>',
    fog: '<path d="M6.6 13.4h10.8a3.5 3.5 0 0 0 .3-7 5.3 5.3 0 0 0-10-1.3 3.6 3.6 0 0 0-1.1 8.3z"/><path d="M4.4 17.6h15.2M6.8 20.6h11.6"/>',
  };
  function icon(name) {
    const d = SVG[name] || SVG.sun;
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  }

  /* ---------- 网络 ---------- */
  function getJSON(url, ms) {
    return new Promise((resolve, reject) => {
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const m = setTimeout(() => { if (ctl) ctl.abort(); reject(new Error('timeout')); }, ms || FETCH_MS);
      fetch(url, ctl ? { signal: ctl.signal } : undefined).then(r => {
        clearTimeout(m);
        if (!r.ok) return reject(new Error('HTTP ' + r.status));
        r.json().then(resolve, reject);
      }, e => { clearTimeout(m); reject(e); });
    });
  }

  async function searchCity(name) {
    const u = `${GEO}?name=${encodeURIComponent(name)}&count=5&language=zh&format=json`;
    const d = await getJSON(u);
    return (d.results || []).map(r => ({
      name: r.name, admin: r.admin1 || '', country: r.country || '',
      lat: r.latitude, lon: r.longitude,
    }));
  }

  /* 当前 + 三天预报一次拿全：省一个请求，也让"今天"和预报来自同一份数据 */
  async function fetchNow(lat, lon) {
    const u = `${FC}?latitude=${(+lat).toFixed(3)}&longitude=${(+lon).toFixed(3)}`
      + `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,cloud_cover,wind_speed_10m,is_day`
      + `&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=3&timezone=auto`;
    const d = await getJSON(u);
    const c = d.current || {};
    const dd = d.daily || {};
    const days = [];
    for (let i = 0; i < 3; i++) {
      const code = dd.weather_code && dd.weather_code[i];
      days.push({
        code: code == null ? 0 : code,
        max: num(dd.temperature_2m_max && dd.temperature_2m_max[i]),
        min: num(dd.temperature_2m_min && dd.temperature_2m_min[i]),
      });
    }
    return {
      temp: num(c.temperature_2m), feels: num(c.apparent_temperature), hum: num(c.relative_humidity_2m),
      precip: num(c.precipitation) || 0, code: c.weather_code == null ? 0 : c.weather_code,
      cloud: num(c.cloud_cover), wind: num(c.wind_speed_10m) || 0,
      isDay: c.is_day == null ? null : !!c.is_day,
      daily: days, at: Date.now(), tz: d.timezone || '',
    };
  }
  const num = v => (typeof v === 'number' && isFinite(v) ? v : null);

  /* ---------- 断网兜底：按节气和纬度编一份天气 ----------
   * 壁纸是常驻的，没网也得有天气（否则卡片永远"加载中"、池子永远大晴天）。
   * 编的原则只有一条：看起来得像那么回事——
   *   1 月中最低、7 月中最高，纬度越高越冷，一天里 15 点最暖、3 点最冷；
   *   温度低于 1° 就下雪，5° 以下下冷雨，其余在晴/多云/阵雨里挑。 */
  function seasonalTemp(date, lat) {
    const doy = dayOfYear(date);
    const base = 30 - Math.abs(lat == null ? 30 : lat) * 0.32;   // 赤道 30°，北纬 30° 约 20.4°
    const t = base - 11.5 * Math.cos((doy - 15) / 365 * Math.PI * 2);
    const h = date.getHours() + date.getMinutes() / 60;
    const diurnal = 3.2 * Math.sin((h - 9) / 24 * Math.PI * 2);  // 15 点 +3.2，3 点 -3.2
    const wob = 2.4 * Math.sin(doy * 2.399 + (lat || 0));        // 逐日的小起伏，别是一条死曲线
    return t + diurnal + wob;
  }
  function dayOfYear(d) {
    const start = new Date(d.getFullYear(), 0, 0);
    return Math.floor((d - start) / 86400000);
  }
  /* 同一个种子永远给同一个结果：不然每次 tick 出来的天气都在跳。
   * 早先用 sin(x)*43758 取小数位，相邻两天会抽到同一个天气码（连着三天雷阵雨），
   * 换成整数散列后分布就正常了。 */
  function seeded(rand, n) {
    let h = (rand | 0) * 374761393 + (n | 0) * 668265263;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function pickCode(temp, r) {
    if (temp < 1) return [71, 73, 75][Math.min(2, (r * 3) | 0)];
    const pool = temp < 5 ? [51, 61, 61, 63, 80]
      : temp < 14 ? [0, 1, 2, 3, 61, 80]
        : temp < 26 ? [0, 0, 1, 2, 3, 80, 95]
          : [0, 0, 1, 2, 80, 95];
    return pool[Math.min(pool.length - 1, (r * pool.length) | 0)];
  }
  function simulate(date, place) {
    const d = date || new Date();
    const lat = place && place.lat != null ? place.lat : 30;
    const doy = dayOfYear(d);
    const temp = seasonalTemp(d, lat);
    const code = pickCode(temp, seeded(doy, 1));
    const daily = [];
    for (let i = 0; i < 3; i++) {
      const dd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, 14);
      const mid = seasonalTemp(dd, lat);
      const c = pickCode(mid, seeded(dayOfYear(dd), 2 + i));
      daily.push({ code: c, max: Math.round(mid + 2.5), min: Math.round(mid - 5.5) });
    }
    return {
      temp: Math.round(temp * 10) / 10, feels: Math.round(temp * 10) / 10, hum: 60,
      precip: 0, code: code, cloud: (info(code).cloud || 0) * 100,
      wind: 6 + seeded(doy, 9) * 12, isDay: d.getHours() >= 6 && d.getHours() < 18,
      daily: daily, at: d.getTime(), tz: '', __sim: true,
    };
  }

  /* ---------- 天气 -> 视觉乘子 ----------
   * 这里是"天气怎么影响池子"的唯一出处：光照、焦散、涟漪密度、摆动、鱼的速度和深浅。
   * 主循环拿去直接乘，不动的地方就是 1（或 0）。 */
  function buildEnv(w, place) {
    const i = info(w ? w.code : 0);
    const mm = w ? (w.precip || 0) : 0;
    const boost = Math.min(1, mm / 4);                       // 码只给档位，毫米数决定密度
    const rain = clamp01(i.rain * 0.75 + (i.rain ? boost * 0.45 : 0));
    const snow = clamp01(i.snow * 0.8 + (i.snow ? boost * 0.3 : 0));
    const cloud = Math.max(i.cloud, w && w.cloud != null ? w.cloud / 100 : 0);
    const fog = i.fog || 0;
    const wind = Math.min(1, (w ? (w.wind || 0) : 0) / 55);

    // 云、雨、雪、雾都压暗；大晴天反过来提一点亮（1.06 是上限，再高就发白了）
    let light = 1 - cloud * 0.22 - rain * 0.18 - snow * 0.10 - fog * 0.12;
    if (cloud < 0.2 && !rain && !snow && !fog) light = 1.06;

    const temp = w && typeof w.temp === 'number' ? w.temp : null;
    // 22°C 最舒服，越偏离越蔫；冷天整池鱼沉一点（鱼是变温动物，这点是真的）
    const comfort = temp == null ? 1 : clamp01(1 - Math.abs(temp - 22) * 0.020);
    return {
      light: light,
      causticK: clamp01(1 - cloud * 0.35 - rain * 0.2 - fog * 0.15),   // 阴天水底没有光斑
      rippleRate: 1 + rain * 3 + snow * 0.5 + wind * 1.2,
      swayK: 1 + wind * 2.2,
      chopK: 1 + wind * 1.1 + rain * 0.5,
      fishSpeed: comfort * (1 - rain * 0.12),
      fishDepth: temp == null ? 0 : Math.max(-0.1, Math.min(0.35, (22 - temp) * 0.012)),
      rain: rain, snow: snow, fog: fog, wind: wind, cloud: cloud, storm: i.storm || 0,
      text: i.text, icon: i.icon, temp: temp,
      offline: !!(w && w.__sim),
    };
  }

  function readCache() { try { return JSON.parse(localStorage.getItem(CACHE) || 'null'); } catch (e) { return null; } }
  function writeCache(c) { try { localStorage.setItem(CACHE, JSON.stringify(c)); } catch (e) { } }
  function needsRefresh() {
    const c = readCache();
    return !c || !c.w || (Date.now() - (c.w.at || 0) > TTL);
  }

  const DAY_LABEL = ['今天', '明天', '后天'];

  /* 一台气象站：自己去拉数据，拉不到就用模拟值，env 一直有值。
   * 外部只要：start(有新数据时的回调) / setCity / search / refresh / snapshot / env */
  function Station(place) {
    this.place = { name: (place && place.name) || '武汉', admin: (place && place.admin) || '',
      lat: place && place.lat != null ? +place.lat : 30.5833, lon: place && place.lon != null ? +place.lon : 114.2667 };
    this.cb = null; this.timer = 0; this.busy = false;
    this.tz = '北京时间';
    this.offline = true;                 // 一上来就是离线模拟，卡片不用等
    this.updated = null;
    this.apply(simulate(new Date(), this.place), true);
    const cached = readCache();
    if (cached && cached.w) {            // 有缓存就先顶上：比凭空编的准
      this.place = cached.place || this.place;
      this.apply(cached.w, (Date.now() - (cached.w.at || 0)) > TTL);
      if (cached.daily) this.daily = cached.daily;
      // 缓存是在 TTL 内拉到的真数据，别把它标成"离线模拟"
      if (cached.w.at) this.updated = new Date(cached.w.at);
    }
  }
  Station.prototype = {
    /* 写入一次观测结果：算 env、记预报、通知外部 */
    apply(w, offline) {
      this.w = w;
      this.env = buildEnv(w, this.place);
      this.env.offline = !!offline;
      if (!this.daily) this.daily = (w && w.daily) || [];
      this.offline = !!offline;
      if (w && w.tz) this.tz = w.tz;
      if (!offline) this.updated = new Date();
      if (this.cb) { try { this.cb(this); } catch (e) { } }
    },
    start(cb) {
      this.cb = cb || null;
      if (!this.timer) this.timer = setInterval(() => this.refresh(false), 5 * 60 * 1000);
      this.refresh(needsRefresh());     // 缓存还新就别浪费一次请求
      return this;
    },
    setCity(p) {
      if (!p) return;
      this.place = { name: p.name || this.place.name, admin: p.admin || '', lat: +p.lat, lon: +p.lon };
      this.daily = null;
      this.refresh(true);
    },
    search(q) { return searchCity(q); },
    async refresh(force) {
      if (this.busy) return;
      if (!force && !needsRefresh()) return;
      this.busy = true;
      try {
        const w = await fetchNow(this.place.lat, this.place.lon);
        writeCache({ place: this.place, w: w, daily: w.daily });
        this.daily = w.daily || [];
        this.apply(w, false);
      } catch (e) {
        // 拉不到：能退回缓存就退，退不了就编一份。总之 env 必须有值。
        const c = readCache();
        if (c && c.w) { this.daily = c.daily || null; this.apply(c.w, true); }
        else { this.daily = null; this.apply(simulate(new Date(), this.place), true); }
        this.err = String((e && e.message) || e);
      }
      this.busy = false;
    },
    /* HUD 每 250ms 读一次：返回的是渲染好的小结构，不含任何 DOM */
    snapshot(now) {
      const d = now || new Date();
      const days = (this.daily && this.daily.length ? this.daily : (this.w && this.w.daily) || [])
        .slice(0, 3).map((x, i) => {
          const inf = info(x.code);
          return { label: DAY_LABEL[i] || ('+' + i), text: inf.text, icon: inf.icon,
            min: x.min == null ? null : Math.round(x.min), max: x.max == null ? null : Math.round(x.max) };
        });
      while (days.length < 3) {                      // 极端情况下也保证三列，版面不会塌
        const inf = info(this.w ? this.w.code : 0);
        days.push({ label: DAY_LABEL[days.length], text: inf.text, icon: inf.icon, min: null, max: null });
      }
      const w = this.w;
      const inf = info(w ? w.code : 0);
      const isDay = w && w.isDay != null ? !!w.isDay : (d.getHours() >= 6 && d.getHours() < 18);
      return {
        city: this.place.name || '武汉',
        tz: this.tz,
        now: w ? { text: inf.text, temp: Math.round(w.temp == null ? 0 : w.temp),
          icon: inf.icon, isDay: isDay } : null,
        days: days,
        offline: this.offline,
        updated: this.updated,
      };
    },
  };

  global.Weather = {
    CODES, CACHE, TTL, FETCH_MS, DAY_LABEL,
    info, icon, iconOf, buildEnv, simulate, seasonalTemp,
    searchCity, fetchNow, readCache, writeCache, needsRefresh,
    Station,
  };
})(typeof window !== 'undefined' ? window : globalThis);
