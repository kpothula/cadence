// Wind and weather along the route, timed to when you'll actually be there (Open-Meteo).
import { bearing } from './geo.js';

const API = 'https://api.open-meteo.com/v1/forecast';
const HOURLY = 'temperature_2m,precipitation_probability,wind_speed_10m,wind_direction_10m,wind_gusts_10m';

async function forecast(points) {
  const url = `${API}?latitude=${points.map(p => p.lat.toFixed(3)).join(',')}` +
    `&longitude=${points.map(p => p.lng.toFixed(3)).join(',')}` +
    `&hourly=${HOURLY}&wind_speed_unit=kmh&timeformat=unixtime&forecast_days=16&past_days=1`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('The weather service is unavailable right now.');
  const j = await r.json();
  return Array.isArray(j) ? j : [j];
}

function pickHour(fc, tSec) {
  const t = fc.hourly.time;
  let best = 0, bd = Infinity;
  for (let i = 0; i < t.length; i++) {
    const dd = Math.abs(t[i] - tSec);
    if (dd < bd) { bd = dd; best = i; }
  }
  if (bd > 2 * 3600) return null;
  const H = fc.hourly;
  return {
    ws: H.wind_speed_10m[best], wd: H.wind_direction_10m[best], gust: H.wind_gusts_10m[best],
    temp: H.temperature_2m[best], pp: H.precipitation_probability[best] ?? 0,
  };
}

export async function windAt(lat, lng, ms) {
  const [fc] = await forecast([{ lat, lng }]);
  const w = pickHour(fc, ms / 1000);
  if (!w) throw new Error('No forecast for that time (up to 16 days ahead).');
  return w;
}

export async function windForRoute(track, analysis, departMs) {
  const { pts, segs, total } = track;
  const n = Math.min(12, Math.max(2, Math.round(total / 10000) + 1));
  const samples = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const dk = total * k / (n - 1);
    while (j < pts.length - 1 && pts[j].d < dk) j++;
    samples.push({ d: pts[j].d, lat: pts[j].lat, lng: pts[j].lng, eta: departMs + analysis.cumTime[j] * 1000 });
  }
  const fcs = await forecast(samples);
  for (let k = 0; k < n; k++) {
    const w = pickHour(fcs[k], samples[k].eta / 1000);
    if (!w) throw new Error('Forecasts only reach 16 days ahead — pick an earlier departure.');
    Object.assign(samples[k], w);
  }

  let head = 0, tail = 0, cross = 0, comp = 0, h1 = 0, h2 = 0, base = 0, windy = 0;
  for (let i = 0; i < segs.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = b.d - a.d;
    if (len <= 0) continue;
    const mid = (a.d + b.d) / 2;
    const s = samples[Math.min(n - 1, Math.round(mid / total * (n - 1)))];
    // Wind direction is where it blows FROM; positive component = headwind.
    const c = s.ws * Math.cos((s.wd - bearing([a.lat, a.lng], [b.lat, b.lng])) * Math.PI / 180);
    if (c > 5) head += len; else if (c < -5) tail += len; else cross += len;
    comp += c * len;
    if (mid < total / 2) h1 += c * len; else h2 += c * len;
    const v = analysis.segSpeed[i];
    const vw = Math.max(4, Math.min(v * 1.35, v - 0.45 * c));
    base += len / 1000 / v * 3600;
    windy += len / 1000 / vw * 3600;
  }

  let vx = 0, vy = 0;
  for (const s of samples) { vx += Math.sin(s.wd * Math.PI / 180) * s.ws; vy += Math.cos(s.wd * Math.PI / 180) * s.ws; }
  const meanDir = (Math.atan2(vx, vy) * 180 / Math.PI + 360) % 360;
  const meanSpeed = samples.reduce((a, s) => a + s.ws, 0) / n;

  return {
    samples, meanDir, meanSpeed,
    head: head / total, tail: tail / total, cross: cross / total,
    avgComp: comp / total, firstHalf: h1 / (total / 2), secondHalf: h2 / (total / 2),
    deltaTime: windy - base,
    tempMin: Math.min(...samples.map(s => s.temp)), tempMax: Math.max(...samples.map(s => s.temp)),
    ppMax: Math.max(...samples.map(s => s.pp)), gustMax: Math.max(...samples.map(s => s.gust)),
  };
}
