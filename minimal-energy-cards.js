// Minimal Energy Cards: an EV charging card and a solar production card styled to match the
// Minimal Dark theme (https://github.com/theak/minimal-dark-ha-theme). No dependencies.
// See README.md for every option.
//
//   type: custom:minimal-ev-card
//   name: Model 3
//   range: sensor.my_car_range
//   battery: sensor.my_car_battery
//   charge_limit: number.my_car_charge_limit            # optional, adds the stepper
//   charging: binary_sensor.my_car_charging
//   plugged: binary_sensor.wall_connector_vehicle_connected
//   power: sensor.wall_connector_power                  # optional, kW
//   complete_time: sensor.my_car_time_charge_complete   # optional, timestamp
//   odometer: sensor.my_car_odometer                    # optional
//
//   type: custom:minimal-solar-card
//   name: Solar
//   entity: sensor.solar_power   # W or kW
//   hours: 6                     # graph window
//   graph: true                  # false shows just the numbers

const VERSION = '1.1.0';

const BASE_CSS = `
  :host { display: block; }
  /* Accent colors; override from a theme or card-mod with these variables. */
  :host {
    --minimal-ev-color: #6cc28a;
    --minimal-solar-color: var(--primary-text-color, #eaebec);
  }
  ha-card { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
  .head { display: flex; align-items: center; gap: 12px; }
  .badge { width: 36px; height: 36px; flex: none; border-radius: 50%; display: flex;
    align-items: center; justify-content: center; --mdc-icon-size: 20px; cursor: pointer; }
  .titles { flex: 1; min-width: 0; }
  .name { font-size: 14px; font-weight: 500; color: var(--primary-text-color); }
  .sub { font-size: 12px; color: var(--secondary-text-color); white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; }
  .value { text-align: right; flex: none; white-space: nowrap; }
  .big { font-size: 22px; line-height: 1.1; font-variant-numeric: tabular-nums;
    color: var(--primary-text-color); }
  .small { font-size: 12px; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
`;

const num = (hass, id) => {
  const s = id && hass.states[id];
  const v = s ? parseFloat(s.state) : NaN;
  return Number.isFinite(v) ? v : null;
};
const unit = (hass, id, fallback) => hass.states[id]?.attributes?.unit_of_measurement ?? fallback;
const isOn = (hass, id) => !!id && hass.states[id]?.state === 'on';
const moreInfo = (el, entityId) =>
  entityId && el.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId }, bubbles: true, composed: true }));
const duration = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`;
};

class MinimalEvCard extends HTMLElement {
  setConfig(config) {
    if (!config.range || !config.battery) throw new Error('range and battery are required');
    this._config = config;
    this._pendingLimit = null;
  }

  getCardSize() { return 3; }
  getGridOptions() { return { columns: 12, rows: 'auto' }; }

  set hass(hass) {
    this._hass = hass;
    if (!this.shadowRoot) this._build();
    this._render();
  }

  _build() {
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${BASE_CSS}
        .bar { position: relative; height: 22px; }
        .track { position: absolute; left: 0; right: 0; top: 7px; height: 8px; border-radius: 4px;
          background: var(--secondary-background-color); overflow: hidden; }
        .target, .fill { position: absolute; top: 0; bottom: 0; left: 0; }
        .target { transition: width 180ms cubic-bezier(0.2, 0, 0, 1); }
        .fill { border-radius: 4px; transition: width 300ms cubic-bezier(0.2, 0, 0, 1); }
        .marker { position: absolute; top: 1px; width: 3px; height: 20px; border-radius: 2px;
          background: var(--primary-text-color); transform: translateX(-50%);
          box-shadow: 0 0 0 2px var(--ha-card-background, var(--card-background-color));
          transition: left 180ms cubic-bezier(0.2, 0, 0, 1); }
        .foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .odo { font-size: 12px; color: var(--disabled-text-color); font-variant-numeric: tabular-nums; }
        .limit { display: flex; align-items: center; gap: 10px; font-size: 12px;
          color: var(--secondary-text-color); white-space: nowrap; }
        .stepper { height: 36px; border-radius: 12px; background: var(--secondary-background-color);
          display: flex; align-items: center; }
        .stepper button { all: unset; width: 40px; height: 36px; display: flex; align-items: center;
          justify-content: center; cursor: pointer; color: var(--secondary-text-color);
          --mdc-icon-size: 18px; transition: transform 120ms cubic-bezier(0.2, 0, 0, 1); }
        .stepper button:active { transform: scale(0.9); }
        .stepper span { width: 40px; text-align: center; font-size: 14px; font-weight: 500;
          color: var(--primary-text-color); font-variant-numeric: tabular-nums; }
      </style>
      <ha-card>
        <div class="head">
          <div class="badge"><ha-icon></ha-icon></div>
          <div class="titles"><div class="name"></div><div class="sub status"></div></div>
          <div class="value"><div class="big range"></div><div class="small pct"></div></div>
        </div>
        <div class="bar"><div class="track"><div class="target"></div><div class="fill"></div></div><div class="marker"></div></div>
        <div class="foot">
          <span class="odo"></span>
          <div class="limit">Charge limit
            <div class="stepper">
              <button class="dec" aria-label="Lower charge limit"><ha-icon icon="mdi:minus"></ha-icon></button>
              <span class="lim"></span>
              <button class="inc" aria-label="Raise charge limit"><ha-icon icon="mdi:plus"></ha-icon></button>
            </div>
          </div>
        </div>
      </ha-card>`;
    const q = (s) => root.querySelector(s);
    this._el = {
      badge: q('.badge'), icon: q('.badge ha-icon'), name: q('.name'), status: q('.status'),
      range: q('.range'), pct: q('.pct'), target: q('.target'), fill: q('.fill'),
      marker: q('.marker'), odo: q('.odo'), lim: q('.lim'), limit: q('.limit'),
    };
    this._el.badge.addEventListener('click', () => moreInfo(this, this._config.range));
    q('.range').addEventListener('click', () => moreInfo(this, this._config.range));
    q('.dec').addEventListener('click', () => this._step(-1));
    q('.inc').addEventListener('click', () => this._step(1));
  }

  _limitBounds() {
    const a = this._hass.states[this._config.charge_limit]?.attributes || {};
    return { min: a.min ?? 50, max: a.max ?? 100 };
  }

  // Taps adjust the number on screen right away; the car is only told once the
  // taps stop, so five quick taps are one API call (and one wake-up), not five.
  _step(dir) {
    const cur = this._pendingLimit ?? num(this._hass, this._config.charge_limit);
    if (cur == null) return;
    const { min, max } = this._limitBounds();
    this._pendingLimit = Math.max(min, Math.min(max, Math.round(cur / 5) * 5 + dir * 5));
    this._render();
    clearTimeout(this._commit);
    this._commit = setTimeout(() => {
      const value = this._pendingLimit;
      this._hass.callService('number', 'set_value', { entity_id: this._config.charge_limit, value });
      // Keep showing the new value until the entity catches up (or 30 s passes).
      setTimeout(() => { if (this._pendingLimit === value) { this._pendingLimit = null; this._render(); } }, 30000);
    }, 900);
  }

  _render() {
    const hass = this._hass, c = this._config, el = this._el;
    if (!hass || !el) return;
    const range = num(hass, c.range), batt = num(hass, c.battery);
    const stateLimit = num(hass, c.charge_limit);
    if (this._pendingLimit != null && stateLimit === this._pendingLimit) this._pendingLimit = null;
    const limit = this._pendingLimit ?? stateLimit;
    const charging = isOn(hass, c.charging), plugged = charging || isOn(hass, c.plugged);
    const accent = 'var(--minimal-ev-color)', amber = 'var(--amber-color, #e3bd62)';
    const tint = (pct) => `color-mix(in srgb, var(--minimal-ev-color) ${pct}%, transparent)`;

    let icon, fg, bg, status, fill, target, statusColor = 'var(--secondary-text-color)';
    if (charging) {
      icon = 'mdi:ev-station'; fg = accent; bg = tint(16);
      fill = accent; target = tint(18); statusColor = accent;
      const parts = ['Charging'];
      const kw = num(hass, c.power);
      if (kw) parts.push(`${kw.toFixed(1)} kW`);
      const done = c.complete_time && Date.parse(hass.states[c.complete_time]?.state);
      if (done && done > Date.now()) parts.push(`${duration(done - Date.now())} to ${limit ?? ''}%`);
      status = parts.join(' · ');
    } else if (plugged) {
      icon = 'mdi:power-plug'; fg = accent; bg = tint(12);
      fill = accent; target = tint(14);
      status = batt != null && limit != null && batt >= limit ? 'Plugged in · Charged to limit' : 'Plugged in · Not charging';
    } else {
      const low = batt != null && batt < 30;
      icon = 'mdi:car-electric'; fg = low ? amber : 'var(--disabled-text-color)'; bg = 'rgba(255, 255, 255, 0.05)';
      fill = low ? amber : 'var(--secondary-text-color)'; target = 'rgba(255, 255, 255, 0.06)';
      status = low ? 'Unplugged · Battery low' : 'Unplugged';
      if (low) statusColor = amber;
    }

    el.icon.setAttribute('icon', icon);
    el.badge.style.color = fg; el.badge.style.background = bg;
    el.name.textContent = c.name || 'Car';
    el.status.textContent = status; el.status.style.color = statusColor;
    el.range.textContent = range != null ? `${Math.round(range)} ${unit(hass, c.range, 'mi')}` : '—';
    el.pct.textContent = batt != null ? `${Math.round(batt)}%` : '';
    el.fill.style.width = `${batt ?? 0}%`; el.fill.style.background = fill;
    el.target.style.width = `${limit ?? 0}%`; el.target.style.background = target;
    el.marker.style.left = `${limit ?? 0}%`; el.marker.style.display = limit == null ? 'none' : '';
    const odo = num(hass, c.odometer);
    el.odo.textContent = odo != null ? `${Math.round(odo).toLocaleString('en-US')} ${unit(hass, c.odometer, 'mi')}` : '';
    el.limit.style.display = c.charge_limit ? '' : 'none';
    el.lim.textContent = limit != null ? `${Math.round(limit)}%` : '—';
  }
}

class MinimalSolarCard extends HTMLElement {
  setConfig(config) {
    if (!config.entity) throw new Error('entity is required');
    this._config = { hours: 6, graph: true, ...config };
    this._series = null; // [[ms, watts], ...] step function, oldest first
    this._hover = null;
  }

  getCardSize() { return 4; }
  getGridOptions() { return { columns: 12, rows: 'auto' }; }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this.shadowRoot) this._build();
    const s = hass.states[this._config.entity];
    if (this._series && s) {
      const last = this._series[this._series.length - 1];
      const w = parseFloat(s.state) * this._scale();
      if (Number.isFinite(w) && (!last || last[1] !== w)) this._series.push([Date.parse(s.last_changed), w]);
    }
    if (first) this._fetch();
    this._render();
  }

  connectedCallback() {
    clearInterval(this._timer);
    this._timer = setInterval(() => this._fetch(), 5 * 60 * 1000);
    if (this._hass) this._fetch();
  }

  disconnectedCallback() { clearInterval(this._timer); this._resize?.disconnect(); }

  // Times follow HA's configured time zone, not the viewing device's.
  _tz() { return this._hass?.config?.time_zone; }

  // Multiplier that turns the entity's readings into watts.
  _scale() { return /^kW$/i.test(unit(this._hass, this._config.entity, 'W')) ? 1000 : 1; }

  _midnight() {
    const now = Date.now();
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: this._tz(), hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(now).map((p) => [p.type, Number(p.value)]));
    return now - ((parts.hour * 60 + parts.minute) * 60 + parts.second) * 1000 - (now % 1000);
  }

  async _fetch() {
    if (!this._hass || this._fetching) return;
    this._fetching = true;
    try {
      const start = Math.min(this._midnight(), Date.now() - this._config.hours * 3600e3);
      const res = await this._hass.callWS({
        type: 'history/history_during_period',
        start_time: new Date(start).toISOString(),
        entity_ids: [this._config.entity],
        minimal_response: true, no_attributes: true, significant_changes_only: false,
      });
      const rows = res[this._config.entity] || [];
      this._series = rows
        .map((r) => [(r.lu ?? r.lc) * 1000, parseFloat(r.s) * this._scale()])
        .filter(([t, w]) => Number.isFinite(t) && Number.isFinite(w));
    } catch (e) {
      console.warn('minimal-solar-card: history fetch failed', e);
    } finally {
      this._fetching = false;
      this._render();
    }
  }

  // Average watts in each of n equal buckets between t0 and t1 (step function).
  _buckets(t0, t1, n) {
    const s = this._series, out = new Array(n).fill(0), dt = (t1 - t0) / n;
    if (!s.length) return out;
    for (let i = 0; i < s.length; i++) {
      const a = Math.max(s[i][0], t0), b = Math.min(i + 1 < s.length ? s[i + 1][0] : t1, t1);
      if (b <= a) continue;
      for (let k = Math.floor((a - t0) / dt); k < n && t0 + k * dt < b; k++) {
        const lo = Math.max(a, t0 + k * dt), hi = Math.min(b, t0 + (k + 1) * dt);
        if (hi > lo) out[k] += (s[i][1] * (hi - lo)) / dt;
      }
    }
    return out;
  }

  _kwhSince(t0) {
    const s = this._series, now = Date.now();
    let wh = 0;
    for (let i = 0; i < s.length; i++) {
      const a = Math.max(s[i][0], t0), b = Math.min(i + 1 < s.length ? s[i + 1][0] : now, now);
      if (b > a) wh += (s[i][1] * (b - a)) / 3600e3;
    }
    return wh / 1000;
  }

  _build() {
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${BASE_CSS}
        ha-card { gap: 10px; padding-bottom: 12px; }
        .badge { background: rgba(255, 255, 255, 0.05); color: var(--minimal-solar-color); }
        .plot { position: relative; height: 60px; margin-left: 40px; cursor: crosshair; touch-action: pan-y; }
        svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
        .ylab { position: absolute; left: -40px; width: 32px; text-align: right; font-size: 11px;
          color: var(--disabled-text-color); white-space: nowrap; }
        .cursor { position: absolute; top: 0; bottom: 0; width: 1px; background: rgba(255, 255, 255, 0.24); display: none; }
        .dot { position: absolute; width: 10px; height: 10px; border-radius: 50%; background: var(--minimal-solar-color);
          box-shadow: 0 0 0 3px var(--ha-card-background, var(--card-background-color)),
            0 0 0 6px color-mix(in srgb, var(--minimal-solar-color) 24%, transparent);
          transform: translate(-50%, -50%); }
        .ticks { position: relative; height: 14px; margin-left: 40px; font-size: 11px;
          color: var(--disabled-text-color); font-variant-numeric: tabular-nums; }
        .ticks span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
        .ticks span.end { transform: translateX(-100%); }
      </style>
      <ha-card>
        <div class="head">
          <div class="badge"><ha-icon icon="mdi:solar-power-variant"></ha-icon></div>
          <div class="titles"><div class="name"></div><div class="sub"></div></div>
          <div class="value"><div class="big"></div><div class="small today"></div></div>
        </div>
        <div class="plot">
          <svg viewBox="0 0 500 100" preserveAspectRatio="none">
            <defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" style="stop-color: var(--minimal-solar-color); stop-opacity: 0.22"></stop>
              <stop offset="1" style="stop-color: var(--minimal-solar-color); stop-opacity: 0"></stop>
            </linearGradient></defs>
            <line x1="0" y1="8" x2="500" y2="8" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"></line>
            <line x1="0" y1="54" x2="500" y2="54" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"></line>
            <line x1="0" y1="100" x2="500" y2="100" stroke="rgba(255,255,255,0.1)" vector-effect="non-scaling-stroke"></line>
            <path class="area" fill="url(#fill)"></path>
            <path class="line" fill="none" style="stroke: var(--minimal-solar-color)" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"></path>
          </svg>
          <span class="ylab top" style="top: calc(8% - 7px)"></span>
          <span class="ylab mid" style="top: calc(54% - 7px)"></span>
          <div class="cursor"></div>
          <div class="dot"></div>
        </div>
        <div class="ticks"></div>
      </ha-card>`;
    const q = (s) => root.querySelector(s);
    this._el = {
      name: q('.name'), sub: q('.sub'), big: q('.big'), today: q('.today'), plot: q('.plot'),
      area: q('.area'), line: q('.line'), top: q('.ylab.top'), mid: q('.ylab.mid'),
      cursor: q('.cursor'), dot: q('.dot'), ticks: q('.ticks'),
    };
    q('.badge').addEventListener('click', () => moreInfo(this, this._config.entity));
    this._resize = new ResizeObserver(() => this._render());
    this._resize.observe(this._el.ticks);
    const scrub = (e) => {
      const r = this._el.plot.getBoundingClientRect();
      this._hover = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      this._render();
    };
    const end = () => { this._hover = null; this._render(); };
    this._el.plot.addEventListener('pointermove', scrub);
    this._el.plot.addEventListener('pointerdown', scrub);
    this._el.plot.addEventListener('pointerleave', end);
    this._el.plot.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') end(); });
    this._el.plot.addEventListener('pointercancel', end);
  }

  _fmtW(w) { return `${(Math.round(w / 10) * 10).toLocaleString('en-US')} W`; }
  _fmtKw(w) { const k = w / 1000; return `${Number.isInteger(k) ? k : k.toFixed(1)} kW`; }
  _fmtTime(ms, withMin = true) {
    const opts = withMin ? { hour: 'numeric', minute: '2-digit' } : { hour: 'numeric' };
    return new Date(ms).toLocaleTimeString('en-US', { ...opts, timeZone: this._tz() });
  }

  _render() {
    const hass = this._hass, el = this._el, c = this._config;
    if (!hass || !el) return;
    el.name.textContent = c.name || 'Solar';
    const raw = num(hass, c.entity), nowW = raw == null ? null : raw * this._scale();

    const graph = c.graph !== false;
    el.plot.style.display = el.ticks.style.display = graph ? '' : 'none';

    if (!this._series) {
      el.big.textContent = nowW != null ? this._fmtW(nowW) : '—';
      el.sub.textContent = 'Loading…';
      return;
    }

    const now = Date.now(), t0 = now - c.hours * 3600e3, n = 120;
    const pts = this._buckets(t0, now, n);
    if (nowW != null) pts[n - 1] = nowW; // end on the live reading
    const peak = Math.max(1000, ...pts);
    const yMax = Math.ceil(peak / 1000) * 1000;
    const X = (i) => (i / (n - 1)) * 500, Y = (w) => 100 - (w / yMax) * 92;
    const line = pts.map((w, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(w).toFixed(1)}`).join('');
    el.line.setAttribute('d', line);
    el.area.setAttribute('d', `${line}L500,100L0,100Z`);
    el.top.textContent = this._fmtKw(yMax);
    el.mid.textContent = this._fmtKw(yMax / 2);

    const idx = this._hover == null ? n - 1 : Math.round(this._hover * (n - 1));
    const w = pts[idx];
    el.dot.style.left = `${(idx / (n - 1)) * 100}%`;
    el.dot.style.top = `${Y(w)}%`;
    el.cursor.style.display = this._hover == null ? 'none' : '';
    el.cursor.style.left = el.dot.style.left;
    el.big.textContent = this._fmtW(w);
    el.sub.textContent = this._hover != null
      ? this._fmtTime(t0 + (idx / (n - 1)) * (now - t0))
      : (nowW ?? 0) > 0 ? 'Producing now' : 'Not producing';
    el.today.textContent = `${this._kwhSince(this._midnight()).toFixed(1)} kWh today`;

    // Whole-hour labels, spaced by the width actually available so they never overlap:
    // the smallest of 1, 2, 3, 4, 6 or 12 hours that leaves ~56px per label.
    const width = el.ticks.clientWidth || 300, pxPerHour = (width * 3600e3) / (now - t0);
    const step = [1, 2, 3, 4, 6, 12].find((h) => h * pxPerHour >= 56) ?? 12;
    const ticks = [];
    const mid = this._midnight();
    const firstTick = mid + Math.ceil((t0 - mid) / (3600e3 * step)) * 3600e3 * step;
    for (let t = firstTick; t < now; t += 3600e3 * step) {
      const x = ((t - t0) / (now - t0)) * width;
      // Keep half a label clear of the left edge and a full label clear of "Now".
      if (x > 20 && x < width - 56) ticks.push(`<span style="left:${(x / width * 100).toFixed(2)}%">${this._fmtTime(t, false)}</span>`);
    }
    ticks.push('<span class="end" style="left:100%">Now</span>');
    const html = ticks.join('');
    if (html !== this._ticksHtml) { el.ticks.innerHTML = html; this._ticksHtml = html; }
  }
}

console.info(`%c MINIMAL-ENERGY-CARDS %c ${VERSION} `, 'color:#18191a;background:#eaebec;font-weight:600', 'color:#eaebec;background:#2b2c2e');
customElements.get('minimal-ev-card') || customElements.define('minimal-ev-card', MinimalEvCard);
customElements.get('minimal-solar-card') || customElements.define('minimal-solar-card', MinimalSolarCard);
window.customCards = window.customCards || [];
window.customCards.push(
  { type: 'minimal-ev-card', name: 'Minimal EV card', description: 'Range, charge state and charge limit for an EV.' },
  { type: 'minimal-solar-card', name: 'Minimal solar card', description: 'Solar production now, today, and a graph.' },
);
