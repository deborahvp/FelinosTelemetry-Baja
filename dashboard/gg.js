// G-G diagram (SVG): lateral vs longitudinal acceleration over the last 60 s.
// Vehicle frame is ISO 8855 (lateral + = left), so left acceleration is drawn on the left.

const NS = 'http://www.w3.org/2000/svg';
const C = 170;
const R = 140;
const MAX_G = 1.0;
const MAX_POINTS = 300;

const el = (tag, attrs, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
};

export class GGDiagram {
  constructor(svg, t) {
    this.svg = svg;
    this.t = t;
    this.build();
  }

  build() {
    const s = this.svg;
    s.replaceChildren();
    const k = R / MAX_G;
    for (const g of [0.25, 0.5, 0.75, 1.0]) {
      el('circle', { cx: C, cy: C, r: g * k, fill: 'none', stroke: 'var(--grid)' }, s);
      if (g >= 0.5) {
        el('text', { x: C - 5, y: C - g * k - 4, 'text-anchor': 'end', 'font-size': 10.5, fill: 'var(--text-3)' }, s).textContent = `${g} g`;
      }
    }
    el('line', { x1: C - R, x2: C + R, y1: C, y2: C, stroke: 'var(--grid)' }, s);
    el('line', { x1: C, x2: C, y1: C - R, y2: C + R, stroke: 'var(--grid)' }, s);
    this.labels = [['accelerate', C + 60, 22, 'middle'], ['brake', C, 336, 'middle'], ['left_', 6, C - 6, 'start'], ['right_', 334, C - 6, 'end']]
      .map(([key, x, y, anchor]) => {
        const n = el('text', { x, y, 'text-anchor': anchor, 'font-size': 11, fill: 'var(--text-3)' }, s);
        n.dataset.key = key;
        n.textContent = this.t(key);
        return n;
      });
    this.dots = el('g', {}, s);
    this.pool = [];
    this.cur = el('circle', { r: 6, fill: 'var(--brand-red)', stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }, s);
  }

  relabel() {
    for (const n of this.labels) n.textContent = this.t(n.dataset.key);
  }

  /** @param {{along: number[], alat: number[]}} pts */
  update({ along, alat }) {
    const k = R / MAX_G;
    const n = along.length;
    const step = Math.max(1, Math.ceil(n / MAX_POINTS));
    const xy = (i) => {
      let x = -alat[i];
      let y = along[i];
      const m = Math.hypot(x, y);
      if (m > MAX_G * 1.05) { x *= (MAX_G * 1.05) / m; y *= (MAX_G * 1.05) / m; }
      return [C + x * k, C - y * k];
    };
    let used = 0;
    for (let i = 0; i < n; i += step) {
      let dot = this.pool[used];
      if (!dot) {
        dot = el('circle', { r: 2.6, fill: 'var(--series-1)' }, this.dots);
        this.pool.push(dot);
      }
      const [cx, cy] = xy(i);
      dot.setAttribute('cx', cx.toFixed(1));
      dot.setAttribute('cy', cy.toFixed(1));
      dot.setAttribute('fill-opacity', (0.25 + (0.75 * i) / n).toFixed(2));
      dot.setAttribute('visibility', 'visible');
      used += 1;
    }
    for (let j = used; j < this.pool.length; j += 1) this.pool[j].setAttribute('visibility', 'hidden');
    if (n) {
      const [cx, cy] = xy(n - 1);
      this.cur.setAttribute('cx', cx);
      this.cur.setAttribute('cy', cy);
      this.cur.setAttribute('visibility', 'visible');
    } else {
      this.cur.setAttribute('visibility', 'hidden');
    }
  }
}
