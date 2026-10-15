import {
  PROFILES, SURFACE, WAYTYPE, GRADE_BANDS, gradeColor,
  routeLegWith, straightLeg, fixedLeg, fillElevation, buildTrack, analyze,
} from './route.js';
import { ElevationChart } from './elevation-chart.js';
import { toGPX, parseGPX } from './gpx.js';
import { windForRoute, windAt } from './weather.js';
import { haversine, destination, pathLength, compass } from './geo.js';

// ---------- utilities ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
const fmtKm = m => (m / 1000).toFixed(m < 10000 ? 2 : 1);
const fmtTime = s => { const m = Math.round(s / 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
const fmtDur = s => { const m = Math.round(Math.abs(s) / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };

let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- state ----------
const DEFAULT_SPEEDS = Object.fromEntries(Object.entries(PROFILES).map(([k, p]) => [k, p.speed]));
const state = {
  waypoints: [],          // { id, lat, lng, mode: 'route'|'line'|'fixed', fixed: [[lat,lng,ele]]|null, name }
  profile: 'road',
  snap: true,
  avoidTowns: false,
  colorBy: 'gradient',
  speeds: { ...DEFAULT_SPEEDS },
  name: '',
  routeId: null,
};
let track = null, analysis = null, wind = null, lastLegs = [];
const past = [], future = [];

const saved = store.get('cadence.current', null);
if (saved) Object.assign(state, saved, { speeds: { ...DEFAULT_SPEEDS, ...(saved.speeds || {}) } });
if (!PROFILES[state.profile]) state.profile = 'road';

// ---------- map ----------
const map = L.map('map', { zoomControl: false, doubleClickZoom: false }).setView(store.get('cadence.view', [52.3676, 4.9041, 13]).slice(0, 2), store.get('cadence.view', [0, 0, 13])[2]);
const osm = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const BASES = {
  'Cycle map': L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', { maxZoom: 20, attribution: `<a href="https://www.cyclosm.org">CyclOSM</a> · ${osm}` }),
  'Streets': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: osm }),
  'Topographic': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: `${osm} · SRTM · <a href="https://opentopomap.org">OpenTopoMap</a>` }),
  'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery © Esri' }),
  'Dark': L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 20, subdomains: 'abcd', attribution: `${osm} · © CARTO` }),
};
(BASES[store.get('cadence.base', 'Cycle map')] || BASES['Cycle map']).addTo(map);
L.control.layers(BASES, null, { position: 'topright' }).addTo(map);
L.control.zoom({ position: 'topright' }).addTo(map);
L.control.scale({ position: 'bottomright', imperial: false }).addTo(map);
map.on('baselayerchange', e => store.set('cadence.base', e.name));
map.on('moveend', () => { const c = map.getCenter(); store.set('cadence.view', [+c.lat.toFixed(5), +c.lng.toFixed(5), map.getZoom()]); });

map.createPane('casing').style.zIndex = 410;
map.createPane('line').style.zIndex = 420;
map.createPane('hit').style.zIndex = 430;
map.createPane('hover').style.zIndex = 590;

const routeLayer = L.layerGroup().addTo(map);
const pendingLayer = L.layerGroup().addTo(map);
const markerLayer = L.layerGroup().addTo(map);
const windLayer = L.layerGroup().addTo(map);
const shortcutLayer = L.layerGroup().addTo(map);
const hoverMarker = L.marker([0, 0], { pane: 'hover', interactive: false, icon: L.divIcon({ className: '', html: '<div class="hover-dot"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }) });
const climbLayer = L.layerGroup().addTo(map);

// ---------- elevation chart ----------
const chart = new ElevationChart($('#elevation'), {
  onHover: d => showHoverAt(d, false),
  onClick: d => { const p = pointAt(d); if (p) map.panTo(p); },
});

// ---------- history ----------
const snapshot = () => JSON.stringify(state.waypoints);
function commit(mutate) {
  past.push(snapshot());
  if (past.length > 100) past.shift();
  future.length = 0;
  mutate();
  changed();
}
function undo() {
  if (!past.length) return;
  future.push(snapshot());
  state.waypoints = JSON.parse(past.pop());
  changed();
}
function redo() {
  if (!future.length) return;
  past.push(snapshot());
  state.waypoints = JSON.parse(future.pop());
  changed();
}
function changed() {
  lastLegs = [];
  renderMarkers();
  renderWaypointList();
  updateToolbar();
  updateHint();
  persist();
  recompute();
}
function persist() {
  const { waypoints, profile, snap, avoidTowns, colorBy, speeds, name, routeId } = state;
  if (!store.set('cadence.current', { waypoints, profile, snap, avoidTowns, colorBy, speeds, name, routeId })) {
    store.set('cadence.current', { waypoints: waypoints.map(w => ({ ...w, fixed: null, mode: w.mode === 'fixed' ? 'route' : w.mode })), profile, snap, colorBy, speeds, name, routeId });
  }
}

const newWp = (lat, lng, name = null, mode = state.snap ? 'route' : 'line') => ({ id: uid(), lat, lng, mode, fixed: null, name });

// ---------- routing ----------
const legCache = new Map();   // key -> Promise
const resolved = new Set();
let routeSeq = 0;

const legKey = (a, b) => b.mode === 'fixed' ? `fixed|${b.id}` :
  [b.mode, b.mode === 'route' ? PROFILES[state.profile].brouter + (state.avoidTowns ? '+towns' : '') : '', a.lat.toFixed(6), a.lng.toFixed(6), b.lat.toFixed(6), b.lng.toFixed(6)].join('|');

function getLeg(a, b) {
  if (b.mode === 'fixed' && b.fixed) return Promise.resolve(fixedLeg(b.fixed));
  const key = legKey(a, b);
  if (!legCache.has(key)) {
    const p = (b.mode === 'line' ? straightLeg(a, b) : routeLegWith(a, b, PROFILES[state.profile].brouter, state.avoidTowns))
      .then(v => { resolved.add(key); return v; })
      .catch(err => { legCache.delete(key); throw err; });
    legCache.set(key, p);
  }
  return legCache.get(key);
}

async function recompute() {
  const seq = ++routeSeq;
  const wps = state.waypoints;
  pendingLayer.clearLayers();
  if (wps.length < 2) {
    track = analysis = null;
    setLoading(false);
    renderRoute();
    return;
  }
  // Dashed placeholders for legs we don't have yet.
  let pending = 0;
  for (let i = 1; i < wps.length; i++) {
    const b = wps[i];
    if (b.mode === 'fixed' || resolved.has(legKey(wps[i - 1], b))) continue;
    pending++;
    L.polyline([[wps[i - 1].lat, wps[i - 1].lng], [b.lat, b.lng]], { pane: 'line', color: '#e0157a', weight: 3, dashArray: '6 8', opacity: 0.6, interactive: false }).addTo(pendingLayer);
  }
  if (pending) setLoading(true);

  const failed = [];
  const results = await Promise.all(wps.slice(1).map((b, i) =>
    getLeg(wps[i], b).catch(() => { failed.push(i); return straightLeg(wps[i], b); })));
  if (seq !== routeSeq) return;
  setLoading(false);
  pendingLayer.clearLayers();
  if (failed.length) toast(failed.length === 1 ? 'No route found for one section — drew a straight line instead.' : `No route found for ${failed.length} sections — drew straight lines instead.`, 4500);

  lastLegs = results;
  track = buildTrack(results);
  analysis = track.total > 1 ? analyze(track, state.profile, state.speeds[state.profile]) : null;
  if (!analysis) track = null;
  renderRoute();
}

function setLoading(on) { $('#loading').hidden = !on; }

function reanalyze() {
  if (!track) return;
  analysis = analyze(track, state.profile, state.speeds[state.profile]);
  renderStats();
  renderBail();
  if (wind) { wind = null; renderWind(); }
}

// ---------- map rendering ----------
function segColor(i) {
  const s = track.segs[i];
  if (state.colorBy === 'surface') return SURFACE[s.surface].color;
  if (state.colorBy === 'way') return WAYTYPE[s.way].color;
  if (state.colorBy === 'gradient') return gradeColor(analysis.gradeAt((track.pts[i].d + track.pts[i + 1].d) / 2));
  return '#e0157a';
}

function drawRoute() {
  routeLayer.clearLayers();
  climbLayer.clearLayers();
  if (!track) return;
  const ll = track.pts.map(p => [p.lat, p.lng]);
  L.polyline(ll, { pane: 'casing', color: '#ffffff', weight: 9, opacity: 0.95, interactive: false, lineJoin: 'round' }).addTo(routeLayer);
  L.polyline(ll, { pane: 'casing', color: '#1d1530', weight: 11, opacity: 0.18, interactive: false, lineJoin: 'round' }).addTo(routeLayer);
  let start = 0, c = segColor(0), st = track.segs[0]?.straight;
  for (let i = 1; i <= track.segs.length; i++) {
    const ci = i < track.segs.length ? segColor(i) : null;
    const si = i < track.segs.length ? track.segs[i].straight : null;
    if (ci !== c || si !== st) {
      L.polyline(ll.slice(start, i + 1), { pane: 'line', color: c, weight: 5, opacity: 1, interactive: false, lineJoin: 'round', dashArray: st ? '2 9' : null, lineCap: 'round' }).addTo(routeLayer);
      start = i; c = ci; st = si;
    }
  }
  track.legRanges.forEach(([s, e], legIdx) => {
    const hit = L.polyline(ll.slice(s, e + 1), { pane: 'hit', color: '#000', opacity: 0.001, weight: 22, className: 'route-hit' });
    hit.on('mousedown', ev => startInsertDrag(ev, legIdx));
    hit.on('mousemove', ev => showHoverAtLatLng(ev.latlng));
    hit.on('mouseout', () => showHoverAt(null, false));
    hit.on('click', ev => L.DomEvent.stopPropagation(ev));
    hit.addTo(routeLayer);
  });
}

const houseSvg = '<svg viewBox="0 0 24 24"><path d="M12 3 2 12h3v9h5v-6h4v6h5v-9h3z"/></svg>';
function renderMarkers() {
  markerLayer.clearLayers();
  const wps = state.waypoints;
  const flag = '<svg viewBox="0 0 24 24"><path d="M5 21V4h11l-1.5 4L16 12H7v9z"/></svg>';
  const finish = '<svg viewBox="0 0 24 24"><path d="M4 4h4v4H4zM12 4h4v4h-4zM8 8h4v4H8zM16 8h4v4h-4zM4 12h4v4H4zM12 12h4v4h-4zM4 16h2v5H4z"/></svg>';
  wps.forEach((wp, i) => {
    const kind = i === 0 ? 'start' : i === wps.length - 1 ? 'end' : nearStart(wp) ? 'home' : 'via';
    const size = kind === 'via' || kind === 'home' ? 22 : 26;
    const html = `<div class="wp wp-${kind}">${kind === 'start' ? flag : kind === 'end' ? finish : kind === 'home' ? houseSvg : i}</div>`;
    const m = L.marker([wp.lat, wp.lng], {
      draggable: true, autoPan: true, keyboard: false, zIndexOffset: kind === 'via' ? 0 : kind === 'home' ? -100 : 100,
      icon: L.divIcon({ className: '', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
    });
    let preview = null;
    m.on('dragstart', () => { map.closePopup(); preview = L.polyline([], { pane: 'line', color: '#e0157a', weight: 3, dashArray: '6 8', interactive: false }).addTo(map); });
    m.on('drag', () => {
      const p = m.getLatLng();
      const pts = [];
      if (wps[i - 1]) pts.push([wps[i - 1].lat, wps[i - 1].lng]);
      pts.push([p.lat, p.lng]);
      if (wps[i + 1]) pts.push([wps[i + 1].lat, wps[i + 1].lng]);
      preview.setLatLngs(pts);
    });
    m.on('dragend', () => {
      preview?.remove();
      const p = m.getLatLng();
      commit(() => {
        wp.lat = p.lat; wp.lng = p.lng; wp.name = null;
        if (wp.mode === 'fixed') { wp.mode = 'route'; wp.fixed = null; }
        const next = wps[i + 1];
        if (next?.mode === 'fixed') { next.mode = 'route'; next.fixed = null; }
      });
      lookupName(wp.id);
    });
    m.on('click', () => openWpPopup(m, i));
    m.on('contextmenu', ev => { L.DomEvent.preventDefault(ev.originalEvent); removeWaypoint(i); });
    m.addTo(markerLayer);
  });
}

function openWpPopup(marker, i) {
  const wp = state.waypoints[i];
  const el = document.createElement('div');
  el.className = 'pop';
  const label = i === 0 ? 'Start' : i === state.waypoints.length - 1 ? 'Finish' : `Waypoint ${i}`;
  const dist = track && track.legRanges[i - 1] ? track.pts[track.legRanges[i - 1][1]].d : 0;
  el.innerHTML = `
    <h4>${esc(wp.name || label)}</h4>
    <div class="muted">${esc(label)}${i > 0 && track ? ` · ${fmtKm(dist)} km from start` : ''}</div>
    ${i > 0 ? `<div class="muted" style="margin-bottom:4px">Section leading here</div>
    <div class="seg"><button data-m="route" class="${wp.mode !== 'line' ? 'active' : ''}">${wp.mode === 'fixed' ? 'Imported' : 'Follow roads'}</button><button data-m="line" class="${wp.mode === 'line' ? 'active' : ''}">Straight line</button></div>` : ''}
    <button class="btn danger">Remove point</button>`;
  el.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', () => {
    const mode = b.dataset.m;
    if (mode === 'route' && wp.mode === 'fixed') return;
    if (wp.mode === mode) return;
    map.closePopup();
    commit(() => { wp.mode = mode; wp.fixed = null; });
  }));
  el.querySelector('.btn.danger').addEventListener('click', () => { map.closePopup(); removeWaypoint(i); });
  marker.bindPopup(el, { offset: [0, -8], autoPanPadding: [40, 40] }).openPopup();
  marker.once('popupclose', () => marker.unbindPopup());
}

function removeWaypoint(i) {
  commit(() => {
    const wps = state.waypoints;
    const next = wps[i + 1];
    if (next && i > 0) {
      if (next.mode === 'fixed' && wps[i].mode === 'fixed') next.fixed = [...wps[i].fixed, ...next.fixed.slice(1)];
      else if (next.mode === 'fixed') { next.mode = 'route'; next.fixed = null; }
    }
    wps.splice(i, 1);
  });
}

// Drag the route line to insert a via point.
function startInsertDrag(ev, legIdx) {
  if (ev.originalEvent.button !== 0) return;
  L.DomEvent.stop(ev);
  map.dragging.disable();
  const ghost = L.marker(ev.latlng, { interactive: false, icon: L.divIcon({ className: '', html: '<div class="wp-ghost"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }) }).addTo(map);
  const a = state.waypoints[legIdx], b = state.waypoints[legIdx + 1];
  const preview = L.polyline([], { pane: 'line', color: '#e0157a', weight: 3, dashArray: '6 8', interactive: false }).addTo(map);
  let moved = false;
  const move = e => {
    const p = map.mouseEventToLatLng(e);
    moved = true;
    ghost.setLatLng(p);
    preview.setLatLngs([[a.lat, a.lng], p, [b.lat, b.lng]]);
  };
  const up = e => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    map.dragging.enable();
    ghost.remove();
    preview.remove();
    if (!moved) return;
    const p = map.mouseEventToLatLng(e);
    const wp = newWp(p.lat, p.lng, null, b.mode === 'line' ? 'line' : 'route');
    commit(() => {
      const nb = state.waypoints[legIdx + 1];
      if (nb.mode === 'fixed') { nb.mode = 'route'; nb.fixed = null; }
      state.waypoints.splice(legIdx + 1, 0, wp);
    });
    lookupName(wp.id);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

// ---------- hover sync ----------
function pointAt(d) {
  if (!track) return null;
  const pts = track.pts;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].d < d) lo = m; else hi = m; }
  const a = pts[lo], b = pts[hi];
  const t = b.d > a.d ? Math.min(1, Math.max(0, (d - a.d) / (b.d - a.d))) : 0;
  return L.latLng(a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t);
}
function showHoverAt(d, fromMap) {
  if (d == null || !track) {
    hoverMarker.remove();
    if (!fromMap) chart.setHover(null);
    return;
  }
  hoverMarker.setLatLng(pointAt(d)).addTo(map);
  if (fromMap) chart.setHover(d);
}
function showHoverAtLatLng(ll) {
  if (!track) return;
  const cos = Math.cos(ll.lat * Math.PI / 180);
  let best = 0, bd = Infinity;
  const pts = track.pts;
  for (let i = 0; i < pts.length; i++) {
    const dx = (pts[i].lng - ll.lng) * cos, dy = pts[i].lat - ll.lat;
    const dd = dx * dx + dy * dy;
    if (dd < bd) { bd = dd; best = i; }
  }
  showHoverAt(pts[best].d, true);
}

// ---------- sidebar rendering ----------
function renderRoute() {
  shortcutLayer.clearLayers();
  drawRoute();
  renderStats();
  renderBreakdown();
  renderClimbs();
  renderBail();
  renderWaypointList();
  renderLegend();
  if (wind) { wind = null; windLayer.clearLayers(); }
  renderWind();
  const marks = track ? state.waypoints.map((w, i) => ({
    d: i === 0 ? 0 : track.pts[track.legRanges[i - 1][1]].d,
    kind: i === 0 || nearStart(w) ? 'start' : i === state.waypoints.length - 1 ? 'end' : 'via',
  })) : [];
  chart.setData(analysis ? analysis.prof : null, marks);
  updateToolbar();
}

function renderStats() {
  const a = analysis;
  $('#s-dist').textContent = a ? fmtKm(a.total) : '0';
  $('#s-asc').textContent = a ? Math.round(a.ascent).toLocaleString() : '0';
  $('#s-desc').textContent = a ? Math.round(a.descent).toLocaleString() : '0';
  $('#s-time').textContent = a ? fmtTime(a.time) : '0:00';
  $('#s-max').textContent = a ? a.maxGrade.toFixed(1) : '0';
  const diff = $('#s-diff');
  diff.className = 'badge' + (a ? ` d${a.difficulty[0]}` : '');
  diff.textContent = a ? a.difficulty[1] : '—';
  $('#elev-stats').innerHTML = a ? [
    ['Gain', `↑ ${Math.round(a.ascent)} m`], ['Loss', `↓ ${Math.round(a.descent)} m`],
    ['High', `${Math.round(a.maxEle)} m`], ['Low', `${Math.round(a.minEle)} m`],
    ['Range', `${Math.round(a.maxEle - a.minEle)} m`], ['Steepest', `${a.maxGrade.toFixed(1)}%`],
    ['Climbing per km', `${(a.ascent / (a.total / 1000)).toFixed(1)} m`],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('') : '';
  const v = state.speeds[state.profile];
  $('#pace').value = v;
  $('#pace-out').textContent = `${v} km/h`;
}

function renderBar(barEl, legEl, dist, defs, total) {
  const entries = Object.entries(dist).filter(([, v]) => v / total > 0.003).sort((x, y) => y[1] - x[1]);
  barEl.innerHTML = entries.map(([k, v]) => `<span style="width:${v / total * 100}%;background:${defs[k].color}" title="${esc(defs[k].label)}"></span>`).join('');
  legEl.innerHTML = entries.map(([k, v]) => `<li><span class="dot" style="background:${defs[k].color}"></span><span class="lbl">${esc(defs[k].label)}</span><span class="num">${fmtKm(v)} km · ${Math.round(v / total * 100)}%</span></li>`).join('');
}

function renderBreakdown() {
  const card = $('#card-breakdown');
  if (!analysis) {
    card.classList.add('disabled');
    $('#bar-surface').innerHTML = $('#bar-way').innerHTML = '';
    $('#leg-surface').innerHTML = $('#leg-way').innerHTML = '<li class="muted">Plan a route to see the breakdown</li>';
    $('#leg-way').innerHTML = '';
    $('#network-share').textContent = '';
    return;
  }
  card.classList.remove('disabled');
  renderBar($('#bar-surface'), $('#leg-surface'), analysis.surfaceDist, SURFACE, analysis.total);
  renderBar($('#bar-way'), $('#leg-way'), analysis.wayDist, WAYTYPE, analysis.total);
  const net = analysis.networkDist / analysis.total;
  $('#network-share').textContent = net > 0.01 ? `${Math.round(net * 100)}% on signed bike routes` : '';
}

const CAT_COLORS = { HC: '#3b0764', 'Cat 1': '#912018', 'Cat 2': '#d92d20', 'Cat 3': '#fb6514', 'Cat 4': '#eaaa08', Climb: '#86cb3c' };
function renderClimbs() {
  const ul = $('#climbs');
  const climbs = analysis ? [...analysis.climbs] : [];
  $('#climb-count').textContent = climbs.length ? `${climbs.length} climb${climbs.length > 1 ? 's' : ''}` : '';
  if (!analysis) { ul.innerHTML = '<li class="empty">Plan a route to find its climbs</li>'; return; }
  if (!climbs.length) { ul.innerHTML = '<li class="empty">No significant climbs — enjoy the flat.</li>'; return; }
  ul.innerHTML = climbs.map((c, k) => `
    <li data-k="${k}">
      <span class="cat" style="background:${CAT_COLORS[c.cat]}">${c.cat}</span>
      <span><b>${fmtKm(c.len)} km</b> at ${c.avg.toFixed(1)}% <span class="cmeta">· max ${c.maxG.toFixed(0)}%</span></span>
      <span class="cmeta">+${Math.round(c.gain)} m · km ${(c.start / 1000).toFixed(1)}</span>
    </li>`).join('');
  $$('li[data-k]', ul).forEach(li => {
    const c = climbs[+li.dataset.k];
    li.addEventListener('mouseenter', () => { chart.setRange([c.start, c.end]); highlightClimb(c); });
    li.addEventListener('mouseleave', () => { chart.setRange(null); climbLayer.clearLayers(); });
    li.addEventListener('click', () => {
      const pts = track.pts.filter(p => p.d >= c.start && p.d <= c.end).map(p => [p.lat, p.lng]);
      if (pts.length > 1) map.fitBounds(pts, { padding: [60, 60] });
    });
  });
}
function highlightClimb(c) {
  climbLayer.clearLayers();
  const pts = track.pts.filter(p => p.d >= c.start && p.d <= c.end).map(p => [p.lat, p.lng]);
  L.polyline(pts, { pane: 'casing', color: '#fde047', weight: 16, opacity: 0.6, interactive: false }).addTo(climbLayer);
}

function renderWaypointList() {
  const ol = $('#wps');
  const wps = state.waypoints;
  $('#wp-count').textContent = wps.length ? `${wps.length} point${wps.length > 1 ? 's' : ''}` : '';
  const spurs = track ? findSpurs(wps, lastLegs) : [];
  $('#spur-tip').hidden = !spurs.length;
  if (spurs.length) $('#spur-tip span').textContent = `${spurs.length === 1 ? 'One point sends' : `${spurs.length} points send`} you down a dead end and back (${fmtKm(spurs.reduce((a, sp) => a + 2 * sp.len, 0))} km extra).`;
  if (!wps.length) { ol.innerHTML = '<li class="empty">No points yet.</li>'; return; }
  ol.innerHTML = wps.map((w, i) => {
    const kind = i === 0 ? 'start' : i === wps.length - 1 ? 'end' : nearStart(w) ? 'home' : 'via';
    const d = i === 0 ? 0 : track?.legRanges[i - 1] ? track.pts[track.legRanges[i - 1][1]].d : null;
    const label = kind === 'home' ? 'Back at start — you can stop here' : w.name || (kind === 'start' ? 'Start' : kind === 'end' ? 'Finish' : `Waypoint ${i}`);
    const tag = i > 0 && w.mode === 'line' ? '<span class="tag">straight</span>' : i > 0 && w.mode === 'fixed' ? '<span class="tag">imported</span>' : '';
    return `<li><span class="n ${kind === 'home' ? 'start' : kind}">${kind === 'start' ? 'S' : kind === 'end' ? 'F' : kind === 'home' ? '⌂' : i}</span>
      <span class="nm" data-i="${i}" title="${esc(label)}">${esc(label)}${tag}</span>
      <span class="km">${d != null ? `${fmtKm(d)} km` : ''}</span>
      <button class="rm" data-i="${i}" title="Remove"><svg class="ic"><use href="#i-x"/></svg></button></li>`;
  }).join('');
  $$('.nm', ol).forEach(el => el.addEventListener('click', () => { const w = wps[+el.dataset.i]; map.setView([w.lat, w.lng], Math.max(map.getZoom(), 15)); }));
  $$('.rm', ol).forEach(el => el.addEventListener('click', () => removeWaypoint(+el.dataset.i)));
}

function renderLegend() {
  const ul = $('#map-legend');
  let defs = null;
  if (state.colorBy === 'surface') defs = SURFACE;
  else if (state.colorBy === 'way') defs = WAYTYPE;
  if (!defs || !analysis) { ul.innerHTML = ''; }
  else {
    const dist = state.colorBy === 'surface' ? analysis.surfaceDist : analysis.wayDist;
    ul.innerHTML = Object.entries(defs).filter(([k]) => dist[k] > 0).map(([, d]) => `<li><span class="dot" style="background:${d.color}"></span>${esc(d.label)}</li>`).join('');
  }
  $$('#color-by button').forEach(b => b.classList.toggle('active', b.dataset.c === state.colorBy));
}

function updateToolbar() {
  const n = state.waypoints.length;
  $('#btn-undo').disabled = !past.length;
  $('#btn-redo').disabled = !future.length;
  $('#btn-reverse').disabled = n < 2;
  $('#btn-outback').disabled = n < 2;
  $('#btn-home').disabled = n < 2 || isLoop();
  $('#btn-clear').disabled = !n;
  $('#btn-gpx').disabled = !track;
  $('#btn-share').disabled = n < 2;
  $('#btn-save').disabled = n < 2;
  $('#btn-wind').disabled = !track;
}
const isLoop = () => {
  const w = state.waypoints;
  return w.length > 2 && haversine([w[0].lat, w[0].lng], [w[w.length - 1].lat, w[w.length - 1].lng]) < 50;
};

function updateHint() {
  const n = state.waypoints.length;
  $('#hint').textContent = n === 0 ? 'Click the map to set your start — or try the Loop generator'
    : n === 1 ? 'Click again to add your destination' : '';
}

// ---------- tools ----------
const cloneWp = (w, from) => ({ ...newWp(w.lat, w.lng, w.name), mode: from.mode, fixed: from.fixed ? [...from.fixed].reverse() : null });

function reverseRoute() {
  commit(() => {
    const old = state.waypoints, n = old.length;
    state.waypoints = old.map((_, j) => {
      const w = old[n - 1 - j];
      return j === 0 ? { ...w, mode: state.snap ? 'route' : 'line', fixed: null } : cloneWp(w, old[n - j]);
    });
  });
}
function outAndBack() {
  commit(() => {
    const old = state.waypoints, n = old.length;
    for (let j = n - 2; j >= 0; j--) state.waypoints.push(cloneWp(old[j], old[j + 1]));
  });
}
function backToStart() {
  const s = state.waypoints[0];
  commit(() => state.waypoints.push(newWp(s.lat, s.lng, s.name)));
}
function clearRoute() {
  commit(() => { state.waypoints = []; state.name = ''; state.routeId = null; });
  $('#route-name').value = '';
}

// ---------- reverse geocoding ----------
const nameQueue = [];
let nameBusy = false;
function lookupName(id) {
  nameQueue.push(id);
  if (!nameBusy) drainNames();
}
async function drainNames() {
  nameBusy = true;
  while (nameQueue.length) {
    const id = nameQueue.shift();
    const wp = state.waypoints.find(w => w.id === id);
    if (!wp || wp.name) continue;
    try {
      const r = await fetch(`https://photon.komoot.io/reverse?lat=${wp.lat.toFixed(5)}&lon=${wp.lng.toFixed(5)}&limit=1`);
      const p = (await r.json()).features?.[0]?.properties;
      if (p) {
        const place = p.city || p.town || p.village || p.district || p.county;
        const main = p.street || p.name;
        const label = [main, place].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
        const cur = state.waypoints.find(w => w.id === id);
        if (cur && !cur.name && label && cur.lat === wp.lat && cur.lng === wp.lng) {
          cur.name = label;
          renderWaypointList();
          persist();
        }
      }
    } catch { /* names are a nicety */ }
    await new Promise(r => setTimeout(r, 250));
  }
  nameBusy = false;
}

// ---------- search ----------
const searchInput = $('#search');
const resultsEl = $('#search-results');
let searchTimer, searchResults = [], searchActive = -1, searchSeq = 0;

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) { closeResults(); return; }
  const m = q.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180) {
    showResults([{ name: `${(+m[1]).toFixed(5)}, ${(+m[2]).toFixed(5)}`, sub: 'Coordinates', lat: +m[1], lng: +m[2] }]);
    return;
  }
  searchTimer = setTimeout(() => runSearch(q), 280);
});
searchInput.addEventListener('keydown', e => {
  if (resultsEl.hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    searchActive = (searchActive + (e.key === 'ArrowDown' ? 1 : -1) + searchResults.length) % searchResults.length;
    $$('li', resultsEl).forEach((li, i) => li.classList.toggle('active', i === searchActive));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    pickResult(searchResults[Math.max(0, searchActive)], true);
  } else if (e.key === 'Escape') closeResults();
});
document.addEventListener('click', e => { if (!e.target.closest('.search')) closeResults(); });

async function runSearch(q) {
  const seq = ++searchSeq;
  const c = map.getCenter();
  try {
    const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}`);
    const j = await r.json();
    if (seq !== searchSeq) return;
    showResults(j.features.map(f => {
      const p = f.properties;
      const name = p.name || [p.street, p.housenumber].filter(Boolean).join(' ') || p.city || 'Unnamed place';
      const sub = [p.street && p.name ? p.street : null, p.city || p.town || p.village, p.state, p.country].filter(Boolean).filter(v => v !== name).join(', ');
      return { name, sub, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], extent: p.extent };
    }));
  } catch {
    if (seq === searchSeq) showResults([]);
  }
}
function showResults(list) {
  searchResults = list;
  searchActive = -1;
  resultsEl.hidden = false;
  $('.search').setAttribute('aria-expanded', 'true');
  if (!list.length) { resultsEl.innerHTML = '<li class="sr-empty">No places found</li>'; return; }
  const verb = state.waypoints.length ? 'Add as next stop' : 'Set as start';
  resultsEl.innerHTML = list.map((r, i) => `
    <li role="option" data-i="${i}" title="${verb}">
      <div class="sr-main"><div class="sr-name">${esc(r.name)}</div><div class="sr-sub">${esc(r.sub)}</div></div>
      <button class="sr-go" data-i="${i}" title="Just show on map">View</button>
    </li>`).join('');
  $$('li[data-i]', resultsEl).forEach(li => li.addEventListener('click', e => {
    const r = list[+li.dataset.i];
    pickResult(r, !e.target.closest('.sr-go'));
  }));
}
function closeResults() { resultsEl.hidden = true; $('.search').setAttribute('aria-expanded', 'false'); }
function pickResult(r, add) {
  if (!r) return;
  closeResults();
  searchInput.value = '';
  if (r.extent && !add) map.fitBounds([[r.extent[1], r.extent[0]], [r.extent[3], r.extent[2]]]);
  else map.setView([r.lat, r.lng], Math.max(map.getZoom(), 14));
  if (add) commit(() => state.waypoints.push(newWp(r.lat, r.lng, r.name)));
}

// ---------- wind ----------
function defaultDeparture() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
}
$('#depart').value = defaultDeparture();

async function checkWind() {
  if (!track) return;
  const btn = $('#btn-wind');
  const t = new Date($('#depart').value).getTime();
  if (!Number.isFinite(t)) { toast('Pick a departure time first.'); return; }
  btn.classList.add('busy');
  try {
    wind = await windForRoute(track, analysis, t);
    renderWind();
  } catch (err) {
    toast(err.message || 'Could not load the forecast.');
  } finally {
    btn.classList.remove('busy');
  }
}

function arrowSvg(deg) {
  // Arrow points where the wind is blowing TO.
  return `<svg viewBox="0 0 24 24" style="transform:rotate(${deg + 180}deg)"><path d="M12 2l6 16-6-4-6 4z"/></svg>`;
}

function renderWind() {
  const out = $('#wind-out');
  windLayer.clearLayers();
  if (!wind) { out.innerHTML = track ? '' : '<p class="muted small" style="margin:10px 0 0">Plan a route to see the wind you\'ll actually ride into, hour by hour.</p>'; return; }
  const w = wind;
  const pct = v => Math.round(v * 100);
  let tip;
  const loop = isLoop() || haversine([track.pts[0].lat, track.pts[0].lng], [track.pts.at(-1).lat, track.pts.at(-1).lng]) < 2000;
  if (!loop && (w.avgComp > 3 || w.head - w.tail > 0.25)) tip = ['bad', `Mostly headwind (${pct(w.head)}% of the ride). Riding the other way gives you the tailwind.`, true];
  else if (loop && w.secondHalf - w.firstHalf > 4) tip = ['bad', 'Headwind on the way home. Reverse to face it while you\'re fresh.', true];
  else if (w.meanSpeed < 8) tip = ['good', 'Barely any wind — direction doesn\'t matter much.', false];
  else tip = ['good', loop ? 'Good direction: the wind is behind you on the way home.' : 'Good direction for the wind.', false];

  out.innerHTML = `
    <div class="wind-head">
      <div class="wind-arrow">${arrowSvg(w.meanDir)}</div>
      <div><b>${Math.round(w.meanSpeed)} km/h from ${compass(w.meanDir)}</b><div class="muted">gusts up to ${Math.round(w.gustMax)} km/h</div></div>
    </div>
    <div class="wind-bar">
      ${w.head > 0.02 ? `<span style="width:${pct(w.head)}%;background:#f04438">${pct(w.head) >= 12 ? `Head ${pct(w.head)}%` : ''}</span>` : ''}
      ${w.cross > 0.02 ? `<span style="width:${pct(w.cross)}%;background:#98a2b3">${pct(w.cross) >= 12 ? `Cross ${pct(w.cross)}%` : ''}</span>` : ''}
      ${w.tail > 0.02 ? `<span style="width:${pct(w.tail)}%;background:#12a150">${pct(w.tail) >= 12 ? `Tail ${pct(w.tail)}%` : ''}</span>` : ''}
    </div>
    <div class="wind-meta">
      <span>Wind effect <b>${Math.abs(w.deltaTime) < 60 ? '±0 min' : `${w.deltaTime > 0 ? '+' : '−'}${fmtDur(w.deltaTime)}`}</b></span>
      <span>Temp <b>${Math.round(w.tempMin)}${Math.round(w.tempMax) !== Math.round(w.tempMin) ? `–${Math.round(w.tempMax)}` : ''}°C</b></span>
      <span>Rain chance <b>${Math.round(w.ppMax)}%</b></span>
    </div>
    <div class="tip ${tip[0]}"><span>${tip[1]}</span>${tip[2] ? '<button class="btn" id="btn-wind-rev">Reverse</button>' : ''}</div>`;
  $('#btn-wind-rev')?.addEventListener('click', () => { reverseRoute(); toast('Route reversed — check the forecast again once it updates.'); });

  for (const s of w.samples) {
    L.marker([s.lat, s.lng], {
      interactive: false, pane: 'hover',
      icon: L.divIcon({ className: '', html: `<div class="wind-pin"><div class="a">${arrowSvg(s.wd)}</div><span>${Math.round(s.ws)}</span></div>`, iconSize: [30, 38], iconAnchor: [15, 11] }),
    }).addTo(windLayer);
  }
}

// ---------- loop generator ----------
let loopDir = 'any', loopShape = 'petals', loopPetals = 'auto';
const autoPetals = km => km <= 25 ? 2 : km <= 60 ? 3 : km <= 120 ? 4 : 5;

// Each shape returns the via points in riding order; HOME marks a pass through the start.
const HOME = 'home';
const SHAPES = {
  // One big loop with the start on its edge.
  classic: { k: 2 * Math.PI * 1.25, build(start, heading, r, jit, sign) {
    const center = destination(start, heading, r);
    return [0, 1, 2].map(k => destination(center, (heading + 180 + sign * 90 * (k + 1) + jit[k].a + 360) % 360, r * jit[k].r));
  } },
  // Several petals that each start and finish at home.
  petals: { k: null, build(start, heading, r, jit, sign, n) {
    const spread = Math.min(70, 360 / n * 0.55);
    const out = [];
    for (let p = 0; p < n; p++) {
      const h = heading + sign * p * 360 / n + jit[p].a * 0.5;
      out.push(destination(start, h - spread / 2, r * 0.75 * jit[p].r));
      out.push(destination(start, h, r * jit[(p + 3) % 8].r));
      out.push(destination(start, h + spread / 2, r * 0.75 * jit[(p + 5) % 8].r));
      if (p < n - 1) out.push(HOME);
    }
    return out;
  } },
  // A spoke out, a ring around home, a spoke back.
  // Half a ring: out, a semicircle around home, and back. Shorter spokes, fewer junctions.
  arc: { k: (2 + Math.PI) * 1.25, build(start, heading, r, jit, sign) {
    return [-90, -45, 0, 45, 90].map((o, k) => destination(start, heading + sign * o, r * (0.9 + jit[k].r * 0.12)));
  } },
  orbit: { k: (2 + 2 * Math.PI * 5 / 6) * 1.25, build(start, heading, r, jit, sign) {
    return [0, 1, 2, 3, 4, 5].map(k => destination(start, heading + sign * 60 * k, r * (0.9 + jit[k].r * 0.12)));
  } },
};

async function generateLoop() {
  const btn = $('#btn-loop');
  const km = +$('#loop-km').value;
  const target = km * 1000;
  const startWp = state.waypoints[0];
  const start = startWp ? [startWp.lat, startWp.lng] : [map.getCenter().lat, map.getCenter().lng];
  const shape = SHAPES[loopShape];
  const n = loopPetals === 'auto' ? autoPetals(km) : +loopPetals;
  btn.classList.add('busy');
  $('#loop-status').textContent = 'Exploring roads…';
  try {
    let heading;
    if (loopDir === 'any') heading = Math.random() * 360;
    else if (loopDir === 'wind') {
      const t = new Date($('#depart').value).getTime() || Date.now();
      const w = await windAt(start[0], start[1], t);
      heading = w.wd;   // ride towards where the wind comes from
      $('#loop-status').textContent = `Wind ${Math.round(w.ws)} km/h from ${compass(w.wd)} — heading out into it…`;
    } else heading = +loopDir + (Math.random() - 0.5) * 30;

    let best = null, lastErr = null;
    // If part of the shape lands somewhere unroutable (water, no roads), rotate and try again.
    for (let attempt = 0; attempt < 4 && !best; attempt++) {
      const h = heading + attempt * 47 * (attempt % 2 ? 1 : -1);
      const sign = Math.random() < 0.5 ? 1 : -1;
      const jit = Array.from({ length: 8 }, () => ({ a: (Math.random() - 0.5) * 30, r: 0.85 + Math.random() * 0.3 }));
      let r = target / (shape.k || n * 2.4 * 1.25);
      try {
        for (let iter = 0; iter < 5; iter++) {
          const home = () => newWp(start[0], start[1], startWp?.name || null, 'route');
          const wps = [home(), ...shape.build(start, h, r, jit, sign, n).map(p => p === HOME ? home() : newWp(p[0], p[1], null, 'route')), home()];
          const legs = await trimSpurs(wps, await Promise.all(wps.slice(1).map((b, k) => getLeg(wps[k], b))));
          const dist = legs.reduce((sum, l) => sum + pathLength(l.coords), 0);
          if (!best || Math.abs(dist - target) < Math.abs(best.dist - target)) best = { wps, dist };
          if (Math.abs(dist - target) / target < 0.07) break;
          $('#loop-status').textContent = `Tuning the loop… (${fmtKm(dist)} km so far)`;
          r *= Math.min(1.8, Math.max(0.55, target / dist));
        }
      } catch (err) {
        lastErr = err;
        $('#loop-status').textContent = 'Hit water or a dead end — trying another angle…';
      }
    }
    if (!best) throw lastErr || new Error('No loop found');
    const label = loopShape === 'petals' ? `${km} km cloverleaf` : loopShape === 'orbit' ? `${km} km orbit` : loopShape === 'arc' ? `${km} km half orbit` : `${km} km loop`;
    commit(() => { state.waypoints = best.wps; state.name = label; state.routeId = null; });
    $('#route-name').value = state.name;
    best.wps.forEach((w, i) => { if (i > 0 && !nearStart(w)) lookupName(w.id); });
    if (!startWp) lookupName(best.wps[0].id);
    map.fitBounds(best.wps.map(w => [w.lat, w.lng]), { padding: [60, 60] });
    const tail = loopShape === 'classic' ? '' : ' See “Cut it short” on the Plan tab for where you can head home.';
    $('#loop-status').textContent = `Got ${fmtKm(best.dist)} km.${tail} Generate again for a different one, or drag the line to tweak it.`;
    btn.lastChild.textContent = 'Generate another';
  } catch (err) {
    $('#loop-status').textContent = 'Couldn\'t build a loop here — try another distance or direction.';
    toast(err.message?.slice(0, 120) || 'Loop generation failed');
  } finally {
    btn.classList.remove('busy');
  }
}

// ---------- dead-end detours ----------
// A via point down a dead end makes the route ride in and straight back out the same way.
// Detect where the legs either side of a point overlap, and the junction where the detour starts.
function findSpurs(wps, legs) {
  const out = [];
  const s0 = [wps[0].lat, wps[0].lng];
  for (let i = 1; i < wps.length - 1; i++) {
    const w = wps[i], next = wps[i + 1];
    if (w.mode !== 'route' || next.mode !== 'route' || !legs[i - 1] || !legs[i]) continue;
    if (haversine(s0, [w.lat, w.lng]) < 60) continue;   // passes through home are deliberate
    const a = legs[i - 1].coords, b = legs[i].coords;
    let k = 0;
    while (k < a.length - 1 && k < b.length - 1 && haversine(a[a.length - 1 - k], b[k]) < 12) k++;
    if (k < 2) continue;
    const len = pathLength(b.slice(0, k));
    // Skip deliberate turnarounds (out & back), where the overlap is most of the leg.
    if (len < 60 || len > 3000 || len > 0.5 * Math.min(pathLength(a), pathLength(b))) continue;
    out.push({ i, at: b[k - 1], len });
  }
  return out;
}
async function trimSpurs(wps, legs) {
  for (let pass = 0; pass < 2; pass++) {
    const spurs = findSpurs(wps, legs);
    if (!spurs.length) break;
    for (const sp of spurs) { wps[sp.i].lat = sp.at[0]; wps[sp.i].lng = sp.at[1]; wps[sp.i].name = null; }
    legs = await Promise.all(wps.slice(1).map((b, k) => getLeg(wps[k], b)));
  }
  return legs;
}
function fixSpurs() {
  const spurs = findSpurs(state.waypoints, lastLegs);
  if (!spurs.length) return;
  commit(() => { for (const sp of spurs) { const w = state.waypoints[sp.i]; w.lat = sp.at[0]; w.lng = sp.at[1]; w.name = null; } });
  spurs.forEach(sp => lookupName(state.waypoints[sp.i].id));
  toast(`Removed ${spurs.length} dead-end detour${spurs.length > 1 ? 's' : ''}`);
}

// ---------- cut it short ----------
const nearStart = (w, m = 60) => {
  const s = state.waypoints[0];
  return !!s && w !== s && haversine([s.lat, s.lng], [w.lat, w.lng]) < m;
};

function renderBail() {
  const card = $('#card-bail');
  const wps = state.waypoints;
  if (!track || !analysis || wps.length < 3 || !nearStart(wps[wps.length - 1], 300)) { card.hidden = true; return; }
  card.hidden = false;
  const total = analysis.total;
  const s0 = [wps[0].lat, wps[0].lng];

  // Home passes are via points sitting on the start; also catch places the track itself rides past home.
  const passes = [];
  wps.forEach((w, i) => { if (i > 0 && i < wps.length - 1 && nearStart(w)) passes.push(track.pts[track.legRanges[i - 1][1]].d); });
  let far = 0, farD = 0, near = false;
  for (const p of track.pts) {
    const h = haversine(s0, [p.lat, p.lng]);
    if (h > far) { far = h; farD = p.d; }
    if (h < 150 && p.d > 1500 && p.d < total - 1500) {
      if (!near && !passes.some(d => Math.abs(d - p.d) < 1500)) passes.push(p.d);
      near = true;
    } else if (h > 400) near = false;
  }
  passes.sort((a, b) => a - b);

  $('#bail-max').textContent = `max ${fmtKm(far)} km from start`;
  const home = Math.round(far * 1.3 / 1000 * 10) / 10;
  const ratio = Math.min(1, far / (total / 2));
  const parts = [];
  if (passes.length) {
    parts.push(`<p>You ride past the start ${passes.length === 1 ? 'once' : `${passes.length} times`}. Stop at any of these and you're home:</p>`);
    parts.push(`<div class="exits">${passes.map(d => `<button class="exit" data-d="${d}"><i></i><b>${fmtKm(d)} km</b><span class="muted">${fmtTime(cumTimeAt(d))}</span></button>`).join('')}<button class="exit" data-d="${total}"><i></i><b>${fmtKm(total)} km</b><span class="muted">full ride</span></button></div>`);
  }
  parts.push(`<p>You're never more than <b>${fmtKm(far)} km</b> from the start as the crow flies (about ${home} km by bike from the furthest point, at km ${fmtKm(farD)}).</p>`);
  parts.push(`<div class="reach" title="How far from home you get, relative to the ride"><span style="width:${Math.max(4, ratio * 100)}%"></span></div>`);
  parts.push('<button class="btn" id="btn-shortcuts"><svg class="ic"><use href="#i-home"/></svg>Show shortcuts home</button><ul class="shortcuts" id="shortcuts"></ul>');
  if (!passes.length && ratio > 0.25) parts.push('<p class="muted">Want laps that pass home? Generate a <b>Cloverleaf</b> loop.</p>');
  $('#bail-out').innerHTML = parts.join('');
  $('#btn-shortcuts').addEventListener('click', showShortcuts);
  $$('#bail-out .exit').forEach(b => {
    const d = +b.dataset.d;
    b.addEventListener('mouseenter', () => { showHoverAt(d, true); chart.setRange([0, d]); });
    b.addEventListener('mouseleave', () => { showHoverAt(null, false); chart.setRange(null); });
    b.addEventListener('click', () => { const p = pointAt(d); if (p) map.panTo(p); });
  });
}
// Routes home from a few points along the ride, so you know what bailing out costs.
async function showShortcuts() {
  const btn = $('#btn-shortcuts');
  if (!track) return;
  btn.classList.add('busy');
  shortcutLayer.clearLayers();
  const total = analysis.total, home = { lat: track.pts[0].lat, lng: track.pts[0].lng, mode: 'route' };
  const fracs = total > 60000 ? [0.2, 0.35, 0.5, 0.65, 0.8] : [0.25, 0.5, 0.75];
  const seq = routeSeq;
  try {
    const rows = await Promise.all(fracs.map(async f => {
      const d = total * f, p = pointAt(d);
      const leg = await getLeg({ lat: p.lat, lng: p.lng }, home).catch(() => null);
      return leg && { d, p, leg, len: pathLength(leg.coords) };
    }));
    if (seq !== routeSeq) return;
    const v = state.speeds[state.profile];
    const ok = rows.filter(Boolean);
    $('#shortcuts').innerHTML = ok.map(r => `<li data-d="${r.d}"><span class="k">km ${fmtKm(r.d)}</span><span>→ <b>${fmtKm(r.len)} km</b> home · ${fmtTime(r.len / 1000 / v * 3600)}</span><span class="muted">−${fmtKm(Math.max(0, total - r.d - r.len))} km</span></li>`).join('') || '<li class="muted">No shortcuts found.</li>';
    for (const r of ok) {
      L.polyline(r.leg.coords.map(c => [c[0], c[1]]), { pane: 'line', color: '#12a150', weight: 4, dashArray: '1 8', lineCap: 'round', opacity: 0.95, interactive: false }).addTo(shortcutLayer);
      L.marker(r.p, { interactive: false, icon: L.divIcon({ className: '', html: `<div class="sc-pin">${fmtKm(r.len)} km home</div>`, iconSize: [90, 20], iconAnchor: [-6, 10] }) }).addTo(shortcutLayer);
    }
    $$('#shortcuts li[data-d]').forEach(li => {
      li.addEventListener('mouseenter', () => showHoverAt(+li.dataset.d, true));
      li.addEventListener('mouseleave', () => showHoverAt(null, false));
    });
    btn.lastChild.textContent = 'Refresh shortcuts';
  } finally {
    btn.classList.remove('busy');
  }
}
function cumTimeAt(d) {
  const pts = track.pts;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].d < d) lo = m; else hi = m; }
  return analysis.cumTime[hi];
}

// ---------- saving / sharing / GPX ----------
const library = () => store.get('cadence.routes', []);
function renderSaved() {
  const list = library();
  $('#saved-count').textContent = list.length || '';
  const ul = $('#saved');
  if (!list.length) { ul.innerHTML = '<li class="empty">No saved routes yet. Plan one and hit Save.</li>'; return; }
  ul.innerHTML = list.map(r => `
    <li data-id="${esc(r.id)}">
      <span class="t">${esc(r.name)}</span>
      <span class="m">${fmtKm(r.dist)} km · ${Math.round(r.ascent)} m · ${esc(PROFILES[r.profile]?.label || '')} · ${new Date(r.savedAt).toLocaleDateString()}</span>
      <button class="rm" title="Delete"><svg class="ic"><use href="#i-trash"/></svg></button>
    </li>`).join('');
  $$('li[data-id]', ul).forEach(li => {
    li.addEventListener('click', e => {
      const id = li.dataset.id;
      if (e.target.closest('.rm')) {
        if (!confirm('Delete this saved route?')) return;
        store.set('cadence.routes', library().filter(r => r.id !== id));
        renderSaved();
        return;
      }
      const r = library().find(x => x.id === id);
      if (r) loadRoute(r);
    });
  });
}
function loadRoute(r) {
  state.profile = r.profile in PROFILES ? r.profile : state.profile;
  state.name = r.name;
  state.routeId = r.id;
  $('#route-name').value = r.name;
  renderProfiles();
  commit(() => { state.waypoints = r.waypoints.map(w => ({ ...w })); });
  fitRoute();
  switchTab('plan');
}
function saveRoute() {
  if (state.waypoints.length < 2) return;
  const name = $('#route-name').value.trim() || state.name || `Ride ${new Date().toLocaleDateString()}`;
  state.name = name;
  $('#route-name').value = name;
  const list = library();
  const entry = {
    id: state.routeId || uid(), name, savedAt: Date.now(), profile: state.profile,
    waypoints: state.waypoints, dist: analysis?.total || 0, ascent: analysis?.ascent || 0,
  };
  const i = list.findIndex(r => r.id === entry.id);
  if (i >= 0) list[i] = entry; else list.unshift(entry);
  if (!store.set('cadence.routes', list)) { toast('Browser storage is full or blocked — export as GPX instead.'); return; }
  state.routeId = entry.id;
  persist();
  renderSaved();
  toast(i >= 0 ? `Updated “${name}”` : `Saved “${name}”`);
}

function encodeShare() {
  const payload = [state.profile, state.waypoints.map(w => [Math.round(w.lat * 1e5), Math.round(w.lng * 1e5), w.mode === 'line' ? 1 : 0]), state.name || '', state.avoidTowns ? 1 : 0];
  return btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeShare(s) {
  const json = decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
  const [profile, wps, name, towns] = JSON.parse(json);
  return { profile, name, avoidTowns: !!towns, waypoints: wps.map(([la, ln, m]) => newWp(la / 1e5, ln / 1e5, null, m ? 'line' : 'route')) };
}
async function shareRoute() {
  const url = `${location.origin}${location.pathname}#r=${encodeShare()}`;
  try {
    await navigator.clipboard.writeText(url);
    toast(state.waypoints.some(w => w.mode === 'fixed') ? 'Link copied. Imported sections will be re-routed for whoever opens it.' : 'Share link copied to clipboard');
  } catch {
    prompt('Copy this link:', url);
  }
}

function exportGPX() {
  if (!track) return;
  const name = $('#route-name').value.trim() || state.name || 'Cadence route';
  const blob = new Blob([toGPX(name, track.pts)], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'route'}.gpx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function importGPX(file) {
  try {
    const { name, coords } = parseGPX(await file.text());
    if (coords.length < 2) throw new Error('No track points found in that file.');
    toast('Importing…');
    await fillElevation(coords).catch(() => {});
    // Split into ~5 km editable sections so the route can be reshaped later.
    const total = pathLength(coords);
    const chunk = Math.max(2000, total / 30);
    const wps = [newWp(coords[0][0], coords[0][1], null, 'route')];
    let acc = 0, seg = [coords[0]];
    for (let i = 1; i < coords.length; i++) {
      acc += haversine(coords[i - 1], coords[i]);
      seg.push(coords[i]);
      if (acc >= chunk || i === coords.length - 1) {
        wps.push({ ...newWp(coords[i][0], coords[i][1]), mode: 'fixed', fixed: seg });
        seg = [coords[i]];
        acc = 0;
      }
    }
    state.name = name || file.name.replace(/\.gpx$/i, '');
    state.routeId = null;
    $('#route-name').value = state.name;
    commit(() => { state.waypoints = wps; });
    fitRoute();
    switchTab('plan');
    toast(`Imported “${state.name}” — ${fmtKm(total)} km`);
  } catch (err) {
    toast(err.message || 'Could not read that GPX file.');
  }
}

function fitRoute() {
  const ll = state.waypoints.flatMap(w => w.fixed ? w.fixed.map(c => [c[0], c[1]]) : [[w.lat, w.lng]]);
  if (ll.length > 1) map.fitBounds(ll, { padding: [50, 50] });
  else if (ll.length === 1) map.setView(ll[0], 14);
}

// ---------- tabs & controls ----------
function switchTab(name) {
  $$('.tab').forEach(t => { const on = t.dataset.tab === name; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); });
  $$('.tabpane').forEach(p => { p.hidden = p.id !== `tab-${name}`; });
}
$$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

function renderProfiles() {
  $('#profiles').innerHTML = Object.entries(PROFILES).map(([k, p]) =>
    `<button class="profile" role="radio" aria-checked="${k === state.profile}" data-p="${k}"><b>${p.label}</b><small>${p.desc}</small></button>`).join('');
  $$('#profiles .profile').forEach(b => b.addEventListener('click', () => {
    if (state.profile === b.dataset.p) return;
    state.profile = b.dataset.p;
    renderProfiles();
    renderStats();
    persist();
    recompute();
  }));
}

$('#pace').addEventListener('input', e => {
  state.speeds[state.profile] = +e.target.value;
  $('#pace-out').textContent = `${e.target.value} km/h`;
  reanalyze();
  persist();
});
$('#avoid-towns').checked = state.avoidTowns;
$('#avoid-towns').addEventListener('change', e => {
  state.avoidTowns = e.target.checked;
  persist();
  recompute();
});
$('#snap').checked = state.snap;
$('#snap').addEventListener('change', e => { state.snap = e.target.checked; persist(); });
$('#route-name').value = state.name;
$('#route-name').addEventListener('change', e => { state.name = e.target.value.trim(); persist(); });

$$('#color-by button').forEach(b => b.addEventListener('click', () => {
  state.colorBy = b.dataset.c;
  persist();
  drawRoute();
  renderLegend();
}));

$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);
$('#btn-reverse').addEventListener('click', reverseRoute);
$('#btn-outback').addEventListener('click', outAndBack);
$('#btn-home').addEventListener('click', backToStart);
$('#btn-clear').addEventListener('click', clearRoute);
$('#btn-wind').addEventListener('click', checkWind);
$('#btn-spurs').addEventListener('click', fixSpurs);
$('#btn-save').addEventListener('click', saveRoute);
$('#btn-gpx').addEventListener('click', exportGPX);
$('#btn-share').addEventListener('click', shareRoute);
$('#btn-import').addEventListener('click', () => $('#file-gpx').click());
$('#file-gpx').addEventListener('change', e => { const f = e.target.files[0]; if (f) importGPX(f); e.target.value = ''; });
$('#btn-new').addEventListener('click', () => { clearRoute(); switchTab('plan'); });
$('#btn-loop').addEventListener('click', generateLoop);
function syncLoopUI() {
  $('#loop-km-out').textContent = `${$('#loop-km').value} km`;
  $('#petals-field').hidden = loopShape !== 'petals';
  const n = loopPetals === 'auto' ? autoPetals(+$('#loop-km').value) : +loopPetals;
  $('#petals-out').textContent = `${n} × ~${Math.round(+$('#loop-km').value / n)} km`;
  $$('#loop-shape .shape').forEach(b => b.setAttribute('aria-checked', b.dataset.shape === loopShape));
  $$('#loop-petals button').forEach(b => b.classList.toggle('active', b.dataset.n === loopPetals));
}
$('#loop-km').addEventListener('input', syncLoopUI);
$$('#loop-shape .shape').forEach(b => b.addEventListener('click', () => { loopShape = b.dataset.shape; syncLoopUI(); }));
$$('#loop-petals button').forEach(b => b.addEventListener('click', () => { loopPetals = b.dataset.n; syncLoopUI(); }));
syncLoopUI();
$$('#loop-dir button').forEach(b => b.addEventListener('click', () => {
  loopDir = b.dataset.dir;
  $$('#loop-dir button').forEach(x => x.classList.toggle('active', x === b));
}));
$('#btn-elev-toggle').addEventListener('click', () => {
  const wrap = $('#mapwrap');
  wrap.classList.toggle('elev-collapsed');
  $('#elevation').classList.toggle('elev-collapsed');
  setTimeout(() => map.invalidateSize(), 50);
});

let locMarker = null;
$('#btn-locate').addEventListener('click', () => map.locate({ setView: true, maxZoom: 15 }));
map.on('locationfound', e => {
  locMarker?.remove();
  locMarker = L.circleMarker(e.latlng, { radius: 7, color: '#fff', weight: 3, fillColor: '#2e90fa', fillOpacity: 1 }).addTo(map);
});
map.on('locationerror', () => toast('Couldn\'t get your location.'));

map.on('click', e => {
  const wp = newWp(e.latlng.lat, e.latlng.lng);
  commit(() => state.waypoints.push(wp));
  lookupName(wp.id);
});

document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, select')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if ((e.key === 'Backspace' || e.key === 'Delete') && state.waypoints.length) { e.preventDefault(); removeWaypoint(state.waypoints.length - 1); }
});

// GPX drag & drop
const mapwrap = $('#mapwrap');
let dragDepth = 0;
mapwrap.addEventListener('dragenter', e => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; $('#dropzone').hidden = false; } });
mapwrap.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropzone').hidden = true; } });
mapwrap.addEventListener('dragover', e => e.preventDefault());
mapwrap.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropzone').hidden = true;
  const f = e.dataTransfer.files[0];
  if (f) importGPX(f);
});

$('#grade-legend').innerHTML = GRADE_BANDS.map(b => `<li><span class="dot" style="background:${b.color}"></span>${b.label}</li>`).join('');

// ---------- boot ----------
if (location.hash.startsWith('#r=')) {
  try {
    const r = decodeShare(location.hash.slice(3));
    if (PROFILES[r.profile]) state.profile = r.profile;
    state.avoidTowns = r.avoidTowns;
    state.waypoints = r.waypoints;
    state.name = r.name;
    state.routeId = null;
    $('#route-name').value = r.name;
    history.replaceState(null, '', location.pathname);
  } catch {
    toast('That share link looks broken.');
  }
}
renderProfiles();
renderSaved();
changed();
if (state.waypoints.length) setTimeout(fitRoute, 0);
