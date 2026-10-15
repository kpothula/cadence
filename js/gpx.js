const esc = s => String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

export function toGPX(name, pts) {
  const body = pts.map(p =>
    `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}">${p.ele != null ? `<ele>${p.ele.toFixed(1)}</ele>` : ''}</trkpt>`
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Cadence route planner" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name><time>${new Date().toISOString()}</time></metadata>
  <trk>
    <name>${esc(name)}</name>
    <type>cycling</type>
    <trkseg>
${body}
    </trkseg>
  </trk>
</gpx>
`;
}

export function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('That file is not valid GPX.');
  let nodes = [...doc.getElementsByTagName('trkpt')];
  if (!nodes.length) nodes = [...doc.getElementsByTagName('rtept')];
  if (!nodes.length) nodes = [...doc.getElementsByTagName('wpt')];
  const coords = nodes.map(n => {
    const ele = n.getElementsByTagName('ele')[0];
    const e = ele ? parseFloat(ele.textContent) : NaN;
    return [parseFloat(n.getAttribute('lat')), parseFloat(n.getAttribute('lon')), Number.isFinite(e) ? e : null];
  }).filter(c => Number.isFinite(c[0]) && Number.isFinite(c[1]));
  const name = doc.getElementsByTagName('name')[0]?.textContent?.trim() || '';
  return { name, coords };
}
