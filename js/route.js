// Routing, track assembly and route analysis.
import { haversine } from './geo.js';

export const PROFILES = {
  road:    { label: 'Road',        desc: 'Fast & paved',       brouter: 'fastbike',            speed: 27, kind: 'road' },
  quiet:   { label: 'Quiet roads', desc: 'Paved, low traffic', brouter: 'fastbike-lowtraffic', speed: 25, kind: 'road' },
  gravel:  { label: 'Gravel',      desc: 'Mixed surfaces',     brouter: 'gravel',              speed: 21, kind: 'gravel' },
  mtb:     { label: 'Mountain',    desc: 'Trails & tracks',    brouter: 'mtb',                 speed: 15, kind: 'mtb' },
  touring: { label: 'Touring',     desc: 'Bike paths first',   brouter: 'trekking',            speed: 19, kind: 'touring' },
  safe:    { label: 'Safest',      desc: 'Avoid traffic',      brouter: 'safety',              speed: 17, kind: 'touring' },
};

export const SURFACE = {
  paved:   { label: 'Paved',            color: '#344054' },
  cobbles: { label: 'Cobbles / setts',  color: '#c026d3' },
  gravel:  { label: 'Gravel / compact', color: '#e3a008' },
  dirt:    { label: 'Dirt / grass',     color: '#8a5a2b' },
  unknown: { label: 'Unknown',          color: '#a3aab8' },
};

export const WAYTYPE = {
  bikepath: { label: 'Bike path',       color: '#12a150' },
  bikelane: { label: 'Bike lane / street', color: '#86cb3c' },
  quiet:    { label: 'Quiet road',      color: '#2e90fa' },
  busy:     { label: 'Busy road',       color: '#f04438' },
  trail:    { label: 'Track / trail',   color: '#b54708' },
  other:    { label: 'Other / off-network', color: '#a3aab8' },
};

export const GRADE_BANDS = [
  { max: -3,       color: '#53b1fd', label: 'Down' },
  { max: 3,        color: '#32d583', label: '0–3%' },
  { max: 6,        color: '#fac515', label: '3–6%' },
  { max: 9,        color: '#fb6514', label: '6–9%' },
  { max: 12,       color: '#f04438', label: '9–12%' },
  { max: Infinity, color: '#912018', label: '12%+' },
];
export function gradeColor(g) {
  for (const b of GRADE_BANDS) if (g < b.max) return b.color;
  return GRADE_BANDS[GRADE_BANDS.length - 1].color;
}

// ---------- fetching legs ----------

const BROUTER = 'https://brouter.de/brouter';

// The public BRouter server throttles bursts: keep a few requests in flight and back off when told to.
const MAX_IN_FLIGHT = 3;
let inFlight = 0;
const waiting = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function brouterFetch(url) {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise(r => waiting.push(r));
  inFlight++;
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url);
      const text = await res.text();
      if (res.ok && text.trimStart()[0] === '{') return text;
      const busy = res.status === 429 || res.status === 503 || /retry later/i.test(text);
      if (!busy || attempt >= 4) throw new Error(busy ? 'The routing server is busy — try again in a moment.' : (text.trim().slice(0, 160) || `Routing failed (${res.status})`));
      await sleep(800 * 2 ** attempt + Math.random() * 400);
    }
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

export async function routeLeg(a, b, brouterProfile) {
  const ll = p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;
  const url = `${BROUTER}?lonlats=${ll(a)}|${ll(b)}&profile=${brouterProfile}&alternativeidx=0&format=geojson`;
  const text = await brouterFetch(url);
  const f = JSON.parse(text).features[0];
  const coords = f.geometry.coordinates.map(c => [c[1], c[0], c.length > 2 ? c[2] : null]);
  const tags = new Array(Math.max(0, coords.length - 1)).fill('');

  // Each message row describes the way leading up to its point; points are a subset of the geometry.
  const msgs = f.properties.messages || [];
  if (msgs.length > 1) {
    const h = msgs[0];
    const iLon = h.indexOf('Longitude'), iLat = h.indexOf('Latitude'), iTags = h.indexOf('WayTags');
    let mi = 1;
    for (let i = 1; i < coords.length; i++) {
      const m = msgs[Math.min(mi, msgs.length - 1)];
      tags[i - 1] = m[iTags] || '';
      if (mi < msgs.length - 1 &&
          Math.abs(coords[i][1] * 1e6 - +m[iLon]) < 2 &&
          Math.abs(coords[i][0] * 1e6 - +m[iLat]) < 2) mi++;
    }
  }
  return { coords, tags };
}

// ---------- custom profiles: avoid towns / avoid climbs ----------
// Stock BRouter profiles (bundled in /profiles) are patched as text and uploaded to BRouter.

// Avoid towns: multiply every way's cost by how built-up the area is (BRouter's
// estimated_town_class) and whether it's a residential street.
const CITY_MULT = `assign city_mult
  multiply switch estimated_town_class=6 2.6 switch estimated_town_class=5 2.2 switch estimated_town_class=4 1.9
           switch estimated_town_class=3 1.6 switch estimated_town_class=2 1.35 switch estimated_town_class=1 1.15 1
           switch highway=residential|living_street|service 1.6 1
`;
function patchTowns(src) {
  const m = src.match(/^([ \t]*)assign([ \t]+)costfactor\b([ \t]*=)?/m);
  if (!m) throw new Error('Profile has no costfactor');
  return src.slice(0, m.index) + CITY_MULT + m[1] + 'assign costfactor multiply city_mult' + src.slice(m.index + m[0].length);
}

// Avoid climbs: switch on each profile's own uphill penalty.
function patchClimbs(src) {
  return src
    .replace(/^(assign\s+uphillcost\s*=\s*)0\b/m, '$1120')                         // fastbike, trekking, safety
    .replace(/^(assign\s+consider_elevation\s+)false\b/m, '$1true')                 // gravel
    .replace(/^(assign\s+avoid_steep_inclines\s+)false\b/m, '$1true')               // gravel
    .replace(/^(\s*assign\s+hills\s+)0\b/m, '$11');                                 // mtb
}

export function patchProfile(src, { towns, climbs }) {
  if (climbs) src = patchClimbs(src);
  if (towns) src = patchTowns(src);
  return src;
}

const customProfiles = new Map();   // "base|towns|climbs" -> Promise<custom id>
const PROFILE_TTL = 6 * 3600 * 1000;
const STORE_KEY = 'cadence.customProfiles';
function customProfile(base, opts, force = false) {
  const key = `${base}|${opts.towns ? 1 : 0}|${opts.climbs ? 1 : 0}`;
  if (!force && customProfiles.has(key)) return customProfiles.get(key);
  const p = (async () => {
    if (!force) {
      try {
        const c = JSON.parse(localStorage.getItem(STORE_KEY) || '{}')[key];
        if (c && Date.now() - c.t < PROFILE_TTL) return c.id;
      } catch { /* storage unavailable */ }
    }
    const src = await (await fetch(`profiles/${base}.brf`)).text();
    const res = await fetch(`${BROUTER}/profile`, { method: 'POST', body: patchProfile(src, opts) });
    const j = await res.json();
    if (!j.profileid || j.error) throw new Error(j.error || 'Could not set up the custom routing profile');
    try {
      const all = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      all[key] = { id: j.profileid, t: Date.now() };
      localStorage.setItem(STORE_KEY, JSON.stringify(all));
    } catch { /* storage unavailable */ }
    return j.profileid;
  })();
  p.catch(() => customProfiles.delete(key));
  customProfiles.set(key, p);
  return p;
}

// Routes with the stock profile, or with an uploaded custom variant (re-uploading if it expired).
export async function routeLegWith(a, b, base, opts = {}) {
  if (!opts.towns && !opts.climbs) return routeLeg(a, b, base);
  try {
    return await routeLeg(a, b, await customProfile(base, opts));
  } catch (err) {
    if (!/profile|custom|not found|file/i.test(err.message)) throw err;
    return routeLeg(a, b, await customProfile(base, opts, true));
  }
}

export async function straightLeg(a, b) {
  const d = haversine([a.lat, a.lng], [b.lat, b.lng]);
  const n = Math.max(1, Math.min(400, Math.ceil(d / 100)));
  const coords = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    coords.push([a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t, null]);
  }
  await fillElevation(coords).catch(() => {});
  return { coords, tags: new Array(n).fill(''), straight: true };
}

export function fixedLeg(coords) {
  return { coords, tags: new Array(Math.max(0, coords.length - 1)).fill('') };
}

// Fills missing elevations from Open-Meteo, sampling at most `max` points and interpolating between them.
export async function fillElevation(coords, max = 300) {
  const missing = coords.some(c => c[2] == null || Number.isNaN(c[2]));
  if (!missing || !coords.length) return;
  const stride = Math.max(1, Math.ceil(coords.length / max));
  const idx = [];
  for (let i = 0; i < coords.length; i += stride) idx.push(i);
  if (idx[idx.length - 1] !== coords.length - 1) idx.push(coords.length - 1);
  const elev = [];
  for (let s = 0; s < idx.length; s += 100) {
    const chunk = idx.slice(s, s + 100);
    const url = 'https://api.open-meteo.com/v1/elevation?latitude=' +
      chunk.map(i => coords[i][0].toFixed(5)).join(',') + '&longitude=' + chunk.map(i => coords[i][1].toFixed(5)).join(',');
    const r = await fetch(url);
    if (!r.ok) throw new Error('Elevation lookup failed');
    elev.push(...(await r.json()).elevation);
  }
  for (let k = 0; k < idx.length - 1; k++) {
    const i0 = idx[k], i1 = idx[k + 1];
    for (let i = i0; i <= i1; i++) {
      const t = i1 === i0 ? 0 : (i - i0) / (i1 - i0);
      coords[i][2] = elev[k] + (elev[k + 1] - elev[k]) * t;
    }
  }
  if (idx.length === 1) coords[0][2] = elev[0];
}

// ---------- tag classification ----------

const PAVED = new Set(['asphalt', 'paved', 'concrete', 'concrete:plates', 'concrete:lanes', 'paving_stones', 'chipseal', 'metal', 'wood']);
const COBBLES = new Set(['sett', 'cobblestone', 'unhewn_cobblestone', 'cobblestone:flattened', 'bricks']);
const GRAVEL = new Set(['gravel', 'fine_gravel', 'compacted', 'pebblestone', 'unpaved', 'rock']);
const DIRT = new Set(['dirt', 'ground', 'earth', 'grass', 'sand', 'mud', 'woodchips', 'soil', 'grass_paver']);
const MAIN = new Set(['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'trunk', 'trunk_link']);
const QUIET = new Set(['residential', 'living_street', 'service', 'unclassified', 'road', 'pedestrian']);
const TRAIL = new Set(['track', 'path', 'footway', 'bridleway', 'steps']);
const NO_LANE = new Set(['no', 'none', 'separate', 'shared_lane']);

const memo = new Map();
export function classify(tagStr) {
  let c = memo.get(tagStr);
  if (c) return c;
  const t = {};
  for (const kv of tagStr.split(' ')) {
    const i = kv.indexOf('=');
    if (i > 0) t[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const hw = t.highway || '';
  let surface = 'unknown';
  const s = t.surface;
  if (s) surface = PAVED.has(s) ? 'paved' : COBBLES.has(s) ? 'cobbles' : GRAVEL.has(s) ? 'gravel' : DIRT.has(s) ? 'dirt' : 'unknown';
  else if (MAIN.has(hw) || QUIET.has(hw) || hw === 'cycleway') surface = 'paved';
  else if (hw === 'track') surface = t.tracktype === 'grade1' ? 'paved' : (t.tracktype === 'grade2' || t.tracktype === 'grade3') ? 'gravel' : t.tracktype ? 'dirt' : 'unknown';

  const lane = ['cycleway', 'cycleway:right', 'cycleway:left', 'cycleway:both'].some(k => t[k] && !NO_LANE.has(t[k]));
  let way = 'other';
  if (hw === 'cycleway' || ((hw === 'path' || hw === 'footway' || hw === 'bridleway') && t.bicycle === 'designated')) way = 'bikepath';
  else if (MAIN.has(hw)) way = lane ? 'bikelane' : 'busy';
  else if (QUIET.has(hw)) way = (lane || t.cyclestreet === 'yes' || t.bicycle_road === 'yes') ? 'bikelane' : 'quiet';
  else if (TRAIL.has(hw)) way = 'trail';

  const network = /route_bicycle_(icn|ncn|rcn|lcn)=yes/.test(tagStr);
  c = { surface, way, network };
  memo.set(tagStr, c);
  return c;
}

// ---------- track ----------

// Joins per-leg results into a single track of points with cumulative distance, plus per-segment attributes.
export function buildTrack(legs) {
  const pts = [], segs = [], legRanges = [];
  for (const leg of legs) {
    const startIdx = Math.max(0, pts.length - 1);
    leg.coords.forEach((c, k) => {
      const p = { lat: c[0], lng: c[1], ele: c[2] == null || Number.isNaN(c[2]) ? null : c[2], d: 0 };
      if (pts.length) {
        const last = pts[pts.length - 1];
        if (k === 0 && haversine([last.lat, last.lng], c) < 2) return;
        const cls = k > 0 ? classify(leg.tags[k - 1] || '') : classify('');
        segs.push({ ...cls, straight: !!leg.straight || k === 0 });
      }
      pts.push(p);
    });
    legRanges.push([startIdx, pts.length - 1]);
  }
  for (let i = 1; i < pts.length; i++) pts[i].d = pts[i - 1].d + haversine([pts[i - 1].lat, pts[i - 1].lng], [pts[i].lat, pts[i].lng]);

  // Interpolate missing elevations along distance.
  let prev = -1;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].ele == null) continue;
    if (prev === -1) for (let j = 0; j < i; j++) pts[j].ele = pts[i].ele;
    else for (let j = prev + 1; j < i; j++) {
      const t = (pts[j].d - pts[prev].d) / ((pts[i].d - pts[prev].d) || 1);
      pts[j].ele = pts[prev].ele + (pts[i].ele - pts[prev].ele) * t;
    }
    prev = i;
  }
  if (prev === -1) pts.forEach(p => { p.ele = 0; });
  else for (let j = prev + 1; j < pts.length; j++) pts[j].ele = pts[prev].ele;

  return { pts, segs, legRanges, total: pts.length ? pts[pts.length - 1].d : 0 };
}

// ---------- analysis ----------

const SURFACE_FACTOR = {
  road:    { paved: 1, cobbles: .8,  gravel: .7,  dirt: .55, unknown: .95 },
  gravel:  { paved: 1, cobbles: .88, gravel: .92, dirt: .8,  unknown: .95 },
  mtb:     { paved: 1, cobbles: .95, gravel: 1,   dirt: .95, unknown: 1 },
  touring: { paved: 1, cobbles: .85, gravel: .85, dirt: .7,  unknown: .95 },
};

function gradeSpeed(v0, g) {
  if (g >= 0) return Math.max(5, v0 / (1 + g * 0.12));
  return Math.min(v0 * (1 - g * 0.06), v0 * 1.6, 55);
}

export function analyze(track, profileId, v0) {
  const { pts, segs, total } = track;
  const step = Math.max(10, total / 2000);
  const d = [], raw = [];
  let j = 0;
  for (let x = 0; ; x += step) {
    const dd = Math.min(x, total);
    while (j < pts.length - 2 && pts[j + 1].d < dd) j++;
    const a = pts[j], b = pts[Math.min(j + 1, pts.length - 1)];
    const t = b.d > a.d ? Math.min(1, Math.max(0, (dd - a.d) / (b.d - a.d))) : 0;
    d.push(dd);
    raw.push(a.ele + (b.ele - a.ele) * t);
    if (dd >= total) break;
  }
  const n = d.length;
  const w = Math.max(1, Math.round(40 / step));
  const e = raw.map((_, k) => {
    let s = 0, c = 0;
    for (let q = Math.max(0, k - w); q <= Math.min(n - 1, k + w); q++) { s += raw[q]; c++; }
    return s / c;
  });

  const h = Math.max(1, Math.round(50 / step));
  const g = e.map((_, k) => {
    const k0 = Math.max(0, k - h), k1 = Math.min(n - 1, k + h);
    return d[k1] > d[k0] ? (e[k1] - e[k0]) / (d[k1] - d[k0]) * 100 : 0;
  });

  let ascent = 0, descent = 0, ref = e[0];
  for (const v of e) {
    const diff = v - ref;
    if (diff >= 3) { ascent += diff; ref = v; } else if (diff <= -3) { descent -= diff; ref = v; }
  }
  let maxGrade = 0;
  for (let k = 0; k < n; k++) if (g[k] > maxGrade && d[k] > 0) maxGrade = g[k];

  const gradeAt = dist => g[Math.min(n - 1, Math.max(0, Math.round(dist / step)))];

  const sf = SURFACE_FACTOR[PROFILES[profileId].kind];
  const segSpeed = new Float32Array(segs.length);
  const cumTime = new Float64Array(pts.length);
  const surfaceDist = {}, wayDist = {};
  let networkDist = 0;
  for (const k in SURFACE) surfaceDist[k] = 0;
  for (const k in WAYTYPE) wayDist[k] = 0;
  for (let i = 0; i < segs.length; i++) {
    const len = pts[i + 1].d - pts[i].d;
    const s = segs[i];
    const v = gradeSpeed(v0, gradeAt((pts[i].d + pts[i + 1].d) / 2)) * (sf[s.surface] ?? 1);
    segSpeed[i] = v;
    cumTime[i + 1] = cumTime[i] + len / 1000 / v * 3600;
    surfaceDist[s.surface] += len;
    wayDist[s.way] += len;
    if (s.network) networkDist += len;
  }


  return {
    total, ascent, descent, maxGrade, time: cumTime[pts.length - 1],
    prof: { d, e, g }, step, gradeAt, segSpeed, cumTime,
    surfaceDist, wayDist, networkDist,
    minEle: Math.min(...e), maxEle: Math.max(...e),
    climbs: findClimbs(d, e),
  };
}

// ---------- terrain difficulty ----------
// How hard the terrain is, independent of distance: climbing per km, steepest grade,
// rough surfaces (for the bike you're on) and how much is on busy roads.
export const LEVELS = [
  { id: 'easy',        label: 'Easy',        cpk: [0, 5],   grade: 6,  rough: 0.1,  busy: 0.1,  desc: 'Flat-ish, smooth and quiet. Up to ~5 m of climbing per km, nothing steeper than 6%.' },
  { id: 'moderate',    label: 'Moderate',    cpk: [5, 10],  grade: 10, rough: 0.25, busy: 0.25, desc: 'Rolling. 5–10 m of climbing per km, short ramps up to ~10%.' },
  { id: 'challenging', label: 'Challenging', cpk: [10, 16], grade: 14, rough: 0.5,  busy: 0.5,  desc: 'Hilly. 10–16 m of climbing per km, climbs up to ~14%.' },
  { id: 'hard',        label: 'Hard',        cpk: [16, 99], grade: 99, rough: 1,    busy: 1,    desc: 'Mountainous. 16+ m of climbing per km and steep walls — as hilly as the area allows.' },
];

export function terrainOf(a, profileId) {
  const kind = PROFILES[profileId].kind;
  const km = Math.max(0.1, a.total / 1000);
  const cpk = a.ascent / km;
  const share = k => (a.surfaceDist[k] || 0) / a.total;
  const rough = kind === 'mtb' ? 0 : kind === 'gravel' ? share('dirt') : share('gravel') + share('dirt') + share('cobbles') * 0.5;
  const busy = (a.wayDist.busy || 0) / a.total;
  let level = LEVELS.findIndex(l => cpk < l.cpk[1]);
  if (level < 0) level = LEVELS.length - 1;
  const reasons = [`${cpk.toFixed(1)} m climbing per km`];
  // Steep ramps can raise the level all the way; rough surfaces up to Challenging; traffic only stops a ride being Easy.
  for (let i = 0; i < LEVELS.length - 1; i++) {
    if (a.maxGrade > LEVELS[i].grade && level <= i) { level = i + 1; reasons.push(`ramps up to ${a.maxGrade.toFixed(0)}%`); }
    if (i < 2 && rough > LEVELS[i].rough && level <= i) { level = i + 1; reasons.push(`${Math.round(rough * 100)}% rough surface`); }
    if (i < 1 && busy > LEVELS[i].busy && level <= i) { level = i + 1; reasons.push(`${Math.round(busy * 100)}% on busy roads`); }
  }
  return { level, ...LEVELS[level], cpk, rough, busy, reasons: [...new Set(reasons)] };
}

// Lower is a better match for the wanted level (index into LEVELS).
export function terrainScore(t, a, want, targetDist) {
  const L = LEVELS[want];
  const outside = t.cpk < L.cpk[0] ? L.cpk[0] - t.cpk : t.cpk > L.cpk[1] ? t.cpk - L.cpk[1] : 0;
  return outside * 2
    + Math.max(0, a.maxGrade - L.grade)
    + Math.max(0, t.rough - L.rough) * 30
    + Math.max(0, t.busy - L.busy) * 20
    + Math.abs(a.total - targetDist) / targetDist * 40
    + Math.max(0, Math.abs(a.total - targetDist) / targetDist - 0.12) * 200;   // well off the distance: only as a last resort
}

// Strava-style climb detection on the smoothed profile.
function findClimbs(d, e) {
  const out = [];
  const push = (lo, hi) => {
    const gain = e[hi] - e[lo], len = d[hi] - d[lo];
    if (gain < 20 || len < 250) return;
    const avg = gain / len * 100;
    if (avg < 3) return;
    const score = len * avg;
    const cat = score >= 80000 ? 'HC' : score >= 64000 ? 'Cat 1' : score >= 32000 ? 'Cat 2' : score >= 16000 ? 'Cat 3' : score >= 8000 ? 'Cat 4' : 'Climb';
    let maxG = 0;
    for (let k = lo + 1; k <= hi; k++) {
      const k0 = Math.max(lo, k - 3);
      const gg = d[k] > d[k0] ? (e[k] - e[k0]) / (d[k] - d[k0]) * 100 : 0;
      if (gg > maxG) maxG = gg;
    }
    out.push({ start: d[lo], end: d[hi], gain, len, avg, maxG, cat, score, top: e[hi] });
  };
  let lo = 0, hi = 0;
  for (let k = 1; k < e.length; k++) {
    if (e[k] >= e[hi]) hi = k;
    else if (e[k] < e[lo]) { push(lo, hi); lo = hi = k; }
    else if (e[hi] - e[k] > Math.max(10, (e[hi] - e[lo]) * 0.25)) { push(lo, hi); lo = hi = k; }
  }
  push(lo, hi);
  return out;
}
