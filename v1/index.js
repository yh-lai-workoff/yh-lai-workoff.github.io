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
const sidebarToggleBtn = document.getElementById('sidebar-toggle');
sidebarToggleBtn.addEventListener('click', () => {
  const isOpen = sidebar.classList.toggle('sidebar--open');
  sidebarToggleBtn.classList.toggle('btn--active', isOpen);
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
  const panel = document.getElementById('control-panel');
  const btn   = document.getElementById('toggle-btn');
  const isCollapsed = panel.classList.toggle('collapsed');
  btn.classList.toggle('btn--active', !isCollapsed);
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

// ─── DATA TABLE OVERLAY ───────────────────────────────────────────────────────

let _tableData    = [];   // full dataset, set once after initMap
let _tableSort    = { col: null, dir: 1 };  // dir: 1 = asc, -1 = desc
let _searchPending = false;

/** Populate the table. Called once from initMap after markers are created. */
function buildTable(locations) {
  _tableData = locations;
  renderTable();
}

/** Full render — diffing via tr visibility for performance at 100+ rows. */
function renderTable() {
  const tbody = document.getElementById('data-table-body');
  const query = (document.getElementById('table-search')?.value || '').trim().toLowerCase();

  // Filter
  let rows = _tableData.filter(loc => {
    if (!query) return true;
    return (loc.id            || '').toLowerCase().includes(query) ||
           (loc.startdatetime || '').toLowerCase().includes(query) ||
           (loc.enddatetime   || '').toLowerCase().includes(query);
  });

  // Sort
  if (_tableSort.col) {
    const col = _tableSort.col;
    const dir = _tableSort.dir;
    rows = rows.slice().sort((a, b) => {
      const av = (a[col] || '');
      const bv = (b[col] || '');
      return av < bv ? -dir : av > bv ? dir : 0;
    });
  }

  // Update count badge
  document.getElementById('table-count').textContent =
    query
      ? `${rows.length} / ${_tableData.length} entries`
      : `${_tableData.length} entries`;

  // Build rows (DocumentFragment — single reflow)
  if (rows.length === 0) {
    tbody.innerHTML = `<tr class="table-no-results"><td colspan="5">No matching entries</td></tr>`;
    return;
  }

  const frag = document.createDocumentFragment();
  rows.forEach(loc => {
    const lat = parseFloat(loc.lat);
    const lng = parseFloat(loc.lng);
    const tr  = document.createElement('tr');

    // Coords cell — navigate button
    const coordsCell = document.createElement('td');
    const btn = document.createElement('button');
    btn.className = 'nav-link';
    btn.title = `Navigate to ${lat}, ${lng}`;
    btn.innerHTML = `▶ ${isNaN(lat) ? '—' : lat.toFixed(5)}, ${isNaN(lng) ? '—' : lng.toFixed(5)}`;
    btn.addEventListener('click', () => navigateToMarker(lat, lng));
    coordsCell.appendChild(btn);

    tr.innerHTML = `
      <td>${loc.id       || '—'}</td>`;
    tr.appendChild(coordsCell);
    tr.insertAdjacentHTML('beforeend', `
      <td>${loc.height         || '—'}</td>
      <td>${loc.startdatetime  || '—'}</td>
      <td>${loc.enddatetime    || '—'}</td>`);

    frag.appendChild(tr);
  });

  tbody.innerHTML = '';
  tbody.appendChild(frag);
}

/** Close the overlay and pan/zoom the map to the selected marker. */
function navigateToMarker(lat, lng) {
  if (isNaN(lat) || isNaN(lng)) return;
  closeTableOverlay();
  const map = window._mapInstance;
  if (!map) return;
  map.panTo({ lat, lng });
  map.setZoom(16);
}

function openTableOverlay() {
  document.getElementById('table-overlay').classList.remove('table-overlay--hidden');
  document.getElementById('table-toggle').classList.add('btn--active');
  document.getElementById('table-search').focus();
}

function closeTableOverlay() {
  document.getElementById('table-overlay').classList.add('table-overlay--hidden');
  document.getElementById('table-toggle').classList.remove('btn--active');
}

function toggleTableOverlay() {
  const isOpen = !document.getElementById('table-overlay').classList.contains('table-overlay--hidden');
  isOpen ? closeTableOverlay() : openTableOverlay();
}

// ── Table controls wiring (safe to run immediately, DOM is ready)
document.getElementById('table-toggle').addEventListener('click', toggleTableOverlay);
document.getElementById('table-close').addEventListener('click', closeTableOverlay);

// Close on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeTableOverlay();
});

// Debounced search via rAF flag — cheap, no timers
document.getElementById('table-search').addEventListener('input', function () {
  const clearBtn = document.getElementById('table-search-clear');
  clearBtn.hidden = this.value === '';
  if (_searchPending) return;
  _searchPending = true;
  requestAnimationFrame(() => {
    _searchPending = false;
    renderTable();
  });
});

document.getElementById('table-search-clear').addEventListener('click', function () {
  document.getElementById('table-search').value = '';
  this.hidden = true;
  renderTable();
});

// Column sort
document.querySelectorAll('.data-table th[data-col]').forEach(th => {
  const col = th.dataset.col;
  if (!['id', 'startdatetime', 'enddatetime'].includes(col)) return;
  th.addEventListener('click', () => {
    if (_tableSort.col === col) {
      _tableSort.dir *= -1;
    } else {
      _tableSort.col = col;
      _tableSort.dir = 1;
    }
    // Update header classes
    document.querySelectorAll('.data-table th').forEach(h => {
      h.classList.remove('sort-asc', 'sort-desc');
    });
    th.classList.add(_tableSort.dir === 1 ? 'sort-asc' : 'sort-desc');
    renderTable();
  });
});

// ─── SHARED MARKER FACTORY ────────────────────────────────────────────────────

/**
 * Create a data marker on the map for a location object and register it in
 * allMarkers.  Returns the AdvancedMarkerElement so callers can further
 * customise it if needed.
 *
 * @param {google.maps.Map}  map
 * @param {google.maps.InfoWindow} infoWindow  - shared InfoWindow instance
 * @param {object} loc  - { id, lat, lng, height, startdatetime, enddatetime }
 * @returns {google.maps.marker.AdvancedMarkerElement}
 */
function createDataMarker(map, infoWindow, loc) {
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
        Height: ${loc.height || '—'} m<br>
        Start: ${loc.startdatetime || '—'}<br>
        End: ${loc.enddatetime   || '—'}
      </div>`);
    infoWindow.open(map, marker);
  });

  allMarkers.push({ marker, loc });
  return marker;
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
  window._infoWindow = infoWindow;  // shared instance for add-marker modal

  locations.forEach(loc => createDataMarker(map, infoWindow, loc));

  updateStats(allMarkers.length, allMarkers.length, 0, false);
  buildTable(locations);
}

// ─── ADD MARKER MODAL ─────────────────────────────────────────────────────────

function openAddMarkerModal(prefillLat, prefillLng) {
  // Optionally prefill lat/lng (e.g. from the OLS Checker inputs)
  if (prefillLat != null) document.getElementById('modal-lat').value = prefillLat;
  if (prefillLng != null) document.getElementById('modal-lng').value = prefillLng;

  clearModalErrors();
  document.getElementById('add-marker-backdrop').classList.remove('modal-backdrop--hidden');
  document.getElementById('add-marker-modal').classList.remove('modal--hidden');
  document.getElementById('modal-id').focus();
}

function closeAddMarkerModal() {
  document.getElementById('add-marker-backdrop').classList.add('modal-backdrop--hidden');
  document.getElementById('add-marker-modal').classList.add('modal--hidden');
  resetModalForm();
}

function resetModalForm() {
  ['modal-id', 'modal-lat', 'modal-lng', 'modal-height', 'modal-start', 'modal-end']
    .forEach(id => { document.getElementById(id).value = ''; });
  clearModalErrors();
}

function clearModalErrors() {
  ['modal-id-error', 'modal-lat-error', 'modal-lng-error']
    .forEach(id => { document.getElementById(id).textContent = ''; });
  ['modal-id', 'modal-lat', 'modal-lng']
    .forEach(id => document.getElementById(id).classList.remove('dt-input--error'));
}

function validateAndSubmitMarker() {
  clearModalErrors();
  let valid = true;

  const idVal  = document.getElementById('modal-id').value.trim();
  const latVal = document.getElementById('modal-lat').value.trim();
  const lngVal = document.getElementById('modal-lng').value.trim();

  if (!idVal) {
    showFieldError('modal-id', 'modal-id-error', 'ID is required');
    valid = false;
  }

  const lat = parseFloat(latVal);
  if (!latVal || isNaN(lat) || lat < -90 || lat > 90) {
    showFieldError('modal-lat', 'modal-lat-error', 'Valid latitude required (−90 to 90)');
    valid = false;
  }

  const lng = parseFloat(lngVal);
  if (!lngVal || isNaN(lng) || lng < -180 || lng > 180) {
    showFieldError('modal-lng', 'modal-lng-error', 'Valid longitude required (−180 to 180)');
    valid = false;
  }

  if (!valid) return;

  const loc = {
    id:            idVal,
    lat:           lat.toString(),
    lng:           lng.toString(),
    height:        document.getElementById('modal-height').value.trim() || '',
    startdatetime: formatDatetimeLocal(document.getElementById('modal-start').value),
    enddatetime:   formatDatetimeLocal(document.getElementById('modal-end').value),
  };

  // Add to table data and re-render
  _tableData.push(loc);
  renderTable();
  updateStats(allMarkers.length + 1, /* will be recounted after marker added */ allMarkers.length + 1, 0, false);

  // Place marker on map
  const map = window._mapInstance;
  const infoWindow = window._infoWindow;
  if (map && infoWindow) {
    createDataMarker(map, infoWindow, loc);
    // Re-run the active filter so the new marker respects it
    const startVal = document.getElementById('start-datetime').value;
    const endVal   = document.getElementById('end-datetime').value;
    if (startVal || endVal) {
      applyDatetimeFilter(startVal ? new Date(startVal) : null, endVal ? new Date(endVal) : null);
    } else {
      updateStats(allMarkers.length, allMarkers.length, 0, false);
    }
  }

  closeAddMarkerModal();
}

/** Show an error message and highlight a field. */
function showFieldError(inputId, errorId, message) {
  document.getElementById(inputId).classList.add('dt-input--error');
  document.getElementById(errorId).textContent = message;
}

/**
 * Convert a datetime-local value ("2025-06-01T14:30") to a display-friendly
 * ISO-like string, or return '' if the input is empty.
 */
function formatDatetimeLocal(value) {
  if (!value) return '';
  // datetime-local gives "YYYY-MM-DDTHH:MM" — return as-is; it's already ISO-compatible
  return value;
}

// ── Wire up modal triggers and controls

// Open from Data Table header
document.getElementById('table-add-marker-btn').addEventListener('click', () => {
  openAddMarkerModal();
});

// Open from OLS Checker — prefill lat/lng if already entered
document.getElementById('ols-add-marker-btn').addEventListener('click', () => {
  const lat = document.getElementById('lat-input').value;
  const lng = document.getElementById('lng-input').value;
  openAddMarkerModal(lat || null, lng || null);
});

// Close controls
document.getElementById('modal-close-btn').addEventListener('click', closeAddMarkerModal);
document.getElementById('modal-cancel-btn').addEventListener('click', closeAddMarkerModal);
document.getElementById('add-marker-backdrop').addEventListener('click', closeAddMarkerModal);

// Submit
document.getElementById('modal-submit-btn').addEventListener('click', validateAndSubmitMarker);

// Keyboard: Enter submits, Escape closes
document.getElementById('add-marker-modal').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); validateAndSubmitMarker(); }
  if (e.key === 'Escape') closeAddMarkerModal();
});

// Clear per-field error styling on input
['modal-id', 'modal-lat', 'modal-lng'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    document.getElementById(id).classList.remove('dt-input--error');
    const errId = id + '-error';
    const errEl = document.getElementById(errId);
    if (errEl) errEl.textContent = '';
  });
});
