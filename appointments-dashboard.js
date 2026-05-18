// appointments-dashboard.js
// Drop into your project, import into your HTML, call init()
// Requires: Chart.js 4.x loaded globally or imported

import { mongoAggregate } from './mongo-client.js';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG  — edit these to match your Mongo field names / collection
// ─────────────────────────────────────────────────────────────────────────────
export const CONFIG = {
  collection:        'APPOINTMENTS',
  dateField:         'APPOINTMENTDATE',
  patientIdField:    'INTERNALID',
  appointmentLength: 'APPOINTMENTLENGTH',   // seconds
  visitLength:       'VISITLENGTH',          // seconds, 0 = no-show / not recorded
  appointmentCode:   'APPOINTMENTCODE',
  recordStatus:      'RECORDSTATUS',         // 1 = active
  validDateRange:    { from: new Date('2011-01-01'), to: new Date('2025-12-31') },
  validLengthRange:  { min: 1, max: 36000 }, // seconds

  // Map APPOINTMENTCODE integers → human labels
  // Sourced from APPOINTMENTTYPE.csv (APPOINTMENTCODE col)
  codeLabels: {
    9:  'Video',
    13: 'Phone',
    5:  'Standard',
    0:  'Unspecified',
    12: 'Long',
    10: 'Follow-up',
    1:  'New Patient',
    2:  'Brief',
    4:  'Urgent',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// THEME
// ─────────────────────────────────────────────────────────────────────────────
const T = {
  primary: '#e05c2f',
  blue:    '#2f7be0',
  green:   '#2fbe7a',
  amber:   '#c4a800',
  purple:  '#9b4fdb',
  muted:   '#8a8278',
  border:  '#e8e4df',
  mono:    "'DM Mono', monospace",
};

const AXIS = {
  grid:  { color: T.border },
  ticks: { color: T.muted, font: { family: T.mono, size: 10 } },
};

const LEGEND = {
  labels: { color: T.muted, font: { family: T.mono, size: 10 }, boxWidth: 10, padding: 12 },
};

// ─────────────────────────────────────────────────────────────────────────────
// MODULE STATE
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  raw:           [],     // parsed + enriched rows
  selectedYears: new Set(),
  charts:        {},
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialise the dashboard.
 * @param {Object} opts
 * @param {string} opts.uri        MongoDB URI
 * @param {string} opts.db         Database name
 * @param {boolean} [opts.activeOnly=true]  Filter RECORDSTATUS === 1
 * @param {Function} [opts.onStatus]        Called with (message, level:'info'|'ok'|'error')
 */
export async function init({ uri = '', db, activeOnly = true, onStatus = () => {} } = {}) {
  onStatus('Fetching appointments…', 'info');

  const pipeline = buildPipeline(activeOnly);
  const rows     = await mongoAggregate(uri, db, CONFIG.collection, pipeline);

  state.raw = rows.map(parseRow).filter(r => r !== null);
  state.selectedYears.clear();

  onStatus(`✓ ${state.raw.length.toLocaleString()} records loaded`, 'ok');
  render();
}

/**
 * Load from a pre-fetched array (for testing / SSR hydration).
 * @param {Array} rows  Raw Mongo documents
 */
export function loadData(rows) {
  state.raw = rows.map(parseRow).filter(r => r !== null);
  state.selectedYears.clear();
  render();
}

/**
 * Toggle a year filter on/off and re-render.
 * Pass null to clear all filters.
 * @param {number|null} year
 */
export function toggleYear(year) {
  if (year === null) {
    state.selectedYears.clear();
  } else if (state.selectedYears.has(year)) {
    state.selectedYears.delete(year);
  } else {
    state.selectedYears.add(year);
  }
  render();
}

/**
 * Returns the currently computed KPIs (useful if you want to bind to your own UI).
 */
export function getKPIs() {
  return computeKPIs(filteredRecords());
}

// ─────────────────────────────────────────────────────────────────────────────
// MONGO PIPELINE
// ─────────────────────────────────────────────────────────────────────────────
function buildPipeline(activeOnly) {
  const stages = [];

  if (activeOnly) {
    stages.push({ $match: { [CONFIG.recordStatus]: '1' } });
  }

  stages.push({
    $project: {
      _id: 0,
      [CONFIG.patientIdField]:    1,
      [CONFIG.dateField]:         1,
      [CONFIG.appointmentLength]: 1,
      [CONFIG.visitLength]:       1,
      [CONFIG.appointmentCode]:   1,
    },
  });

  return stages;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROW PARSING
// ─────────────────────────────────────────────────────────────────────────────
// Parses "D/M/YYYY H:MM:SS AM/PM" (Australian locale from BP software)
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

function toNum(v) { return typeof v === 'number' ? v : parseFloat(v); }

function parseRow(r) {
  const d = parseAusDate(r[CONFIG.dateField]);
  if (isNaN(d)) return null;

  const year  = d.getFullYear();
  const month = d.getMonth();        // 0-11
  const dow   = d.getDay();          // 0=Sun

  if (year < 2011 || year > 2025) return null;

  const rawVL = toNum(r[CONFIG.visitLength]);
  const rawAL = toNum(r[CONFIG.appointmentLength]);
  const { min, max } = CONFIG.validLengthRange;

  return {
    patientId: r[CONFIG.patientIdField],
    code:      r[CONFIG.appointmentCode] ?? null,
    year,
    month,
    dow,
    yearMonth: `${year}-${String(month + 1).padStart(2, '0')}`,
    visitMin:  (typeof rawVL === 'number' && rawVL >= min && rawVL <= max) ? rawVL / 60 : null,
    bookedMin: (typeof rawAL === 'number' && rawAL >= min && rawAL <= max) ? rawAL / 60 : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FILTERING
// ─────────────────────────────────────────────────────────────────────────────
function filteredRecords() {
  if (state.selectedYears.size === 0) return state.raw;
  return state.raw.filter(r => state.selectedYears.has(r.year));
}

function allYears() {
  return [...new Set(state.raw.map(r => r.year))].sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// KPI COMPUTATION
// ─────────────────────────────────────────────────────────────────────────────
function computeKPIs(records) {
  const total    = records.length;
  const patients = new Set(records.map(r => r.patientId));
  const patCount = patients.size;

  const vlRecs = records.filter(r => r.visitMin !== null);
  const alRecs = records.filter(r => r.bookedMin !== null);

  const avgVisit  = vlRecs.length ? avg(vlRecs.map(r => r.visitMin))  : null;
  const avgBooked = alRecs.length ? avg(alRecs.map(r => r.bookedMin)) : null;

  // YoY: last two years present in this filtered set
  const byYear = groupBy(records, r => r.year);
  const sortedYears = Object.keys(byYear).map(Number).sort();
  let yoyPct = null, yoyYears = null;
  if (sortedYears.length >= 2) {
    const cur = byYear[sortedYears.at(-1)].length;
    const prv = byYear[sortedYears.at(-2)].length;
    yoyPct   = ((cur - prv) / prv) * 100;
    yoyYears = [sortedYears.at(-2), sortedYears.at(-1)];
  }

  return {
    total,
    uniquePatients: patCount,
    avgPerPatient:  patCount > 0 ? total / patCount : null,
    avgVisitMin:    avgVisit,
    avgBookedMin:   avgBooked,
    yoyPct,
    yoyYears,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-YEAR STATS (for table + new/returning chart)
// ─────────────────────────────────────────────────────────────────────────────
function computeYearStats(allRecords) {
  // First year each patient appeared — computed over ALL records (not filtered)
  const firstYear = {};
  allRecords.forEach(r => {
    if (firstYear[r.patientId] === undefined || r.year < firstYear[r.patientId]) {
      firstYear[r.patientId] = r.year;
    }
  });

  const byYear = groupBy(allRecords, r => r.year);
  const stats  = {};

  for (const [yr, recs] of Object.entries(byYear)) {
    const y       = Number(yr);
    const pats    = new Set(recs.map(r => r.patientId));
    const newPats = new Set([...pats].filter(pid => firstYear[pid] === y));
    const retPats = new Set([...pats].filter(pid => firstYear[pid] !== y));
    const vls     = recs.filter(r => r.visitMin  !== null).map(r => r.visitMin);
    const als     = recs.filter(r => r.bookedMin !== null).map(r => r.bookedMin);

    stats[y] = {
      year:           y,
      count:          recs.length,
      uniquePatients: pats.size,
      newPatients:    newPats.size,
      retPatients:    retPats.size,
      avgVisitMin:    vls.length ? avg(vls) : null,
      avgBookedMin:   als.length ? avg(als) : null,
    };
  }

  return stats;
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────────────
function render() {
  const filtered  = filteredRecords();
  const years     = allYears();
  const yearStats = computeYearStats(state.raw);   // always over all data
  const kpis      = computeKPIs(filtered);

  renderKPIs(kpis);
  renderYearPills(years);
  renderMonthlyTrend(filtered);
  renderAnnualBar(yearStats, years);
  renderCodeDist(filtered);
  renderDOW(filtered);
  renderVisitLenByMonth(filtered);
  renderNewReturn(yearStats, years);
  renderTable(yearStats, years);
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — KPIs
// Write to elements by convention: data-kpi="total|patients|avgPat|avgVisit|avgBooked|yoy"
// ─────────────────────────────────────────────────────────────────────────────
function renderKPIs(kpis) {
  setText('[data-kpi="total"]',     kpis.total.toLocaleString());
  setText('[data-kpi="patients"]',  kpis.uniquePatients.toLocaleString());
  setText('[data-kpi="avgPat"]',    kpis.avgPerPatient != null ? kpis.avgPerPatient.toFixed(1) : '—');
  setText('[data-kpi="avgVisit"]',  kpis.avgVisitMin   != null ? kpis.avgVisitMin.toFixed(1) + ' min' : '—');
  setText('[data-kpi="avgBooked"]', kpis.avgBookedMin  != null ? kpis.avgBookedMin.toFixed(1) + ' min' : '—');

  if (kpis.yoyPct != null) {
    const sign = kpis.yoyPct >= 0 ? '+' : '';
    setText('[data-kpi="yoy"]',    sign + kpis.yoyPct.toFixed(1) + '%');
    setText('[data-kpi="yoySub"]', `${kpis.yoyYears[0]} → ${kpis.yoyYears[1]}`);
  } else {
    setText('[data-kpi="yoy"]',    '—');
    setText('[data-kpi="yoySub"]', '');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — Year pills  (element id="yearPills")
// ─────────────────────────────────────────────────────────────────────────────
function renderYearPills(years) {
  const container = document.getElementById('yearPills');
  if (!container) return;

  container.innerHTML = '';

  const allPill = pill('All years', state.selectedYears.size === 0, () => toggleYear(null));
  container.appendChild(allPill);

  for (const y of years) {
    container.appendChild(pill(y, state.selectedYears.has(y), () => toggleYear(y)));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — Monthly trend  (canvas id="chartMonthly")
// ─────────────────────────────────────────────────────────────────────────────
function renderMonthlyTrend(records) {
  const map = countBy(records, r => r.yearMonth);
  const labels = Object.keys(map).sort();
  const vals   = labels.map(k => map[k]);

  mkChart('chartMonthly', 'line', {
    labels,
    datasets: [{
      label: 'Appointments',
      data: vals,
      borderColor: T.primary,
      backgroundColor: T.primary + '18',
      borderWidth: 2,
      pointRadius: 0,
      fill: true,
      tension: 0.3,
    }],
  }, {
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: c => ` ${c.parsed.y.toLocaleString()} appts` } },
    },
    scales: {
      x: { ...AXIS, ticks: { ...AXIS.ticks, maxTicksLimit: 18 } },
      y: { ...AXIS, beginAtZero: true, ticks: { ...AXIS.ticks, callback: v => fmtK(v) } },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — Annual bar  (canvas id="chartAnnual")
// ─────────────────────────────────────────────────────────────────────────────
function renderAnnualBar(yearStats, years) {
  const vals = years.map(y => yearStats[y]?.count ?? 0);

  mkChart('chartAnnual', 'bar', {
    labels: years,
    datasets: [{
      label: 'Appointments',
      data: vals,
      backgroundColor: years.map((_, i) => i === years.length - 1 ? T.primary : T.primary + '77'),
      borderRadius: 5,
    }],
  }, {
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: c => ` ${c.parsed.y.toLocaleString()}` } },
    },
    scales: {
      x: { ...AXIS },
      y: { ...AXIS, beginAtZero: true, ticks: { ...AXIS.ticks, callback: v => fmtK(v) } },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — Appointment code donut  (canvas id="chartCode")
// ─────────────────────────────────────────────────────────────────────────────
function renderCodeDist(records) {
  const map = countBy(records, r => r.code ?? 'Unknown');
  const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const total  = sorted.reduce((s, [, v]) => s + v, 0);
  const labels = sorted.map(([c]) => CONFIG.codeLabels[c] ?? `Code ${c}`);
  const vals   = sorted.map(([, v]) => v);
  const colors = [T.primary, T.blue, T.green, T.amber, T.purple,
                  T.primary + '88', T.blue + '88', T.green + '88'];

  mkChart('chartCode', 'doughnut', {
    labels,
    datasets: [{
      data: vals,
      backgroundColor: colors,
      borderWidth: 2,
      borderColor: '#fff',
      hoverOffset: 6,
    }],
  }, {
    cutout: '55%',
    plugins: {
      legend: { ...LEGEND, position: 'right' },
      tooltip: { callbacks: {
        label: c => ` ${c.label}: ${c.parsed.toLocaleString()} (${(c.parsed / total * 100).toFixed(1)}%)`,
      }},
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — Day of week  (canvas id="chartDOW")
// ─────────────────────────────────────────────────────────────────────────────
function renderDOW(records) {
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const counts    = Array(7).fill(0);
  records.forEach(r => { counts[r.dow]++; });

  mkChart('chartDOW', 'bar', {
    labels: DAY_NAMES,
    datasets: [{
      label: 'Appointments',
      data: counts,
      backgroundColor: counts.map((_, i) => i === 0 || i === 6 ? T.muted + '66' : T.blue + 'bb'),
      borderRadius: 4,
    }],
  }, {
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: c => ` ${c.parsed.y.toLocaleString()}` } },
    },
    scales: {
      x: { ...AXIS },
      y: { ...AXIS, beginAtZero: true, ticks: { ...AXIS.ticks, callback: v => fmtK(v) } },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — Avg visit length by calendar month  (canvas id="chartVisitLen")
// ─────────────────────────────────────────────────────────────────────────────
function renderVisitLenByMonth(records) {
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const buckets     = Array.from({ length: 12 }, () => []);
  records.forEach(r => { if (r.visitMin !== null) buckets[r.month].push(r.visitMin); });

  const vals = buckets.map(b => b.length ? parseFloat(avg(b).toFixed(1)) : null);

  mkChart('chartVisitLen', 'bar', {
    labels: MONTH_NAMES,
    datasets: [{
      label: 'Avg Visit (min)',
      data: vals,
      backgroundColor: T.green + 'bb',
      borderRadius: 4,
    }],
  }, {
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: c => ` ${c.parsed.y} min avg` } },
    },
    scales: {
      x: { ...AXIS },
      y: { ...AXIS, beginAtZero: true },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — New vs Returning patients  (canvas id="chartNewReturn")
// ─────────────────────────────────────────────────────────────────────────────
function renderNewReturn(yearStats, years) {
  const newV = years.map(y => yearStats[y]?.newPatients ?? 0);
  const retV = years.map(y => yearStats[y]?.retPatients ?? 0);

  mkChart('chartNewReturn', 'bar', {
    labels: years,
    datasets: [
      { label: 'New Patients',       data: newV, backgroundColor: T.amber + 'cc', borderRadius: 4, stack: 'stack' },
      { label: 'Returning Patients', data: retV, backgroundColor: T.blue  + 'cc', borderRadius: 4, stack: 'stack' },
    ],
  }, {
    plugins: {
      legend: { ...LEGEND },
      tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${c.parsed.y.toLocaleString()}` } },
    },
    scales: {
      x: { ...AXIS, stacked: true },
      y: { ...AXIS, stacked: true, beginAtZero: true, ticks: { ...AXIS.ticks, callback: v => fmtK(v) } },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — Summary table  (tbody id="summaryBody")
// ─────────────────────────────────────────────────────────────────────────────
function renderTable(yearStats, years) {
  const tbody = document.getElementById('summaryBody');
  if (!tbody) return;

  const maxCount = Math.max(...Object.values(yearStats).map(s => s.count));
  tbody.innerHTML = '';

  for (const y of [...years].sort((a, b) => b - a)) {
    const s = yearStats[y];
    if (!s) continue;

    const pct      = ((s.count / maxCount) * 100).toFixed(0);
    const avgV     = s.avgVisitMin  != null ? s.avgVisitMin.toFixed(1)  : '—';
    const avgA     = s.avgBookedMin != null ? s.avgBookedMin.toFixed(1) : '—';
    const avgPP    = s.uniquePatients > 0   ? (s.count / s.uniquePatients).toFixed(1) : '—';

    tbody.insertAdjacentHTML('beforeend', `
      <tr>
        <td><strong>${y}</strong></td>
        <td>${s.count.toLocaleString()}</td>
        <td>${s.uniquePatients.toLocaleString()}</td>
        <td>${avgPP}</td>
        <td>${avgV}</td>
        <td>${avgA}</td>
        <td>
          <div style="display:flex;align-items:center;gap:6px">
            <div style="flex:1;height:4px;background:#e8e4df;border-radius:2px;overflow:hidden">
              <div style="width:${pct}%;height:100%;background:${T.primary};border-radius:2px"></div>
            </div>
            <span style="font-size:10px;color:${T.muted};font-family:${T.mono}">${pct}%</span>
          </div>
        </td>
      </tr>`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function avg(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }

function countBy(arr, keyFn) {
  const out = {};
  arr.forEach(item => { const k = keyFn(item); out[k] = (out[k] ?? 0) + 1; });
  return out;
}

function groupBy(arr, keyFn) {
  const out = {};
  arr.forEach(item => { const k = keyFn(item); (out[k] = out[k] ?? []).push(item); });
  return out;
}

function fmtK(v) { return v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v; }

function setText(selector, text) {
  const el = document.querySelector(selector);
  if (el) el.textContent = text;
}

function pill(label, active, onClick) {
  const el = document.createElement('span');
  el.className = 'pill' + (active ? ' active' : '');
  el.textContent = label;
  el.onclick = onClick;
  return el;
}

function mkChart(id, type, data, options) {
  const canvas = document.getElementById(id);
  if (!canvas) return null;
  if (state.charts[id]) state.charts[id].destroy();
  state.charts[id] = new Chart(canvas, { type, data, options });
  return state.charts[id];
}
