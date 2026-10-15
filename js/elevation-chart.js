// Canvas elevation profile, filled by gradient, with hover sync.
import { gradeColor } from './route.js';

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

export class ElevationChart {
  constructor(root, { onHover, onClick } = {}) {
    this.root = root;
    this.canvas = root.querySelector('canvas');
    this.tip = root.querySelector('.elev-tip');
    this.ctx = this.canvas.getContext('2d');
    this.onHover = onHover;
    this.onClick = onClick;
    this.prof = null;
    this.marks = [];
    this.hoverD = null;
    this.range = null;
    this.geom = { l: 0, w: 1 };

    new ResizeObserver(() => this.draw()).observe(this.canvas);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.draw());

    const pick = clientX => {
      if (!this.prof || !this.total) return null;
      const r = this.canvas.getBoundingClientRect();
      const t = (clientX - r.left - this.geom.l) / this.geom.w;
      return t < 0 || t > 1 ? null : t * this.total;
    };
    const hover = d => { this.setHover(d); this.onHover?.(d); };
    this.canvas.addEventListener('mousemove', ev => hover(pick(ev.clientX)));
    this.canvas.addEventListener('mouseleave', () => hover(null));
    this.canvas.addEventListener('click', ev => { const d = pick(ev.clientX); if (d != null) this.onClick?.(d); });
    this.canvas.addEventListener('touchstart', ev => hover(pick(ev.touches[0].clientX)), { passive: true });
    this.canvas.addEventListener('touchmove', ev => hover(pick(ev.touches[0].clientX)), { passive: true });
    this.canvas.addEventListener('touchend', () => setTimeout(() => hover(null), 1200));
  }

  setData(prof, marks = []) {
    this.prof = prof;
    this.marks = marks;
    this.total = prof ? prof.d[prof.d.length - 1] : 0;
    this.range = null;
    this.draw();
  }
  setHover(d) { this.hoverD = d; this.draw(); }
  setRange(r) { this.range = r; this.draw(); }

  draw() {
    const c = this.canvas, ctx = this.ctx, dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.documentElement);
    const col = n => css.getPropertyValue(n).trim();
    const font = '11px Inter, system-ui, sans-serif';

    if (!this.prof || !this.total) {
      ctx.fillStyle = col('--muted');
      ctx.font = '13px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Your elevation profile appears here once the route has two points', W / 2, H / 2);
      this.tip.hidden = true;
      return;
    }

    const pad = { l: 48, r: 14, t: 26, b: 22 };
    const w = W - pad.l - pad.r, h = H - pad.t - pad.b;
    this.geom = { l: pad.l, w };
    const { d, e, g } = this.prof;
    // Fit the vertical scale to this route's own lowest and highest points.
    let lo = Infinity, hi = -Infinity, kLo = 0, kHi = 0;
    e.forEach((v, k) => { if (v < lo) { lo = v; kLo = k; } if (v > hi) { hi = v; kHi = k; } });
    const span = Math.max(hi - lo, 4);
    const yMin = (hi + lo) / 2 - span / 2 - span * 0.06;
    const yMax = (hi + lo) / 2 + span / 2 + span * 0.12;
    const ys = niceStep(span / 3);
    const X = v => pad.l + v / this.total * w;
    const Y = v => pad.t + h - (v - yMin) / (yMax - yMin) * h;

    // grid + y labels (nice values that fall inside the fitted range)
    ctx.font = font;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = Math.ceil(yMin / ys) * ys; v <= yMax; v += ys) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = col('--grid');
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
      ctx.fillStyle = col('--muted');
      ctx.fillText(`${Math.round(v)} m`, pad.l - 6, y);
    }
    // x labels
    const km = this.total / 1000;
    const xs = niceStep(km / Math.max(2, Math.floor(w / 90)));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let v = 0; v <= km + 1e-6; v += xs) {
      const x = X(v * 1000);
      ctx.fillText(`${+v.toFixed(1)} km`, Math.min(Math.max(x, pad.l + 14), W - pad.r - 14), H - pad.b + 6);
    }

    // highlighted range (e.g. a climb)
    if (this.range) {
      ctx.fillStyle = col('--brand-soft');
      ctx.fillRect(X(this.range[0]), pad.t - 10, X(this.range[1]) - X(this.range[0]), h + 10);
    }

    // gradient fill, grouped into runs of the same colour
    const base = Y(yMin);
    ctx.globalAlpha = 0.9;
    let k0 = 0;
    for (let k = 1; k < d.length; k++) {
      const cA = gradeColor(g[k0]);
      if (k === d.length - 1 || gradeColor(g[k]) !== cA) {
        ctx.beginPath();
        ctx.moveTo(X(d[k0]), base);
        for (let q = k0; q <= k; q++) ctx.lineTo(X(d[q]), Y(e[q]));
        ctx.lineTo(X(d[k]), base);
        ctx.closePath();
        ctx.fillStyle = cA;
        ctx.fill();
        k0 = k;
      }
    }
    ctx.globalAlpha = 1;
    ctx.beginPath();
    for (let k = 0; k < d.length; k++) k ? ctx.lineTo(X(d[k]), Y(e[k])) : ctx.moveTo(X(d[k]), Y(e[k]));
    ctx.strokeStyle = col('--text');
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // highest and lowest points
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    for (const [k, label, up] of [[kHi, `▲ ${Math.round(hi)} m`, true], [kLo, `▼ ${Math.round(lo)} m`, false]]) {
      const x = X(d[k]), y = Y(e[k]);
      ctx.fillStyle = col('--text');
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      ctx.textAlign = x < pad.l + 40 ? 'left' : x > W - pad.r - 40 ? 'right' : 'center';
      ctx.textBaseline = up ? 'bottom' : 'top';
      ctx.fillText(label, x, up ? y - 5 : Math.min(y + 5, base - 13));
    }
    ctx.font = font;

    // waypoint ticks
    for (const m of this.marks) {
      const x = X(m.d);
      ctx.fillStyle = m.kind === 'start' ? '#12a150' : col('--text');
      ctx.beginPath(); ctx.arc(x, base, m.kind === 'via' ? 3 : 4, 0, Math.PI * 2); ctx.fill();
    }

    // hover
    if (this.hoverD != null) {
      const k = Math.min(d.length - 1, Math.max(0, Math.round(this.hoverD / this.total * (d.length - 1))));
      const x = X(d[k]), y = Y(e[k]);
      ctx.strokeStyle = col('--text');
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x + .5, pad.t - 6); ctx.lineTo(x + .5, base); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col('--brand');
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      this.tip.hidden = false;
      this.tip.textContent = `${(d[k] / 1000).toFixed(1)} km · ${Math.round(e[k])} m · ${g[k] >= 0 ? '+' : ''}${g[k].toFixed(1)}%`;
      const tw = this.tip.offsetWidth;
      this.tip.style.left = `${Math.min(Math.max(x, tw / 2 + 4), W - tw / 2 - 4)}px`;
    } else {
      this.tip.hidden = true;
    }
  }
}
