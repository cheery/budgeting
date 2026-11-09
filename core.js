// Core budget model: plain-text parsing/serialization, 3-way merge, statistics.
// No DOM dependencies, so it can be tested with plain Node.

export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function emptyBudget() {
  // plans: { [year]: { [category]: number[12] } }
  // tx:    [{ date: 'YYYY-MM-DD', cat, amount, note }]
  // balances: { 'YYYY-MM-DD': amount } = account balance at the start of that day
  return { currency: 'EUR', categories: [], plans: {}, tx: [], balances: {} };
}

// Errors carry a `key` and `args` so the UI can translate them (see i18n.js `err.*`).
function fail(key, args, msg) {
  const e = new Error(msg);
  e.key = key; e.args = args;
  throw e;
}
const errEntry = (line, e) => ({ line, msg: e.message, key: e.key, args: e.args });

// ---------- tokenizing ----------

function tokenize(line) {
  const toks = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    const start = i;
    if (line[i] === '"') {
      let s = '';
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) i++;
        s += line[i++];
      }
      if (i >= line.length) fail('quote', [], 'Unterminated quote');
      i++;
      toks.push({ v: s, end: i });
    } else {
      while (i < line.length && !/\s/.test(line[i])) i++;
      toks.push({ v: line.slice(start, i), end: i });
    }
  }
  return toks;
}

export function quote(name) {
  if (name !== '' && !/[\s"\\]/.test(name)) return name;
  return '"' + name.replace(/[\\"]/g, '\\$&') + '"';
}

export function parseAmount(s) {
  const n = Number(String(s).trim().replace(/\s/g, '').replace(',', '.'));
  if (String(s).trim() === '' || !Number.isFinite(n)) fail('amount', [s], `Bad amount "${s}"`);
  return Math.round(n * 100) / 100;
}

export function fmtNum(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function parseMonths(s) {
  if (s === undefined || s === 'all') return [...Array(12).keys()];
  const out = new Set();
  for (const part of s.split(',')) {
    const m = part.match(/^(\d{1,2})(?:-(\d{1,2}))?$/);
    if (!m) fail('months', [s], `Bad month list "${s}"`);
    const a = +m[1], b = m[2] ? +m[2] : a;
    if (a < 1 || b > 12 || a > b) fail('months', [part], `Bad month range "${part}"`);
    for (let k = a; k <= b; k++) out.add(k - 1);
  }
  return [...out];
}

function formatMonths(list) {
  if (list.length === 12) return 'all';
  const parts = [];
  for (let i = 0; i < list.length; i++) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
    parts.push(i === j ? `${list[i] + 1}` : `${list[i] + 1}-${list[j] + 1}`);
    i = j;
  }
  return parts.join(',');
}

// ---------- parse / serialize ----------

export function parse(text) {
  const b = emptyBudget();
  const errors = [];
  const records = [];
  const catMap = new Map();

  text.split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    try {
      records.push({ ln: idx + 1, line, toks: tokenize(line) });
    } catch (e) {
      errors.push(errEntry(idx + 1, e));
    }
  });

  const addCat = (name, type, certain = false) => {
    let c = catMap.get(name);
    if (!c) {
      c = { name, type, certain };
      catMap.set(name, c);
      b.categories.push(c);
    } else Object.assign(c, { type, certain });
    return c;
  };
  const useCat = (name, ln) => {
    if (!catMap.has(name)) {
      errors.push({ line: ln, msg: `Category "${name}" not declared; added as expense`, key: 'undeclared', args: [name], warn: true });
      addCat(name, 'expense');
    }
  };

  // Pass 1: settings and categories, so order in the file doesn't matter.
  for (const r of records) {
    const [kw, ...rest] = r.toks.map(t => t.v);
    try {
      if (kw === 'currency') {
        if (!/^[A-Za-z]{3}$/.test(rest[0] || '')) fail('currency', [], 'Expected 3-letter currency code');
        b.currency = rest[0].toUpperCase();
      } else if (kw === 'category') {
        if (rest.length < 2 || rest.length > 3 || !['income', 'expense'].includes(rest[1])
          || (rest.length === 3 && rest[2] !== 'certain'))
          fail('category', [], 'Expected: category NAME income|expense [certain]');
        addCat(rest[0], rest[1], rest.length === 3);
      }
    } catch (e) { errors.push(errEntry(r.ln, e)); }
  }

  // Pass 2: plans and transactions.
  for (const r of records) {
    const vals = r.toks.map(t => t.v);
    const kw = vals[0];
    try {
      if (kw === 'currency' || kw === 'category') continue;
      if (kw === 'balance') {
        if (vals.length !== 3) fail('balance', [], 'Expected: balance YYYY-MM-DD AMOUNT');
        checkDate(vals[1]);
        b.balances[vals[1]] = parseAmount(vals[2]);
      } else if (kw === 'plan') {
        if (vals.length < 4 || vals.length > 5) fail('plan', [], 'Expected: plan YEAR CATEGORY AMOUNT [MONTHS]');
        const year = vals[1];
        if (!/^\d{4}$/.test(year)) fail('year', [year], `Bad year "${year}"`);
        const amount = parseAmount(vals[3]);
        const months = parseMonths(vals[4]);
        useCat(vals[2], r.ln);
        const row = ((b.plans[year] ||= {})[vals[2]] ||= Array(12).fill(0));
        for (const m of months) row[m] = amount;
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(kw)) {
        if (vals.length < 3) fail('tx', [], 'Expected: DATE CATEGORY AMOUNT [note]');
        checkDate(kw);
        const amount = parseAmount(vals[2]);
        useCat(vals[1], r.ln);
        const note = r.line.slice(r.toks[2].end).trim();
        b.tx.push({ date: kw, cat: vals[1], amount, note });
      } else {
        fail('unknown', [], 'Unrecognized line');
      }
    } catch (e) { errors.push(errEntry(r.ln, e)); }
  }
  sortTx(b);
  return { budget: b, errors };
}

function checkDate(s) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z');
  if (!d || isNaN(d) || d.toISOString().slice(0, 10) !== s) fail('date', [s], `Bad date "${s}"`);
}

export function sortTx(b) {
  b.tx = b.tx.map((t, i) => [t, i])
    .sort((x, y) => (x[0].date < y[0].date ? -1 : x[0].date > y[0].date ? 1 : x[1] - y[1]))
    .map(x => x[0]);
}

export function serialize(b) {
  const out = [
    '# Budget file - plain text, safe to edit by hand. Lines starting with # are ignored.',
    '#   currency CODE',
    '#   category NAME income|expense [certain]   certain = planned amount counts',
    '#                                             as actual in months with no transactions',
    '#   balance YYYY-MM-DD AMOUNT            account balance at the start of that day',
    '#   plan YEAR CATEGORY AMOUNT MONTHS     MONTHS: all | 3 | 1-6 | 1,4,7,10',
    '#   YYYY-MM-DD CATEGORY AMOUNT [note]    (negative amount = refund)',
    '#   Quote names that contain spaces: "Car insurance"',
    '',
    `currency ${b.currency}`,
    '',
  ];
  for (const t of ['income', 'expense'])
    for (const c of b.categories.filter(c => c.type === t))
      out.push(`category ${quote(c.name)} ${c.type}${c.certain ? ' certain' : ''}`);

  const bal = Object.keys(b.balances || {}).sort();
  if (bal.length) out.push('', ...bal.map(d => `balance ${d} ${fmtNum(b.balances[d])}`));

  for (const year of Object.keys(b.plans).sort()) {
    const lines = [];
    const yp = b.plans[year];
    const order = [...b.categories.map(c => c.name), ...Object.keys(yp)]
      .filter((n, i, a) => a.indexOf(n) === i && yp[n]);
    for (const name of order) {
      const groups = new Map();
      yp[name].forEach((amt, m) => {
        if (amt) (groups.get(amt) || groups.set(amt, []).get(amt)).push(m);
      });
      for (const [amt, months] of groups)
        lines.push(`plan ${year} ${quote(name)} ${fmtNum(amt)} ${formatMonths(months)}`);
    }
    if (lines.length) out.push('', `# ---- Plan ${year} ----`, ...lines);
  }

  let cur = '';
  for (const t of b.tx) {
    const ym = t.date.slice(0, 7);
    if (ym !== cur) { out.push('', `# ---- ${ym} ----`); cur = ym; }
    const note = (t.note || '').replace(/[\r\n]+/g, ' ').trim();
    out.push(`${t.date} ${quote(t.cat)} ${fmtNum(t.amount)}${note ? ' ' + note : ''}`);
  }
  return out.join('\n') + '\n';
}

// ---------- 3-way merge ----------
// Works on canonical (serialized) lines as a multiset: every line is one fact,
// so "remote + what I added - what I removed" is a sound merge.

function factLines(text) {
  const counts = new Map();
  for (const l of serialize(parse(text).budget).split('\n')) {
    if (!l.trim() || l.startsWith('#')) continue;
    counts.set(l, (counts.get(l) || 0) + 1);
  }
  return counts;
}

// base === null means "no common ancestor" (first sync, import): take the union.
export function merge(base, local, remote) {
  const B = base === null ? null : factLines(base), L = factLines(local), R = factLines(remote);
  const keys = new Set([...(B ? B.keys() : []), ...L.keys(), ...R.keys()]);
  const lines = [];
  for (const k of keys) {
    const l = L.get(k) || 0, r = R.get(k) || 0;
    const n = B ? Math.max(0, r + l - (B.get(k) || 0)) : Math.max(l, r);
    for (let i = 0; i < n; i++) lines.push(k);
  }
  // If both sides changed the currency, prefer local: put local's line last.
  const localCur = [...L.keys()].find(k => k.startsWith('currency '));
  if (localCur) lines.push(localCur);
  return serialize(parse(lines.join('\n')).budget);
}

// ---------- editing helpers ----------

export function planRow(b, year, cat) {
  return ((b.plans[year] ||= {})[cat] ||= Array(12).fill(0));
}

export function renameCategory(b, from, to) {
  const c = b.categories.find(c => c.name === from);
  if (!c) return;
  c.name = to;
  for (const t of b.tx) if (t.cat === from) t.cat = to;
  for (const y of Object.keys(b.plans)) {
    if (b.plans[y][from]) { b.plans[y][to] = b.plans[y][from]; delete b.plans[y][from]; }
  }
}

// Number of lines in the file that mention the category (besides its own
// `category` line): one per transaction, one per serialized plan line.
export function categoryUses(b, name) {
  let n = b.tx.filter(t => t.cat === name).length;
  for (const yp of Object.values(b.plans))
    if (yp[name]) n += new Set(yp[name].filter(x => x)).size;  // = plan lines, see serialize()
  return n;
}

// Only unused categories can be deleted, so no data is ever removed by accident.
export function deleteCategory(b, name) {
  if (categoryUses(b, name) > 0) return false;
  b.categories = b.categories.filter(c => c.name !== name);
  for (const y of Object.keys(b.plans)) delete b.plans[y][name];  // all-zero rows
  return true;
}

export function copyPlan(b, fromYear, toYear) {
  const src = b.plans[fromYear] || {};
  const dst = (b.plans[toYear] ||= {});
  for (const [cat, row] of Object.entries(src)) dst[cat] = [...row];
}

// ---------- statistics ----------

export function ym(year, m) {
  return `${year}-${String(m + 1).padStart(2, '0')}`;
}

export function monthStats(b, year, m) {
  const prefix = ym(year, m);
  const actual = {}, count = {};
  for (const t of b.tx)
    if (t.date.startsWith(prefix)) {
      actual[t.cat] = (actual[t.cat] || 0) + t.amount;
      count[t.cat] = (count[t.cat] || 0) + 1;
    }
  const rows = b.categories.map(c => {
    const planned = b.plans[year]?.[c.name]?.[m] || 0;
    // A "certain" category counts its planned amount until real transactions are entered.
    const auto = !!c.certain && !count[c.name] && planned !== 0;
    return {
      cat: c.name, type: c.type, certain: !!c.certain, auto, planned,
      actual: auto ? planned : Math.round((actual[c.name] || 0) * 100) / 100,
    };
  });
  const sum = (type, key) => Math.round(rows.filter(r => r.type === type).reduce((s, r) => s + r[key], 0) * 100) / 100;
  return {
    rows,
    income: { planned: sum('income', 'planned'), actual: sum('income', 'actual') },
    expense: { planned: sum('expense', 'planned'), actual: sum('expense', 'actual') },
    tx: b.tx.filter(t => t.date.startsWith(prefix)),
  };
}

export function yearStats(b, year) {
  return [...Array(12).keys()].map(m => {
    const s = monthStats(b, year, m);
    return {
      plannedNet: s.income.planned - s.expense.planned,
      actualNet: s.income.actual - s.expense.actual,
      income: s.income, expense: s.expense,
    };
  });
}

// ---------- account balance ----------

// Signed net (income - expense) of real transactions in date's month that happened before it.
function txNetBefore(b, date) {
  const types = new Map(b.categories.map(c => [c.name, c.type]));
  let n = 0;
  for (const t of b.tx)
    if (t.date.slice(0, 7) === date.slice(0, 7) && t.date < date)
      n += types.get(t.cat) === 'income' ? t.amount : -t.amount;
  return n;
}

// Running account balance at the end of each month of `year`, planned and actual.
// Starts from the latest `balance` entry on or before each month (possibly in an earlier
// year), or from 0 on Jan 1 of `year` if there is none. A mid-month balance already
// includes that month's earlier transactions, so they are not counted twice.
export function runningBalance(b, year) {
  const y = +year;
  const entries = Object.entries(b.balances || {}).sort(([a], [c]) => (a < c ? -1 : 1));
  const nets = new Map();
  const net = (yy, m) => {
    const k = yy * 12 + m;
    if (!nets.has(k)) {
      const s = monthStats(b, String(yy), m);
      nets.set(k, { plan: s.income.planned - s.expense.planned, actual: s.income.actual - s.expense.actual });
    }
    return nets.get(k);
  };
  const plan = [], actual = [], anchored = [];
  for (let m = 0; m < 12; m++) {
    const monthEnd = `${ym(y, m)}-31`;
    const found = entries.filter(([d]) => d <= monthEnd).pop();
    const [date, amount] = found || [`${y}-01-01`, 0];
    const ay = +date.slice(0, 4), am = +date.slice(5, 7) - 1;
    const before = found ? txNetBefore(b, date) : 0;
    let p = amount - before, a = amount - before;
    for (let k = ay * 12 + am; k <= y * 12 + m; k++) {
      const n = net(Math.floor(k / 12), k % 12);
      p += n.plan; a += n.actual;
    }
    plan.push(Math.round(p * 100) / 100);
    actual.push(Math.round(a * 100) / 100);
    anchored.push(!!found);
  }
  return { plan, actual, anchored };
}

// The balance entry (date, amount) falling in a given month, if any (the last one).
export function balanceInMonth(b, year, m) {
  const prefix = ym(year, m);
  const d = Object.keys(b.balances || {}).filter(k => k.startsWith(prefix)).sort().pop();
  return d ? { date: d, amount: b.balances[d] } : null;
}
