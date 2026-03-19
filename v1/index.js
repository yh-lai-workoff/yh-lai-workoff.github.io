// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  mapsApiKey: '', // DEV ONLY
  csvUrl: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQw9s9AkynJ-GfEuiIpqGCuP-SyvC4rP7lvzGdJtPdCCdrOgUd5GiWcF9SCcBl3A_76MZ39ApNr-RJk/pub?gid=0&single=true&output=csv',
  center: { lat: 1.3521, lng: 103.8198 },
  zoom: 12,
};

const CSV_FILES = [
  "csv/CAB.csv",
];

const CSV_FILES2 = [
  "csv/CAB_limit.csv",
];

// OLS START
// ─── OLS CONSTANTS
const R_EARTH = 6371000;
const CLEARYWAY = 60;
const HALF_WIDTH = 140;
const TS_DIST = 3000;
const ITS_LEN = 1200;
const ITS_DIST = 315;
const DIV_ANGLE = 15;
const ITS_MAXH = 45;
const TS_MAXH = 60;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

function vectorise(pta, ptb) {
  const phi1 = toRad(pta.lat);
  const phi2 = toRad(ptb.lat);
  const dphi = phi2 - phi1;
  const dlam = toRad(ptb.lng - pta.lng);

  // Haversine Part
  const s = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) ** 2;
  const distance =  2 * R_EARTH * Math.asin(Math.sqrt(s));

  // Bearing Part
  const y = Math.sin(dlam) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dlam);
  const bearing = (toDeg(Math.atan2(y, x)) + 360) % 360;
  
  return { bearing, distance, points: { pta, ptb } };
}

// Vector from vectorise(), add angle, travel distance, from either start or end point of vector
function deflect(vector, angle, distance, from = 'start') {
  const bearing = (vector.bearing + angle + 360) % 360;
  const origin  = from.toLowerCase() === 'end' ? vector.points.ptb : vector.points.pta;
  
  const delta = distance / R_EARTH;
  const theta = toRad(bearing);
  const phi_s = toRad(origin.lat);
  const lam_s = toRad(origin.lng);

  const phi_f = Math.asin(
    Math.sin(phi_s) * Math.cos(delta) +
    Math.cos(phi_s) * Math.sin(delta) * Math.cos(theta)
  );
  const lam_f = lam_s + Math.atan2(
    Math.sin(theta) * Math.sin(delta) * Math.cos(phi_s),
    Math.cos(delta) - Math.sin(phi_s) * Math.sin(phi_f)
  );

  return { lat: toDeg(phi_f), lng: ((toDeg(lam_f) + 540) % 360) - 180 };
}

function get_ols_polygons(centerline) {
  const clcw = vectorise(
    deflect(centerline, 180, CLEARYWAY, 'start'),
    deflect(centerline, 0, CLEARYWAY, 'end')
  );

  // Runway Box
  const rwyAL = deflect(clcw, -90, HALF_WIDTH, 'end');
  const rwyAR = deflect(clcw, 90, HALF_WIDTH, 'end');
  const rwyBL = deflect(clcw, -90, HALF_WIDTH, 'start');
  const rwyBR = deflect(clcw, 90, HALF_WIDTH, 'start');

  // Takeoff Surface
  const tsHypo = TS_DIST/Math.cos(toRad(DIV_ANGLE));

  const tsAL = deflect(vectorise(clcw.points.ptb, rwyAL), (90 - DIV_ANGLE), tsHypo, 'end');
  const tsAR = deflect(vectorise(clcw.points.ptb, rwyAR), -(90 - DIV_ANGLE), tsHypo, 'end');

  const tsBL = deflect(vectorise(clcw.points.pta, rwyBL), -(90 - DIV_ANGLE), tsHypo, 'end');
  const tsBR = deflect(vectorise(clcw.points.pta, rwyBR), (90 - DIV_ANGLE), tsHypo, 'end');

  // Inner Transition Surface
  const itsAL1 = deflect(vectorise(clcw.points.ptb, rwyAL), 90, ITS_LEN, 'end');
  const itsAR1 = deflect(vectorise(clcw.points.ptb, rwyAR), -90, ITS_LEN, 'end');
  const itsBL1 = deflect(vectorise(clcw.points.pta, rwyBL), -90, ITS_LEN, 'end');
  const itsBR1 = deflect(vectorise(clcw.points.pta, rwyBR), 90, ITS_LEN, 'end');
  
  const itsAL2 = deflect(vectorise(rwyAL,itsAL1), -90, ITS_DIST, 'end');
  const itsAR2 = deflect(vectorise(rwyAR,itsAR1), 90, ITS_DIST, 'end');
  const itsBL2 = deflect(vectorise(rwyBL,itsBL1), 90, ITS_DIST, 'end');
  const itsBR2 = deflect(vectorise(rwyBR,itsBR1), -90, ITS_DIST, 'end');

  // First 2 points of each polygon define the perpendicular-distance reference edge
  return {
    rwy: [rwyAL, rwyAR, rwyBR, rwyBL],
    ts1: [rwyAL, rwyAR, tsAR, tsAL],
    ts2: [rwyBL, rwyBR, tsBR, tsBL],
    its1: [itsAL1, itsBL1, itsBL2, itsAL2],
    its2: [itsAR1, itsBR1, itsBR2, itsAR2],
  };
}

/** Signed perpendicular & along-track distances from vector AB to point (metres). */
function orth_dist(vector, point) {
  const toPoint = vectorise(vector.points.pta, point);
  const delta = toPoint.distance / R_EARTH;
  const theta = toRad(toPoint.bearing - vector.bearing);

  const perpDist  = Math.asin(Math.sin(delta) * Math.sin(theta)) * R_EARTH;
  const alongDist = Math.acos(Math.cos(delta) / Math.cos(perpDist / R_EARTH)) * R_EARTH * Math.sign(Math.cos(theta));

  return { perpDistance: perpDist, alongDistance: alongDist };
}

function fetch_height(poly, maxd, maxh, point) {
  return maxh * Math.abs(orth_dist(vectorise(poly[0], poly[1]), point).perpDistance) / maxd;
}

/** Convex polygon point-in-polygon test via cross-product half-plane check. */
function point_in_polygon(polygon, point) {
  const n = polygon.length;
  let sign = 0;

  for (let i = 0; i < n; i++) {
    const { lat: ay, lng: ax } = polygon[i];
    const { lat: by, lng: bx } = polygon[(i + 1) % n];
    const cross = (bx - ax) * (point.lat - ay) - (by - ay) * (point.lng - ax);
    const s = Math.sign(cross);
    if (s === 0) return true;   // on the edge
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Return the lowest applicable OLS height limit, or null if outside all surfaces. */
function get_OLS_height(olsPolys, point) {
  if (point_in_polygon(olsPolys.rwy, point)) return 0;

  for (const { poly, maxd, maxh } of [
    { poly: olsPolys.ts1, maxd: TS_DIST, maxh: TS_MAXH },
    { poly: olsPolys.ts2, maxd: TS_DIST, maxh: TS_MAXH },
  ]) {
    if (point_in_polygon(poly, point)) return fetch_height(poly, maxd, maxh, point);
  }

  for (const { poly, maxd, maxh } of [
    { poly: olsPolys.its1, maxd: ITS_DIST, maxh: ITS_MAXH },
    { poly: olsPolys.its2, maxd: ITS_DIST, maxh: ITS_MAXH },
  ]) {
    if (point_in_polygon(poly, point)) return fetch_height(poly, maxd, maxh, point);
  }

  return null;
}

// ─── CSV / DATA HELPERS ───────────────────────────────────────────────────────

/** Parse a simple 2-column (lat, lng) CSV into an array of objects. */
async function CSVtoOBJ(csvFile) {
  const response = await fetch(csvFile);
  if (!response.ok) throw new Error(`Failed to load: ${csvFile}`);
  const lines = (await response.text()).trim().split('\n').filter(Boolean);
  return lines.slice(1).map(row => {
    const [lat, lng] = row.split(',').map(v => parseFloat(v.trim()));
    return { lat, lng };
  });
}

/** Fetch marker data from Google Sheets CSV and return location objects. */
async function fetchSheetData(csvUrl) {
  try {
    const response = await fetch(csvUrl);
    const csvText  = await response.text();
    console.log("Retrieved Data:",csvText);
    const rows     = csvText.split('\n').filter(row => row.trim() !== '');
    const headers  = ["id", "height", "lat", "lng", "startdatetime", "enddatetime"];
    const data     = rows.slice(1).map(row => {
      const values = row.split(',');
      return headers.reduce((obj, header, i) => {
        obj[header.trim()] = values[i]?.trim();
        return obj;
      }, {});
    });

    return data;
  } catch (error) {
    console.error("Error fetching sheet:", error);
  }
}

function wkttolatlng(wkt) {
  const match = wkt.match(/POLYGON\s*\(\(([\s\S]+?)\)\)/i);
  if (!match) return null;
  return match[1].split(",").map((pair) => {
    const [lng, lat] = pair.trim().split(/\s+/).map(Number);
    return { lat, lng };
  });
}

function parseCSV(csvText) {
  const lines = csvText.trim().split("\n");
  const polygons = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const wktMatch = line.match(/^"(POLYGON[^"]+)"\s*,\s*([^,]*),?(.*)?$/i);
    if (!wktMatch) continue;

    const [, wkt, name] = wktMatch;
    const color = name.trim().toLowerCase();
    const paths = wkttolatlng(wkt);
    if (!paths) continue;

    polygons.push({ paths, color });
  }

  return polygons;
}

async function loadFileText(filePath) {
  const response = await fetch(filePath);
  if (!response.ok) throw new Error(`Failed to load: ${filePath}`);
  return parseCSV(await response.text());
}

// ─── MAP RENDERING ────────────────────────────────────────────────────────────
function getPolygonOptions(color, paths) {
  const colorStyles = {
    yellow: { strokeColor: "#FFD700", fillColor: "#FFD700" },
    red:    { strokeColor: "#FF0000", fillColor: "#FF0000" },
    black:  { strokeColor: "#000000", fillColor: "#333333" },
  };

  const style = colorStyles[color] || { strokeColor: "#0000FF", fillColor: "#0000FF" };

  return {
    paths,
    strokeColor: style.strokeColor,
    strokeOpacity: 0.8,
    strokeWeight: 2,
    fillColor: style.fillColor,
    fillOpacity: 0.35,
    clickable: false,
  };
}

async function processCSV(map, fileList) {
  const allPolygons = [];
  for (const filePath of fileList) {
    try {
      const polygonConfigs = await loadFileText(filePath);
      for (const { paths, color } of polygonConfigs) {
        const polygon = new google.maps.Polygon(getPolygonOptions(color, paths));
        polygon.setMap(map);
        allPolygons.push(polygon);
      }

      console.log(`Loaded ${polygonConfigs.length} polygons from ${filePath}`);
    } catch (err) {
      console.error(`Error loading ${filePath}:`, err);
    }
  }

  console.log(`Total polygons added to map: ${allPolygons.length}`);
  return allPolygons;
}

// ── OLS surface styles
const OLS_STYLES = {
  rwy:   { strokeColor: '#FFFFFF', fillColor: '#CCCCCC', label: 'Runway'},
  ts1: { strokeColor: '#FF9900', fillColor: '#FFAA00', label: 'Takeoff Surface A'},
  ts2: { strokeColor: '#FF9900', fillColor: '#FFAA00', label: 'Takeoff Surface B'},
  its1: { strokeColor: '#00CCFF', fillColor: '#00BBEE', label: 'ITS Right'},
  its2:  { strokeColor: '#00CCFF', fillColor: '#00BBEE', label: 'ITS Left'},
};

function drawOLSSurfaces(map, surfaces) {
  const polygons = [];
  const infoWindow = new google.maps.InfoWindow();

  for (const [key, path] of Object.entries(surfaces)) {
    const style = OLS_STYLES[key];
    const polygon = new google.maps.Polygon({
      paths:         path,
      strokeColor:   style.strokeColor,
      strokeOpacity: 0.9,
      strokeWeight:  1.5,
      fillColor:     style.fillColor,
      fillOpacity:   0.20,
      map,
      clickable: false,
    });

    polygons.push(polygon);
  }

  console.log(`OLS: ${polygons.length} surfaces rendered`);
  return polygons;
}

// ─── DATETIME FILTER
let allMarkers    = []; // [{ marker, loc }]
let layer1Polygons = []; // google.maps.Polygon[] from CSV_FILES
let layer2Polygons = []; // google.maps.Polygon[] from CSV_FILES2

function setLayerVisible(polygons, visible) {
  polygons.forEach(p => p.setMap(visible ? window._mapInstance : null));
}

function applyDatetimeFilter(filterStart, filterEnd) {
  const hasFilter = filterStart || filterEnd;
  let visible = 0;
  let hidden  = 0;

  allMarkers.forEach(({ marker, loc }) => {
    let show = true;

    if (hasFilter) {
      // Parse marker interval (may be absent/invalid → treat as ±∞)
      const markerStart = loc.startdatetime ? new Date(loc.startdatetime) : null;
      const markerEnd   = loc.enddatetime   ? new Date(loc.enddatetime)   : null;

      // Overlap condition:
      //   marker ends AFTER filterStart  (or marker has no end)
      //   AND marker starts BEFORE filterEnd (or marker has no start)
      const afterFilterStart  = filterStart ? (!markerEnd   || markerEnd   >= filterStart) : true;
      const beforeFilterEnd   = filterEnd   ? (!markerStart || markerStart <= filterEnd)   : true;

      show = afterFilterStart && beforeFilterEnd;
    }

    marker.map = show ? window._mapInstance : null;
    show ? visible++ : hidden++;
  });

  updateStats(allMarkers.length, visible, hidden, hasFilter);
}

function updateStats(total, visible, hidden, hasFilter) {
  document.getElementById('stat-total').textContent   = total;
  document.getElementById('stat-visible').textContent = visible;
  document.getElementById('stat-hidden').textContent  = hidden;

  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  if (hasFilter) {
    dot.className  = 'status-dot status-dot--active';
    text.textContent = 'Filter active';
  } else {
    dot.className  = 'status-dot';
    text.textContent = 'No filter active';
  }
}

// ─── SIDEBAR & FILTER BUTTON HANDLERS

const sidebar = document.getElementById('sidebar');
document.getElementById('sidebar-toggle').addEventListener('click', () => {
  sidebar.classList.toggle('sidebar--open');
});

document.getElementById('apply-filter').addEventListener('click', () => {
  const startVal = document.getElementById('start-datetime').value;
  const endVal   = document.getElementById('end-datetime').value;
  const filterStart = startVal ? new Date(startVal) : null;
  const filterEnd   = endVal   ? new Date(endVal)   : null;
  applyDatetimeFilter(filterStart, filterEnd);
});

document.getElementById('clear-filter').addEventListener('click', () => {
  document.getElementById('start-datetime').value = '';
  document.getElementById('end-datetime').value   = '';
  applyDatetimeFilter(null, null);
});

// ─── OLS CHECKER UI

function toggleMenu() {
  document.getElementById('control-panel').classList.toggle('collapsed');
}

function handleCheck() {
  const point = {
    lat: parseFloat(document.getElementById('lat-input').value),
    lng: parseFloat(document.getElementById('lng-input').value),
  };
  const heightInput = parseFloat(document.getElementById('height-input').value);
  const statusEl    = document.getElementById('status-info');

  if (isNaN(point.lat) || isNaN(point.lng)) {
    statusEl.dataset.state = 'idle';
    statusEl.textContent = 'Invalid input';
    return;
  }

  const olsSurfaces = get_ols_polygons(vectorise(thresholdA, thresholdB));
  const result = get_OLS_height(olsSurfaces, point);

  if (result === null) {
    statusEl.dataset.state = 'outside';
    statusEl.textContent = 'Outside OLS';
  } else if (result === 0 || result < heightInput) {
    statusEl.dataset.state = 'breach';
    statusEl.textContent = `Breach — limit ${result.toFixed(1)} m`;
  } else {
    statusEl.dataset.state = 'clear';
    statusEl.textContent = `Clear — limit ${result.toFixed(1)} m`;
  }
}

// ─── MAP INIT
let thresholdA = null;
let thresholdB = null;
let activeMarker = null;

async function initMap() {
  const [locations, endpointData] = await Promise.all([
    fetchSheetData(CONFIG.csvUrl),
    CSVtoOBJ(CSV_FILES2[0]),
  ]);

  // Use CSV thresholds if valid, otherwise fall back to OLS placeholders
  thresholdA = (endpointData?.[0]?.lat) ? endpointData[0] : { lat: 1.3590, lng: 103.9840 };
  thresholdB = (endpointData?.[1]?.lat) ? endpointData[1] : { lat: 1.3230, lng: 103.9840 };
  console.log('OLS thresholds — A:', thresholdA, 'B:', thresholdB);

  const map = new google.maps.Map(document.getElementById("map"), {
    zoom: CONFIG.zoom,
    center: CONFIG.center,
    mapTypeId: 'satellite',
    mapId: 'DEMO_MAP_ID', // Required for AdvancedMarkerElement
  });

  // Place a marker on map click and populate OLS checker inputs
  map.addListener('click', async (e) => {
    const clickedPos = e.latLng;
    document.getElementById('lat-input').value = clickedPos.lat().toFixed(6);
    document.getElementById('lng-input').value = clickedPos.lng().toFixed(6);
    if (activeMarker) activeMarker.map = null;

    const { AdvancedMarkerElement, PinElement } = await google.maps.importLibrary('marker');
    const bluePin = new PinElement({ 
      background: '#4285F4',
      borderColor: '#1d5dbd',
      glyphColor: 'white'
    });

    activeMarker = new AdvancedMarkerElement({
      map, 
      position: clickedPos,
      content: bluePin.element
    });
  });

  window._mapInstance = map;

  layer1Polygons = await processCSV(map, CSV_FILES);
  layer2Polygons = drawOLSSurfaces(map, get_ols_polygons(vectorise(thresholdA, thresholdB)));

  // Wire layer visibility checkboxes
  document.getElementById('layer1-toggle').addEventListener('change', e => {
    setLayerVisible(layer1Polygons, e.target.checked);
  });
  document.getElementById('layer2-toggle').addEventListener('change', e => {
    setLayerVisible(layer2Polygons, e.target.checked);
  });

  // Map Markers
  const infoWindow = new google.maps.InfoWindow();

  locations.forEach((loc) => {
    const lat = parseFloat(loc.lat);
    const lng = parseFloat(loc.lng);
    const marker = new google.maps.marker.AdvancedMarkerElement({
      position: { lat, lng },
      map,
      title: `${loc.id} (${lat}, ${lng})`,
    });
    marker.addListener('gmp-click', () => {
      infoWindow.setContent(`
        <div class="custom-info">
          <strong>ID: ${loc.id}</strong><br>
          Coords: (${lat}, ${lng})<br>
          Start: ${loc.startdatetime || '—'}<br>
          End: ${loc.enddatetime   || '—'}
        </div>`);
      infoWindow.open(map, marker);
    });
    allMarkers.push({ marker, loc });
  });

  updateStats(allMarkers.length, allMarkers.length, 0, false);
}
