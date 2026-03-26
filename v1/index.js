// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  // ── Storage backend: 'sheets' | 'firebase'
  storageBackend: 'sheets',

  // ── Google Sheets / Apps Script
  csvUrl: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQw9s9AkynJ-GfEuiIpqGCuP-SyvC4rP7lvzGdJtPdCCdrOgUd5GiWcF9SCcBl3A_76MZ39ApNr-RJk/pub?gid=0&single=true&output=csv',
  webappUrl: 'https://script.google.com/macros/s/AKfycbwkiAFhUHiwp02T_ofG2ve3rCWV2EBI9ljMusaT3ThQZH72FjGZJtCpuF6ZLUteM9bnaQ/exec',
  
  // ── Firebase / Firestore
  firebase: {
    apiKey: '',
    authDomain: '',
    projectId: '',
    // The Firestore collection that stores marker documents.
    // Each document must contain the fields: id, height, lat, lng,
    // startdatetime, enddatetime  (all strings, same convention as Sheets).
    markersCollection: '',
  },

  // ── Map defaults
  mapsApiKey: '',
  center: { lat: 1.3521, lng: 103.8198 },
  zoom: 12,
};

const CSV_FILES = [
  "csv/CAB.csv",
];

const CSV_FILES2 = [
  "csv/CAB_limit.csv",
];

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

// ─── OLS GEOMETRY

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

// ─── STORAGE ABSTRACTION ──────────────────────────────────────────────────────
//
//  Both backends expose the same two async functions:
//
//    readMarkers()  → Promise<loc[]>
//      Returns an array of location objects:
//      { id, height, lat, lng, startdatetime, enddatetime }  (all strings)
//
//    writeMarker(loc) → Promise<void>
//      Persists a single location object to the backend.
//      The returned promise resolves when the write is acknowledged (or best-
//      effort for Sheets, which cannot easily confirm row insertion).
//
//  The active backend is selected by CONFIG.storageBackend and exposed through
//  the two top-level functions  readMarkers()  and  writeMarker()  below.
// ─────────────────────────────────────────────────────────────────────────────

// ── Shared field order / normalisation ────────────────────────────────────────

const MARKER_FIELDS = ['id', 'height', 'lat', 'lng', 'startdatetime', 'enddatetime'];

/** Normalise any raw object into a clean loc with only the expected fields. */
function normaliseMarker(raw) {
  const loc = {};
  MARKER_FIELDS.forEach(f => { loc[f] = (raw[f] ?? '').toString().trim(); });
  return loc;
}

// ── Google Sheets backend ─────────────────────────────────────────────────────

const SheetsBackend = {
  /**
   * Fetch marker data from the published Google Sheets CSV.
   * Column order in the sheet must match MARKER_FIELDS.
   */
  async readMarkers() {
    const response = await fetch(CONFIG.csvUrl);
    if (!response.ok) throw new Error(`Sheets CSV fetch failed: ${response.status}`);
    const csvText = await response.text();
    console.log('[Sheets] Retrieved CSV:', csvText);

    const rows = csvText.split('\n').filter(row => row.trim() !== '');
    // Skip the header row; map each data row by column index → MARKER_FIELDS
    return rows.slice(1).map(row => {
      const values = row.split(',');
      const raw    = {};
      MARKER_FIELDS.forEach((field, i) => { raw[field] = values[i]?.trim() ?? ''; });
      return normaliseMarker(raw);
    });
  },

  /**
   * POST a new marker row to Google Sheets via the deployed Apps Script web app.
   * The script is expected to accept a JSON body and append a row.
   */
  async writeMarker(loc) {
    const response = await fetch(CONFIG.webappUrl, {
      method: 'POST',
      body:   JSON.stringify({ action: 'create', ...normaliseMarker(loc) }),
    });
    const result = await response.json();
    console.log('[Sheets] Marker written:', result);
  },
  
  /**
   * Update an existing marker row in Google Sheets.
   * Sends a PUT-style POST with action:'update' and the target id.
   */
  async updateMarker(id, updates) {
    const response = await fetch(CONFIG.webappUrl, {
      method: 'POST',
      body:   JSON.stringify({ action: 'update', id, ...normaliseMarker({ id, ...updates }) }),
    });
    const result = await response.json();
    console.log('[Sheets] Marker updated:', result);
  },

  /**
   * Delete a marker row from Google Sheets by its id.
   */
  async deleteMarker(id) {
    const response = await fetch(CONFIG.webappUrl, {
      method: 'POST',
      body:   JSON.stringify({ action: 'delete', id }),
    });
    const result = await response.json();
    console.log('[Sheets] Marker deleted:', result);
  },
};

// ── Firebase / Firestore backend ──────────────────────────────────────────────
//
//  Uses the Firebase JS SDK (compat CDN build) loaded lazily so that
//  Sheets-only deployments incur no extra network cost.
//
//  Firestore native types used
//  ───────────────────────────
//  • GeoPoint  — stores { lat, lng } as a single compound field.
//                Semantically richer than two separate doubles and keeps the
//                document schema tidy.  Billing is per-document, so the field
//                count has no cost impact.  Unpacked to strings on read to
//                keep the shared loc shape consistent across backends.
//
//  • Timestamp — stores startdatetime / enddatetime as native Firestore
//                Timestamps rather than plain strings.  On read, converted to
//                ISO 8601 strings (same format the Sheets backend returns) so
//                the rest of the app is unaffected.  Avoids the raw
//                "Timestamp(seconds=…)" toString output from the SDK.
// ─────────────────────────────────────────────────────────────────────────────

const FirebaseBackend = {
  _db: null,   // cached Firestore instance

  /** Initialise Firebase app + Firestore on first use. */
  async _getDb() {
    if (this._db) return this._db;

    await FirebaseBackend._loadSDK();

    const app = firebase.initializeApp({
      apiKey:     CONFIG.firebase.apiKey,
      authDomain: CONFIG.firebase.authDomain,
      projectId:  CONFIG.firebase.projectId,
    });

    this._db = firebase.firestore(app);
    console.log('[Firebase] Firestore initialised for project:', CONFIG.firebase.projectId);
    return this._db;
  },

  /** Dynamically inject the Firebase compat CDN scripts (package-less). */
  _loadSDK() {
    // Compat builds expose the global `firebase` object — no bundler needed.
    const CDN = 'https://www.gstatic.com/firebasejs/10.12.2';
    const scripts = [
      `${CDN}/firebase-app-compat.js`,
      `${CDN}/firebase-firestore-compat.js`,
    ];

    // Load sequentially: firebase-app must be ready before firestore attaches.
    return scripts.reduce((chain, src) => chain.then(() => loadScript(src)), Promise.resolve());
  },
  // ── Type converters ──────────────────────────────────────────────────────

  /**
   * Convert a Firestore Timestamp (or anything else) to an ISO 8601 string.
   * • Firestore Timestamp  → "YYYY-MM-DDTHH:MM:SS.mmmZ"
   * • Plain string         → returned as-is
   * • null / undefined     → ''
   */
  _timestampToISO(value) {
    if (!value) return '';
    // Firestore compat Timestamp objects expose a toDate() method.
    if (typeof value.toDate === 'function') return value.toDate().toISOString();
    return value.toString();
  },

  /**
   * Convert an ISO 8601 string to a Firestore Timestamp for storage.
   * An empty string results in null — Firestore omits null fields on write.
   */
  _isoToTimestamp(isoString) {
    if (!isoString) return null;
    const date = new Date(isoString);
    if (isNaN(date.getTime())) {
      console.warn('[Firebase] Could not parse datetime string:', isoString);
      return null;
    }
    return firebase.firestore.Timestamp.fromDate(date);
  },

  /**
   * Deserialise a raw Firestore document into a normalised loc object.
   *
   * Expected document shape:
   *   { id: string, height: string, coords: GeoPoint,
   *     startdatetime: Timestamp|null, enddatetime: Timestamp|null }
   *
   * Falls back gracefully if coords is stored as separate lat/lng fields
   * (i.e. documents written before the GeoPoint migration).
   */
  _docToLoc(data) {
    // ── Coordinates: GeoPoint → separate lat / lng strings
    let lat = '';
    let lng = '';
    if (data.coords && typeof data.coords.latitude === 'number') {
      // Native GeoPoint field
      lat = data.coords.latitude.toString();
      lng = data.coords.longitude.toString();
    } else {
      // Legacy fallback: individual numeric / string fields
      lat = (data.lat ?? '').toString();
      lng = (data.lng ?? '').toString();
    }

    return normaliseMarker({
      id:            data.id            ?? '',
      height:        data.height        ?? '',
      lat,
      lng,
      startdatetime: this._timestampToISO(data.startdatetime),
      enddatetime:   this._timestampToISO(data.enddatetime),
    });
  },

  /**
   * Serialise a normalised loc object into the Firestore document shape.
   * Uses GeoPoint for coordinates and Timestamp for datetimes.
   */
  _locToDoc(loc) {
    return {
      id:            loc.id,
      height:        loc.height || '',
      coords:        new firebase.firestore.GeoPoint(
                       parseFloat(loc.lat),
                       parseFloat(loc.lng)
                     ),
      startdatetime: this._isoToTimestamp(loc.startdatetime),
      enddatetime:   this._isoToTimestamp(loc.enddatetime),
    };
  },

  // ── CRUD ─────────────────────────────────────────────────────────────────

  /**
   * Read all documents from the markers collection and return as loc[].
   * Both GeoPoint-format and legacy lat/lng-format documents are handled.
   */
  async readMarkers() {
    const db       = await this._getDb();
    const snapshot = await db.collection(CONFIG.firebase.markersCollection).get();

    const markers = snapshot.docs.map(doc => this._docToLoc(doc.data()));
    console.log(`[Firebase] Read ${markers.length} markers from '${CONFIG.firebase.markersCollection}'`);
    return markers;
  },

  /**
   * Write a marker document to Firestore.
   * Document ID = loc.id  (human-readable; re-submitting the same ID is idempotent).
   * Coordinates stored as GeoPoint; datetimes stored as Timestamps.
   */
  async writeMarker(loc) {
    const db  = await this._getDb();
    const doc = this._locToDoc(loc);
    await db.collection(CONFIG.firebase.markersCollection).doc(doc.id).set(doc);
    console.log('[Firebase] Marker written:', doc.id);
  },
  
  /**
   * Update an existing Firestore document by id.
   * Only the fields present in `updates` are merged/overwritten.
   */
  async updateMarker(id, updates) {
    const db = await this._getDb();
    const partial = {};
    if (updates.height != null) partial.height = updates.height;
    if (updates.lat != null && updates.lng != null) {
      partial.coords = new firebase.firestore.GeoPoint(
        parseFloat(updates.lat), parseFloat(updates.lng)
      );
    }
    if ('startdatetime' in updates) partial.startdatetime = this._isoToTimestamp(updates.startdatetime);
    if ('enddatetime'   in updates) partial.enddatetime   = this._isoToTimestamp(updates.enddatetime);

    await db.collection(CONFIG.firebase.markersCollection).doc(id).update(partial);
    console.log('[Firebase] Marker updated:', id);
  },

  /**
   * Delete a Firestore document by id.
   */
  async deleteMarker(id) {
    const db = await this._getDb();
    await db.collection(CONFIG.firebase.markersCollection).doc(id).delete();
    console.log('[Firebase] Marker deleted:', id);
  },
};

// ── Active backend ─────────────────────────────────────────────────────────────

/** Map of backend name → implementation. Add new backends here. */
const STORAGE_BACKENDS = {
  sheets:   SheetsBackend,
  firebase: FirebaseBackend,
};

/** Resolve the backend once at startup. Throws early for typos in CONFIG. */
function resolveBackend() {
  const key     = (CONFIG.storageBackend || 'sheets').toLowerCase();
  const backend = STORAGE_BACKENDS[key];
  if (!backend) {
    throw new Error(
      `Unknown storageBackend "${CONFIG.storageBackend}". ` +
      `Valid options: ${Object.keys(STORAGE_BACKENDS).join(', ')}`
    );
  }
  console.log(`[Storage] Active backend: ${key}`);
  return backend;
}

const activeBackend = resolveBackend();

/**
 * Read all markers from the active storage backend.
 * @returns {Promise<Array<{id,height,lat,lng,startdatetime,enddatetime}>>}
 */
async function readMarkers() {
  return activeBackend.readMarkers();
}

/**
 * Persist a single marker to the active storage backend.
 * @param {{ id, height, lat, lng, startdatetime, enddatetime }} loc
 */
async function writeMarker(loc) {
  return activeBackend.writeMarker(loc);
}

/**
 * Update fields of an existing marker in the active storage backend.
 * @param {string} id  - the marker's id
 * @param {object} updates - partial loc fields to update
 */
async function updateMarker(id, updates) {
  return activeBackend.updateMarker(id, updates);
}

/**
 * Delete a marker from the active storage backend.
 * @param {string} id
 */
async function deleteMarker(id) {
  return activeBackend.deleteMarker(id);
}

// ─── UTILITY HELPERS

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

/** Inject a <script> tag and resolve when it loads. */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s   = document.createElement('script');
    s.src     = src;
    s.onload  = resolve;
    s.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(s);
  });
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
let allMarkers = []; // [{ marker, loc }]
let layer1Polygons = []; // google.maps.Polygon[] from CSV_FILES
let layer2Polygons = []; // google.maps.Polygon[] from OLS surfaces

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

      // Overlap: marker ends after filterStart AND marker starts before filterEnd
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

// ─── SIDEBAR TAB SWITCHING
document.querySelectorAll('.sidebar-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('sidebar-tab--active'));
    tab.classList.add('sidebar-tab--active');
    document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.add('sidebar-panel--hidden'));
    document.getElementById('panel-' + target).classList.remove('sidebar-panel--hidden');
  });
});

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
    return (loc.id || '').toLowerCase().includes(query) ||
           (loc.startdatetime || '').toLowerCase().includes(query) ||
           (loc.enddatetime || '').toLowerCase().includes(query);
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
    tbody.innerHTML = `<tr class="table-no-results"><td colspan="6">No matching entries</td></tr>`;
    return;
  }

  const frag = document.createDocumentFragment();
  rows.forEach(loc => {
    const lat = parseFloat(loc.lat);
    const lng = parseFloat(loc.lng);
    const expired = isExpired(loc);
    const tr  = document.createElement('tr');
    if (expired) tr.classList.add('row--expired');

    // Coords cell — navigate button
    const coordsCell = document.createElement('td');
    const btn = document.createElement('button');
    btn.className = 'nav-link';
    btn.title = `Navigate to ${lat}, ${lng}`;
    btn.innerHTML = `▶ ${isNaN(lat) ? '—' : lat.toFixed(5)}, ${isNaN(lng) ? '—' : lng.toFixed(5)}`;
    btn.addEventListener('click', () => navigateToMarker(lat, lng));
    coordsCell.appendChild(btn);
    
    // Actions cell — Edit + Delete
    const actionsCell = document.createElement('td');
    actionsCell.className = 'actions-cell';

    const editBtn = document.createElement('button');
    editBtn.className = 'action-btn action-btn--edit';
    editBtn.title = 'Edit marker';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', () => openEditMarkerModal(loc));

    const delBtn = document.createElement('button');
    delBtn.className = 'action-btn action-btn--delete';
    delBtn.title = 'Delete marker';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => confirmDeleteMarker(loc));

    actionsCell.appendChild(editBtn);
    actionsCell.appendChild(delBtn);

    tr.innerHTML = `<td>${loc.id || '—'}</td>`;
    tr.appendChild(coordsCell);
    
    // Height cell — value + chart trigger button
    const heightCell = document.createElement('td');
    const heightVal  = loc.height || '';
    if (heightVal) {
      const chartBtn = document.createElement('button');
      chartBtn.className = 'height-chart-btn';
      chartBtn.title = 'Show height chart';
      chartBtn.innerHTML = `${heightVal} <span class="height-chart-icon">▲</span>`;
      chartBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showHeightChart(chartBtn, heightVal, loc.lat, loc.lng, loc.id);
      });
      heightCell.appendChild(chartBtn);
    } else {
      heightCell.textContent = '—';
    }

    tr.appendChild(heightCell);
    tr.insertAdjacentHTML('beforeend', `
      <td>${loc.startdatetime || '—'}</td>
      <td class="${expired ? 'cell--expired' : ''}">${loc.enddatetime || '—'}</td>`);
    tr.appendChild(actionsCell);

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

/**
 * Open the table overlay and pre-fill the search box with the given query.
 * Called from InfoWindow ID links.
 */
function openTableWithSearch(query) {
  const searchEl = document.getElementById('table-search');
  searchEl.value = query;
  document.getElementById('table-search-clear').hidden = false;
  openTableOverlay();
  renderTable();
}

// ── Table controls wiring
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

// ─── HEIGHT CHART ─────────────────────────────────────────────────────────────
//
//  The chart is a simple 2-D cross-section of the OLS slope:
//    X-axis — perpendicular distance across the surface (0 → maxd)
//    Y-axis — height (0 → maxh)
//    Slope  — a straight line from (0,0) to (chartW, maxh), same angle for all surfaces
//
//  The marker is drawn as a vertical bar at its perpendicular-distance fraction
//  along the X-axis, rising to its height (clamped to maxh for drawing).
//  Green = below the slope limit at that position. Red = above it.
//  Outside OLS → empty chart.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve OLS surface membership and return geometry needed for the chart.
 *
 * Returns:
 *   surface  — 'ts' | 'its' | 'rwy' | 'outside'
 *   perpFrac — perpendicular-distance fraction 0→1 across the surface (null outside)
 *   limit    — OLS height limit at this exact position = maxh * perpFrac  (null outside)
 *   maxh     — surface absolute maximum height (null outside)
 *   maxd     — surface perpendicular depth in metres (null outside)
 */
function resolveOLSSurface(lat, lng) {
  if (!thresholdA || !thresholdB)  return { surface: 'outside', perpFrac: null, limit: null, maxh: null, maxd: null };
  if (isNaN(lat)  || isNaN(lng))   return { surface: 'outside', perpFrac: null, limit: null, maxh: null, maxd: null };

  const point    = { lat, lng };
  const olsPolys = get_ols_polygons(vectorise(thresholdA, thresholdB));

  if (point_in_polygon(olsPolys.rwy, point)) {
    return { surface: 'rwy', perpFrac: 0, limit: 0, maxh: 0, maxd: 0 };
  }

  for (const poly of [olsPolys.ts1, olsPolys.ts2]) {
    if (point_in_polygon(poly, point)) {
      const perpAbs = Math.abs(orth_dist(vectorise(poly[0], poly[1]), point).perpDistance);
      const perpFrac = Math.min(perpAbs / TS_DIST, 1);
      return { surface: 'ts', perpFrac, limit: TS_MAXH * perpFrac, maxh: TS_MAXH, maxd: TS_DIST };
    }
  }

  for (const poly of [olsPolys.its1, olsPolys.its2]) {
    if (point_in_polygon(poly, point)) {
      const perpAbs = Math.abs(orth_dist(vectorise(poly[0], poly[1]), point).perpDistance);
      const perpFrac = Math.min(perpAbs / ITS_DIST, 1);
      return { surface: 'its', perpFrac, limit: ITS_MAXH * perpFrac, maxh: ITS_MAXH, maxd: ITS_DIST };
    }
  }

  return { surface: 'outside', perpFrac: null, limit: null, maxh: null, maxd: null };
}

/**
 * Build the height chart SVG.
 *
 * Visual layout:
 *   - Diagonal slope line from bottom-left (0,0) to top-right (maxd, maxh).
 *   - Vertical marker bar at x = perpFrac * chartW, height = min(h, maxh).
 *   - Green bar if h ≤ limit at that position; red bar if h > limit.
 *   - Actual height labelled even when clamped.
 *   - Y-axis: 0 at bottom → maxh at top.
 *   - X-axis: inner edge (0) → outer edge (maxd).
 *   - Outside OLS: empty axes with "Outside OLS" message.
 *
 * @param {number|string} heightVal
 * @param {number|string} lat
 * @param {number|string} lng
 * @param {string}        [label]
 * @returns {string} HTML string
 */
function buildHeightChart(heightVal, lat, lng, label = 'Height vs OLS') {
  const h = parseFloat(heightVal);
  const hasH = !isNaN(h) && heightVal !== '';

  const { surface, perpFrac, limit, maxh } = resolveOLSSurface(
    parseFloat(lat), parseFloat(lng)
  );

  // ── Per-surface colour palette
  const PALETTE = {
    ts:      { accent: '#FFAA00', badge: 'TAKEOFF SURFACE' },
    its:     { accent: '#00BBEE', badge: 'INNER TRANSITION' },
    rwy:     { accent: '#aaaaaa', badge: 'RUNWAY STRIP' },
    outside: { accent: '#3a4a5c', badge: 'OUTSIDE OLS' },
  };
  const pal = PALETTE[surface];

  // ── SVG canvas
  const W = 224, H = 160;
  const padL = 36, padR = 12, padT = 30, padB = 28;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const baseY  = padT + chartH;   // y-pixel of the x-axis
  const topY   = padT;            // y-pixel of maxh

  // Convert a height value → y pixel (clamped to chart)
  const yPx = v => baseY - Math.min(v / (maxh || 1), 1) * chartH;

  // Marker bar x-pixel (centre) and drawn height
  const barX     = perpFrac !== null ? padL + perpFrac * chartW : null;
  const barPxH   = hasH && maxh > 0 ? Math.min(h / maxh, 1) * chartH : 0;
  const barY     = baseY - barPxH;
  const isBreech = hasH && limit !== null && h > limit;
  const barColor = !hasH || surface === 'outside' ? '#3a4a5c': isBreech ? '#ff4d4d':'#00e5a0';

  // Y-axis ticks: 0, maxh/2, maxh  (keep it simple)
  const yTicks = maxh > 0 ? [0, Math.round(maxh / 2), maxh] : [0];

  // ── Build SVG
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="font-family:'Space Mono',monospace;display:block">`;

  // Background
  svg += `<rect width="${W}" height="${H}" rx="5" fill="#0b0f14"/>`;

  // Title
  svg += `<text x="${padL}" y="13" font-size="8" fill="#5a6a80" font-weight="700" letter-spacing="0.5">${label.toUpperCase()}</text>`;

  // Surface badge (top-right)
  const badgeW = 94;
  svg += `<rect x="${W - padR - badgeW}" y="3" width="${badgeW}" height="14" rx="3" fill="${pal.accent}" opacity="0.12"/>`;
  svg += `<text x="${W - padR - badgeW / 2}" y="12.5" text-anchor="middle" font-size="6.5" fill="${pal.accent}" font-weight="700" letter-spacing="0.3">${pal.badge}</text>`;

  // Y-axis spine + label
  svg += `<line x1="${padL}" y1="${topY}" x2="${padL}" y2="${baseY}" stroke="#2a3a4a" stroke-width="1.5"/>`;
  svg += `<text x="${padL - 5}" y="${topY - 4}" text-anchor="end" font-size="7" fill="#3a4a5c">m</text>`;

  // X-axis baseline
  svg += `<line x1="${padL}" y1="${baseY}" x2="${padL + chartW}" y2="${baseY}" stroke="#2a3a4a" stroke-width="1.5"/>`;

  // X-axis labels
  svg += `<text x="${padL}" y="${baseY + 12}" text-anchor="middle" font-size="7" fill="#3a4a5c">0</text>`;
  if (maxh > 0) {
    svg += `<text x="${padL + chartW}" y="${baseY + 12}" text-anchor="middle" font-size="7" fill="#3a4a5c">max</text>`;
    svg += `<text x="${padL + chartW / 2}" y="${baseY + 20}" text-anchor="middle" font-size="6.5" fill="#2a3a4a">← distance →</text>`;
  }

  // Y-axis ticks
  yTicks.forEach(tick => {
    if (maxh === 0) return;
    const y = yPx(tick);
    svg += `<line x1="${padL - 3}" y1="${y}" x2="${padL}" y2="${y}" stroke="#2a3a4a" stroke-width="1"/>`;
    svg += `<text x="${padL - 5}" y="${y + 3.5}" text-anchor="end" font-size="7.5" fill="#5a6a80">${tick}</text>`;
  });

  if (surface === 'outside') {
    // ── Empty state
    svg += `<text x="${padL + chartW / 2}" y="${padT + chartH / 2 - 4}" text-anchor="middle" font-size="9" fill="#3a4a5c" font-weight="700">Outside OLS</text>`;
    svg += `<text x="${padL + chartW / 2}" y="${padT + chartH / 2 + 10}" text-anchor="middle" font-size="7.5" fill="#2a3a4a">No surface limit</text>`;

  } else if (surface === 'rwy') {
    // ── Runway: flat limit = 0
    svg += `<text x="${padL + chartW / 2}" y="${padT + chartH / 2}" text-anchor="middle" font-size="8" fill="${pal.accent}" font-weight="700">Runway — limit 0 m</text>`;
    if (hasH && h > 0) {
      svg += `<text x="${padL + chartW / 2}" y="${padT + chartH / 2 + 14}" text-anchor="middle" font-size="8" fill="#ff4d4d" font-weight="700">Breach: ${h} m</text>`;
    }

    } else {
      // ── TS or ITS: draw the slope + marker bar

    // OLS slope line: (padL, baseY) → (padL + chartW, topY)
    svg += `<line x1="${padL}" y1="${baseY}" x2="${padL + chartW}" y2="${topY}" stroke="${pal.accent}" stroke-width="1.5" opacity="0.7"/>`;

    // Shaded slope area (triangle)
    svg += `<polygon points="${padL},${baseY} ${padL + chartW},${topY} ${padL + chartW},${baseY}" fill="${pal.accent}" opacity="0.06"/>`;

    // Marker bar (vertical rect from baseline up to marker height, at barX)
    if (hasH && barX !== null && barPxH > 0) {
      const barW = 10;
      svg += `<rect x="${barX - barW / 2}" y="${barY}" width="${barW}" height="${barPxH}" rx="2" fill="${barColor}" opacity="0.85"/>`;

      // Slope limit dot at barX on the slope line (y = baseY - perpFrac * chartH)
      const slopeLimitY = baseY - perpFrac * chartH;
      svg += `<circle cx="${barX}" cy="${slopeLimitY}" r="3" fill="${pal.accent}" opacity="0.9"/>`;

      // Height label — above bar, flip below if too close to top
      const lblY = barY > padT + 16 ? barY - 5 : barY + 12;
      const lblVal = `${h % 1 === 0 ? h : h.toFixed(1)} m`;
      svg += `<text x="${barX}" y="${lblY}" text-anchor="middle" font-size="8.5" fill="${barColor}" font-weight="700">${lblVal}</text>`;

      // Limit label at the slope dot
      const limLblY = slopeLimitY > padT + 12 ? slopeLimitY - 4 : slopeLimitY + 11;
      svg += `<text x="${barX + 7}" y="${limLblY}" font-size="7" fill="${pal.accent}" opacity="0.85">${limit.toFixed(1)}</text>`;
    } else if (!hasH) {
      svg += `<text x="${padL + chartW / 2}" y="${padT + chartH / 2 + 4}" text-anchor="middle" font-size="8" fill="#3a4a5c">Enter height</text>`;
    }
  }

  svg += `</svg>`;
  return `<div class="height-chart">${svg}</div>`;
}

/**
 * Open the height chart popover anchored to a trigger element.
 */
function showHeightChart(triggerEl, height, lat, lng, markerId) {
  closeHeightChart();

  const pop = document.createElement('div');
  pop.id = 'height-chart-popover';
  pop.className = 'height-chart-popover';
  pop.innerHTML = buildHeightChart(height, lat, lng, markerId || 'Height vs OLS');

  // Position below the trigger
  document.body.appendChild(pop);

  const rect = triggerEl.getBoundingClientRect();
  const popW = 236, popH = 172;
  let left = rect.left + rect.width / 2 - popW / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - popW - 8));
  const top = rect.bottom + popH + 8 > window.innerHeight
    ? rect.top - popH - 6
    : rect.bottom + 6;

  pop.style.left = `${left}px`;
  pop.style.top  = `${top}px`;

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', _heightChartOutsideHandler, { once: true });
  }, 0);
}

function closeHeightChart() {
  document.getElementById('height-chart-popover')?.remove();
}

function _heightChartOutsideHandler(e) {
  if (!document.getElementById('height-chart-popover')?.contains(e.target)) {
    closeHeightChart();
  }
}

// ─── SHARED MARKER FACTORY ────────────────────────────────────────────────────

/**
 * Returns true if the marker's end datetime is in the past (expired).
 * Markers with no end datetime are NOT considered expired.
 */
function isExpired(loc) {
  if (!loc.enddatetime) return false;
  const end = new Date(loc.enddatetime);
  return !isNaN(end.getTime()) && end < new Date();
}

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
  const expired = isExpired(loc);

  // Build a custom pin element so expired markers get a distinct colour
  const pin = document.createElement('div');
  pin.className = expired ? 'map-pin map-pin--expired' : 'map-pin';

  const marker = new google.maps.marker.AdvancedMarkerElement({
    position: { lat, lng },
    map,
    title: `${loc.id} (${lat}, ${lng})`,
    content: pin,
  });

  marker.addListener('gmp-click', () => {
    const expiredBadge = expired
      ? `<span style="color:#ff6b6b;font-size:10px;background:rgba(255,107,107,0.1);border:1px solid rgba(255,107,107,0.35);padding:1px 6px;border-radius:3px;font-family:monospace;">EXPIRED</span><br>`
      : '';
    infoWindow.setContent(`
      <div class="custom-info">
        ${expiredBadge}
        <strong>ID: <a class="info-id-link" onclick="openTableWithSearch('${loc.id.replace(/'/g, "\\'")}')" title="View in table" href="#">${loc.id}</a></strong><br>
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
    readMarkers(),
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
  _updateModalChart();
}

function closeAddMarkerModal() {
  document.getElementById('add-marker-backdrop').classList.add('modal-backdrop--hidden');
  document.getElementById('add-marker-modal').classList.add('modal--hidden');
  closeEditMode();
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
function showFieldError(inputId, errorId, message) {
  document.getElementById(inputId).classList.add('dt-input--error');
  document.getElementById(errorId).textContent = message;
}

function formatDatetimeLocal(value) {
  if (!value) return '';
  return value; // "YYYY-MM-DDTHH:MM" — already ISO-compatible
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
  
  if (_editingMarkerId) {
    // ── UPDATE mode
    updateMarker(_editingMarkerId, loc).catch(err => console.error('[Storage] updateMarker failed:', err));

    // Update in-memory table data
    const tIdx = _tableData.findIndex(l => l.id === _editingMarkerId);
    if (tIdx !== -1) _tableData[tIdx] = { ..._tableData[tIdx], ...loc };

    // Update map marker tooltip and remove/re-add with refreshed pin colour
    const mIdx = allMarkers.findIndex(m => m.loc.id === _editingMarkerId);
    if (mIdx !== -1) {
      const { marker, loc: oldLoc } = allMarkers[mIdx];
      const wasOnMap = marker.map;
      marker.map = null;   // remove old marker
      allMarkers.splice(mIdx, 1);
      if (wasOnMap) {
        createDataMarker(window._mapInstance, window._infoWindow, loc);
      } else {
        allMarkers.push({ marker: { map: null }, loc });
      }
    }

    renderTable();
    closeAddMarkerModal();
    return;
  }

  // ── ADD mode

  // Persist to active backend (non-blocking)
  writeMarker(loc).catch(err => console.error('[Storage] writeMarker failed:', err));

  // Optimistically update the UI
  _tableData.push(loc);
  renderTable();
  updateStats(allMarkers.length + 1, allMarkers.length + 1, 0, false);

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

// ─── EDIT MARKER ──────────────────────────────────────────────────────────────

let _editingMarkerId = null;  // tracks which marker is being edited

function openEditMarkerModal(loc) {
  _editingMarkerId = loc.id;

  // Populate modal fields with existing values
  document.getElementById('modal-id').value = loc.id || '';
  document.getElementById('modal-id').readOnly = true;   // id is the primary key — lock it
  document.getElementById('modal-id').style.opacity = '0.5';
  document.getElementById('modal-lat').value = loc.lat || '';
  document.getElementById('modal-lng').value = loc.lng || '';
  document.getElementById('modal-height').value = loc.height || '';
  document.getElementById('modal-start').value = loc.startdatetime
    ? loc.startdatetime.slice(0, 16) : '';  // trim to "YYYY-MM-DDTHH:MM"
  document.getElementById('modal-end').value = loc.enddatetime
    ? loc.enddatetime.slice(0, 16) : '';

  document.getElementById('modal-title').textContent = 'Edit Marker';
  document.getElementById('modal-submit-btn').textContent = 'Save Changes';

  clearModalErrors();
  document.getElementById('add-marker-backdrop').classList.remove('modal-backdrop--hidden');
  document.getElementById('add-marker-modal').classList.remove('modal--hidden');
  document.getElementById('modal-lat').focus();
  _updateModalChart();
}

function closeEditMode() {
  _editingMarkerId = null;
  document.getElementById('modal-id').readOnly = false;
  document.getElementById('modal-id').style.opacity = '';
  document.getElementById('modal-title').textContent = 'Add Marker';
  document.getElementById('modal-submit-btn').textContent = 'Add Marker';
}

// ─── DELETE MARKER ────────────────────────────────────────────────────────────

function confirmDeleteMarker(loc) {
  // Custom confirm dialog using the existing modal-backdrop
  const confirmed = window.confirm(
    `Delete marker "${loc.id}"?\n\nThis action cannot be undone.`
  );
  if (!confirmed) return;

  // Remove from backend (non-blocking)
  deleteMarker(loc.id).catch(err => console.error('[Storage] deleteMarker failed:', err));

  // Remove from allMarkers and map
  const idx = allMarkers.findIndex(m => m.loc.id === loc.id);
  if (idx !== -1) {
    allMarkers[idx].marker.map = null;  // remove from map
    allMarkers.splice(idx, 1);
  }

  // Remove from table data and re-render
  _tableData = _tableData.filter(l => l.id !== loc.id);
  renderTable();
  updateStats(allMarkers.length, allMarkers.filter(m => m.marker.map).length,
    allMarkers.filter(m => !m.marker.map).length, false);

  console.log('[UI] Marker deleted:', loc.id);
}

// ─── MODAL HEIGHT CHART ───────────────────────────────────────────────────────

/** Re-render the inline chart inside the modal based on the current height input. */
function _updateModalChart() {
  const container = document.getElementById('modal-height-chart');
  if (!container) return;
  const height = document.getElementById('modal-height').value;
  const lat    = parseFloat(document.getElementById('modal-lat').value);
  const lng    = parseFloat(document.getElementById('modal-lng').value);
  const id     = document.getElementById('modal-id').value.trim();
  container.innerHTML = buildHeightChart(height, lat, lng, id || 'Height vs OLS');
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
    const errEl = document.getElementById(id + '-error');
    if (errEl) errEl.textContent = '';
  });
});

// Live-update the height chart in the modal as the user types
document.getElementById('modal-height').addEventListener('input', _updateModalChart);
document.getElementById('modal-id').addEventListener('input', _updateModalChart);
document.getElementById('modal-lat').addEventListener('input', _updateModalChart);
document.getElementById('modal-lng').addEventListener('input', _updateModalChart);