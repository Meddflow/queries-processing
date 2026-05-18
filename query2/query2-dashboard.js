// query2-dashboard.js
// Query 2: Age Band & Youth Demand Analysis
//
// Reverse-engineered from Query_2__5.pbix
// Confirmed measure names from pbix Layout:
//   APPOINTMENTS table:
//     - Patient Count         → DISTINCTCOUNT(APPOINTMENTS.INTERNALID)
//     - Age Band Growth       → (current_year - first_year) / first_year per ageband
//     - Age Band Rank         → RANK of Age Band Growth desc
//     - Age Band Share        → Patient Count / Total Patient Count for that diagnosis
//     - Youth Patients        → Patient Count filtered to Ageband IN ('02 - 12 to 17', '03 - 18 to 24')
//     - Youth 12-24 Count     → same as Youth Patients
//     - Youth Growth          → Age Band Growth filtered to youth cohort
//     - Youth Appointments    → COUNT of appointments for youth cohort
//     - Adult Appointments    → COUNT of appointments for non-youth cohort
//     - Adult Growth          → Age Band Growth for adult cohort
//     - Youth Faster Than Adult → IF(Youth Growth > Adult Growth, "Youth Growing Faster", "Adult Growing Faster")
//     - Youth Region Rank     → RANK of Youth Growth desc per PHN_Name
//     - Diagnosis Group       → column on APPOINTMENTS (PASTHISTORY join)
//
//   PATIENTS table:
//     - Ageband               → calculated column, bands: 01-0-11, 02-12-17, 03-18-24, 04-25-34, 05-35-44, 06-45-54, 07-55-64, 08-65+
//     - Age                   → calculated from DOB or AGE field
//
// Youth cohort filter (from pbix):
//   PATIENTS.Ageband IN ('02 - 12 to 17', '03 - 18 to 24')
//
// Tables used: APPOINTMENTS, PATIENTS, PASTHISTORY, APPOINTMENTTYPE, Postcode_PHN_SA3_SA4
// Join keys:   APPOINTMENTS.INTERNALID → PATIENTS.INTERNALID
//              APPOINTMENTS.INTERNALID → PASTHISTORY.INTERNALID
//              APPOINTMENTS.APPOINTMENTTYPE → APPOINTMENTTYPE.APPOINTMENTCODE
//              PATIENTS.POSTCODE → Postcode_PHN_SA3_SA4.Postcode

import { mongoAggregate } from './mongo-client.js';

// DD/MM/YYYY H:MM:SS AM/PM (Australian locale from BP software)
function parseAusDate(str) {
  if (!str || typeof str !== 'string') return new Date(NaN);
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return new Date(str);
  let [, day, month, year, hr, min, sec, ampm] = m;
  hr = parseInt(hr);
  if (ampm) {
    if (ampm.toUpperCase() === 'PM' && hr < 12) hr += 12;
    if (ampm.toUpperCase() === 'AM' && hr === 12) hr = 0;
  }
  return new Date(parseInt(year), parseInt(month) - 1, parseInt(day), hr, parseInt(min), parseInt(sec));
}

// Server strips BOM from field names, so INTERNALID is always clean here
function getPatientId(p) {
  return p['INTERNALID'] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
export const CONFIG = {
  db: 'dokotela-reporting',

  // Age band boundaries (from pbix: 01-0-11, 02-12-17, 03-18-24 ...)
  // Ageband is a column on PATIENTS - derived from AGE or DOB field
  // Youth cohort = agebands '02 - 12 to 17' AND '03 - 18 to 24'
  ageBands: [
    { code: '01', label: '0 - 11',   min: 0,  max: 11  },
    { code: '02', label: '12 to 17', min: 12, max: 17  },
    { code: '03', label: '18 to 24', min: 18, max: 24  },
    { code: '04', label: '25 to 34', min: 25, max: 34  },
    { code: '05', label: '35 to 44', min: 35, max: 44  },
    { code: '06', label: '45 to 54', min: 45, max: 54  },
    { code: '07', label: '55 to 64', min: 55, max: 64  },
    { code: '08', label: '65+',      min: 65, max: 999 },
  ],

  // Youth cohort = these two agebands (confirmed from pbix filter)
  youthAgebands: ['02 - 12 to 17', '03 - 18 to 24'],

  // Diagnosis groups (same keyword rules as Q6)
  diagGroups: {
    'ADHD':       ['adhd', 'attention deficit', 'attention-deficit'],
    'Anxiety':    ['anxiety', 'anxious', 'panic disorder', 'generalised anxiety', 'generalized anxiety'],
    'Depression': ['depression', 'depressive', 'major depressive', 'mdd'],
    'PTSD':       ['ptsd', 'post-traumatic', 'post traumatic', 'posttraumatic'],
    'ASD':        ['asd', 'autism', 'autistic', 'asperger'],
    'Psychosis':  ['psychosis', 'psychotic', 'schizophrenia', 'schizoaffective'],
  },

  // Year range for growth calc (pbix uses 6-year window: 2019-2025)
  growthFromYear: 2019,
  growthToYear:   2025,

  // Field names in MongoDB collections
  fields: {
    patientId:    'INTERNALID',
    ageField:     'AGE',          // in PATIENTS collection - adjust if field name differs
    dobField:     'DOB',          // fallback if AGE not present
    agebandField: 'Ageband',      // computed column in PATIENTS (may already exist in Atlas)
    postcode:     'POSTCODE',
    diagText:     'ITEMTEXT',     // in PASTHISTORY
    apptDate:     'APPOINTMENTDATE',
    apptType:     'APPOINTMENTTYPE',
    phnName:      'PHN_Name',     // in Postcode_PHN_SA3_SA4
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// MODULE STATE
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  patients:    [],   // enriched patient records with ageband + diagnosis + phn
  charts:      {},
  selectedYear: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main entry point. Fetches all required data from MongoDB and renders.
 * @param {string} uri   MongoDB URI
 * @param {Function} onStatus  (msg, level) callback
 */
export async function init(uri, onStatus = () => {}) {
  const db = CONFIG.db;
  onStatus('Fetching PATIENTS…', 'info');

  // ── 1. PATIENTS with age/ageband + postcode
  const patients = await mongoAggregate(uri, db, 'PATIENTS', [
    { $addFields: {
        INTERNALID: {
          $reduce: {
            input: { $objectToArray: '$$ROOT' },
            initialValue: null,
            in: { $cond: [{ $regexMatch: { input: '$$this.k', regex: 'INTERNALID$' } }, '$$this.v', '$$value'] },
          },
        },
    }},
    { $project: { _id: 0, INTERNALID: 1, DOB: 1, POSTCODE: 1 } },
  ]);
  onStatus(`Got ${patients.length} patients. Fetching PASTHISTORY…`, 'info');

  // ── 2. PASTHISTORY for diagnosis classification
  const history = await mongoAggregate(uri, db, 'PASTHISTORY', [
    { $match: { RECORDSTATUS: 1 } },
    { $project: { _id: 0, [CONFIG.fields.patientId]: 1, [CONFIG.fields.diagText]: 1 }},
  ]);
  onStatus(`Got ${history.length} history records. Fetching APPOINTMENTS…`, 'info');

  // ── 3. APPOINTMENTS with year
  const appts = await mongoAggregate(uri, db, 'APPOINTMENTS', [
    { $match: { RECORDSTATUS: '1' } },
    { $project: {
        _id: 0,
        [CONFIG.fields.patientId]: 1,
        [CONFIG.fields.apptDate]:  1,
    }},
  ]);
  onStatus(`Got ${appts.length} appointments. Fetching PHN map…`, 'info');

  // ── 4. Postcode → PHN mapping
  const phnMap = await mongoAggregate(uri, db, 'Postcode_PHN_SA3_SA4', [
    { $project: { _id: 0, Postcode: 1, [CONFIG.fields.phnName]: 1, State: 1 }},
  ]);

  onStatus('Processing…', 'info');
  const enriched = buildEnrichedPatients(patients, history, appts, phnMap);
  state.patients = enriched;

  onStatus(`✓ ${enriched.length} patients enriched`, 'ok');
  render();
}

/**
 * Load pre-fetched data directly (for testing).
 */
export function loadData(patients, history, appts, phnMap) {
  state.patients = buildEnrichedPatients(patients, history, appts, phnMap);
  render();
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA ENRICHMENT
// ─────────────────────────────────────────────────────────────────────────────
function buildEnrichedPatients(patients, history, appts, phnMap) {
  // Postcode → PHN lookup
  const phnLookup = {};
  for (const r of phnMap) {
    if (r.Postcode) phnLookup[String(r.Postcode).padStart(4, '0')] = { phn: r[CONFIG.fields.phnName], state: r.State };
  }

  // Patient diagnosis (first matching group wins — same logic as Q6)
  const diagByPatient = {};
  for (const r of history) {
    const pid  = String(r[CONFIG.fields.patientId] ?? '');
    if (!pid || diagByPatient[pid]) continue;
    const text = (r[CONFIG.fields.diagText] ?? '').toLowerCase();
    for (const [grp, kws] of Object.entries(CONFIG.diagGroups)) {
      if (kws.some(k => text.includes(k))) { diagByPatient[pid] = grp; break; }
    }
    if (!diagByPatient[pid]) diagByPatient[pid] = 'Other';
  }

  // Appointment years per patient
  const apptYearsByPatient = {};
  for (const r of appts) {
    const pid = String(r[CONFIG.fields.patientId] ?? '');
    if (!pid) continue;
    const d = parseAusDate(r[CONFIG.fields.apptDate]);
    if (isNaN(d)) continue;
    const yr = d.getFullYear();
    if (yr < 2011 || yr > 2025) continue;
    if (!apptYearsByPatient[pid]) apptYearsByPatient[pid] = new Set();
    apptYearsByPatient[pid].add(yr);
  }

  // Appointment count per patient per year
  const apptCountByPatientYear = {};
  for (const r of appts) {
    const pid = String(r[CONFIG.fields.patientId] ?? '');
    if (!pid) continue;
    const d = parseAusDate(r[CONFIG.fields.apptDate]);
    if (isNaN(d)) continue;
    const yr = d.getFullYear();
    if (yr < 2011 || yr > 2025) continue;
    const key = `${pid}__${yr}`;
    apptCountByPatientYear[key] = (apptCountByPatientYear[key] ?? 0) + 1;
  }

  const enriched = [];
  for (const p of patients) {
    const pid = String(getPatientId(p) ?? '');
    if (!pid) continue;

    // Ageband — use existing field if present, else compute from AGE
    let ageband = p[CONFIG.fields.agebandField] ?? null;
    if (!ageband) {
      const age = computeAge(p);
      ageband = age !== null ? getAgeband(age) : null;
    }

    const pc  = String(p[CONFIG.fields.postcode] ?? '').trim().padStart(4, '0');
    const geo = phnLookup[pc] ?? { phn: null, state: null };

    enriched.push({
      pid,
      ageband,
      isYouth: ageband !== null && CONFIG.youthAgebands.includes(ageband),
      diagnosis:  diagByPatient[pid] ?? 'Other',
      phn:        geo.phn,
      state:      geo.state,
      years:      apptYearsByPatient[pid] ?? new Set(),
      apptCounts: apptCountByPatientYear,  // access via `${pid}__${yr}`
    });
  }

  return enriched;
}

function computeAge(patient) {
  const dob = patient[CONFIG.fields.dobField];
  if (dob) {
    const d = parseAusDate(dob);
    if (!isNaN(d)) {
      const now = new Date();
      let a = now.getFullYear() - d.getFullYear();
      if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) a--;
      if (a >= 0 && a < 120) return a;
    }
  }
  return null;
}

function getAgeband(age) {
  for (const b of CONFIG.ageBands) {
    if (age >= b.min && age <= b.max) return `${b.code} - ${b.label}`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// METRIC COMPUTATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Patient Count by Diagnosis × Ageband × Year
 * Mirrors pbix pivot: Rows=Diagnosis+Ageband, Columns=Year, Values=Patient Count
 */
export function patientCountByDiagAgeBandYear() {
  const result = {};
  for (const p of state.patients) {
    for (const yr of p.years) {
      const key = `${p.diagnosis}__${p.ageband ?? 'Unknown'}__${yr}`;
      result[key] = (result[key] ?? new Set());
      result[key].add(p.pid);
    }
  }
  // Convert Sets to counts
  const counts = {};
  for (const [k, s] of Object.entries(result)) counts[k] = s.size;
  return counts;
}

/**
 * Age Band Share per Diagnosis per Year
 * = Patient Count(diag, ageband, year) / Patient Count(diag, year)
 */
export function ageBandShare() {
  const raw = patientCountByDiagAgeBandYear();

  // Total per diag+year
  const totals = {};
  for (const [key, cnt] of Object.entries(raw)) {
    const [diag, , yr] = key.split('__');
    const tk = `${diag}__${yr}`;
    totals[tk] = (totals[tk] ?? 0) + cnt;
  }

  const shares = {};
  for (const [key, cnt] of Object.entries(raw)) {
    const [diag, band, yr] = key.split('__');
    const total = totals[`${diag}__${yr}`] ?? 0;
    shares[key] = total > 0 ? cnt / total : 0;
  }
  return shares;
}

/**
 * Age Band Growth per Diagnosis
 * = (count in growthToYear - count in growthFromYear) / count in growthFromYear
 * Mirrors pbix "Age Band Growth" measure
 */
export function ageBandGrowth() {
  const raw    = patientCountByDiagAgeBandYear();
  const from   = CONFIG.growthFromYear;
  const to     = CONFIG.growthToYear;
  const result = {};

  const diagBands = new Set(
    Object.keys(raw).map(k => { const [d, b] = k.split('__'); return `${d}__${b}`; })
  );

  for (const db of diagBands) {
    const [diag, band] = db.split('__');
    const cntFrom = raw[`${diag}__${band}__${from}`] ?? 0;
    const cntTo   = raw[`${diag}__${band}__${to}`]   ?? 0;
    result[db] = cntFrom > 0 ? (cntTo - cntFrom) / cntFrom : null;
  }
  return result;
}

/**
 * Age Band Rank per Diagnosis (rank by growth desc)
 * Mirrors pbix "Age Band Rank" measure
 */
export function ageBandRank() {
  const growth = ageBandGrowth();
  const byDiag = {};

  for (const [key, val] of Object.entries(growth)) {
    const [diag] = key.split('__');
    if (!byDiag[diag]) byDiag[diag] = [];
    byDiag[diag].push({ key, val });
  }

  const ranks = {};
  for (const [, entries] of Object.entries(byDiag)) {
    const sorted = [...entries]
      .filter(e => e.val !== null)
      .sort((a, b) => (b.val ?? -Infinity) - (a.val ?? -Infinity));
    sorted.forEach((e, i) => { ranks[e.key] = i + 1; });
  }
  return ranks;
}

/**
 * Youth Patients per Diagnosis per Year
 * Filter: PATIENTS.Ageband IN ('02 - 12 to 17', '03 - 18 to 24')
 */
export function youthPatientsByDiagYear() {
  const result = {};
  for (const p of state.patients) {
    if (!p.isYouth) continue;
    for (const yr of p.years) {
      const key = `${p.diagnosis}__${yr}`;
      if (!result[key]) result[key] = new Set();
      result[key].add(p.pid);
    }
  }
  const counts = {};
  for (const [k, s] of Object.entries(result)) counts[k] = s.size;
  return counts;
}

/**
 * Youth Growth per Diagnosis
 * = (youthCount_toYear - youthCount_fromYear) / youthCount_fromYear
 */
export function youthGrowthByDiag() {
  const counts = youthPatientsByDiagYear();
  const from   = CONFIG.growthFromYear;
  const to     = CONFIG.growthToYear;
  const diags  = new Set(Object.keys(counts).map(k => k.split('__')[0]));
  const result = {};

  for (const diag of diags) {
    const cntFrom = counts[`${diag}__${from}`] ?? 0;
    const cntTo   = counts[`${diag}__${to}`]   ?? 0;
    result[diag]  = cntFrom > 0 ? (cntTo - cntFrom) / cntFrom : null;
  }
  return result;
}

/**
 * Youth appointments + growth by PHN region
 * Mirrors pbix: PHN_Name, Youth Appointments, Youth Growth, Youth Region Rank
 */
export function youthByPHN() {
  const apptsByPHN  = {};
  const growthByPHN = {};
  const from = CONFIG.growthFromYear;
  const to   = CONFIG.growthToYear;

  for (const p of state.patients) {
    if (!p.isYouth || !p.phn) continue;
    const phn = p.phn;

    // total youth appointments across all years
    for (const yr of p.years) {
      const cnt = p.apptCounts[`${p.pid}__${yr}`] ?? 0;
      apptsByPHN[phn] = (apptsByPHN[phn] ?? 0) + cnt;
    }
  }

  // Growth: unique youth patients from→to per PHN
  const phnYearPats = {};
  for (const p of state.patients) {
    if (!p.isYouth || !p.phn) continue;
    for (const yr of p.years) {
      const key = `${p.phn}__${yr}`;
      if (!phnYearPats[key]) phnYearPats[key] = new Set();
      phnYearPats[key].add(p.pid);
    }
  }

  const phns = new Set(Object.keys(apptsByPHN));
  for (const phn of phns) {
    const cntFrom = (phnYearPats[`${phn}__${from}`] ?? new Set()).size;
    const cntTo   = (phnYearPats[`${phn}__${to}`]   ?? new Set()).size;
    growthByPHN[phn] = cntFrom > 0 ? (cntTo - cntFrom) / cntFrom : null;
  }

  // Rank by growth desc
  const sorted = Object.entries(growthByPHN)
    .filter(([, g]) => g !== null)
    .sort((a, b) => (b[1] ?? -Infinity) - (a[1] ?? -Infinity));

  const result = [];
  sorted.forEach(([phn, growth], i) => {
    result.push({
      phn,
      youthAppointments: apptsByPHN[phn] ?? 0,
      youthGrowth:       growth,
      rank:              i + 1,
    });
  });

  // Add PHNs with no growth data
  for (const phn of phns) {
    if (!result.find(r => r.phn === phn)) {
      result.push({ phn, youthAppointments: apptsByPHN[phn] ?? 0, youthGrowth: null, rank: null });
    }
  }

  return result.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
}

/**
 * Youth vs Adult growth comparison per PHN
 * Mirrors pbix: Youth Faster Than Adult column
 */
export function youthVsAdultByPHN() {
  const from = CONFIG.growthFromYear;
  const to   = CONFIG.growthToYear;

  const yearPats = { youth: {}, adult: {} };
  const appts    = { youth: {}, adult: {} };

  for (const p of state.patients) {
    if (!p.phn) continue;
    const cohort = p.isYouth ? 'youth' : 'adult';
    for (const yr of p.years) {
      const key = `${p.phn}__${yr}`;
      if (!yearPats[cohort][key]) yearPats[cohort][key] = new Set();
      yearPats[cohort][key].add(p.pid);
      const cnt = p.apptCounts[`${p.pid}__${yr}`] ?? 0;
      appts[cohort][p.phn] = (appts[cohort][p.phn] ?? 0) + cnt;
    }
  }

  const phns = new Set([
    ...Object.keys(appts.youth),
    ...Object.keys(appts.adult),
  ]);

  const result = [];
  for (const phn of phns) {
    const yF = (yearPats.youth[`${phn}__${from}`] ?? new Set()).size;
    const yT = (yearPats.youth[`${phn}__${to}`]   ?? new Set()).size;
    const aF = (yearPats.adult[`${phn}__${from}`] ?? new Set()).size;
    const aT = (yearPats.adult[`${phn}__${to}`]   ?? new Set()).size;

    const yGrowth = yF > 0 ? (yT - yF) / yF : null;
    const aGrowth = aF > 0 ? (aT - aF) / aF : null;

    const fasterLabel = (yGrowth !== null && aGrowth !== null)
      ? (yGrowth > aGrowth ? 'Youth Growing Faster' : 'Adult Growing Faster')
      : 'Adult Growing Faster';

    result.push({
      phn,
      youthAppointments: appts.youth[phn] ?? 0,
      adultAppointments: appts.adult[phn] ?? 0,
      youthGrowth: yGrowth,
      adultGrowth: aGrowth,
      fasterLabel,
    });
  }

  return result.sort((a, b) => b.youthAppointments - a.youthAppointments);
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────────────
function render() {
  renderKPIs();
  renderHeatmap();
  renderAgeBandGrowthTable();
  renderYouthTrendLine();
  renderYouthByPHNTable();
  renderYouthVsAdultTable();
  renderYearlyStackedBar();
}

// ─────────────────────────────────────────────────────────────────────────────
// CHART HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const T = {
  primary: '#e05c2f', blue: '#2f7be0', green: '#2fbe7a',
  amber: '#c4a800', purple: '#9b4fdb', muted: '#8a8278', border: '#e8e4df',
  mono: "'DM Mono', monospace",
};
const AXIS = {
  grid:  { color: T.border },
  ticks: { color: T.muted, font: { family: T.mono, size: 10 } },
};

function mkChart(id, type, data, options) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  if (state.charts[id]) state.charts[id].destroy();
  state.charts[id] = new Chart(canvas, { type, data, options });
}

function setText(sel, val) {
  const el = document.querySelector(sel); if (el) el.textContent = val;
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — KPIs
// ─────────────────────────────────────────────────────────────────────────────
function renderKPIs() {
  const youth   = state.patients.filter(p => p.isYouth);
  const total   = state.patients.length;
  const yGrowth = youthGrowthByDiag();

  const topDiag  = Object.entries(yGrowth)
    .filter(([, g]) => g !== null)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0];

  setText('[data-kpi="totalPatients"]',  total.toLocaleString());
  setText('[data-kpi="youthPatients"]',  youth.length.toLocaleString());
  setText('[data-kpi="youthPct"]',       total > 0 ? (youth.length / total * 100).toFixed(1) + '%' : '—');
  setText('[data-kpi="topYouthDiag"]',   topDiag ? topDiag[0] : '—');
  setText('[data-kpi="topYouthGrowth"]', topDiag ? (topDiag[1] * 100).toFixed(0) + '%' : '—');
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — Heatmap: Patient Count by Diagnosis × Ageband
// canvas id="chartHeatmap" — rendered as grouped bar (Chart.js has no heatmap)
// ─────────────────────────────────────────────────────────────────────────────
function renderHeatmap() {
  const counts = patientCountByDiagAgeBandYear();
  const bands  = CONFIG.ageBands.map(b => b.code + ' - ' + b.label);
  const diags  = ['ADHD', 'Anxiety', 'Depression', 'PTSD', 'ASD', 'Psychosis', 'Other'];
  const colors = [T.primary, T.blue, T.green, T.amber, T.purple, '#e040fb', T.muted];

  // Sum across all years
  const totals = {};
  for (const [key, cnt] of Object.entries(counts)) {
    const [diag, band] = key.split('__');
    const k = `${diag}__${band}`;
    totals[k] = (totals[k] ?? 0) + cnt;
  }

  const datasets = diags.map((diag, i) => ({
    label: diag,
    data:  bands.map(band => totals[`${diag}__${band}`] ?? 0),
    backgroundColor: colors[i] + 'cc',
    borderRadius: 3,
  }));

  mkChart('chartHeatmap', 'bar', { labels: bands, datasets }, {
    plugins: { legend: { labels: { color: T.muted, font: { family: T.mono, size: 10 }, boxWidth: 10 } } },
    scales: {
      x: { ...AXIS, ticks: { ...AXIS.ticks, maxRotation: 30 } },
      y: { ...AXIS, beginAtZero: true, ticks: { ...AXIS.ticks, callback: v => v >= 1000 ? (v/1000).toFixed(0)+'k' : v } },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — Age Band Growth table  (tbody id="tbodyAgeBand")
// ─────────────────────────────────────────────────────────────────────────────
function renderAgeBandGrowthTable() {
  const tbody = document.getElementById('tbodyAgeBand');
  if (!tbody) return;

  const growth = ageBandGrowth();
  const ranks  = ageBandRank();
  const counts = patientCountByDiagAgeBandYear();

  // Sum total patients per diag+band
  const totals = {};
  for (const [key, cnt] of Object.entries(counts)) {
    const [diag, band] = key.split('__');
    totals[`${diag}__${band}`] = (totals[`${diag}__${band}`] ?? 0) + cnt;
  }

  const rows = Object.entries(growth)
    .map(([key, g]) => {
      const [diag, band] = key.split('__');
      return { diag, band, growth: g, rank: ranks[key] ?? null, total: totals[key] ?? 0 };
    })
    .sort((a, b) => (b.growth ?? -Infinity) - (a.growth ?? -Infinity))
    .slice(0, 30);

  tbody.innerHTML = rows.map(r => {
    const g = r.growth !== null ? (r.growth * 100).toFixed(1) + '%' : '—';
    const rankBadge = r.rank === 1 ? `<span style="color:#2fbe7a;font-weight:700">★ #${r.rank}</span>` : `#${r.rank ?? '—'}`;
    return `<tr>
      <td><b>${r.diag}</b></td>
      <td>${r.band}</td>
      <td style="text-align:right">${r.total.toLocaleString()}</td>
      <td style="text-align:right;color:${(r.growth ?? 0) > 0 ? '#2fbe7a' : '#e05c2f'}">${g}</td>
      <td style="text-align:center">${rankBadge}</td>
    </tr>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — Youth trend line by Diagnosis × Year
// canvas id="chartYouthTrend"
// ─────────────────────────────────────────────────────────────────────────────
function renderYouthTrendLine() {
  const counts = youthPatientsByDiagYear();
  const years  = [...new Set(Object.keys(counts).map(k => k.split('__')[1]))].map(Number).sort();
  const diags  = ['ADHD', 'Anxiety', 'Depression', 'PTSD', 'ASD', 'Psychosis', 'Other'];
  const colors = [T.primary, T.blue, T.green, T.amber, T.purple, '#e040fb', T.muted];

  const datasets = diags.map((diag, i) => ({
    label: diag,
    data:  years.map(yr => counts[`${diag}__${yr}`] ?? 0),
    borderColor: colors[i],
    backgroundColor: 'transparent',
    borderWidth: 2,
    pointRadius: 3,
    tension: 0.3,
  }));

  mkChart('chartYouthTrend', 'line', { labels: years, datasets }, {
    plugins: { legend: { labels: { color: T.muted, font: { family: T.mono, size: 10 }, boxWidth: 10 } } },
    scales: {
      x: { ...AXIS },
      y: { ...AXIS, beginAtZero: true },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — Youth by PHN table  (tbody id="tbodyPHN")
// ─────────────────────────────────────────────────────────────────────────────
function renderYouthByPHNTable() {
  const tbody = document.getElementById('tbodyPHN');
  if (!tbody) return;

  const data = youthByPHN().slice(0, 30);
  tbody.innerHTML = data.map(r => {
    const g = r.youthGrowth !== null ? (r.youthGrowth * 100).toFixed(0) + '%' : '—';
    const rankColor = r.rank === 1 ? '#2fbe7a' : r.rank === 2 ? '#c4a800' : '#8a8278';
    return `<tr>
      <td><b>${r.phn ?? '—'}</b></td>
      <td style="text-align:right">${r.youthAppointments.toLocaleString()}</td>
      <td style="text-align:right;color:${(r.youthGrowth ?? 0) > 0 ? '#2fbe7a' : '#e05c2f'}">${g}</td>
      <td style="text-align:center;color:${rankColor}">${r.rank ?? '—'}</td>
    </tr>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — Youth vs Adult by PHN  (tbody id="tbodyYouthAdult")
// ─────────────────────────────────────────────────────────────────────────────
function renderYouthVsAdultTable() {
  const tbody = document.getElementById('tbodyYouthAdult');
  if (!tbody) return;

  const data = youthVsAdultByPHN().slice(0, 30);
  tbody.innerHTML = data.map(r => {
    const yG = r.youthGrowth !== null ? (r.youthGrowth * 100).toFixed(0) + '%' : '—';
    const aG = r.adultGrowth !== null ? (r.adultGrowth * 100).toFixed(0) + '%' : '—';
    const isYouthFaster = r.fasterLabel === 'Youth Growing Faster';
    return `<tr>
      <td><b>${r.phn ?? '—'}</b></td>
      <td style="text-align:right">${r.youthAppointments.toLocaleString()}</td>
      <td style="text-align:right">${r.adultAppointments.toLocaleString()}</td>
      <td style="text-align:right;color:#2fbe7a">${yG}</td>
      <td style="text-align:right;color:#2f7be0">${aG}</td>
      <td style="color:${isYouthFaster ? '#2fbe7a' : '#8a8278'};font-weight:${isYouthFaster ? '700' : '400'}">${r.fasterLabel}</td>
    </tr>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — Stacked bar: Youth appointments by year + diagnosis
// canvas id="chartYouthStacked"
// ─────────────────────────────────────────────────────────────────────────────
function renderYearlyStackedBar() {
  const counts = youthPatientsByDiagYear();
  const years  = [...new Set(Object.keys(counts).map(k => k.split('__')[1]))].map(Number).sort();
  const diags  = ['ADHD', 'Anxiety', 'Depression', 'PTSD', 'ASD', 'Psychosis', 'Other'];
  const colors = [T.primary, T.blue, T.green, T.amber, T.purple, '#e040fb', T.muted];

  const datasets = diags.map((diag, i) => ({
    label: diag,
    data:  years.map(yr => counts[`${diag}__${yr}`] ?? 0),
    backgroundColor: colors[i] + 'cc',
    borderRadius: 3,
    stack: 'stack',
  }));

  mkChart('chartYouthStacked', 'bar', { labels: years, datasets }, {
    plugins: { legend: { labels: { color: T.muted, font: { family: T.mono, size: 10 }, boxWidth: 10 } } },
    scales: {
      x: { ...AXIS, stacked: true },
      y: { ...AXIS, stacked: true, beginAtZero: true },
    },
  });
}
