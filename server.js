/**
 * server.js — Dokotela dashboard backend
 * Bridges the HTML/JS dashboard to MongoDB Atlas.
 *
 * Setup:
 *   npm init -y
 *   npm install express mongodb dotenv
 *   node server.js          <- reads MONGO_URI from .env automatically
 *
 * Then open http://localhost:3001/appointments.html in your browser.
 */

require('dotenv').config();   // loads .env into process.env
const express         = require('express');
const cors            = require('cors');
const { MongoClient } = require('mongodb');
const path            = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());

// ── URI resolution ────────────────────────────────────────────────────────────
// Priority: MONGO_URI env var > body.uri from the request
// Never hardcode credentials in source. Set the env var instead:
//
//   export MONGO_URI="mongodb+srv://Ayraf:<password>@dokotela-reporting.yy46axu.mongodb.net/?appName=Dokotela-reporting"
//   node server.js
//
// Or create a .env file (never commit it) and use dotenv:
//   npm install dotenv
//   add `require('dotenv').config()` at the top of this file
//
const SERVER_URI = process.env.MONGO_URI || null;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));   // serves query6_remoteness.html

// ── POST /api/aggregate ──────────────────────────────────────────────────────
// Body: { uri, db, collection, pipeline }
// Returns: array of documents
// ─────────────────────────────────────────────────────────────────────────────
// Restore Date objects that JSON.stringify flattened to ISO strings
function reviveDates(v) {
  if (Array.isArray(v))            return v.map(reviveDates);
  if (v && typeof v === 'object')  return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, reviveDates(val)]));
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) return new Date(v);
  return v;
}

// Strip UTF-8 BOM (﻿) from field names — some CSV imports leave it on the first column
function stripBOM(v) {
  if (Array.isArray(v)) return v.map(stripBOM);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k.replace(/^﻿/, '')] = stripBOM(val);
    }
    return out;
  }
  return v;
}

app.post('/api/aggregate', async (req, res) => {
  const { uri: bodyUri, db, collection, pipeline: rawPipeline } = req.body;
  const uri      = SERVER_URI || bodyUri;
  const pipeline = reviveDates(rawPipeline);

  if (!uri || !db || !collection || !pipeline) {
    return res.status(400).json({ error: 'Missing required fields: uri, db, collection, pipeline' });
  }

  let client;
  try {
    client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
    });
    await client.connect();

    const result = await client
      .db(db)
      .collection(collection)
      .aggregate(pipeline, { allowDiskUse: true })
      .toArray();

    console.log(`[aggregate] ${db}.${collection} → ${result.length} docs`);
    res.json(stripBOM(result));

  } catch (err) {
    console.error('[aggregate error]', err.message);
    res.status(500).json({ error: err.message });

  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// ═════════════════════════════════════════════════════════════════════════════
// SHARED SERVER-SIDE HELPERS
// ═════════════════════════════════════════════════════════════════════════════

// Handles both Australian date strings ("D/M/YYYY H:MM:SS AM/PM") and Date objects
function parseAusDate(str) {
  if (str instanceof Date) return str;
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

function srvAvg(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }

function srvCountBy(arr, keyFn) {
  const out = {};
  arr.forEach(item => { const k = keyFn(item); out[k] = (out[k] ?? 0) + 1; });
  return out;
}

function srvGroupBy(arr, keyFn) {
  const out = {};
  arr.forEach(item => { const k = keyFn(item); (out[k] = out[k] ?? []).push(item); });
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/query6  —  Appointments Dashboard
// Body: { uri?, db? }
// Returns: { kpis, charts: { chartMonthly, chartAnnual, chartCode,
//                            chartDOW, chartVisitLen, chartNewReturn },
//            tables: { summaryTable } }
// Each chart has: { title, type, labels, datasets[] }  — plug straight into Chart.js
// ═════════════════════════════════════════════════════════════════════════════

const Q6_CODE_LABELS = {
  9: 'Video', 13: 'Phone', 5: 'Standard', 0: 'Unspecified',
  12: 'Long', 10: 'Follow-up', 1: 'New Patient', 2: 'Brief', 4: 'Urgent',
};
const Q6_VALID_LEN = { min: 1, max: 36000 }; // seconds

function q6ParseRow(r) {
  const d = parseAusDate(r.APPOINTMENTDATE);
  if (isNaN(d)) return null;
  const year  = d.getFullYear();
  const month = d.getMonth(); // 0–11
  const dow   = d.getDay();   // 0=Sun
  if (year < 2011 || year > 2025) return null;

  const toNum = v => (typeof v === 'number' ? v : parseFloat(v));
  const rawVL = toNum(r.VISITLENGTH);
  const rawAL = toNum(r.APPOINTMENTLENGTH);
  const { min, max } = Q6_VALID_LEN;

  return {
    patientId: r.INTERNALID,
    code:      r.APPOINTMENTCODE ?? null,
    year, month, dow,
    yearMonth: `${year}-${String(month + 1).padStart(2, '0')}`,
    visitMin:  (!isNaN(rawVL) && rawVL >= min && rawVL <= max) ? rawVL / 60 : null,
    bookedMin: (!isNaN(rawAL) && rawAL >= min && rawAL <= max) ? rawAL / 60 : null,
  };
}

function q6ComputeKPIs(records) {
  const total    = records.length;
  const patCount = new Set(records.map(r => r.patientId)).size;
  const vlRecs   = records.filter(r => r.visitMin  !== null);
  const alRecs   = records.filter(r => r.bookedMin !== null);

  const byYear      = srvGroupBy(records, r => r.year);
  const sortedYears = Object.keys(byYear).map(Number).sort();
  let yoyPct = null, yoyYears = null;
  if (sortedYears.length >= 2) {
    const cur  = byYear[sortedYears.at(-1)].length;
    const prv  = byYear[sortedYears.at(-2)].length;
    yoyPct     = ((cur - prv) / prv) * 100;
    yoyYears   = [sortedYears.at(-2), sortedYears.at(-1)];
  }

  return {
    total,
    uniquePatients: patCount,
    avgPerPatient:  patCount > 0 ? +(total / patCount).toFixed(1) : null,
    avgVisitMin:    vlRecs.length ? +srvAvg(vlRecs.map(r => r.visitMin)).toFixed(1)  : null,
    avgBookedMin:   alRecs.length ? +srvAvg(alRecs.map(r => r.bookedMin)).toFixed(1) : null,
    yoyPct:         yoyPct !== null ? +yoyPct.toFixed(1) : null,
    yoyYears,
  };
}

function q6ComputeYearStats(allRecords) {
  const firstYear = {};
  allRecords.forEach(r => {
    if (firstYear[r.patientId] === undefined || r.year < firstYear[r.patientId])
      firstYear[r.patientId] = r.year;
  });

  const byYear = srvGroupBy(allRecords, r => r.year);
  const stats  = {};
  for (const [yr, recs] of Object.entries(byYear)) {
    const y       = Number(yr);
    const pats    = new Set(recs.map(r => r.patientId));
    const newPats = new Set([...pats].filter(pid => firstYear[pid] === y));
    const vls     = recs.filter(r => r.visitMin  !== null).map(r => r.visitMin);
    const als     = recs.filter(r => r.bookedMin !== null).map(r => r.bookedMin);
    stats[y] = {
      year: y, count: recs.length,
      uniquePatients: pats.size,
      newPatients:    newPats.size,
      retPatients:    pats.size - newPats.size,
      avgVisitMin:    vls.length ? +srvAvg(vls).toFixed(1) : null,
      avgBookedMin:   als.length ? +srvAvg(als).toFixed(1) : null,
    };
  }
  return stats;
}

function q6BuildCharts(records, yearStats, years) {
  // chartMonthly — Monthly appointment trend (line)
  const monthMap    = srvCountBy(records, r => r.yearMonth);
  const monthLabels = Object.keys(monthMap).sort();
  const chartMonthly = {
    title: 'Monthly Appointment Trend',
    type: 'line',
    labels: monthLabels,
    datasets: [{ label: 'Appointments', data: monthLabels.map(k => monthMap[k]) }],
  };

  // chartAnnual — Annual appointments (bar)
  const chartAnnual = {
    title: 'Annual Appointments',
    type: 'bar',
    labels: years,
    datasets: [{ label: 'Appointments', data: years.map(y => yearStats[y]?.count ?? 0) }],
  };

  // chartCode — Appointment type distribution (doughnut)
  const codeMap    = srvCountBy(records, r => String(r.code ?? 'Unknown'));
  const codeSorted = Object.entries(codeMap).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const chartCode  = {
    title: 'Appointment Type Distribution',
    type: 'doughnut',
    labels: codeSorted.map(([c]) => Q6_CODE_LABELS[c] ?? `Code ${c}`),
    datasets: [{ label: 'Count', data: codeSorted.map(([, v]) => v) }],
  };

  // chartDOW — Day of week (bar)
  const dowCounts = Array(7).fill(0);
  records.forEach(r => { dowCounts[r.dow]++; });
  const chartDOW = {
    title: 'Appointments by Day of Week',
    type: 'bar',
    labels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    datasets: [{ label: 'Appointments', data: dowCounts }],
  };

  // chartVisitLen — Avg visit length by calendar month (bar)
  const buckets = Array.from({ length: 12 }, () => []);
  records.forEach(r => { if (r.visitMin !== null) buckets[r.month].push(r.visitMin); });
  const chartVisitLen = {
    title: 'Avg Visit Length by Month (minutes)',
    type: 'bar',
    labels: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
    datasets: [{ label: 'Avg Visit (min)', data: buckets.map(b => b.length ? +srvAvg(b).toFixed(1) : null) }],
  };

  // chartNewReturn — New vs returning patients by year (stacked bar)
  const chartNewReturn = {
    title: 'New vs Returning Patients by Year',
    type: 'bar',
    stacked: true,
    labels: years,
    datasets: [
      { label: 'New Patients',       data: years.map(y => yearStats[y]?.newPatients ?? 0) },
      { label: 'Returning Patients', data: years.map(y => yearStats[y]?.retPatients ?? 0) },
    ],
  };

  return { chartMonthly, chartAnnual, chartCode, chartDOW, chartVisitLen, chartNewReturn };
}

app.post('/api/query6', async (req, res) => {
  const { uri: bodyUri, db = 'dokotela-reporting' } = req.body ?? {};
  const uri = SERVER_URI || bodyUri;
  if (!uri) return res.status(400).json({ error: 'MongoDB URI required — set MONGO_URI env var or pass uri in body' });

  let client;
  try {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
    await client.connect();

    const rawRows = await client.db(db).collection('APPOINTMENTS').aggregate([
      { $match: { RECORDSTATUS: '1' } },
      { $project: { _id: 0, INTERNALID: 1, APPOINTMENTDATE: 1, APPOINTMENTLENGTH: 1, VISITLENGTH: 1, APPOINTMENTCODE: 1 } },
    ], { allowDiskUse: true }).toArray();

    console.log(`[query6] ${rawRows.length} appointments fetched`);

    const records   = stripBOM(rawRows).map(q6ParseRow).filter(Boolean);
    const years     = [...new Set(records.map(r => r.year))].sort();
    const yearStats = q6ComputeYearStats(records);
    const kpis      = q6ComputeKPIs(records);
    const charts    = q6BuildCharts(records, yearStats, years);

    const summaryTable = {
      title: 'Annual Summary',
      rows: [...years].sort((a, b) => b - a).map(y => {
        const s = yearStats[y];
        return {
          year:           s.year,
          count:          s.count,
          uniquePatients: s.uniquePatients,
          newPatients:    s.newPatients,
          retPatients:    s.retPatients,
          avgPerPatient:  s.uniquePatients > 0 ? +(s.count / s.uniquePatients).toFixed(1) : null,
          avgVisitMin:    s.avgVisitMin,
          avgBookedMin:   s.avgBookedMin,
        };
      }),
    };

    res.json({ kpis, charts, tables: { summaryTable } });

  } catch (err) {
    console.error('[query6 error]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (client) await client.close().catch(() => {});
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/query2  —  Age Band & Youth Demand Analysis
// Body: { uri?, db? }
// Returns: { kpis, charts: { chartHeatmap, chartYouthTrend, chartYouthStacked },
//            tables: { ageBandGrowthTable, youthByPHNTable, youthVsAdultTable } }
// Each chart has: { title, type, labels, datasets[] }  — plug straight into Chart.js
// ═════════════════════════════════════════════════════════════════════════════

const Q2_CONFIG = {
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
  youthAgebands: ['02 - 12 to 17', '03 - 18 to 24'],
  diagGroups: {
    'ADHD':       ['adhd', 'attention deficit', 'attention-deficit'],
    'Anxiety':    ['anxiety', 'anxious', 'panic disorder', 'generalised anxiety', 'generalized anxiety'],
    'Depression': ['depression', 'depressive', 'major depressive', 'mdd'],
    'PTSD':       ['ptsd', 'post-traumatic', 'post traumatic', 'posttraumatic'],
    'ASD':        ['asd', 'autism', 'autistic', 'asperger'],
    'Psychosis':  ['psychosis', 'psychotic', 'schizophrenia', 'schizoaffective'],
  },
  growthFromYear: 2019,
  growthToYear:   2025,
  diagOrder: ['ADHD', 'Anxiety', 'Depression', 'PTSD', 'ASD', 'Psychosis', 'Other'],
};

function q2GetAgeband(age) {
  for (const b of Q2_CONFIG.ageBands) {
    if (age >= b.min && age <= b.max) return `${b.code} - ${b.label}`;
  }
  return null;
}

function q2ComputeAge(p) {
  const age = p.AGE;
  if (typeof age === 'number' && age > 0 && age < 120) return age;
  const dob = p.DOB;
  if (dob) {
    const d = new Date(dob);
    if (!isNaN(d)) {
      const now = new Date();
      let a = now.getFullYear() - d.getFullYear();
      if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) a--;
      if (a >= 0 && a < 120) return a;
    }
  }
  return null;
}

function q2BuildEnriched(patients, history, appts, phnMap) {
  // Postcode → PHN lookup
  const phnLookup = {};
  for (const r of phnMap) {
    if (r.Postcode) phnLookup[String(r.Postcode).padStart(4, '0')] = { phn: r.PHN_Name, state: r.State };
  }

  // Patient → diagnosis (first matching group wins)
  const diagByPatient = {};
  for (const r of history) {
    const pid = String(r.INTERNALID ?? '');
    if (!pid || diagByPatient[pid]) continue;
    const text = (r.ITEMTEXT ?? '').toLowerCase();
    for (const [grp, kws] of Object.entries(Q2_CONFIG.diagGroups)) {
      if (kws.some(k => text.includes(k))) { diagByPatient[pid] = grp; break; }
    }
    if (!diagByPatient[pid]) diagByPatient[pid] = 'Other';
  }

  // Appointment years + counts per patient
  const apptYears  = {};
  const apptCounts = {};
  for (const r of appts) {
    const pid = String(r.INTERNALID ?? '');
    if (!pid) continue;
    const d  = parseAusDate(r.APPOINTMENTDATE);
    if (isNaN(d)) continue;
    const yr = d.getFullYear();
    if (!apptYears[pid]) apptYears[pid] = new Set();
    apptYears[pid].add(yr);
    const key = `${pid}__${yr}`;
    apptCounts[key] = (apptCounts[key] ?? 0) + 1;
  }

  const enriched = [];
  for (const p of patients) {
    const pid = String(p.INTERNALID ?? '');
    if (!pid) continue;

    let ageband = p.Ageband ?? null;
    if (!ageband) {
      const age = q2ComputeAge(p);
      ageband = age !== null ? q2GetAgeband(age) : null;
    }

    const pc  = String(p.POSTCODE ?? '').trim().padStart(4, '0');
    const geo = phnLookup[pc] ?? { phn: null, state: null };

    enriched.push({
      pid,
      ageband,
      isYouth:   ageband !== null && Q2_CONFIG.youthAgebands.includes(ageband),
      diagnosis: diagByPatient[pid] ?? 'Other',
      phn:       geo.phn,
      state:     geo.state,
      years:     apptYears[pid] ?? new Set(),
      apptCounts,
    });
  }
  return enriched;
}

function q2PatientCountByDiagBandYear(patients) {
  const sets = {};
  for (const p of patients) {
    for (const yr of p.years) {
      const key = `${p.diagnosis}__${p.ageband ?? 'Unknown'}__${yr}`;
      if (!sets[key]) sets[key] = new Set();
      sets[key].add(p.pid);
    }
  }
  const counts = {};
  for (const [k, s] of Object.entries(sets)) counts[k] = s.size;
  return counts;
}

function q2AgeBandGrowth(counts) {
  const { growthFromYear: from, growthToYear: to } = Q2_CONFIG;
  const diagBands = new Set(Object.keys(counts).map(k => { const [d, b] = k.split('__'); return `${d}__${b}`; }));
  const result = {};
  for (const db of diagBands) {
    const [diag, band] = db.split('__');
    const cntFrom = counts[`${diag}__${band}__${from}`] ?? 0;
    const cntTo   = counts[`${diag}__${band}__${to}`]   ?? 0;
    result[db] = cntFrom > 0 ? (cntTo - cntFrom) / cntFrom : null;
  }
  return result;
}

function q2AgeBandRank(growth) {
  const byDiag = {};
  for (const [key, val] of Object.entries(growth)) {
    const [diag] = key.split('__');
    if (!byDiag[diag]) byDiag[diag] = [];
    byDiag[diag].push({ key, val });
  }
  const ranks = {};
  for (const entries of Object.values(byDiag)) {
    [...entries].filter(e => e.val !== null)
      .sort((a, b) => (b.val ?? -Infinity) - (a.val ?? -Infinity))
      .forEach((e, i) => { ranks[e.key] = i + 1; });
  }
  return ranks;
}

function q2YouthPatientsByDiagYear(patients) {
  const sets = {};
  for (const p of patients) {
    if (!p.isYouth) continue;
    for (const yr of p.years) {
      const key = `${p.diagnosis}__${yr}`;
      if (!sets[key]) sets[key] = new Set();
      sets[key].add(p.pid);
    }
  }
  const counts = {};
  for (const [k, s] of Object.entries(sets)) counts[k] = s.size;
  return counts;
}

function q2YouthGrowthByDiag(youthCounts) {
  const { growthFromYear: from, growthToYear: to } = Q2_CONFIG;
  const diags = new Set(Object.keys(youthCounts).map(k => k.split('__')[0]));
  const result = {};
  for (const diag of diags) {
    const cntFrom = youthCounts[`${diag}__${from}`] ?? 0;
    const cntTo   = youthCounts[`${diag}__${to}`]   ?? 0;
    result[diag]  = cntFrom > 0 ? (cntTo - cntFrom) / cntFrom : null;
  }
  return result;
}

function q2YouthByPHN(patients) {
  const { growthFromYear: from, growthToYear: to } = Q2_CONFIG;
  const apptsByPHN  = {};
  const phnYearPats = {};

  for (const p of patients) {
    if (!p.isYouth || !p.phn) continue;
    for (const yr of p.years) {
      apptsByPHN[p.phn] = (apptsByPHN[p.phn] ?? 0) + (p.apptCounts[`${p.pid}__${yr}`] ?? 0);
      const key = `${p.phn}__${yr}`;
      if (!phnYearPats[key]) phnYearPats[key] = new Set();
      phnYearPats[key].add(p.pid);
    }
  }

  const growthByPHN = {};
  for (const phn of Object.keys(apptsByPHN)) {
    const cntFrom = (phnYearPats[`${phn}__${from}`] ?? new Set()).size;
    const cntTo   = (phnYearPats[`${phn}__${to}`]   ?? new Set()).size;
    growthByPHN[phn] = cntFrom > 0 ? (cntTo - cntFrom) / cntFrom : null;
  }

  const result = [];
  Object.entries(growthByPHN)
    .filter(([, g]) => g !== null)
    .sort((a, b) => (b[1] ?? -Infinity) - (a[1] ?? -Infinity))
    .forEach(([phn, growth], i) => result.push({ phn, youthAppointments: apptsByPHN[phn] ?? 0, youthGrowth: growth, rank: i + 1 }));

  for (const phn of Object.keys(apptsByPHN)) {
    if (!result.find(r => r.phn === phn))
      result.push({ phn, youthAppointments: apptsByPHN[phn] ?? 0, youthGrowth: null, rank: null });
  }
  return result.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
}

function q2YouthVsAdultByPHN(patients) {
  const { growthFromYear: from, growthToYear: to } = Q2_CONFIG;
  const yearPats = { youth: {}, adult: {} };
  const appts    = { youth: {}, adult: {} };

  for (const p of patients) {
    if (!p.phn) continue;
    const cohort = p.isYouth ? 'youth' : 'adult';
    for (const yr of p.years) {
      const key = `${p.phn}__${yr}`;
      if (!yearPats[cohort][key]) yearPats[cohort][key] = new Set();
      yearPats[cohort][key].add(p.pid);
      appts[cohort][p.phn] = (appts[cohort][p.phn] ?? 0) + (p.apptCounts[`${p.pid}__${yr}`] ?? 0);
    }
  }

  const phns = new Set([...Object.keys(appts.youth), ...Object.keys(appts.adult)]);
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

function q2BuildCharts(patCountByDiagBandYear, youthCountsByDiagYear) {
  const DIAGS = Q2_CONFIG.diagOrder;
  const BANDS = Q2_CONFIG.ageBands.map(b => `${b.code} - ${b.label}`);

  // chartHeatmap — Patient Count by Diagnosis × Ageband summed across all years (grouped bar)
  const heatTotals = {};
  for (const [key, cnt] of Object.entries(patCountByDiagBandYear)) {
    const [diag, band] = key.split('__');
    const k = `${diag}__${band}`;
    heatTotals[k] = (heatTotals[k] ?? 0) + cnt;
  }
  const chartHeatmap = {
    title: 'Patient Count by Diagnosis & Age Band (all years)',
    type: 'bar',
    labels: BANDS,
    datasets: DIAGS.map(diag => ({
      label: diag,
      data:  BANDS.map(band => heatTotals[`${diag}__${band}`] ?? 0),
    })),
  };

  // chartYouthTrend — Youth patients by year & diagnosis (line)
  const trendYears = [...new Set(Object.keys(youthCountsByDiagYear).map(k => k.split('__')[1]))]
    .map(Number).sort();
  const chartYouthTrend = {
    title: 'Youth Patients by Year & Diagnosis (12–24 cohort)',
    type: 'line',
    labels: trendYears,
    datasets: DIAGS.map(diag => ({
      label: diag,
      data:  trendYears.map(yr => youthCountsByDiagYear[`${diag}__${yr}`] ?? 0),
    })),
  };

  // chartYouthStacked — Youth patients stacked by diagnosis & year (stacked bar)
  const chartYouthStacked = {
    title: 'Youth Patients Stacked by Diagnosis & Year',
    type: 'bar',
    stacked: true,
    labels: trendYears,
    datasets: DIAGS.map(diag => ({
      label: diag,
      stack: 'stack',
      data:  trendYears.map(yr => youthCountsByDiagYear[`${diag}__${yr}`] ?? 0),
    })),
  };

  return { chartHeatmap, chartYouthTrend, chartYouthStacked };
}

app.post('/api/query2', async (req, res) => {
  const { uri: bodyUri, db = 'dokotela-reporting' } = req.body ?? {};
  const uri = SERVER_URI || bodyUri;
  if (!uri) return res.status(400).json({ error: 'MongoDB URI required — set MONGO_URI env var or pass uri in body' });

  let client;
  try {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
    await client.connect();
    const mdb = client.db(db);

    // $addFields + $reduce normalises INTERNALID regardless of UTF-8 BOM on the field name
    const normId = {
      $addFields: {
        INTERNALID: {
          $reduce: {
            input: { $objectToArray: '$$ROOT' },
            initialValue: null,
            in: { $cond: [{ $regexMatch: { input: '$$this.k', regex: 'INTERNALID$' } }, '$$this.v', '$$value'] },
          },
        },
      },
    };

    const [rawPatients, rawHistory, rawAppts, rawPHN] = await Promise.all([
      mdb.collection('PATIENTS').aggregate([
        normId,
        { $match: { INTERNALID: { $ne: null } } },
        { $project: { _id: 0, INTERNALID: 1, AGE: 1, DOB: 1, Ageband: 1, POSTCODE: 1 } },
      ], { allowDiskUse: true }).toArray(),

      mdb.collection('PASTHISTORY').aggregate([
        { $match: { RECORDSTATUS: 1 } },
        { $project: { _id: 0, INTERNALID: 1, ITEMTEXT: 1 } },
      ], { allowDiskUse: true }).toArray(),

      mdb.collection('APPOINTMENTS').aggregate([
        normId,
        { $match: { INTERNALID: { $ne: null }, RECORDSTATUS: '1' } },
        { $project: { _id: 0, INTERNALID: 1, APPOINTMENTDATE: 1 } },
      ], { allowDiskUse: true }).toArray(),

      mdb.collection('Postcode_PHN_SA3_SA4').aggregate([
        { $project: { _id: 0, Postcode: 1, PHN_Name: 1, State: 1 } },
      ], { allowDiskUse: true }).toArray(),
    ]);

    console.log(`[query2] patients=${rawPatients.length} history=${rawHistory.length} appts=${rawAppts.length} phn=${rawPHN.length}`);

    const patients = q2BuildEnriched(
      stripBOM(rawPatients),
      stripBOM(rawHistory),
      rawAppts,
      stripBOM(rawPHN),
    );

    // Metrics
    const patCountByDiagBandYear = q2PatientCountByDiagBandYear(patients);
    const youthCountsByDiagYear  = q2YouthPatientsByDiagYear(patients);
    const growth                 = q2AgeBandGrowth(patCountByDiagBandYear);
    const ranks                  = q2AgeBandRank(growth);
    const youthGrowthByDiag      = q2YouthGrowthByDiag(youthCountsByDiagYear);

    // KPIs
    const youthPats = patients.filter(p => p.isYouth);
    const topDiag   = Object.entries(youthGrowthByDiag)
      .filter(([, g]) => g !== null)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0];
    const kpis = {
      totalPatients:  patients.length,
      youthPatients:  youthPats.length,
      youthPct:       patients.length > 0 ? +(youthPats.length / patients.length * 100).toFixed(1) : null,
      topYouthDiag:   topDiag ? topDiag[0] : null,
      topYouthGrowth: topDiag ? +(topDiag[1] * 100).toFixed(0) : null,
    };

    // Charts
    const charts = q2BuildCharts(patCountByDiagBandYear, youthCountsByDiagYear);

    // Tables
    const patTotals = {};
    for (const [key, cnt] of Object.entries(patCountByDiagBandYear)) {
      const [diag, band] = key.split('__');
      patTotals[`${diag}__${band}`] = (patTotals[`${diag}__${band}`] ?? 0) + cnt;
    }

    const ageBandGrowthTable = {
      title: 'Age Band Growth Ranking (2019 → 2025)',
      rows: Object.entries(growth)
        .map(([key, g]) => {
          const [diagnosis, ageBand] = key.split('__');
          return { diagnosis, ageBand, totalPatients: patTotals[key] ?? 0, growth: g, rank: ranks[key] ?? null };
        })
        .sort((a, b) => (b.growth ?? -Infinity) - (a.growth ?? -Infinity)),
    };

    const youthByPHNTable = {
      title: 'Youth Demand by PHN Region (ranked by growth)',
      rows: q2YouthByPHN(patients),
    };

    const youthVsAdultTable = {
      title: 'Youth vs Adult Growth by PHN Region',
      rows: q2YouthVsAdultByPHN(patients),
    };

    res.json({ kpis, charts, tables: { ageBandGrowthTable, youthByPHNTable, youthVsAdultTable } });

  } catch (err) {
    console.error('[query2 error]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (client) await client.close().catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`\n▶  Dashboard:       http://localhost:${PORT}`);
  console.log(`   Mongo URI:        ${SERVER_URI ? '(from .env)' : '(from request body)'}`);
  console.log(`   Aggregate API:    POST http://localhost:${PORT}/api/aggregate`);
  console.log(`   Query 6 API:      POST http://localhost:${PORT}/api/query6`);
  console.log(`   Query 2 API:      POST http://localhost:${PORT}/api/query2\n`);
});
