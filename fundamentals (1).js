// Turns SEC "companyfacts" XBRL JSON into clean annual + quarterly rows.
// Quarterly values: 3-month figures are used directly; where a company only reports
// year-to-date numbers (typical for cash flow) or Q4 (which is never filed on its own),
// the quarter is derived by subtraction.

const DAY = 864e5;
const t = (s) => Date.parse(s + 'T00:00:00Z');
const near = (a, b, days = 6) => Math.abs(t(a) - t(b)) <= days * DAY;
const months = (e) => Math.round((t(e.end) - t(e.start)) / DAY / 30.44);

// type: flow = covers a period (income / cash flow), instant = balance sheet date
// Tags are tried in order; later tags fill gaps when a company changed tag over the years.
const METRICS = [
  { key: 'revenue', type: 'flow', unit: 'USD', tags: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueGoodsNet'] },
  { key: 'costOfRevenue', type: 'flow', unit: 'USD', tags: ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold'] },
  { key: 'grossProfit', type: 'flow', unit: 'USD', tags: ['GrossProfit'] },
  { key: 'rnd', type: 'flow', unit: 'USD', tags: ['ResearchAndDevelopmentExpense'] },
  { key: 'operatingIncome', type: 'flow', unit: 'USD', tags: ['OperatingIncomeLoss'] },
  { key: 'netIncome', type: 'flow', unit: 'USD', tags: ['NetIncomeLoss', 'ProfitLoss'] },
  { key: 'epsDiluted', type: 'flow', unit: 'USD/shares', tags: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'] },
  // Weighted share counts can't be derived by subtraction, so only directly reported values are used.
  { key: 'sharesDiluted', type: 'flow', unit: 'shares', derive: false, tags: ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfSharesOutstandingBasicAndDiluted'] },
  { key: 'dps', type: 'flow', unit: 'USD/shares', tags: ['CommonStockDividendsPerShareDeclared', 'CommonStockDividendsPerShareCashPaid'] },
  { key: 'ocf', type: 'flow', unit: 'USD', tags: ['NetCashProvidedByUsedInOperatingActivities'] },
  { key: 'capex', type: 'flow', unit: 'USD', tags: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'] },
  { key: 'buybacks', type: 'flow', unit: 'USD', tags: ['PaymentsForRepurchaseOfCommonStock'] },
  { key: 'cash', type: 'instant', unit: 'USD', tags: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'] },
  { key: 'currentAssets', type: 'instant', unit: 'USD', tags: ['AssetsCurrent'] },
  { key: 'assets', type: 'instant', unit: 'USD', tags: ['Assets'] },
  { key: 'currentLiabilities', type: 'instant', unit: 'USD', tags: ['LiabilitiesCurrent'] },
  { key: 'liabilities', type: 'instant', unit: 'USD', tags: ['Liabilities'] },
  { key: 'debt', type: 'instant', unit: 'USD', tags: ['LongTermDebt', 'LongTermDebtNoncurrent'] },
  { key: 'equity', type: 'instant', unit: 'USD', tags: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'] },
];

const PERIOD_KEYS = ['revenue', 'netIncome', 'operatingIncome', 'epsDiluted', 'ocf'];

function hasNear(map, end) {
  if (map.has(end)) return true;
  for (const k of map.keys()) if (near(k, end)) return true;
  return false;
}

function getNear(map, end) {
  if (map.has(end)) return map.get(end);
  for (const [k, v] of map) if (near(k, end)) return v;
  return null;
}

function dedupe(list, keyFn) {
  const m = new Map();
  for (const e of list) {
    const k = keyFn(e);
    const p = m.get(k);
    if (!p || e.filed > p.filed) m.set(k, e); // latest filing wins (restatements)
  }
  return [...m.values()];
}

function flowSeries(entries, derive = true) {
  const ent = dedupe(
    entries.filter((e) => e.start && e.end && typeof e.val === 'number'),
    (e) => e.start + '|' + e.end
  );
  const by = { 3: [], 6: [], 9: [], 12: [] };
  for (const e of ent) {
    const m = months(e);
    if (by[m]) by[m].push(e);
  }
  const annualEntries = new Map();
  for (const e of by[12]) {
    if (!/^10-K/.test(e.form || '')) continue;
    const p = annualEntries.get(e.end);
    if (!p || e.filed > p.filed) annualEntries.set(e.end, e);
  }
  const quarterly = new Map();
  for (const e of by[3]) {
    const p = quarterly.get(e.end);
    if (p === undefined) quarterly.set(e.end, e.val);
  }
  if (derive) {
    for (const a of annualEntries.values()) {
      const S = a.start, E = a.end;
      const q1 = by[3].find((x) => near(x.start, S));
      const c6 = by[6].find((x) => near(x.start, S));
      const c9 = by[9].find((x) => near(x.start, S));
      if (q1 && c6 && !hasNear(quarterly, c6.end)) quarterly.set(c6.end, c6.val - q1.val);
      if (c6 && c9 && !hasNear(quarterly, c9.end)) quarterly.set(c9.end, c9.val - c6.val);
      if (c9 && !hasNear(quarterly, E)) quarterly.set(E, a.val - c9.val); // Q4 = FY - 9M
    }
  }
  return { annual: new Map([...annualEntries].map(([k, e]) => [k, e.val])), quarterly };
}

function instantSeries(entries) {
  const ent = dedupe(
    entries.filter((e) => !e.start && e.end && typeof e.val === 'number'),
    (e) => e.end
  );
  const m = new Map(ent.map((e) => [e.end, e.val]));
  return { annual: m, quarterly: m };
}

function mergeInto(target, source) {
  for (const [k, v] of source) if (!hasNear(target, k)) target.set(k, v);
}

function buildSeries(metric, gaap) {
  const annual = new Map(), quarterly = new Map();
  for (const tag of metric.tags) {
    const units = gaap[tag] && gaap[tag].units && gaap[tag].units[metric.unit];
    if (!units) continue;
    const s = metric.type === 'flow' ? flowSeries(units, metric.derive !== false) : instantSeries(units);
    mergeInto(annual, s.annual);
    mergeInto(quarterly, s.quarterly);
  }
  return { annual, quarterly };
}

function clusterEnds(ends) {
  const sorted = [...new Set(ends)].sort();
  const out = [];
  for (const e of sorted) {
    if (out.length && near(out[out.length - 1], e)) out[out.length - 1] = e;
    else out.push(e);
  }
  return out;
}

function build(facts) {
  const gaap = (facts.facts && facts.facts['us-gaap']) || {};
  const series = {};
  for (const m of METRICS) series[m.key] = buildSeries(m, gaap);

  const result = { name: facts.entityName, annual: [], quarterly: [] };
  for (const mode of ['annual', 'quarterly']) {
    const ends = [];
    for (const k of PERIOD_KEYS) for (const e of series[k][mode].keys()) ends.push(e);
    const periods = clusterEnds(ends).slice(mode === 'annual' ? -10 : -40);
    result[mode] = periods.map((end) => {
      const v = {};
      for (const m of METRICS) {
        const val = getNear(series[m.key][mode], end);
        v[m.key] = val === undefined ? null : val;
      }
      return { end, v };
    });
  }
  return result;
}

module.exports = { build, METRICS };
