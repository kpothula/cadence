# Cadence — cycling route planner

A no-build, static web app for planning bike rides. Open it, click the map, ride.

**Live:** https://pothula.me/cadence/

```bash
node serve.mjs        # → http://localhost:5173
```

Any static file server works (ES modules need http://, not file://).

## What it does

- **Click-to-route** on OpenStreetMap via [BRouter](https://brouter.de), with six bike types: Road, Quiet roads, Gravel, Mountain, Touring, Safest.
- **Drag the line to reshape** it, drag points to move them, right-click a point to remove it. Full undo/redo (⌘Z / ⇧⌘Z), Backspace removes the last point.
- **Per-section mode**: follow roads, or draw a straight line (ferries, missing paths). Click a point to switch.
- **What you'll ride on**: surface (paved / cobbles / gravel / dirt) and way type (bike path, bike lane, quiet road, busy road, trail), plus the share of the ride on signed bike networks.
- **Colour the route** by gradient, surface or way type.
- **Elevation profile** coloured by gradient, scaled to the route's own lowest and highest points (both marked), with gain, loss, high, low, range, steepest grade and climbing per km. Linked to the map when you hover.
- **Climb detection** with Strava-style categories (Cat 4 → HC). Hover a climb to highlight it, click it to zoom.
- **Realistic moving time**, based on your flat pace, the gradient and the surface.
- **Wind & weather for your departure time**: the forecast is matched to when you'll reach each part of the route. You get the headwind/tailwind split, how much time the wind costs, temperature and rain chance. It tells you if riding the other way would be better.
- **Loop generator**: pick a distance and a direction to head out in, including **"Into wind"** (headwind first while you're fresh, tailwind home). Four shapes:
  - **Cloverleaf**: 2–5 laps that each finish at home, so you can stop after any lap.
  - **Orbit**: rides out, circles around home and comes back, so you're never far away.
  - **Half orbit**: a semicircle around home. Fewer junctions, still close enough to bail out.
  - **Classic**: one big loop.
- **Difficulty** for generated loops: Easy, Moderate, Challenging or Hard. Each level is judged on climbing per km, steepest grade, rough surface (for your bike) and busy roads. The generator compares four loops in different directions and keeps the best match. If the area can't deliver that level, it says so. The Plan tab's difficulty badge uses the same scale (hover it to see why).
- **Avoid climbs**: switches on each profile's own uphill penalty, so the route prefers flatter roads where there's a choice. Easy loops turn it on automatically.
- **Cut it short**: for any round trip, it lists the kilometres where you pass the start (with elapsed time), and how far from home you ever get. **Show shortcuts home** routes back from several points and draws them on the map, with the distance saved.
- **Avoid towns & city streets**: uploads a patched BRouter profile (bundled in `profiles/`) that penalises built-up areas and residential streets. Works with every bike type, and can be combined with Avoid climbs.
- **No dead-end detours**: generated loops move any point that sends you down a dead end and back onto the junction. For routes you draw yourself, the Waypoints card offers a "Remove detours" fix.
- **Reverse, out & back, return to start.**
- **GPX export / import** (or drop a .gpx on the map). Imported tracks stay editable.
- **Saved routes** (in this browser), **share links**, and autosave of the current plan.
- Five base maps (CyclOSM, streets, topo, satellite, dark), search with Photon, light and dark mode, and a layout that works on phones.

## Structure

| File | Purpose |
| --- | --- |
| `index.html` | Layout and icons |
| `css/styles.css` | Styling, light/dark tokens, mobile layout |
| `js/main.js` | State, map interaction, UI rendering |
| `js/route.js` | BRouter fetching, tag classification, track building, stats, climbs |
| `js/elevation-chart.js` | Canvas elevation profile |
| `js/weather.js` | Open-Meteo wind and weather along the route |
| `js/gpx.js` | GPX read/write |
| `js/geo.js` | Distance, bearing and destination maths |
| `profiles/*.brf` | Stock BRouter profiles, patched at runtime for "avoid towns" / "avoid climbs" |
| `serve.mjs` | Tiny static dev server |

Uses free public services: BRouter (routing), Photon (search), Open-Meteo (weather and elevation), and OSM / CyclOSM / OpenTopoMap / Esri / CARTO tiles. Be gentle with them; for heavy use, run your own BRouter instance.
