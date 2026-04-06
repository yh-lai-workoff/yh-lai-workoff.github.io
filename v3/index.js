// ════════════════════════════════════════════════════════
//  1. CSV PARSING — generic, decoupled from source
// ════════════════════════════════════════════════════════

function parseCSV(raw) {
  const lines = raw.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
    return obj;
  });
}

// ════════════════════════════════════════════════════════
//  2. DATA RETRIEVAL — swap implementations freely
// ════════════════════════════════════════════════════════

// Declared here so retrieveAssignments (below) can safely reference them
// before initFirebase() is called in init().
let db = null;           // Firestore instance, null until initFirebase()
let useFirebase = false; // toggled true once Firebase init succeeds

async function fetchCSVText(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${path}`);
  return res.text();
}

// Returns raw parsed rows; callers normalise to domain objects
async function retrieveLots() { return parseCSV(await fetchCSVText('csv/lots.csv')); }
async function retrieveLotConfigs() {
  const res = await fetch('data/lotscfg.json');
  if (!res.ok) throw new Error(`HTTP ${res.status} — csv/lotscfg.json`);
  return res.json(); // returns the parsed array directly
}

/**
 * Retrieve aircraft assignment records.
 * Column order: [0] ID  [1] Code  [2] Length  [3] Wingspan  [4] ACN
 *               [5] Arrival Datetime  [6] Depart Datetime  [7] Assigned Lot  [8] Assigned Slot
 */
async function retrieveAssignments() {
  if (useFirebase) return fbReadAssignments();
  const rows = parseCSV(await fetchCSVText('csv/dummy.csv'));
  return rows.map(r => {
    const v = Object.values(r);
    return {
      id: v[0] ?? '', code: v[1] ?? '', length: v[2] ?? '',
      wingspan: v[3] ?? '', acn: v[4] ?? '', arrival: v[5] ?? '',
      depart: v[6] ?? '', lot: v[7] ?? '', slot: v[8] ?? ''
    };
  });
}

// ════════════════════════════════════════════════════════
//  2b. FIREBASE — CRUD layer (package-less compat SDK)
//      Configure firebaseConfig before going live.
//      CSV methods above are kept for offline/test use.
// ════════════════════════════════════════════════════════

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyDe9qcKHQ0vB73x3KgXCKlz3cx2I3OebiQ",
  authDomain:        "test-fly-apps.firebaseapp.com",
  projectId:         "test-fly-apps",
  // storageBucket:     "REPLACE_WITH_YOUR_STORAGE_BUCKET",
  // messagingSenderId: "REPLACE_WITH_YOUR_MESSAGING_SENDER_ID",
  // appId:             "REPLACE_WITH_YOUR_APP_ID"
};

const COLLECTION = 'queuetable'; // Firestore collection name

function initFirebase() {
  try {
    if (!firebase || !FIREBASE_CONFIG.projectId || FIREBASE_CONFIG.projectId.startsWith('REPLACE')) return false;
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.firestore();
    return true;
  } catch (e) {
    console.warn('[Firebase] init failed — falling back to CSV.', e);
    return false;
  }
}

/** READ — fetch all assignments from Firestore */
async function fbReadAssignments() {
  const snap = await db.collection(COLLECTION).orderBy('arrival').get();
  return snap.docs.map(doc => {
    const d = doc.data();
    // Firestore may return Timestamp objects for datetime fields; normalise to ISO strings
    const toISO = v => (v && typeof v.toDate === 'function') ? v.toDate().toISOString() : (v ?? '');
    return {
      _docId:   doc.id,
      id:       d.id       ?? d.ID       ?? '',
      code:     d.code     ?? d.Code     ?? '',
      length:   d.length   ?? d.Length   ?? '',
      wingspan: d.wingspan  ?? d.Wingspan ?? '',
      acn:      d.acn      ?? d.ACN      ?? '',
      arrival:  toISO(d.arrival ?? d.Arrival),
      depart:   toISO(d.depart  ?? d.Depart),
      lot:      d.lot      ?? d.Lot      ?? '',
      slot:     d.slot     ?? d.Slot     ?? ''
    };
  });
}

/** CREATE — add a new assignment document */
async function fbCreateAssignment(record) {
  const { _docId, ...data } = record; // strip internal field
  const ref = await db.collection(COLLECTION).add(data);
  return { _docId: ref.id, ...data };
}

/** UPDATE — overwrite a document by Firestore doc ID */
async function fbCreateAssignment(record) {
  const { _docId, ...data } = record; // strip internal field
  await db.collection(COLLECTION).doc(data.id).set(data);
  return { _docId: data.id, ...data };
}

/** DELETE — remove a document by Firestore doc ID */
async function fbDeleteAssignment(docId) {
  await db.collection(COLLECTION).doc(docId).delete();
}

// ════════════════════════════════════════════════════════
//  3. APPLICATION STATE
// ════════════════════════════════════════════════════════

const CODE_COLORS = {
  A: '#4da8ff', // blue
  B: '#00d4aa', // teal/green
  C: '#c77dff', // purple
  D: '#ff9f1c', // amber-orange
  E: '#ffcc00', // yellow
  F: '#ff6ec7'  // pink/magenta
};

let lots = [];
let configs = {}; // { lotId: { slots: [{slotNum, maxCode, pcn}] } }
let assignments = [];
let conflictSet = { bad: new Set(), codeBad: new Set(), aclBad: new Set(), acnBad: new Set(), slotBad: new Set() };

let selectedLot = null;

// Viewport
let vpX = 0, vpY = 0, vpScale = 1, minScale = 0.3, maxScale = 6, vpBounds = null;
const BUFFER = 120;

// Table
let sortCol = 'arrival', sortDir = 'asc';
let fID = '', fCodes = new Set();
let fArrFrom = null, fArrTo = null, fDepFrom = null, fDepTo = null;

// ── Map datetime filter state ──────────────────────────
// Defaults to today at 08:30
function defaultMapFilterDT() {
  const d = new Date();
  d.setHours(8, 30, 0, 0);
  return d;
}
let mapFilterDT = defaultMapFilterDT(); // Date | null — null means "show all"

// ── Plane image cache ──────────────────────────────────
// { codeKey: HTMLImageElement | 'loading' | 'error' }
const planeImgCache = {};

// ── Row selection (table CRUD) ─────────────────────────
let selectedRowId = null; // assignment .id of currently selected table row

function setSelectedRow(id) {
  selectedRowId = id;
  document.getElementById('btnUpdate').disabled = !id;
  document.getElementById('btnDelete').disabled = !id;
}

function getPlaneImage(code) {
  const key = code.toLowerCase();
  if (planeImgCache[key]) return planeImgCache[key];
  planeImgCache[key] = 'loading';
  const img = new Image();
  img.onload  = () => { planeImgCache[key] = img; render(); };
  img.onerror = () => { planeImgCache[key] = 'error'; };
  img.src = `assets/code${key}.png`;
  return 'loading';
}

// ════════════════════════════════════════════════════════
//  4. CONFLICT DETECTION
// ════════════════════════════════════════════════════════

// Code ordering for lot-assignment compatibility checks
const CODE_ORDER = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5 };

function overlaps(a1, a2, b1, b2) { return a1 < b2 && b1 < a2; }

/**
 * Each criterion is a function:
 *   (group, cfg, lotId, bad, codeBad, aclBad) => void
 * It mutates the provided Sets to flag conflicting record IDs.
 * Add new criteria by pushing to CONFLICT_CRITERIA below.
 */
const CONFLICT_CRITERIA = [

  // ── Criterion 1: Mixed-code conflict (same lot, overlapping time) ──
  function mixedCode(group, _sc, _lid, bad, codeBad) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (!overlaps(new Date(a.arrival), new Date(a.depart),
                      new Date(b.arrival), new Date(b.depart))) continue;
        if (a.code !== b.code) {
          bad.add(a.id); bad.add(b.id);
          codeBad.add(a.id); codeBad.add(b.id);
        }
      }
    }
  },

  // ── Criterion 2: Capacity — more simultaneous planes than slots ──
  function capacityOverflow(group, slotCfgs, _lid, bad) {
    const maxSlots = slotCfgs.length || Infinity;
    group.forEach(a => {
      const a1 = new Date(a.arrival), a2 = new Date(a.depart);
      const sim = group.filter(b => b.id !== a.id &&
        overlaps(a1, a2, new Date(b.arrival), new Date(b.depart)));
      if (sim.length + 1 > maxSlots) {
        bad.add(a.id); sim.forEach(b => bad.add(b.id));
      }
    });
  },

  // ── Criterion 3: Plane code exceeds slot's maxCode ──
  function codeExceedsSlotMax(group, _sc, _lid, bad, _cb, aclBad, _ab, _sb, slotCfgFor) {
    group.forEach(a => {
      const sc = slotCfgFor(a);
      if (!sc) return;
      if ((CODE_ORDER[a.code] ?? 0) > (CODE_ORDER[sc.maxCode] ?? -1)) {
        bad.add(a.id); aclBad.add(a.id);
      }
    });
  },

  // ── Criterion 4: ACN exceeds slot PCN ──
  function acnExceedsSlotPcn(group, _sc, _lid, bad, _cb, _ab, acnBad, _sb, slotCfgFor) {
    group.forEach(a => {
      const sc = slotCfgFor(a);
      if (!sc) return;
      const acn = parseInt(a.acn);
      if (!isNaN(acn) && acn > sc.pcn) { bad.add(a.id); acnBad.add(a.id); }
    });
  },

  // ── Criterion 5: Duplicate slot number, overlapping time ──
  function duplicateSlot(group, _sc, _lid, bad, _cb, _ab, _ab2, slotBad) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (!a.slot || !b.slot || String(a.slot) !== String(b.slot)) continue;
        if (!overlaps(new Date(a.arrival), new Date(a.depart),
                      new Date(b.arrival), new Date(b.depart))) continue;
        bad.add(a.id); bad.add(b.id); slotBad.add(a.id); slotBad.add(b.id);
      }
    }
  },

  // ── ADD NEW CRITERIA HERE ──
  // function myNew(group, slotCfgs, lotId, bad, codeBad, aclBad, acnBad, slotBad, slotCfgFor) {}
  // FUTURE — mutual exclusion (Code E/F forces adjacent slots vacant):
  // function exclusionZone(group, slotCfgs, _lid, bad, _cb, _ab, _anb, _sb, slotCfgFor) {
  //   group.forEach(a => {
  //     const sc = slotCfgFor(a);
  //     if (!sc?.adjacentExclusion?.length) return;
  //     const conflicting = group.filter(b =>
  //       b.id !== a.id && sc.adjacentExclusion.includes(Number(b.slot)) &&
  //       overlaps(new Date(a.arrival), new Date(a.depart), new Date(b.arrival), new Date(b.depart))
  //     );
  //     if (conflicting.length) { bad.add(a.id); conflicting.forEach(b => bad.add(b.id)); }
  //   });
  // }
];

/**
 * Run all criteria against all lots and return flagged ID sets.
 * Returns { bad, codeBad, aclBad, acnBad, slotBad }
 *   bad      — all conflicting IDs (any reason)
 *   codeBad  — mixed-code violations
 *   aclBad   — code-incompatible lot assignment
 *   acnBad   — ACN > PCN violations
 *   slotBad  — duplicate slot number violations
 */
function detectConflicts(assignments, configs) {
  const bad     = new Set();
  const codeBad = new Set();
  const aclBad  = new Set();
  const acnBad  = new Set();
  const slotBad = new Set();

  const byLot = {};
  assignments.forEach(a => { (byLot[a.lot] ??= []).push(a); });

  Object.entries(byLot).forEach(([lotId, group]) => {
    const lotCfg   = configs[lotId]; // { slots: [{slotNum, maxCode, pcn}] }
    const slotCfgs = lotCfg ? lotCfg.slots : [];

    // Helper: get slot config for a given assignment
    const slotCfgFor = a => slotCfgs.find(s => s.slotNum === parseInt(a.slot)) ?? null;

    CONFLICT_CRITERIA.forEach(fn =>
      fn(group, slotCfgs, lotId, bad, codeBad, aclBad, acnBad, slotBad, slotCfgFor)
    );
  });

  return { bad, codeBad, aclBad, acnBad, slotBad };
}


// ════════════════════════════════════════════════════════
//  4b. MAP-FILTER HELPERS
// ════════════════════════════════════════════════════════

/**
 * Returns assignments active at a given Date (or all if dt is null).
 */
function activeAt(dt) {
  if (!dt) return assignments;
  return assignments.filter(a => {
    const arr = new Date(a.arrival), dep = new Date(a.depart);
    return arr <= dt && dt < dep;
  });
}

/**
 * Build per-lot info for the current map filter datetime:
 * { [lotId]: { planes: [{id,code}], hasConflict: bool } }
 *
 * hasConflict is true when any assignment visible in the current filter
 * window also appears in the global conflictSet (capacity or code conflict).
 */
function buildLotOccupancy(dt) {
  const visible = activeAt(dt);
  const byLot = {};
  visible.forEach(a => { (byLot[a.lot] ??= []).push({ id: a.id, code: a.code, slot: a.slot }); });

  const result = {};
  Object.entries(byLot).forEach(([lotId, planes]) => {
    const hasConflict = planes.some(p => conflictSet.bad.has(p.id));
    result[lotId] = { planes, hasConflict };
  });
  return result;
}

// ════════════════════════════════════════════════════════
//  5. CANVAS / MAP
// ════════════════════════════════════════════════════════

const canvas = document.getElementById('mapCanvas');
const ctx = canvas.getContext('2d');
const mapCtr = document.getElementById('mapContainer');

function resizeCanvas() { canvas.width = mapCtr.clientWidth; canvas.height = mapCtr.clientHeight; render(); }
window.addEventListener('resize', resizeCanvas);

const w2s = (wx, wy) => ({ x: (wx - vpX) * vpScale + canvas.width / 2, y: (wy - vpY) * vpScale + canvas.height / 2 });
const s2w = (sx, sy) => ({ x: (sx - canvas.width / 2) / vpScale + vpX, y: (sy - canvas.height / 2) / vpScale + vpY });

function hexRgba(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function lotCorners({ x, y, w, h, bearing }) {
  const r = bearing * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), hw = w / 2, hh = h / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([lx, ly]) => [x + lx * c - ly * s, y + lx * s + ly * c]);
}

function computeBounds() {
  if (!lots.length) return null;
  let mnX = 1e9, mnY = 1e9, mxX = -1e9, mxY = -1e9;
  lots.forEach(l => lotCorners(l).forEach(([cx, cy]) => {
    mnX = Math.min(mnX, cx); mnY = Math.min(mnY, cy);
    mxX = Math.max(mxX, cx); mxY = Math.max(mxY, cy);
  }));
  return { minX: mnX - BUFFER, minY: mnY - BUFFER, maxX: mxX + BUFFER, maxY: mxY + BUFFER };
}

function fitView() {
  vpBounds = computeBounds(); if (!vpBounds) return;
  const ww = vpBounds.maxX - vpBounds.minX, wh = vpBounds.maxY - vpBounds.minY;
  vpScale = Math.min(canvas.width / ww, canvas.height / wh) * 0.9;
  minScale = vpScale * 0.8;
  vpX = (vpBounds.minX + vpBounds.maxX) / 2; vpY = (vpBounds.minY + vpBounds.maxY) / 2;
}

function clamp() {
  if (!vpBounds) return;
  const hw = canvas.width / 2 / vpScale, hh = canvas.height / 2 / vpScale;
  vpX = Math.max(vpBounds.minX + hw, Math.min(vpBounds.maxX - hw, vpX));
  vpY = Math.max(vpBounds.minY + hh, Math.min(vpBounds.maxY - hh, vpY));
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (vpBounds && lots.length) {
    const p1 = w2s(vpBounds.minX + BUFFER / 2, vpBounds.minY + BUFFER / 2);
    const p2 = w2s(vpBounds.maxX - BUFFER / 2, vpBounds.maxY - BUFFER / 2);
    ctx.save();
    ctx.fillStyle = 'rgba(20,32,44,0.5)'; ctx.strokeStyle = 'rgba(42,58,74,0.6)';
    ctx.lineWidth = 1; ctx.setLineDash([6, 4]);
    ctx.fillRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
    ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
    ctx.setLineDash([]); ctx.restore();
  }

  // Pre-compute occupancy once per render
  const occupancy = buildLotOccupancy(mapFilterDT);

  lots.forEach(lot => drawLot(lot, occupancy[lot.id] || null));
  updateInfoBar();
}

// ────────────────────────────────────────────────────────
//  Slot index pattern: fill odd indices first, then even
//  (1-based positions; slot 0-based index = pos-1)
//  e.g. n=5 slots, 2 planes → slot indices [0, 2]  (pos 1, 3)
//  FUTURE CHANGE: replace oddFirstSlots to alter fill order
// ────────────────────────────────────────────────────────
function oddFirstSlots(numSlots, numPlanes) {
  // Build interleaved order: 0, 2, 4, ... then 1, 3, 5, ...
  const order = [];
  for (let i = 0; i < numSlots; i += 2) order.push(i);
  for (let i = 1; i < numSlots; i += 2) order.push(i);
  return order.slice(0, numPlanes);
}

function drawLot(lot, occ) {
  const { id, x, y, w, h, bearing } = lot;
  const lotCfg   = configs[id];
  const slotCfgs = lotCfg ? lotCfg.slots : [];
  const n        = slotCfgs.length || 1;
  const isSel    = selectedLot === id;
  const sc       = w2s(x, y), rad = bearing * Math.PI / 180;

  // slot number → { id, code, hasConflict }
  const slotMap = {};
  if (occ) {
    occ.planes.forEach(p => {
      const sn = parseInt(p.slot);
      if (!isNaN(sn) && sn >= 1)
        slotMap[sn] = { id: p.id, code: p.code, hasConflict: conflictSet.bad.has(p.id) };
    });
  }

  ctx.save(); ctx.translate(sc.x, sc.y); ctx.rotate(rad);
  const sw = w * vpScale, sh = h * vpScale;

  // ── Lot background ──
  ctx.fillStyle = isSel ? 'rgba(0,212,170,0.05)' : 'rgba(14,24,34,0.92)';
  ctx.strokeStyle = isSel ? '#00d4aa' : 'rgba(42,58,74,0.9)';
  ctx.lineWidth = isSel ? 2 : 1;
  ctx.fillRect(-sw / 2, -sh / 2, sw, sh);
  ctx.strokeRect(-sw / 2, -sh / 2, sw, sh);

  // ── Per-slot rendering ──
  const slotW = sw / n;
  for (let i = 0; i < n; i++) {
    const slotNum  = i + 1;
    const sx       = -sw / 2 + i * slotW;
    const occupant = slotMap[slotNum];
    const slotCfg  = slotCfgs[i]; // {slotNum, maxCode, pcn}

    if (occupant) {
      if (occupant.hasConflict) {
        // ── Conflict: red ──
        ctx.fillStyle   = 'rgba(255,77,109,0.15)';
        ctx.strokeStyle = 'rgba(255,77,109,0.85)';
        ctx.lineWidth   = 1.2;
        ctx.fillRect(sx + 1, -sh / 2 + 1, slotW - 2, sh - 2);
        ctx.strokeRect(sx + 1, -sh / 2 + 1, slotW - 2, sh - 2);
        // Hatch
        ctx.save();
        ctx.beginPath(); ctx.rect(sx + 1, -sh / 2 + 1, slotW - 2, sh - 2); ctx.clip();
        ctx.strokeStyle = 'rgba(255,77,109,0.25)'; ctx.lineWidth = 1;
        ctx.beginPath();
        const step = Math.max(slotW, sh) / 6;
        for (let d = -(slotW + sh); d < slotW + sh; d += step) {
          ctx.moveTo(sx + d, -sh / 2); ctx.lineTo(sx + d + sh, sh / 2);
        }
        ctx.stroke(); ctx.restore();
      } else {
        // ── Occupied: color = plane's code color ──
        const col = CODE_COLORS[occupant.code] || '#888';
        ctx.fillStyle   = hexRgba(col, 0.18);
        ctx.strokeStyle = hexRgba(col, 0.75);
        ctx.lineWidth   = 1;
        ctx.fillRect(sx + 1, -sh / 2 + 1, slotW - 2, sh - 2);
        ctx.strokeRect(sx + 1, -sh / 2 + 1, slotW - 2, sh - 2);
      }
    } else {
      // ── Empty ──
      ctx.fillStyle   = 'rgba(255,255,255,0.02)';
      ctx.strokeStyle = 'rgba(42,58,74,0.55)';
      ctx.lineWidth   = 0.7;
      ctx.fillRect(sx + 1, -sh / 2 + 1, slotW - 2, sh - 2);
      ctx.strokeRect(sx + 1, -sh / 2 + 1, slotW - 2, sh - 2);
    }

    // Slot number
    if (slotW > 12 && sh > 10) {
      let labelCol;
      if (occupant?.hasConflict)  labelCol = 'rgba(255,77,109,0.85)';
      else if (occupant)          labelCol = hexRgba(CODE_COLORS[occupant.code] || '#888', 0.9);
      else                        labelCol = 'rgba(90,122,138,0.45)';
      ctx.fillStyle = labelCol;
      ctx.font = `bold ${Math.min(10, slotW * 0.4)}px 'Share Tech Mono',monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(slotNum, sx + slotW / 2, 0);
    }
  }

  // ── Plane images — non-conflict occupied slots only ──
  Object.entries(slotMap).forEach(([snStr, occupant]) => {
    if (occupant.hasConflict) return;
    const slotNum = parseInt(snStr), i = slotNum - 1;
    if (i < 0 || i >= n) return;
    const sx  = -sw / 2 + i * slotW;
    const img = getPlaneImage(occupant.code);
    if (!img || img === 'loading' || img === 'error') {
      if (img === 'error') {
        const col = CODE_COLORS[occupant.code] || '#888';
        const pad = Math.max(2, slotW * 0.1), padH = Math.max(2, sh * 0.1);
        ctx.fillStyle = hexRgba(col, 0.25); ctx.strokeStyle = hexRgba(col, 0.6);
        ctx.lineWidth = 1;
        ctx.fillRect(sx + pad, -sh / 2 + padH, slotW - pad * 2, sh - padH * 2);
        ctx.strokeRect(sx + pad, -sh / 2 + padH, slotW - pad * 2, sh - padH * 2);
      }
      return;
    }
    const pad = Math.max(2, Math.min(slotW, sh) * 0.08);
    const availW = slotW - pad * 2, availH = sh - pad * 2;
    const imgAspect = img.naturalWidth / img.naturalHeight;
    let drawW, drawH;
    if (availW / availH > imgAspect) { drawH = availH; drawW = drawH * imgAspect; }
    else { drawW = availW; drawH = drawW / imgAspect; }
    const drawX = sx + slotW / 2 - drawW / 2, drawY = -sh / 2 + sh / 2 - drawH / 2;
    ctx.save();
    ctx.beginPath(); ctx.rect(sx + 1, -sh / 2 + 1, slotW - 2, sh - 2); ctx.clip();
    ctx.drawImage(img, drawX, drawY, drawW, drawH);
    ctx.restore();
  });

  // ── Lot border ──
  const anyConflict = Object.values(slotMap).some(s => s.hasConflict);
  ctx.strokeStyle = anyConflict ? 'rgba(255,77,109,0.9)' : (isSel ? '#00d4aa' : 'rgba(42,58,74,0.9)');
  ctx.lineWidth   = anyConflict || isSel ? 2 : 1;
  ctx.strokeRect(-sw / 2, -sh / 2, sw, sh);

  // Direction arrow
  if (sh > 14) {
    ctx.strokeStyle = anyConflict ? 'rgba(255,77,109,0.6)' : 'rgba(90,122,138,0.45)';
    ctx.lineWidth = 1.5; ctx.beginPath();
    ctx.moveTo(0, sh / 2 - 4); ctx.lineTo(0, -sh / 2 + 4);
    ctx.moveTo(-4, -sh / 2 + 10); ctx.lineTo(0, -sh / 2 + 4); ctx.lineTo(4, -sh / 2 + 10);
    ctx.stroke();
  }

  // Lot ID label only (no code label)
  if (sw > 20 || sh > 20) {
    const lsz = Math.max(9, Math.min(14, sw * 0.12));
    ctx.font = `bold ${lsz}px 'Barlow Condensed',sans-serif`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = anyConflict ? '#ff4d6d' : (isSel ? '#00d4aa' : 'rgba(90,122,138,0.9)');
    ctx.fillText(id, -sw / 2 + 3, -sh / 2 - 3 / vpScale);
  }
  ctx.restore();
}

// Pan/Zoom
let panning = false, psx, psy, pvx, pvy;
let activeView = 'map'; // 'map' | 'table'

function isMapActive() { return activeView === 'map'; }

canvas.addEventListener('mousedown', e => {
  if (!isMapActive() || e.button !== 0) return;
  panning = true; psx = e.clientX; psy = e.clientY; pvx = vpX; pvy = vpY;
});
window.addEventListener('mouseup', () => { panning = false; });
window.addEventListener('mousemove', e => {
  if (!isMapActive()) return;
  const R = canvas.getBoundingClientRect();
  const sw = s2w(e.clientX - R.left, e.clientY - R.top);
  document.getElementById('mapCoords').textContent = `X: ${sw.x.toFixed(1)}  Y: ${sw.y.toFixed(1)}`;
  if (!panning) { hoverCheck(e.clientX - R.left, e.clientY - R.top, e.clientX, e.clientY); return; }
  vpX = pvx - (e.clientX - psx) / vpScale; vpY = pvy - (e.clientY - psy) / vpScale;
  clamp(); render();
});
canvas.addEventListener('wheel', e => {
  if (!isMapActive()) return;
  e.preventDefault();
  const R = canvas.getBoundingClientRect(), mx = e.clientX - R.left, my = e.clientY - R.top;
  const wb = s2w(mx, my), f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  vpScale = Math.max(minScale, Math.min(maxScale, vpScale * f));
  const wa = s2w(mx, my); vpX += wb.x - wa.x; vpY += wb.y - wa.y; clamp(); render();
}, { passive: false });
const doZoom = f => { if (!isMapActive()) return; vpScale = Math.max(minScale, Math.min(maxScale, vpScale * f)); clamp(); render(); };
document.getElementById('zoomIn').onclick  = () => doZoom(1.3);
document.getElementById('zoomOut').onclick = () => doZoom(1 / 1.3);
document.getElementById('resetView').onclick = () => { if (!isMapActive()) return; fitView(); render(); };

function hitTest(sx, sy) {
  const { x: wx, y: wy } = s2w(sx, sy);
  for (let i = lots.length - 1; i >= 0; i--) {
    const l = lots[i], r = -(l.bearing * Math.PI / 180);
    const dx = wx - l.x, dy = wy - l.y;
    const lx = dx * Math.cos(r) - dy * Math.sin(r), ly = dx * Math.sin(r) + dy * Math.cos(r);
    if (Math.abs(lx) <= l.w / 2 && Math.abs(ly) <= l.h / 2) return l;
  }
  return null;
}

function hoverCheck(sx, sy, cx, cy) {
  const tt  = document.getElementById('tooltip');
  const lot = hitTest(sx, sy);
  if (!lot) {
    tt.style.display = 'none';
    canvas.style.cursor = panning ? 'grabbing' : 'grab';
    return;
  }

  // Determine which slot was hit within the lot
  const lotCfg   = configs[lot.id];
  const slotCfgs = lotCfg ? lotCfg.slots : [];
  const n        = slotCfgs.length || 1;
  const rad      = -(lot.bearing * Math.PI / 180);
  const { x: wx, y: wy } = s2w(sx, sy);
  const dx = wx - lot.x, dy = wy - lot.y;
  // Rotate into lot-local space
  const lx = dx * Math.cos(rad) - dy * Math.sin(rad); // along width axis
  const slotFrac = (lx + lot.w / 2) / lot.w;          // 0..1 from left
  const slotIdx  = Math.min(n - 1, Math.max(0, Math.floor(slotFrac * n)));
  const slotNum  = slotIdx + 1;
  const slotCfg  = slotCfgs[slotIdx] ?? null;

  // Find any assignment occupying this slot right now
  const occ = buildLotOccupancy(mapFilterDT)[lot.id];
  const occupant = occ ? occ.planes.find(p => parseInt(p.slot) === slotNum) : null;
  const assignment = occupant ? assignments.find(a => a.id === occupant.id) : null;

  const hasConflict = occupant && conflictSet.bad.has(occupant.id);
  const maxCode     = slotCfg ? slotCfg.maxCode : '—';
  const pcn         = slotCfg ? slotCfg.pcn : '—';
  const codeCol     = occupant ? (CODE_COLORS[occupant.code] || '#888') : 'var(--text-dim)';
  const conflStr    = hasConflict ? ' <span style="color:var(--danger)">⚠ CONFLICT</span>' : '';

  let html = `<div class="tt-title">STAND ${lot.id} — SLOT ${slotNum}</div>
    <div class="tt-row"><span>MAX CODE</span><span>${maxCode}</span></div>
    <div class="tt-row"><span>PCN</span><span>${pcn}</span></div>`;

  if (occupant && assignment) {
    const fmtT = s => s ? new Date(s).toLocaleString('en-GB',
      { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', hour12:false }) : '—';
    html += `
    <div class="tt-row"><span>FLIGHT</span><span style="color:${codeCol}">${assignment.id}</span></div>
    <div class="tt-row"><span>CODE</span><span style="color:${codeCol}">${assignment.code}</span></div>
    <div class="tt-row"><span>ACN</span><span>${assignment.acn || '—'}</span></div>
    <div class="tt-row"><span>ARR</span><span>${fmtT(assignment.arrival)}</span></div>
    <div class="tt-row"><span>DEP</span><span>${fmtT(assignment.depart)}</span></div>
    <div class="tt-row"><span>STATUS</span><span>${conflStr || '<span style="color:var(--accent)">OK</span>'}</span></div>`;
  } else {
    html += `<div class="tt-row"><span>STATUS</span><span style="color:var(--text-dim)">VACANT</span></div>`;
  }

  tt.style.display = 'block';
  tt.style.left    = (cx + 16) + 'px';
  tt.style.top     = (cy - 10) + 'px';
  tt.innerHTML     = html;
  canvas.style.cursor = 'pointer';
}

canvas.addEventListener('click', e => {
  if (!isMapActive()) return;
  const R = canvas.getBoundingClientRect(), hit = hitTest(e.clientX - R.left, e.clientY - R.top);
  selectedLot = hit ? (selectedLot === hit.id ? null : hit.id) : null;
  syncSidebarSelection(); render();
});

function syncSidebarSelection() {
  document.querySelectorAll('.lot-card').forEach(c => {
    c.classList.toggle('selected', c.dataset.id === selectedLot);
    if (c.dataset.id === selectedLot) c.scrollIntoView({ block: 'nearest' });
  });
}

// ════════════════════════════════════════════════════════
//  6. MAP SIDEBAR UI
// ════════════════════════════════════════════════════════

function buildMapUI() { buildLegend(); buildLotList(); buildMapFilter(); }

function buildLegend() {
  document.getElementById('legend').innerHTML = Object.entries(CODE_COLORS).map(([c, col]) => `
    <div class="legend-item">
      <div class="legend-swatch" style="background:${hexRgba(col, 0.3)};border-color:${col}"></div>
      <span style="color:${col}">${c}</span>
    </div>`).join('');
}

function buildLotList() {
  const el = document.getElementById('lotList'); el.innerHTML = '';
  lots.forEach(lot => {
    const lotCfg   = configs[lot.id];
    const slotCfgs = lotCfg ? lotCfg.slots : [];
    const n        = slotCfgs.length;
    // Summarise maxCodes present
    const card = document.createElement('div');
    card.className = 'lot-card'; card.dataset.id = lot.id;
    if (selectedLot === lot.id) card.classList.add('selected');

    card.innerHTML = `
      <div class="lot-card-header">
        <div class="lot-id">${lot.id}</div>
        <span style="font-family:var(--mono);font-size:11px;color:var(--text-dim);margin-left:auto">${n} SLOT${n !== 1 ? 'S' : ''}</span>
      </div>
      ${!n ? '<div style="font-size:13px;color:var(--text-dim);font-family:var(--mono)">NO CONFIG</div>' : ''}`;

    card.addEventListener('click', () => {
      selectedLot = selectedLot === lot.id ? null : lot.id;
      syncSidebarSelection();
      if (selectedLot) { vpX = lot.x; vpY = lot.y; clamp(); }
      render();
    });
    el.appendChild(card);
  });
}

// ── Map datetime filter UI ────────────────────────────
function toLocalInputValue(dt) {
  // Format Date → "YYYY-MM-DDTHH:MM" for datetime-local input
  const pad = n => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

function buildMapFilter() {
  const el = document.getElementById('mapFilterSection');
  if (!el) return;

  const inputEl  = document.getElementById('mapFilterDT');
  const resetEl  = document.getElementById('mapFilterReset');
  const prevDay  = document.getElementById('mapFilterPrevDay');
  const nextDay  = document.getElementById('mapFilterNextDay');

  // Set default value
  inputEl.value = toLocalInputValue(mapFilterDT);
  updateMapFilterLabel();

  inputEl.addEventListener('change', e => {
    mapFilterDT = e.target.value ? new Date(e.target.value) : defaultMapFilterDT();
    updateMapFilterLabel();
    render();
  });

  resetEl.addEventListener('click', () => {
    mapFilterDT = defaultMapFilterDT();
    inputEl.value = toLocalInputValue(mapFilterDT);
    updateMapFilterLabel();
    render();
  });

  function stepDay(delta) {
    if (!mapFilterDT) mapFilterDT = defaultMapFilterDT();
    mapFilterDT = new Date(mapFilterDT.getTime() + delta * 24 * 60 * 60 * 1000);
    inputEl.value = toLocalInputValue(mapFilterDT);
    updateMapFilterLabel();
    render();
  }

  prevDay.addEventListener('click', () => stepDay(-1));
  nextDay.addEventListener('click', () => stepDay(+1));
}

function updateMapFilterLabel() {
  const lbl = document.getElementById('mapFilterLabel');
  if (!lbl) return;
  const d = mapFilterDT;
  const pad = n => String(n).padStart(2, '0');
  lbl.textContent = `@ ${d.getDate()} ${d.toLocaleString('en',{month:'short'}).toUpperCase()} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  lbl.style.color = 'var(--accent)';
}

// ════════════════════════════════════════════════════════
//  7. TABLE VIEW
// ════════════════════════════════════════════════════════

function buildTableUI() { buildCodeBtns(); renderTable(); }

function buildCodeBtns() {
  const codes = [...new Set(assignments.map(a => a.code))].sort();
  document.getElementById('codeBtns').innerHTML = codes.map(code => {
    const col = CODE_COLORS[code] || '#888', on = fCodes.size === 0 || fCodes.has(code);
    return `<button class="code-filter-btn${on ? ' active' : ''}" data-code="${code}"
      style="${on ? `background:${col};border-color:${col}` : `border-color:${hexRgba(col, 0.4)};color:${col}`}">${code}</button>`;
  }).join('');
  document.getElementById('codeBtns').querySelectorAll('.code-filter-btn').forEach(b =>
    b.addEventListener('click', () => {
      const c = b.dataset.code;
      fCodes.has(c) ? fCodes.delete(c) : fCodes.add(c);
      buildCodeBtns(); renderTable();
    }));
}

function filteredRows() {
  let rows = [...assignments];
  if (fID) rows = rows.filter(r => r.id.toLowerCase().includes(fID.toLowerCase()));
  if (fCodes.size) rows = rows.filter(r => fCodes.has(r.code));
  if (fArrFrom) rows = rows.filter(r => new Date(r.arrival) >= fArrFrom);
  if (fArrTo) rows = rows.filter(r => new Date(r.arrival) <= fArrTo);
  if (fDepFrom) rows = rows.filter(r => new Date(r.depart) >= fDepFrom);
  if (fDepTo) rows = rows.filter(r => new Date(r.depart) <= fDepTo);
  rows.sort((a, b) => {
    let va = a[sortCol] ?? '', vb = b[sortCol] ?? '';
    if (sortCol === 'arrival' || sortCol === 'depart') { va = new Date(va); vb = new Date(vb); }
    else if (sortCol === 'acn' || sortCol === 'slot' || sortCol === 'length' || sortCol === 'wingspan') {
      va = parseFloat(va) || 0; vb = parseFloat(vb) || 0;
    }
    return (va < vb ? -1 : va > vb ? 1 : 0) * (sortDir === 'asc' ? 1 : -1);
  });
  return rows;
}

function fmtDT(s) {
  if (!s) return '—';
  const d = new Date(s); if (isNaN(d)) return s;
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

function renderTable() {
  const rows = filteredRows(), tbody = document.getElementById('tBody');
  const { bad, codeBad, aclBad, acnBad, slotBad } = conflictSet;
  const now = new Date();
  now.setHours(0, 0, 0, 0); // compare at day boundary (today midnight)

  const totalConfl = bad.size;
  document.getElementById('conflictBar').style.display = totalConfl ? 'flex' : 'none';
  document.getElementById('conflictCount').textContent = totalConfl;
  document.getElementById('ibConflItem').style.display = totalConfl ? '' : 'none';
  document.getElementById('ibConfl').textContent = totalConfl;
  document.getElementById('ibRows').textContent = rows.length;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="no-data">NO MATCHING ENTRIES</td></tr>'; return;
  }

  tbody.innerHTML = rows.map(r => {
    const isBad = bad.has(r.id);
    const isCodeBad = codeBad.has(r.id);
    const isAclBad  = aclBad.has(r.id);
    const isAcnBad  = acnBad.has(r.id);
    const isSlotBad = slotBad.has(r.id);
    const col = CODE_COLORS[r.code] || '#888';
    const isSel = r.id === selectedRowId;
    
    // Depart date is in the past (strictly before today midnight)
    const departDate = r.depart ? new Date(r.depart) : null;
    const isExpired  = departDate && departDate < now;

    const codeCellCls = isCodeBad ? ' code-conflict' : '';
    const codeBadge = isCodeBad
      ? `<span class="lot-conflict-badge" style="font-size:12px;font-weight:bold;letter-spacing:1px">${r.code}</span>`
      : `<span class="code-badge" style="color:${col};border-color:${hexRgba(col, 0.5)};background:${hexRgba(col, 0.1)}">${r.code}</span>`;

    // Lot badge — aclBad (code incompatible) shown distinctly
    const lotCls  = (isBad || isAclBad) ? 'conflict' : '';
    const lotBadge = (isBad || isAclBad)
      ? `<span class="lot-conflict-badge">${r.lot || '—'}</span>`
      : `<span class="lot-badge">${r.lot || '—'}</span>`;

    // Slot badge
    const slotCls  = isSlotBad ? 'conflict' : '';
    const slotTxt  = r.slot || '—';

    // ACN badge
    const acnCls   = isAcnBad ? 'conflict' : 'col-dim';

    // Depart cell: conflict overrides expired styling
    const departCls = isBad ? 'conflict' : (isExpired ? 'depart-expired' : '');

    return `<tr class="${isSel ? 'row-selected' : ''}" data-id="${r.id}">
      <td class="col-id">${r.id}</td>
      <td class="${'td-code' + codeCellCls}">${codeBadge}</td>
      <td class="col-dim">${r.length || '—'}</td>
      <td class="col-dim">${r.wingspan || '—'}</td>
      <td class="${acnCls}">${r.acn || '—'}</td>
      <td class="${isBad ? 'conflict' : ''}">${fmtDT(r.arrival)}</td>
      <td class="${departCls}">${fmtDT(r.depart)}${isExpired && !isBad ? ' <span class="expired-tag">EXPIRED</span>' : ''}</td>
      <td class="${lotCls}">${lotBadge}</td>
      <td class="${slotCls}">${slotTxt}</td>
    </tr>`;
  }).join('');

  // Row click → select
  tbody.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.addEventListener('click', () => {
      const id = tr.dataset.id;
      setSelectedRow(selectedRowId === id ? null : id);
      renderTable();
    });
  });
}

// Sort headers
document.querySelectorAll('th[data-col]').forEach(th => {
  th.addEventListener('click', () => {
    const c = th.dataset.col;
    sortDir = (sortCol === c && sortDir === 'asc') ? 'desc' : 'asc'; sortCol = c;
    document.querySelectorAll('th[data-col]').forEach(t => t.classList.remove('sort-asc', 'sort-desc'));
    th.classList.add('sort-' + sortDir);
    renderTable();
  });
});
document.querySelector('th[data-col="arrival"]').classList.add('sort-asc');

// Filter bindings
document.getElementById('fID').addEventListener('input', e => { fID = e.target.value; renderTable(); });
document.getElementById('fArrFrom').addEventListener('change', e => { fArrFrom = e.target.value ? new Date(e.target.value) : null; renderTable(); });
document.getElementById('fArrTo').addEventListener('change', e => { fArrTo = e.target.value ? new Date(e.target.value) : null; renderTable(); });
document.getElementById('fDepFrom').addEventListener('change', e => { fDepFrom = e.target.value ? new Date(e.target.value) : null; renderTable(); });
document.getElementById('fDepTo').addEventListener('change', e => { fDepTo = e.target.value ? new Date(e.target.value) : null; renderTable(); });
document.getElementById('clearFilters').addEventListener('click', () => {
  fID = ''; fCodes.clear(); fArrFrom = fArrTo = fDepFrom = fDepTo = null;
  ['fID', 'fArrFrom', 'fArrTo', 'fDepFrom', 'fDepTo'].forEach(id => document.getElementById(id).value = '');
  buildCodeBtns(); renderTable();
});

// ════════════════════════════════════════════════════════
//  7b. CRUD — modal & toolbar wiring
// ════════════════════════════════════════════════════════

// ── Datetime local helpers ──────────────────────────────
function toInputDT(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr); if (isNaN(d)) return '';
  return toLocalInputValue(d); // reuse existing helper
}

function fromInputDT(val) {
  return val ? new Date(val) : null;
}

// ── Modal open/close ────────────────────────────────────
function openCrudModal(mode, record) {
  const modal = document.getElementById('crudModal');
  // Set state BEFORE showing
  modal._mode   = mode;
  modal._record = record ?? null;

  document.getElementById('modalTitle').textContent = mode === 'create' ? 'NEW ASSIGNMENT' : 'EDIT ASSIGNMENT';
  document.getElementById('modalError').textContent = '';
  document.getElementById('mID').value        = record?.id        ?? '';
  document.getElementById('mCode').value      = record?.code      ?? 'A';
  document.getElementById('mLength').value    = record?.length    ?? '';
  document.getElementById('mWingspan').value  = record?.wingspan  ?? '';
  document.getElementById('mAcn').value       = record?.acn       ?? '';
  document.getElementById('mArrival').value   = toInputDT(record?.arrival ?? '');
  document.getElementById('mDepart').value    = toInputDT(record?.depart  ?? '');
  document.getElementById('mLot').value       = record?.lot       ?? '';
  document.getElementById('mSlot').value      = record?.slot      ?? '';

  document.getElementById('mID').readOnly = mode === 'update';
  
  // Show/hide suggestion panel
  const panel = document.getElementById('lotSuggestPanel');
  panel.style.display = mode === 'create' ? '' : 'none';

  modal.classList.remove('hidden');
  
  if (mode === 'create') {
    // Wire all relevant inputs to refresh suggestion table
    const triggers = ['mCode', 'mAcn', 'mArrival', 'mDepart'];
    triggers.forEach(id => {
      const el = document.getElementById(id);
      // Remove old listener if any, then add fresh one
      el._suggestListener && el.removeEventListener('change', el._suggestListener);
      el.removeEventListener('input', el._suggestListener);
      el._suggestListener = () => refreshLotSuggestions();
      el.addEventListener('change', el._suggestListener);
      el.addEventListener('input',  el._suggestListener);
    });
    refreshLotSuggestions();
  }
}

// ── Lot suggestion logic ────────────────────────────────

/**
 * Rebuild the lot suggestion table shown inside the CREATE modal.
 * Shows one column per parking lot. Rows:
 *   Row 1 (header) : lot IDs
 *   Row 2 (config) : config chip (active during period, or best eligible)
 *   Row 3 (count)  : taken / max slots
 */
function refreshLotSuggestions() {
  const panel = document.getElementById('lotSuggestPanel');
  const tbl   = document.getElementById('lotSuggestTable');
  if (!panel || !tbl) return;

  const planeCode = (document.getElementById('mCode')?.value || '').toUpperCase();
  const acnVal    = parseInt(document.getElementById('mAcn')?.value) || 0;
  const arrVal    = document.getElementById('mArrival')?.value;
  const depVal    = document.getElementById('mDepart')?.value;
  const arrDt     = arrVal ? new Date(arrVal) : null;
  const depDt     = depVal ? new Date(depVal) : null;
  const hasPeriod = arrDt && depDt && arrDt < depDt;

  // For each lot, work out which config to display and occupancy during the period
  const lotData = lots.map(lot => {
    const lotCfg   = configs[lot.id];
    const slotCfgs = lotCfg ? lotCfg.slots : [];
    const n        = slotCfgs.length;

    // Find slots compatible with this plane code
    const planeRank  = CODE_ORDER[planeCode] ?? 0;
    const compatSlots = slotCfgs.filter(s => (CODE_ORDER[s.maxCode] ?? -1) >= planeRank
                                          && (!acnVal || acnVal <= s.pcn));
    const codeOk  = compatSlots.length > 0;
    const pcnOk   = compatSlots.length > 0; // folded into compatSlots filter above
    const available = codeOk;

    let takenSlots = 0;
    if (hasPeriod) {
      takenSlots = assignments.filter(a =>
        a.lot === lot.id &&
        overlaps(new Date(a.arrival), new Date(a.depart), arrDt, depDt)
      ).length;
    }

    const freeCompatSlots = hasPeriod
      ? compatSlots.filter(s => {
          // slot is free if no assignment occupies it during the period
          const takenSlotNums = assignments
            .filter(a => a.lot === lot.id &&
              overlaps(new Date(a.arrival), new Date(a.depart), arrDt, depDt))
            .map(a => parseInt(a.slot));
          return !takenSlotNums.includes(s.slotNum);
        })
      : compatSlots;

    const isFull = available && freeCompatSlots.length === 0;
    // For display: show maxCode range
    const maxCodeSet = [...new Set(slotCfgs.map(s => s.maxCode))].sort(
      (a,b) => (CODE_ORDER[a]??0)-(CODE_ORDER[b]??0));
    const displayCode = maxCodeSet.join('/');
    const minPcn = slotCfgs.length ? Math.min(...slotCfgs.map(s => s.pcn)) : 0;

    return { lot, slotCfgs, compatSlots, freeCompatSlots, takenSlots,
             n, available, isFull, codeOk, pcnOk, displayCode, minPcn };
  });

  // Build table HTML
  const headerCells = lotData.map(d => {
    const cls = d.available && !d.isFull ? 'lsug-lot-avail': d.available ? 'lsug-lot-full' : 'lsug-lot-incompat';
    return `<th class="${cls}">${d.lot.id}</th>`;
  }).join('');

  const configCells = lotData.map(d => {
    if (!d.slotCfgs.length) return `<td class="lsug-cell lsug-none">—</td>`;
    const reasons = [];
    if (!d.codeOk) reasons.push('CODE');
    if (!d.pcnOk)  reasons.push('PCN');
    const incompatTxt = reasons.length
      ? `<span class="lsug-incompat-tag">${reasons.join('+')}</span>` : '';
    return `<td class="lsug-cell ${d.available ? '' : 'lsug-cell-incompat'}">
      <span class="lsug-chip" style="color:var(--text-dim);border-color:var(--border)">
        MAX ${d.displayCode} | PCN≥${d.minPcn}</span>${incompatTxt}
    </td>`;
  }).join('');

  const countCells = lotData.map(d => {
    if (!d.slotCfgs.length) return `<td class="lsug-cell lsug-none">—/—</td>`;
    const free = d.freeCompatSlots.length, total = d.compatSlots.length;
    const cls = d.isFull ? 'lsug-count-full' : (d.available ? 'lsug-count-ok' : 'lsug-count-incompat');
    return `<td class="lsug-cell"><span class="${cls}">${free} free / ${total} compat</span></td>`;
  }).join('');

  tbl.innerHTML = `
    <thead><tr>${headerCells}</tr></thead>
    <tbody>
      <tr>${configCells}</tr>
      <tr>${countCells}</tr>
    </tbody>`;
}

function closeCrudModal() { document.getElementById('crudModal').classList.add('hidden'); }

// ── Validate & collect form ─────────────────────────────
function collectForm() {
  const id       = document.getElementById('mID').value.trim();
  const code     = document.getElementById('mCode').value.trim().toUpperCase();
  const length   = parseFloat(document.getElementById('mLength').value) || 0;
  const wingspan = parseFloat(document.getElementById('mWingspan').value) || 0;
  const acn      = parseInt(document.getElementById('mAcn').value)       || 0;
  const arrival  = fromInputDT(document.getElementById('mArrival').value);
  const depart   = fromInputDT(document.getElementById('mDepart').value);
  const lot      = document.getElementById('mLot').value.trim().toUpperCase();
  const slot     = parseInt(document.getElementById('mSlot').value)      || 0;

  if (!id)      return { err: 'ID IS REQUIRED' };
  if (!code)    return { err: 'CODE IS REQUIRED' };
  if (!arrival) return { err: 'ARRIVAL IS REQUIRED' };
  if (!depart)  return { err: 'DEPART IS REQUIRED' };
  if (!lot)     return { err: 'ASSIGNED LOT IS REQUIRED' };
  if (new Date(arrival) >= new Date(depart)) return { err: 'ARRIVAL MUST BE BEFORE DEPART' };

  return { data: { id, code, length, wingspan, acn, arrival, depart, lot, slot } };
}

// ── CONFIRM button ──────────────────────────────────────
document.getElementById('modalConfirm').addEventListener('click', async () => {
  const modal = document.getElementById('crudModal');
  const { err, data } = collectForm();
  if (err) { document.getElementById('modalError').textContent = err; return; }

  const btn = document.getElementById('modalConfirm');
  btn.textContent = 'SAVING…'; btn.disabled = true;

  try {
    if (useFirebase) {
      if (modal._mode === 'create') {
        const created = await fbCreateAssignment(data);
        assignments.push(created);
      } else {
        // Use original record's id (pre-uppercase normalisation) and preserve _docId
        const originalId = modal._record?.id ?? data.id;
        const existing   = assignments.find(a => a.id === originalId);
        if (!existing) throw new Error(`Record not found: ${originalId}`);
        const merged = { ...existing, ...data, _docId: existing._docId };
        await fbUpdateAssignment(merged);
        const idx = assignments.findIndex(a => a.id === originalId);
        if (idx !== -1) assignments[idx] = merged;
      }
    } else {
      // CSV / local mode — mutate in-memory only
      if (modal._mode === 'create') {
        if (assignments.find(a => a.id === data.id)) {
          document.getElementById('modalError').textContent = 'ID ALREADY EXISTS'; return;
        }
        assignments.push(data);
      } else {
        const originalId = modal._record?.id ?? data.id;
        const idx = assignments.findIndex(a => a.id === originalId);
        if (idx !== -1) assignments[idx] = { ...assignments[idx], ...data };
      }
    }

    conflictSet = detectConflicts(assignments, configs);
    setSelectedRow(data.id);
    buildTableUI(); render(); closeCrudModal();
  } catch (e) {
    document.getElementById('modalError').textContent = 'ERROR: ' + e.message;
    console.error('[CRUD] save failed', e);
  } finally {
    btn.textContent = 'SAVE'; btn.disabled = false;
  }
});

document.getElementById('modalCancel').addEventListener('click', closeCrudModal);
document.getElementById('modalClose').addEventListener('click', closeCrudModal);

// ── DELETE modal ────────────────────────────────────────
function openDeleteModal(id) {
  document.getElementById('deleteTargetID').textContent = id;
  document.getElementById('deleteModal').classList.remove('hidden');
  document.getElementById('deleteModal')._targetId = id;
}
function closeDeleteModal() { document.getElementById('deleteModal').classList.add('hidden'); }

document.getElementById('deleteModalClose').addEventListener('click', closeDeleteModal);
document.getElementById('deleteCancelBtn').addEventListener('click', closeDeleteModal);

document.getElementById('deleteConfirmBtn').addEventListener('click', async () => {
  const modal    = document.getElementById('deleteModal');
  const targetId = modal._targetId;
  const btn      = document.getElementById('deleteConfirmBtn');
  btn.textContent = 'DELETING…'; btn.disabled = true;

  try {
    if (useFirebase) {
      const rec = assignments.find(a => a.id === targetId);
      if (rec?._docId) await fbDeleteAssignment(rec._docId);
    }
    assignments = assignments.filter(a => a.id !== targetId);
    conflictSet = detectConflicts(assignments, configs);
    setSelectedRow(null);
    buildTableUI(); render(); closeDeleteModal();
  } catch (e) {
    alert('DELETE FAILED: ' + e.message);
  } finally {
    btn.textContent = 'DELETE'; btn.disabled = false;
  }
});

// ── Toolbar buttons ─────────────────────────────────────
document.getElementById('btnCreate').addEventListener('click', () => openCrudModal('create', null));

document.getElementById('btnUpdate').addEventListener('click', () => {
  if (!selectedRowId) return;
  const record = assignments.find(a => a.id === selectedRowId);
  if (record) openCrudModal('update', record);
});

document.getElementById('btnDelete').addEventListener('click', () => {
  if (!selectedRowId) return;
  openDeleteModal(selectedRowId);
});

// ════════════════════════════════════════════════════════
//  8. VIEW SWITCHING
// ════════════════════════════════════════════════════════

function showMap() {
  activeView = 'map';
  document.getElementById('mapView').classList.remove('hidden');
  document.getElementById('tableView').classList.add('hidden');
  document.getElementById('btnMap').classList.add('active');
  document.getElementById('btnTable').classList.remove('active');
  document.getElementById('ibZoomItem').style.display = '';
  document.getElementById('ibRowsItem').style.display = 'none';
  document.getElementById('ibConflItem').style.display = 'none';
  resizeCanvas();
}
function showTable() {
  activeView = 'table';
  // Dismiss any lingering map tooltip and cancel panning
  document.getElementById('tooltip').style.display = 'none';
  canvas.style.cursor = 'grab';
  panning = false;
  document.getElementById('tableView').classList.remove('hidden');
  document.getElementById('mapView').classList.add('hidden');
  document.getElementById('btnTable').classList.add('active');
  document.getElementById('btnMap').classList.remove('active');
  document.getElementById('ibZoomItem').style.display = 'none';
  document.getElementById('ibRowsItem').style.display = '';
  if (conflictSet.bad.size) document.getElementById('ibConflItem').style.display = '';
  renderTable();
}
document.getElementById('btnMap').addEventListener('click', showMap);
document.getElementById('btnTable').addEventListener('click', showTable);

// ════════════════════════════════════════════════════════
//  9. INFO BAR
// ════════════════════════════════════════════════════════

function updateInfoBar() {
  document.getElementById('ibStands').textContent = lots.length;
  let total = 0;
  lots.forEach(l => { const c = configs[l.id]; if (c) total += c.slots.length; });
  document.getElementById('ibSlots').textContent = total;
  const selCfg = selectedLot && configs[selectedLot];
  const selSlots = selCfg ? selCfg.slots : [];
  const codes = selSlots.length ? [...new Set(selSlots.map(s => s.maxCode))].sort((a,b)=>(CODE_ORDER[a]??0)-(CODE_ORDER[b]??0)).join('/') : '—';
  document.getElementById('ibConfig').textContent = selSlots.length ? `${selectedLot}: ${selSlots.length} SLOTS (${codes})` : '—';
  document.getElementById('ibZoom').textContent = Math.round(vpScale * 100 / (minScale / 0.8)) + '%';
}

// ════════════════════════════════════════════════════════
//  10. INIT
// ════════════════════════════════════════════════════════

async function init() {
  const st = document.getElementById('loadStatus');
  try {
    useFirebase = initFirebase();

    // Update source tag
    const tag = document.getElementById('crudSourceTag');
    if (tag) { tag.textContent = '✓'; tag.title = useFirebase ? 'Source: Firebase' : 'Source: CSV'; }

    const lotRows = await retrieveLots();
    lots = lotRows.map(r => ({
      id: r['ID'], x: parseFloat(r['X']), y: parseFloat(r['Y']),
      w: parseFloat(r['width']), h: parseFloat(r['height']), bearing: parseFloat(r['bearing']) || 0
    }));

    const cfgData = await retrieveLotConfigs(); // already parsed JSON array
    configs = {};
    cfgData.forEach(entry => {
      configs[entry.id] = { slots: entry.slots }; // slots: [{slotNum, maxCode, pcn}]
    });

    assignments = await retrieveAssignments();
    conflictSet = detectConflicts(assignments, configs);

    resizeCanvas(); fitView(); buildMapUI(); buildTableUI(); render();
    st.textContent = '● LIVE';
    st.className = 'status-pill ok';
  } catch (err) {
    st.textContent = 'LOAD ERROR'; st.className = 'status-pill err';
    console.error(err);
    document.getElementById('tBody').innerHTML =
      `<tr><td colspan="9" class="no-data" style="color:var(--danger)">
        FAILED TO LOAD — Serve this file via a local web server with csv/ alongside it.<br>
        <span style="opacity:.6;font-size:10px">${err.message}</span>
      </td></tr>`;
  }
}

init();