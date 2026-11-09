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
