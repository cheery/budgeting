import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../core.js';

const SAMPLE = `currency EUR
category Salary income
category "Car insurance" expense
category Groceries expense
plan 2026 Salary 3500 all
plan 2026 Salary 4000 7
plan 2026 "Car insurance" 640 3,9
plan 2026 Groceries 400 1-12
2026-03-02 Groceries 54,20 Lidl "weekly" shop
2026-03-01 Salary 3500
2026-03-15 "Car insurance" 640
`;

test('parse basics', () => {
  const { budget: b, errors } = core.parse(SAMPLE);
  assert.deepEqual(errors, []);
  assert.equal(b.categories.length, 3);
  assert.equal(b.plans['2026'].Salary[6], 4000);
  assert.equal(b.plans['2026'].Salary[5], 3500);
  assert.equal(b.plans['2026']['Car insurance'][2], 640);
  assert.equal(b.plans['2026']['Car insurance'][3], 0);
  assert.equal(b.tx[0].date, '2026-03-01');               // sorted
  assert.equal(b.tx[1].amount, 54.2);                     // comma decimal
  assert.equal(b.tx[1].note, 'Lidl "weekly" shop');        // raw note
});

test('serialize round-trips', () => {
  const t1 = core.serialize(core.parse(SAMPLE).budget);
  const t2 = core.serialize(core.parse(t1).budget);
  assert.equal(t1, t2);
  assert.match(t1, /plan 2026 Salary 3500 1-6,8-12/);
  assert.match(t1, /plan 2026 "Car insurance" 640 3,9/);
  assert.deepEqual(core.parse(t1).budget, core.parse(SAMPLE).budget);
});

test('errors and warnings', () => {
  const { budget, errors } = core.parse('2026-02-30 Food 3\nplan 26 X 1\nfoo\n2026-01-01 Food abc\n2026-01-02 Food 5');
  assert.equal(errors.filter(e => !e.warn).length, 4);
  assert.ok(errors.some(e => e.warn && /Food/.test(e.msg)));
  assert.equal(budget.tx.length, 1);
});

test('stats', () => {
  const s = core.monthStats(core.parse(SAMPLE).budget, '2026', 2);
  assert.equal(s.income.planned, 3500);
  assert.equal(s.expense.planned, 1040);
  assert.equal(s.expense.actual, 694.2);
  assert.equal(s.income.actual, 3500);
});

test('3-way merge keeps both sides', () => {
  const base = core.serialize(core.parse(SAMPLE).budget);
  const local = base + '2026-03-20 Groceries 30 phone\n';
  const remote = base.replace('2026-03-15 "Car insurance" 640\n', '') + '2026-03-21 Groceries 12 laptop\n';
  const m = core.parse(core.merge(base, local, remote)).budget;
  const notes = m.tx.map(t => t.note);
  assert.ok(notes.includes('phone') && notes.includes('laptop'));
  assert.ok(!m.tx.some(t => t.cat === 'Car insurance'));   // remote deletion kept
});

test('merge keeps intentional duplicates, union without base does not double', () => {
  const base = SAMPLE;
  const local = SAMPLE + '2026-03-02 Groceries 54.20 Lidl "weekly" shop\n'; // same purchase twice
  const m1 = core.parse(core.merge(base, local, base)).budget;
  assert.equal(m1.tx.filter(t => t.amount === 54.2).length, 2);
  const m2 = core.parse(core.merge(null, SAMPLE, SAMPLE)).budget;
  assert.equal(m2.tx.length, 3);
});

test('plan edits merge', () => {
  const base = SAMPLE;
  const local = SAMPLE.replace('plan 2026 Groceries 400 1-12', 'plan 2026 Groceries 450 1-12');
  const m = core.parse(core.merge(base, local, base)).budget;
  assert.equal(m.plans['2026'].Groceries[5], 450);
});

test('rename category', () => {
  const b = core.parse(SAMPLE).budget;
  core.renameCategory(b, 'Groceries', 'Food');
  assert.equal(b.plans['2026'].Food[0], 400);
  assert.ok(b.tx.some(t => t.cat === 'Food'));
});

test('certain categories count plan until a transaction exists', () => {
  const src = `category Salary income certain
category Rent expense certain
category Food expense
plan 2026 Salary 3000 all
plan 2026 Rent 1000 all
plan 2026 Food 300 all
2026-02-01 Rent 1050
2026-02-03 Food 40
`;
  const { budget: b, errors } = core.parse(src);
  assert.deepEqual(errors, []);
  assert.equal(b.categories[0].certain, true);
  assert.equal(b.categories[2].certain, false);
  const jan = core.monthStats(b, '2026', 0);
  assert.equal(jan.income.actual, 3000);       // no tx, but certain
  assert.equal(jan.expense.actual, 1000);      // rent auto, food 0
  const feb = core.monthStats(b, '2026', 1);
  assert.equal(feb.expense.actual, 1090);      // real rent replaces plan
  assert.equal(feb.rows.find(r => r.cat === 'Rent').auto, false);
  const out = core.serialize(b);
  assert.match(out, /category Rent expense certain/);
  assert.match(out, /category Food expense\n/);
  assert.deepEqual(core.parse(out).budget, b);
  assert.equal(core.parse('category X expense sure').errors.length, 1);
});

test('categories in use cannot be deleted', () => {
  const b = core.parse(SAMPLE).budget;
  // Salary: 2 plan lines (3500 / 4000) + 1 transaction
  assert.equal(core.categoryUses(b, 'Salary'), 3);
  assert.equal(core.deleteCategory(b, 'Salary'), false);
  assert.ok(b.categories.some(c => c.name === 'Salary'));
  // Plan-only usage also blocks deletion
  b.categories.push({ name: 'Gym', type: 'expense', certain: false });
  core.planRow(b, '2026', 'Gym')[4] = 30;
  assert.equal(core.categoryUses(b, 'Gym'), 1);
  assert.equal(core.deleteCategory(b, 'Gym'), false);
  // Cleared plan row (all zeros) is not a use
  core.planRow(b, '2026', 'Gym')[4] = 0;
  assert.equal(core.categoryUses(b, 'Gym'), 0);
  assert.equal(core.deleteCategory(b, 'Gym'), true);
  assert.ok(!b.categories.some(c => c.name === 'Gym'));
  assert.ok(!('Gym' in b.plans['2026']));
});

test('training lessons: content complete in both languages, checks detect progress', async () => {
  const learn = await import('../learn.js');
  for (const l of learn.LESSONS)
    for (const lang of ['fi', 'en']) {
      assert.ok(l[lang]?.title && l[lang]?.body, `${l.id} ${lang}`);
      assert.equal(!!l.fi.tip, !!l.en.tip, `${l.id} tip in both languages`);
    }
  assert.deepEqual(Object.keys(learn.UI.fi).sort(), Object.keys(learn.UI.en).sort());
  const now = new Date(2026, 2, 15);
  const L = id => learn.LESSONS.find(l => l.id === id);
  const empty = core.parse('category Salary income').budget;
  assert.equal(learn.detect(L('income'), empty, now), false);
  assert.equal(learn.detect(L('why'), empty, now), null);       // manual only
  const b = core.parse(SAMPLE + 'category Puskuri expense\nplan 2026 Puskuri 50 all\n').budget;
  assert.equal(learn.detect(L('income'), b, now), true);
  assert.equal(learn.detect(L('savings'), b, now), true);
  assert.equal(learn.detect(L('fixed'), b, now), false);        // nothing marked certain
  assert.equal(learn.detect(L('track'), b, now), true);         // 3 transactions in March
  assert.equal(learn.detect(L('ahead'), b, now), true);
});

test('i18n: both languages complete; lesson labels and error keys resolve', async () => {
  const { STR, translator, errorText } = await import('../i18n.js');
  const learn = await import('../learn.js');
  const fi = Object.keys(STR.fi).sort(), en = Object.keys(STR.en).sort();
  assert.deepEqual(fi, en);
  for (const k of en) assert.equal(typeof STR.fi[k], typeof STR.en[k], k);
  assert.equal(STR.fi.months.length, 12);
  assert.equal(STR.fi.starter.length, STR.en.starter.length);
  // every {key} used in lessons exists
  for (const l of learn.LESSONS) for (const lang of ['fi', 'en'])
    for (const [, k] of (l[lang].body + (l[lang].tip || '')).matchAll(/\{([\w.]+)\}/g))
      assert.ok(k in STR[lang], `${l.id}/${lang}: {${k}}`);
  // every parse error carries a key that has a translation
  const bad = ['x "unterminated', 'currency EURO', 'category X', 'plan 26 X 1', 'plan 2026 X 1 13',
    '2026-02-30 X 1', '2026-01-01 X abc', '2026-01-01', 'hello', '2026-01-01 Undeclared 5', 'balance 2026-02-01'];
  const { errors } = core.parse(bad.join('\n'));
  assert.equal(errors.length, bad.length);
  const t = translator('fi');
  for (const e of errors) {
    assert.ok(e.key && `err.${e.key}` in STR.fi, `${e.line}: ${e.msg}`);
    assert.notEqual(errorText(t, e), e.msg);
  }
  assert.equal(errorText(t, { message: 'raw' }), 'raw');
});

test('balance entries: parse, serialize, merge', () => {
  const src = SAMPLE + 'balance 2026-05-01 800\nbalance 2026-01-01 -120,5\n';
  const { budget: b, errors } = core.parse(src);
  assert.deepEqual(errors, []);
  assert.deepEqual(b.balances, { '2026-05-01': 800, '2026-01-01': -120.5 });
  const out = core.serialize(b);
  assert.match(out, /balance 2026-01-01 -120.50\nbalance 2026-05-01 800\n/);
  assert.deepEqual(core.parse(out).budget, b);
  assert.equal(core.parse('balance 2026-02-30 5').errors[0].key, 'date');
  assert.equal(core.parse('balance 2026-02-01').errors[0].key, 'balance');
  const merged = core.parse(core.merge(SAMPLE, SAMPLE + 'balance 2026-03-01 100\n', SAMPLE + 'balance 2026-06-01 50\n')).budget;
  assert.deepEqual(merged.balances, { '2026-03-01': 100, '2026-06-01': 50 });
});

test('running balance', () => {
  const base = `category Pay income
category Food expense
plan 2026 Pay 1000 all
plan 2026 Food 600 all
plan 2027 Pay 1000 all
plan 2027 Food 900 all
`;
  // No balance entry: same as cumulative net from 0 on Jan 1.
  let r = core.runningBalance(core.parse(base).budget, '2026');
  assert.deepEqual(r.plan.slice(0, 3), [400, 800, 1200]);
  assert.equal(r.anchored[0], false);

  // Balance at the start of May: months before it still count from 0, May onwards from 800.
  r = core.runningBalance(core.parse(base + 'balance 2026-05-01 800\n').budget, '2026');
  assert.equal(r.plan[3], 1600);
  assert.equal(r.plan[4], 1200);          // 800 + 1000 - 600
  assert.equal(r.plan[11], 1200 + 7 * 400);
  assert.equal(r.anchored[4], true);

  // Mid-month balance already includes earlier transactions of that month.
  const mid = base + '2026-05-02 Food 100\n2026-05-20 Food 50\nbalance 2026-05-10 500\n';
  r = core.runningBalance(core.parse(mid).budget, '2026');
  assert.equal(r.actual[4], 500 + 100 - 150);   // = 450: only the 50 spent after the 10th
  assert.equal(r.plan[4], 500 + 100 + 400);      // plan for May assumes the rest goes to plan

  // Carries over into the next year.
  r = core.runningBalance(core.parse(base + 'balance 2026-12-01 300\n').budget, '2027');
  assert.equal(r.plan[0], 300 + 400 + 100);
  assert.equal(r.anchored[0], true);
  assert.deepEqual(core.balanceInMonth(core.parse(mid).budget, '2026', 4), { date: '2026-05-10', amount: 500 });
});

test('cloud storage check accepts the app format only', () => {
  assert.equal(core.checkStorable(SAMPLE), new TextEncoder().encode(SAMPLE).length);
  const err = (s) => { try { core.checkStorable(s); } catch (e) { return [e.key, e.args]; } return null; };
  assert.deepEqual(err('hello world\n'), ['storeInvalid', [1]]);
  assert.deepEqual(err(SAMPLE + 'plan 2026 Groceries x all\n'), ['storeInvalid', [12]]);
  assert.equal(err('currency EUR\n\u0000')[0], 'storeInvalid');
  assert.equal(err(42)[0], 'storeInvalid');
  assert.equal(err('# ' + 'x'.repeat(core.MAX_STORED_BYTES))[0], 'storeTooLarge');
  // An undeclared category is only a warning, so it can still be stored.
  assert.ok(core.checkStorable('2026-01-01 Food 5\n') > 0);
});

test('rotation removes old years and keeps the kept years\' actual balance', () => {
  const text = `currency EUR
category Salary income
category Rent expense certain
category Food expense
balance 2023-06-15 1000
plan 2023 Salary 3000 all
plan 2023 Rent 900 all
plan 2024 Salary 3100 all
plan 2024 Rent 950 all
plan 2025 Salary 3200 all
plan 2025 Rent 1000 all
2023-06-01 Food 20
2023-07-03 Food 300
2024-02-10 Food 250
2025-01-05 Food 80
2025-03-01 Salary 3200
`;
  const b = core.parse(text).budget;
  const before = core.runningBalance(b, '2025').actual;
  assert.deepEqual(core.rotationPreview(b, 2025), { tx: 3, planYears: 2, balances: 1 });
  core.rotate(b, 2025);
  assert.deepEqual(b.tx.map(t => t.date), ['2025-01-05', '2025-03-01']);
  assert.deepEqual(Object.keys(b.plans), ['2025']);
  assert.deepEqual(Object.keys(b.balances), ['2025-01-01']);
  assert.deepEqual(core.runningBalance(b, '2025').actual, before);
  assert.equal(b.categories.length, 3);
  // Without balance entries every year starts from 0, so nothing needs carrying.
  const c = core.parse(SAMPLE + '2024-05-01 Groceries 10\n').budget;
  core.rotate(c, 2025);
  assert.deepEqual(c.balances, {});
  assert.equal(c.tx.length, 3);
  // The rotated text still syncs: a 3-way merge drops the old lines on the other device too.
  const rotated = core.serialize(b);
  assert.equal(core.merge(text, text, rotated), rotated);
});
