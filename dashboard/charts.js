// Live time-series charts (uPlot). Follows the newest data in a sliding window; drag to zoom
// into history (the whole session stays in memory), double-click to follow live again.

/* global uPlot */

export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const fmtNum = (v, digits) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits).replace('-', '−'));

export class LiveChart {
  /**
   * @param {HTMLElement} el
   * @param {{series: {label: () => string, color: string, unit: string, digits: number}[],
   *          yMin: number, yMax: number, windowS: number, t: (key: string) => string}} opts
   */
  constructor(el, opts) {
    this.el = el;
    this.opts = opts;
    this.follow = true;
    this.tmax = 0;
    this.data = [[], ...opts.series.map(() => [])];
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    this.tip.hidden = true;
    this.build();
    new ResizeObserver(() => this.u && this.u.setSize(this.size())).observe(el);
  }

  size() {
    return { width: Math.max(this.el.clientWidth, 100), height: Math.max(this.el.clientHeight, 100) };
  }

  build() {
    if (this.u) this.u.destroy();
    const { series, yMin, yMax } = this.opts;
    const text3 = cssVar('--text-3');
    const grid = cssVar('--grid');
    const font = '12px "Segoe UI", system-ui, sans-serif';
    const opts = {
      ...this.size(),
      legend: { show: false },
      cursor: { drag: { x: true, y: false, setScale: true }, points: { size: 8 }, sync: { key: 'felinos' } },
      scales: {
        x: { time: false },
        y: { range: (u, min, max) => [Math.min(yMin, min ?? yMin), Math.max(yMax, max ?? yMax)] },
      },
      axes: [
        {
          stroke: text3, font, size: 28, space: 60,
          grid: { stroke: grid, width: 1, dash: [3, 4] }, ticks: { show: false },
          splits: (u, i, min, max) => this.timeSplits(min, max),
          values: (u, splits) => splits.map((v) => this.relLabel(v)),
        },
        {
          stroke: text3, font, size: 48, grid: { stroke: grid, width: 1 }, ticks: { show: false },
          values: (u, splits) => splits.map((v) => String(+v.toFixed(2)).replace('-', '−')),
        },
      ],
      series: [{}, ...series.map((s) => ({ stroke: cssVar(s.color), width: 2, points: { show: false } }))],
      hooks: {
        setSelect: [(u) => { if (u.select.width > 2) this.follow = false; }],
        setCursor: [(u) => this.showTip(u)],
        draw: [(u) => this.drawLastPoint(u)],
      },
    };
    this.u = new uPlot(opts, this.data, this.el);
    this.u.over.addEventListener('dblclick', () => { this.follow = true; this.redraw(); });
    this.u.over.addEventListener('mouseleave', () => { this.tip.hidden = true; });
    this.el.appendChild(this.tip);
  }

  /** Ticks anchored at the newest sample ("now") and stepping back in round seconds. */
  timeSplits(min, max) {
    const span = max - min;
    const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800].find((s) => span / s <= 7) ?? 3600;
    const out = [];
    for (let v = this.tmax; v >= min - 1e-9; v -= step) if (v <= max + 1e-9) out.unshift(v);
    return out;
  }

  /** Dot on the newest value of the first series, as in the design. */
  drawLastPoint(u) {
    const xs = this.data[0];
    const ys = this.data[1];
    let i = xs.length - 1;
    while (i >= 0 && (ys[i] === null || ys[i] === undefined)) i -= 1;
    if (i < 0 || xs[i] < u.scales.x.min || xs[i] > u.scales.x.max) return;
    const x = u.valToPos(xs[i], 'x', true);
    const y = u.valToPos(ys[i], 'y', true);
    const ctx = u.ctx;
    const r = 5.5 * devicePixelRatio;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fillStyle = cssVar(this.opts.series[0].color);
    ctx.strokeStyle = cssVar('--surface');
    ctx.lineWidth = 2.5 * devicePixelRatio;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  relLabel(v) {
    const rel = v - this.tmax;
    return Math.abs(rel) < 0.5 ? this.opts.t('now') : `${Math.round(rel)} s`;
  }

  /** @param {number[][]} data [t, ...series], t in seconds since session start. */
  setData(data, tmax) {
    this.data = data;
    this.tmax = tmax;
    this.redraw();
  }

  redraw() {
    const u = this.u;
    const keep = this.follow ? null : { min: u.scales.x.min, max: u.scales.x.max };
    u.setData(this.data, true);
    if (keep) u.setScale('x', keep);
    else u.setScale('x', { min: this.tmax - this.opts.windowS, max: Math.max(this.tmax, 1) });
  }

  showTip(u) {
    const i = u.cursor.idx;
    if (i === null || i === undefined || u.cursor.left < 0) { this.tip.hidden = true; return; }
    const rows = this.opts.series.map((s, k) => {
      const v = this.data[k + 1][i];
      return `<div><i style="background:var(${s.color})"></i>${s.label()} <b class="num">${fmtNum(v, s.digits)}</b> ${s.unit}</div>`;
    });
    this.tip.innerHTML = `<div class="num">${this.relLabel(this.data[0][i])}</div>${rows.join('')}`;
    this.tip.hidden = false;
    const left = u.cursor.left + u.bbox.left / devicePixelRatio;
    const flip = left > this.el.clientWidth - 170;
    this.tip.style.left = `${flip ? left - this.tip.offsetWidth - 12 : left + 12}px`;
    this.tip.style.top = `${Math.max(0, u.cursor.top - 10)}px`;
  }
}
