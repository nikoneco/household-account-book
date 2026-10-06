'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '..', 'shared', 'domain.js'), 'utf8');

function load(extra = { crypto: webcrypto }) {
  const context = vm.createContext({ module: { exports: {} }, ...extra });
  vm.runInContext(source, context);
  return context.module.exports;
}
const D = load();
const NOW = '2027-06-30T03:00:00.000Z';
const plain = value => JSON.parse(JSON.stringify(value));
const invalid = (action, code = 'INVALID_INPUT') => assert.throws(action, error => error.code === code);

function book(now = NOW) {
  let state = D.emptyState();
  let id = 0;
  let operation = 0;
  const options = { uuid: () => `generated-${++id}`, now };
  return {
    get state() { return state; },
    options,
    run(type, payload, extra = {}) {
      const input = state;
      const before = JSON.stringify(input);
      const outcome = D.execute(input, { type, payload, operationId: `operation-${++operation}`, ...extra }, options);
      assert.equal(JSON.stringify(input), before, `${type} mutated its input`);
      state = outcome.state;
      return outcome.result;
    },
    attempt(type, payload, code = 'INVALID_INPUT', extra = {}) {
      const before = JSON.stringify(state);
      invalid(() => D.execute(state, { type, payload, operationId: `operation-${++operation}`, ...extra }, options), code);
      assert.equal(JSON.stringify(state), before, `${type} failure mutated its input`);
    }
  };
}

test('all fixed payment methods pay on JST day one in the same month; zero stays unpaid', () => {
  const b = book('2026-10-05T03:00:00.000Z');
  fixed(b, { paymentMethod: 'bank', memo: '引落', plannedAmount: 1234 });
  fixed(b, { id: 'cash', paymentMethod: 'cash' });
  fixed(b, { id: 'card', paymentMethod: 'card' });
  fixed(b, { id: 'zero', paymentMethod: 'bank', plannedAmount: 0 });
  b.run('materializeMonth', { month: '2026-10' });
  assert.equal(b.state.expenses.length, 3);
  for (const method of ['cash', 'bank', 'card']) {
    const row = b.state.expenses.find(e => e.paymentMethod === method);
    assert.equal(row.useDate, '2026-10-01');
    assert.equal(row.accountingMonth, '2026-10');
  }
  const actual = b.state.expenses[0];
  assert.deepEqual(plain({ ...actual, id: '', planId: '' }), {
    id: '', planId: '', settingId: 'fixed', useDate: '2026-10-01', accountingMonth: '2026-10',
    amount: 1234, category: '固定費', paymentMethod: 'bank', fixed: true,
    description: '通信費', memo: '引落', manualEdited: false, version: 1
  });
  assert.equal(D.summarize(b.state, '2026-10').fixedTotal, 11234);
  assert.equal(D.summarize(b.state, '2026-10').cardTotal, 5000);
  assert.equal(D.summarize(b.state, '2026-11').expenses, 0);
  const outcome = D.reconcileBankFixedExpenses(b.state, b.options);
  assert.equal(outcome.changed, false);
  assert.equal(outcome.state.revision, b.state.revision);
  assert.deepEqual(plain(outcome.createdExpenseIds), []);
});

test('future bank snapshots become due at JST midnight and keep frozen values after setting edits', () => {
  const b = book('2026-10-31T14:59:59.999Z');
  fixed(b, { paymentMethod: 'bank', plannedAmount: 100, memo: '当初' });
  b.run('materializeMonth', { month: '2026-11' });
  b.run('saveSetting', { id: 'fixed', plannedAmount: 900, name: '変更後', category: 'その他', memo: '新', paymentMethod: 'cash', active: false });
  const before = JSON.stringify(b.state);
  assert.equal(D.reconcileBankFixedExpenses(b.state, b.options).changed, false);
  const due = D.reconcileBankFixedExpenses(b.state, { ...b.options, now: '2026-10-31T15:00:00.000Z' });
  assert.equal(JSON.stringify(b.state), before);
  assert.equal(due.createdExpenseIds.length, 1);
  const actual = due.state.expenses.find(row => row.accountingMonth === '2026-11');
  assert.equal(actual.useDate, '2026-11-01');
  assert.equal(actual.amount, 100);
  assert.equal(actual.description, '通信費');
  assert.equal(actual.category, '固定費');
  assert.equal(actual.memo, '当初');
  assert.equal(D.reconcileBankFixedExpenses(due.state, { ...b.options, now: '2026-11-05T03:00:00.000Z' }).changed, false);
});

test('bank catch-up only pays saved post-rollout snapshots and current active bank settings', () => {
  const b = book('2026-09-20T03:00:00.000Z');
  fixed(b, { paymentMethod: 'bank', plannedAmount: 100 });
  b.run('materializeMonth', { month: '2026-10' });
  assert.equal(b.state.expenses.length, 0);
  const september = plain(b.state.plans.find(row => row.month === '2026-09'));
  const outcome = D.reconcileBankFixedExpenses(b.state, { ...b.options, now: '2026-12-05T03:00:00.000Z' });
  assert.deepEqual(plain(outcome.state.expenses.map(row => row.accountingMonth)).sort(), ['2026-10', '2026-12']);
  assert.equal(outcome.state.plans.some(row => row.month === '2026-11'), false);
  assert.deepEqual(plain(outcome.state.plans.find(row => row.month === '2026-09')), september);
  assert.equal(outcome.state.revision, b.state.revision + 1);
});

test('all automatic fixed actual edits, detachment, month moves and deletion never recreate the original', () => {
  for (const method of ['cash', 'bank', 'card']) for (const action of ['edit', 'detach', 'move', 'delete']) {
    const b = book('2026-10-05T03:00:00.000Z');
    fixed(b, { paymentMethod: method });
    const actual = b.state.expenses[0];
    if (action === 'delete') b.run('deleteExpense', { id: actual.id });
    else b.run('upsertExpense', { id: actual.id, ...(
      action === 'edit' ? { amount: 999, paymentMethod: 'cash' } :
      action === 'detach' ? { settingId: '', fixed: false } : { useDate: '2026-11-02' }
    ) });
    b.run('materializeMonth', { month: '2026-10' });
    const outcome = D.reconcileBankFixedExpenses(b.state, b.options);
    assert.equal(outcome.changed, false, action);
    assert.equal(outcome.state.expenses.length, 1, action);
  }
});

test('legacy linked payments and tombstones suppress auto-pay without overwriting their values', () => {
  for (const method of ['cash', 'bank', 'card']) for (const deleted of [false, true]) {
    const b = book('2026-09-20T03:00:00.000Z');
    fixed(b, { paymentMethod: method });
    b.run('materializeMonth', { month: '2026-10' });
    expense(b, { settingId: 'fixed', paymentMethod: 'cash', useDate: '2026-10-05', amount: 321 });
    if (deleted) b.run('deleteExpense', { id: 'expense' });
    const legacy = plain(b.state);
    legacy.plans.forEach(plan => { delete plan.bankAutoHandled; });
    const original = JSON.stringify(legacy.expenses);
    const outcome = D.reconcileBankFixedExpenses(legacy, { ...b.options, now: '2026-10-05T03:00:00.000Z' });
    assert.equal(outcome.createdExpenseIds.length, 0);
    assert.equal(JSON.stringify(outcome.state.expenses), original);
    assert.equal(outcome.state.plans.find(row => row.month === '2026-10').bankAutoHandled, true);
    assert.equal(D.reconcileBankFixedExpenses(outcome.state, { ...b.options, now: '2026-10-05T03:00:00.000Z' }).changed, false);
  }
});
test('fixed costs keep the same month across year end; normal card purchases retain billing rules', () => {
  const b=book('2026-12-31T14:59:59.999Z');
  for(const method of ['cash','bank','card'])fixed(b,{id:method,paymentMethod:method,plannedAmount:100});
  b.run('materializeMonth',{month:'2027-01'});
  assert.equal(b.state.expenses.length,3,'Future plans are not paid early');
  const next=D.reconcileBankFixedExpenses(b.state,{...b.options,now:'2026-12-31T15:00:00.000Z'});
  assert.equal(next.createdExpenseIds.length,3);
  for(const row of next.state.expenses.filter(e=>e.accountingMonth==='2027-01'))assert.equal(row.useDate,'2027-01-01');
  assert.equal(D.reconcileBankFixedExpenses(next.state,{...b.options,now:'2027-01-01T03:00:00.000Z'}).changed,false);
  expense(b,{paymentMethod:'card',useDate:'2026-12-28'});
  assert.equal(b.state.expenses.find(e=>e.id==='expense').accountingMonth,'2027-02');
  b.run('upsertExpense',{id:'expense',fixed:true});
  const fixedRow=b.state.expenses.find(e=>e.id==='expense');
  assert.equal(fixedRow.useDate,'2026-12-01');assert.equal(fixedRow.accountingMonth,'2026-12');
  b.attempt('upsertExpense',{id:'expense',accountingMonth:'2027-02'});
  b.run('upsertExpense',{id:'expense',fixed:false,useDate:'2026-12-28'});
  assert.equal(b.state.expenses.find(e=>e.id==='expense').accountingMonth,'2027-02');
});
test('editing legacy card fixed actuals preserves their saved target month and links', () => {
  const b=book('2026-09-20T03:00:00.000Z');
  fixed(b,{paymentMethod:'card'});b.run('materializeMonth',{month:'2026-10'});
  expense(b,{useDate:'2026-10-01',settingId:'fixed',paymentMethod:'card',memo:'旧実績'});
  const legacy=plain(b.state),actual=legacy.expenses.find(e=>e.id==='expense');
  actual.useDate='2026-09-27';
  actual.category='必要経費';
  const before=JSON.stringify(legacy.expenses);
  assert.equal(D.reconcileBankFixedExpenses(legacy,{...b.options,now:'2026-10-05T03:00:00.000Z'}).createdExpenseIds.length,0);
  assert.equal(JSON.stringify(legacy.expenses),before);
  for(const payload of [{id:actual.id,amount:1234},{...actual,amount:1234}]){
    const changed=D.execute(legacy,{type:'upsertExpense',operationId:'legacy-edit',payload},{...b.options,now:'2026-10-05T03:00:00.000Z'}).state;
    assert.equal(changed.expenses.length,1);const edited=changed.expenses[0];
    assert.equal(edited.amount,1234);assert.equal(edited.useDate,'2026-10-01');assert.equal(edited.accountingMonth,'2026-10');
    assert.equal(edited.category,'固定費');
    assert.equal(edited.planId,actual.planId);assert.equal(edited.memo,'旧実績');
    assert.equal(D.reconcileBankFixedExpenses(changed,{...b.options,now:'2026-10-05T03:00:00.000Z'}).changed,false);
  }
});
function saving(b, overrides = {}) {
  return b.run('saveSetting', { id: 'saving', kind: 'saving', name: '旅行積立', plannedAmount: 20000, openingBalance: 50000, ...overrides });
}
function fixed(b, overrides = {}) {
  return b.run('saveSetting', { id: 'fixed', kind: 'fixed', name: '通信費', plannedAmount: 5000, paymentMethod: 'card', category: '必要経費', ...overrides });
}
function expense(b, overrides = {}) {
  return b.run('upsertExpense', { id: 'expense', useDate: '2026-10-05', amount: 1000, category: '食費', paymentMethod: 'cash', ...overrides });
}
function deposit(b, overrides = {}) {
  return b.run('saveTransfer', { id: 'deposit', date: '2026-10-05', settingId: 'saving', kind: 'deposit', amount: 10000, ...overrides });
}
function withdrawal(b, overrides = {}) {
  return b.run('saveTransfer', { id: 'withdrawal', date: '2026-10-06', settingId: 'saving', kind: 'withdrawal', amount: 1000, expenseId: 'expense', ...overrides });
}
function receipt(b, overrides = {}) {
  return b.run('registerReceipt', { id: 'receipt', imageHash: 'hash-123', fileId: 'private-drive-file', fileName: '買物.jpg', mimeType: 'image/jpeg', ...overrides });
}
function mixed(overrides = {}) {
  return {
    receiptId: 'receipt', useDate: '2026-10-28', paymentMethod: 'card', total: 2200,
    lines: [{ lineId: '1', amount: 1200, category: '食費', description: '食品' }, { lineId: '2', amount: 1000, category: '酒', description: 'お酒' }],
    ...overrides
  };
}

test('UMD runs in a browser/GAS global and Node VM; empty states own their arrays', () => {
  const browser = vm.createContext({ crypto: webcrypto });
  vm.runInContext(source, browser);
  assert.equal(typeof browser.HouseholdDomain.execute, 'function');
  const gas = vm.createContext({});
  vm.runInContext(source, gas);
  assert.equal(typeof gas.HouseholdDomain.cardMonth, 'function');
  const first = D.emptyState();
  first.expenses.push({ id: 'test' });
  assert.equal(D.emptyState().expenses.length, 0);
  assert.deepEqual(Object.keys(D.emptyState()), ['schemaVersion', 'revision', 'expenses', 'settings', 'plans', 'transfers', 'incomes', 'bills', 'receipts', 'operations']);
  assert.deepEqual(plain(D.CATEGORIES), ['食費', '酒', '趣味', '外食', '被服費', '美容', '積立', '必要経費', 'その他']);
});

test('27/28 card cutoff handles year boundaries and leap dates', () => {
  for (const [date, expected] of [
    ['2026-10-01', '2026-11'], ['2026-10-27', '2026-11'], ['2026-10-28', '2026-12'], ['2026-10-31', '2026-12'],
    ['2026-11-27', '2026-12'], ['2026-11-28', '2027-01'], ['2026-12-27', '2027-01'], ['2026-12-28', '2027-02'],
    ['2024-02-29', '2024-04'], ['2000-02-29', '2000-04'], ['0004-02-29', '0004-04']
  ]) assert.equal(D.cardMonth(date), expected, date);
  for (const date of ['2025-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-10-00', '2026-1-02', '2026-10-5', '0000-01-01', null, '9999-12-28']) {
    invalid(() => D.cardMonth(date));
  }
});

test('todayJst uses JST midnight instead of UTC or host timezone', () => {
  assert.equal(D.todayJst('2026-12-31T14:59:59.999Z'), '2026-12-31');
  assert.equal(D.todayJst('2026-12-31T15:00:00.000Z'), '2027-01-01');
  assert.equal(D.todayJst(() => new Date('2026-10-04T15:00:00.000Z')), '2026-10-05');
  invalid(() => D.todayJst('invalid'));
});

test('expense accounting separates purchase date from card billing month and supports explicit correction', () => {
  const b = book();
  expense(b, { paymentMethod: 'card', useDate: '2026-10-28' });
  assert.equal(b.state.expenses[0].accountingMonth, '2026-12');
  assert.equal(D.summarize(b.state, '2026-10').expenses, 0);
  assert.equal(D.summarize(b.state, '2026-12').expenses, 1000);
  b.run('upsertExpense', { id: 'expense', accountingMonth: '2026-11' });
  assert.equal(D.summarize(b.state, '2026-11').cardTotal, 1000);
  b.run('upsertExpense', { id: 'expense', memo: '計上月を修正済み' });
  assert.equal(b.state.expenses[0].accountingMonth, '2026-11');
  b.run('upsertExpense', { id: 'expense', useDate: '2026-11-28' });
  assert.equal(b.state.expenses[0].accountingMonth, '2027-01');
  b.run('upsertExpense', { id: 'expense', paymentMethod: 'bank' });
  assert.equal(b.state.expenses[0].accountingMonth, '2026-11');
  assert.equal(b.state.expenses[0].version, 5);
});

test('money, enum, boolean, and real calendar dates are validated without coercion', () => {
  const b = book();
  for (const amount of [0, -1, 1.5, '1000', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) b.attempt('upsertExpense', { useDate: '2026-10-05', amount });
  for (const patch of [{ category: '未分類' }, { paymentMethod: 'credit' }, { fixed: 'false' }, { useDate: '2026-02-29' }, { accountingMonth: '2026-13' }]) {
    b.attempt('upsertExpense', { useDate: '2026-10-05', amount: 10, ...patch });
  }
  assert.equal(expense(b, { amount: 1 }).amount, 1);
  b.run('deleteExpense', { id: 'expense' });
  assert.equal(D.summarize(b.state, '2026-10').expenses, 0);
  assert.equal(b.state.expenses[0].deleted, true);
  b.attempt('upsertExpense', { id: 'expense', amount: 20 }, 'CONFLICT');
});

test('monthly wages and bill are single records; confirmed bills never count again as expenses', () => {
  const b = book();
  expense(b, { paymentMethod: 'card', useDate: '2026-10-27', amount: 7000, fixed: true, category: '必要経費' });
  const wage = b.run('saveIncome', { month: '2026-10', amount: 300000 });
  assert.equal(b.run('saveIncome', { month: '2026-10', amount: 310000 }).id, wage.id);
  assert.equal(b.state.incomes.length, 1);
  const bill = b.run('saveBill', { month: '2026-10', confirmedAmount: 7100 });
  assert.equal(b.run('saveBill', { month: '2026-10', confirmedAmount: 7000 }).id, bill.id);
  assert.equal(b.state.bills.length, 1);
  const summary = D.summarize(b.state, '2026-10');
  assert.equal(summary.expenses, 7000);
  assert.equal(summary.fixedTotal, 7000);
  assert.equal(summary.cardTotal, 7000);
  assert.equal(summary.billDifference, 0);
  assert.equal(summary.monthlyRemaining, 303000);
  b.run('saveBill', { month: '2026-10', confirmedAmount: 7200 });
  assert.equal(D.summarize(b.state, '2026-10').billDifference, 200);
  assert.equal(D.summarize(b.state, '2026-11').billDifference, null);
  b.run('saveIncome', { month: '2026-11', amount: 0 });
  b.run('saveBill', { month: '2026-11', confirmedAmount: 0 });
  for (const amount of [-1, 1.1, '0']) b.attempt('saveIncome', { month: '2026-11', amount });
  b.attempt('saveBill', { id: 'another', month: '2026-10', confirmedAmount: 10 }, 'CONFLICT');
  b.attempt('saveIncome', { id: wage.id, month: '2026-11', amount: 10 }, 'CONFLICT');
});

test('fixed expenses use frozen accounting-month plans and one actual per plan', () => {
  const b = book('2026-11-30T03:00:00.000Z');
  fixed(b);
  const actualId = b.state.expenses[0].id;
  b.run('upsertExpense', { id: actualId, amount: 5001 });
  const row = b.state.expenses[0];
  const plan = b.state.plans[0];
  assert.equal(row.fixed, true);
  assert.equal(row.planId, plan.id);
  assert.equal(plan.month, '2026-11');
  assert.equal(D.summarize(b.state, '2026-10').fixedTotal, 0);
  assert.equal(D.summarize(b.state, '2026-11').fixedTotal, 5001);
  b.attempt('upsertExpense', { id: 'duplicate', useDate: '2026-11-26', amount: 5000, paymentMethod: 'card', settingId: 'fixed' }, 'CONFLICT');
  b.attempt('upsertExpense', { id: 'wrongmonth', useDate: '2026-10-05', amount: 5000, planId: plan.id });
  b.attempt('upsertExpense', { id: actualId, accountingMonth: '2026-12' });
  b.run('upsertExpense', { id: actualId, useDate: '2026-12-27' });
  assert.equal(b.state.plans.length, 2);
  assert.equal(b.state.expenses[0].planId, b.state.plans[1].id);
  assert.equal(b.state.expenses[0].useDate, '2026-12-01');
  b.run('deleteExpense', { id: actualId });
  expense(b, { id: 'replacement', settingId: 'fixed', useDate: '2026-12-05' });
  assert.equal(D.summarize(b.state, '2026-12').fixedTotal, 1000);
  saving(b);
  b.attempt('upsertExpense', { id: 'invalid-link', useDate: '2026-10-05', amount: 10, settingId: 'saving' });
});

test('setting edits, future edits and stops do not alter any existing month snapshot', () => {
  const b = book('2026-10-31T03:00:00.000Z');
  saving(b);
  fixed(b, { memo: '最初の設定' });
  b.run('materializeMonth', { month: '2026-10' });
  b.run('materializeMonth', { month: '2027-02' });
  const snapshotValues = () => b.state.plans.map(({ bankAutoHandled, ...plan }) => plan);
  const before = JSON.stringify(snapshotValues());
  b.options.now = '2027-02-01T03:00:00.000Z';
  b.run('saveSetting', { id: 'fixed', name: '携帯代', plannedAmount: 9999, paymentMethod: 'bank', category: 'その他', memo: '変更', active: false });
  b.run('saveSetting', { id: 'saving', plannedAmount: 500, name: '旅行', active: false });
  b.run('materializeMonth', { month: '2026-10' });
  b.run('materializeMonth', { month: '2027-02' });
  assert.equal(JSON.stringify(snapshotValues()), before);
  assert.equal(b.state.expenses.find(e=>e.accountingMonth==='2027-02').amount, 5000);
  assert.equal(D.summarize(b.state, '2026-10').savingsPlanned, 20000);
  assert.equal(D.summarize(b.state, '2027-02').fixedPlanned, 5000);
  assert.equal(b.run('materializeMonth', { month: '2027-03' }).length, 0);
  b.run('savePlan', { month: '2026-10', settingId: 'saving', plannedAmount: 15000 });
  assert.equal(D.summarize(b.state, '2026-10').savingsPlanned, 15000);
  assert.equal(D.summarize(b.state, '2027-02').savingsPlanned, 20000);
  b.run('savePlan', { month: '2026-10', settingId: 'saving', plannedAmount: 0 });
  assert.equal(D.summarize(b.state, '2026-10').savingsPlanned, 0);
  b.attempt('savePlan', { month: '2026-10', settingId: 'saving', plannedAmount: -1 });
  b.attempt('savePlan', { month: '2026-11', settingId: 'saving', plannedAmount: 100 }, 'NOT_FOUND');
  b.attempt('savePlan', { id: b.state.plans[0].id, month: '2027-01', plannedAmount: 10 }, 'CONFLICT');
  b.attempt('saveSetting', { id: 'saving', kind: 'fixed' }, 'CONFLICT');
});

test('savings accumulate independently of monthly surplus and track planned versus actual flow', () => {
  const b = book('2026-10-31T03:00:00.000Z');
  saving(b);
  b.run('materializeMonth', { month: '2026-10' });
  b.run('saveIncome', { month: '2026-10', amount: 200000 });
  expense(b, { amount: 30000 });
  deposit(b, { amount: 10000 });
  withdrawal(b, { amount: 5000 });
  const s = D.summarize(b.state, '2026-10');
  assert.equal(D.balance(b.state, 'saving'), 55000);
  assert.equal(s.expenses, 30000);
  assert.equal(s.savingsPlanned, 20000);
  assert.equal(s.savingsDeposited, 10000);
  assert.equal(s.savingsWithdrawn, 5000);
  assert.equal(s.salaryExpenses, 25000);
  assert.equal(s.salaryOutflow, 35000);
  assert.equal(s.monthlyRemaining, 165000);
  assert.equal(s.categories['食費'], 30000);
  assert.equal(s.outflowCategories['食費'], 25000);
  assert.equal(s.outflowCategories['積立'], 10000);
  assert.equal(Object.values(s.outflowCategories).reduce((n,value)=>n+value,0),s.salaryOutflow);
  assert.equal(s.savings[0].balance, 55000);
  assert.equal(D.summarize(b.state, '2026-11').salaryExpenses, 0);
  assert.equal(D.summarize(b.state, '2026-11').monthlyRemaining, 0);
  assert.equal(D.summarize(b.state, '2026-11').savings[0].balance, 55000);
});

test('salary remainder excludes saving-funded purchases, counts deposits, and ignores unlinked withdrawals', () => {
  const b = book();
  saving(b, { openingBalance: 500000 });
  b.run('saveIncome', { month: '2026-10', amount: 300000 });
  expense(b, { amount: 500000, fundingSettingId: 'saving' });
  withdrawal(b, { amount: 500000 });
  let s = D.summarize(b.state, '2026-10');
  assert.equal(s.expenses, 500000);
  assert.equal(s.savingsFunded, 500000);
  assert.equal(s.salaryExpenses, 0);
  assert.equal(s.monthlyRemaining, 300000);
  assert.equal(s.savings[0].balance, 0);
  deposit(b, { date: '2026-10-07', amount: 20000 });
  withdrawal(b, { id: 'unlinked', date: '2026-10-08', amount: 10000, expenseId: '' });
  s = D.summarize(b.state, '2026-10');
  assert.equal(s.savingsWithdrawn, 510000);
  assert.equal(s.salaryOutflow, 20000);
  assert.equal(s.monthlyRemaining, 280000, 'Unlinked withdrawal must not count as salary income');
  assert.equal(s.savings[0].balance, 10000);
  assert.equal(s.outflowCategories['食費'], 0);
  assert.equal(s.outflowCategories['積立'], 20000);
  assert.equal(Object.values(s.outflowCategories).reduce((n,value)=>n+value,0),s.salaryOutflow);
  assert.equal(D.summarize(b.state, '2026-11').monthlyRemaining, 0, 'No surplus carryover');
  b.run('deleteTransfer', { id: 'unlinked' });
  b.run('deleteTransfer', { id: 'withdrawal' });
  assert.equal(D.summarize(b.state, '2026-10').monthlyRemaining, -220000);
  assert.equal(D.summarize(b.state, '2026-10').outflowCategories['食費'],500000);
});

test('partial cash funding covers its purchase month, not the withdrawal month', () => {
  const b = book();
  saving(b);
  b.run('saveIncome', { month: '2026-10', amount: 300000 });
  expense(b, { amount: 20000, fundingSettingId: 'saving' });
  withdrawal(b, { date: '2026-11-01', amount: 8000 });
  assert.equal(D.summarize(b.state, '2026-10').salaryExpenses, 12000);
  assert.equal(D.summarize(b.state, '2026-10').monthlyRemaining, 288000);
  assert.equal(D.summarize(b.state, '2026-10').savingsWithdrawn, 0);
  assert.equal(D.summarize(b.state, '2026-11').savingsWithdrawn, 8000);
  assert.equal(D.summarize(b.state, '2026-11').monthlyRemaining, 0);
  assert.equal(D.summarize(b.state, '2026-10').savingsPending, 12000);
  assert.equal(D.summarize(b.state, '2026-10').outflowCategories['食費'],12000);
  assert.equal(Object.values(D.summarize(b.state,'2026-11').outflowCategories).reduce((n,value)=>n+value,0),0);
});

test('outflow breakdown includes deposit-only months and actual saving-category expenses, independent of setting category and plans', () => {
  const b=book('2026-10-31T03:00:00.000Z');saving(b,{category:'必要経費'});
  b.run('materializeMonth',{month:'2026-10'});
  let s=D.summarize(b.state,'2026-10');
  assert.equal(s.savingsPlanned,20000);assert.equal(s.outflowCategories['積立'],0);
  deposit(b,{amount:10000});
  s=D.summarize(b.state,'2026-10');
  assert.equal(s.expenses,0);assert.equal(s.outflowCategories['積立'],10000);assert.equal(s.outflowCategories['必要経費'],0);
  expense(b,{category:'積立',amount:1500});
  expense(b,{id:'fixed-saving',category:'必要経費',amount:10000,fixed:true,description:'定額貯金'});
  b.options.now='2026-11-02T03:00:00.000Z';
  deposit(b,{id:'nov-deposit',date:'2026-11-01',amount:4000});
  s=D.summarize(b.state,'2026-10');
  assert.equal(s.outflowCategories['積立'],11500);assert.equal(s.outflowCategories['固定費'],10000);assert.equal(s.outflowCategories['必要経費'],0);
  assert.equal(s.categories['積立'],1500,'purchase-only summary remains compatible');
  assert.deepEqual(plain(s.outflowItems.map(item=>[item.description,item.category,item.amount])),[['積立','積立',1500],['定額貯金','固定費',10000],['旅行積立','積立',10000]]);
  assert.equal(Object.values(s.outflowCategories).reduce((n,value)=>n+value,0),s.salaryOutflow);
  assert.equal(D.summarize(b.state,'2026-11').outflowCategories['積立'],4000);
  b.run('deleteTransfer',{id:'deposit'});
  assert.equal(D.summarize(b.state,'2026-10').outflowCategories['積立'],1500);
  b.run('deleteExpense',{id:'expense'});
  assert.equal(D.summarize(b.state,'2026-10').outflowCategories['積立'],0);
});

test('outflow breakdown follows card billing month and actual partial funding, without changing purchase or bill totals', () => {
  const b=book();saving(b);
  expense(b,{category:'必要経費',paymentMethod:'card',useDate:'2026-10-28',amount:10000,fundingSettingId:'saving'});
  assert.equal(D.summarize(b.state,'2026-10').outflowCategories['必要経費'],0);
  let s=D.summarize(b.state,'2026-12');
  assert.equal(s.outflowCategories['必要経費'],10000,'designation without withdrawal stays in salary outflow');
  withdrawal(b,{date:'2026-12-01',amount:4000});
  withdrawal(b,{id:'unlinked',date:'2026-12-01',amount:1000,expenseId:''});
  deposit(b,{date:'2026-12-01',amount:2000});
  s=D.summarize(b.state,'2026-12');
  assert.equal(s.outflowCategories['必要経費'],6000);assert.equal(s.outflowCategories['積立'],2000);
  assert.equal(s.cardTotal,10000);assert.equal(s.categories['必要経費'],10000);
  assert.equal(s.outflowItems.find(item=>item.kind==='purchase').amount,6000);
  assert.equal(s.outflowItems.find(item=>item.kind==='purchase').savingsCovered,4000);
  assert.equal(Object.values(s.outflowCategories).reduce((n,value)=>n+value,0),s.salaryOutflow);
  withdrawal(b,{id:'rest',date:'2026-12-02',amount:6000});
  assert.equal(D.summarize(b.state,'2026-12').outflowCategories['必要経費'],0);
  assert.equal(D.summarize(b.state,'2026-12').outflowItems.filter(item=>item.kind==='purchase').length,0);
});

test('purchase-linked withdrawals validate cumulative amount, saving kind and funding selection', () => {
  const b = book();
  saving(b);
  saving(b, { id: 'other-saving', name: '別の積立' });
  fixed(b);
  expense(b, { amount: 1000, fundingSettingId: 'saving', paymentMethod: 'bank' });
  assert.equal(D.balance(b.state, 'saving'), 50000);
  assert.equal(D.summarize(b.state, '2026-10').savingsPending, 1000);
  withdrawal(b, { amount: 400 });
  withdrawal(b, { id: 'part2', amount: 600 });
  assert.equal(D.balance(b.state, 'saving'), 49000);
  assert.equal(D.summarize(b.state, '2026-10').savingsPending, 0);
  b.attempt('saveTransfer', { date: '2026-10-06', settingId: 'saving', kind: 'withdrawal', amount: 1, expenseId: 'expense' });
  b.attempt('saveTransfer', { date: '2026-10-06', settingId: 'other-saving', kind: 'withdrawal', amount: 1, expenseId: 'expense' });
  b.attempt('saveTransfer', { date: '2026-10-06', settingId: 'fixed', kind: 'deposit', amount: 10 });
  b.attempt('saveTransfer', { date: '2026-10-06', settingId: 'saving', kind: 'deposit', amount: 10, expenseId: 'expense' });
  b.attempt('saveTransfer', { date: '2026-10-06', month: '2026-11', settingId: 'saving', kind: 'deposit', amount: 10 });
  b.attempt('upsertExpense', { id: 'expense', amount: 999 });
  b.attempt('upsertExpense', { id: 'expense', fundingSettingId: 'other-saving' });
  b.attempt('deleteExpense', { id: 'expense' }, 'CONFLICT');
  b.run('deleteTransfer', { id: 'withdrawal' });
  b.run('deleteTransfer', { id: 'part2' });
  b.run('deleteExpense', { id: 'expense' });
  assert.equal(D.balance(b.state, 'saving'), 50000);
  assert.equal(D.summarize(b.state, '2026-10').savingsPending, 0);
  b.attempt('upsertExpense', { useDate: '2026-10-05', amount: 10, fundingSettingId: 'fixed' });
});

test('card savings designation leaves balance unchanged until actual withdrawal in billing month', () => {
  const b = book('2026-12-10T02:00:00.000Z');
  saving(b);
  expense(b, { useDate: '2026-10-28', paymentMethod: 'card', amount: 10000, fundingSettingId: 'saving', description: '積立で買った品' });
  assert.equal(D.balance(b.state, 'saving'), 50000);
  assert.equal(D.summarize(b.state, '2026-10').savingsPending, 0);
  const pending = D.summarize(b.state, '2026-12');
  assert.equal(pending.savingsPending, 10000);
  assert.equal(pending.pendingFunding[0].expenseId, 'expense');
  b.attempt('saveTransfer', { date: '2026-10-28', settingId: 'saving', kind: 'withdrawal', expenseId: 'expense', amount: 10000 });
  b.attempt('saveTransfer', { date: '2026-11-28', settingId: 'saving', kind: 'withdrawal', expenseId: 'expense', amount: 10000 });
  b.attempt('saveTransfer', { date: '2026-12-28', settingId: 'saving', kind: 'withdrawal', expenseId: 'expense', amount: 10000 });
  b.attempt('saveTransfer', { date: '2026-12-11', settingId: 'saving', kind: 'deposit', amount: 1000 });
  withdrawal(b, { date: '2026-12-10', amount: 4000 });
  assert.equal(D.balance(b.state, 'saving'), 46000);
  assert.equal(D.summarize(b.state, '2026-12').savingsPending, 6000);
  assert.equal(D.summarize(b.state, '2026-12').savings[0].pending, 6000);
  b.attempt('upsertExpense', { id: 'expense', accountingMonth: '2027-01' });
  b.attempt('upsertExpense', { id: 'expense', useDate: '2026-11-28' });
  b.attempt('saveTransfer', { id: 'withdrawal', date: '2026-11-28' });
  b.run('deleteTransfer', { id: 'withdrawal' });
  b.run('upsertExpense', { id: 'expense', accountingMonth: '2026-11' });
  withdrawal(b, { date: '2026-11-28', amount: 10000 });
  assert.equal(D.summarize(b.state, '2026-11').savingsPending, 0);
  assert.equal(D.summarize(b.state, '2026-11').expenses, 10000);
});

test('future actual transfer compares JST dates, including the UTC date boundary', () => {
  const b = book('2026-10-04T15:00:00.000Z');
  saving(b);
  deposit(b, { date: '2026-10-05' });
  b.attempt('saveTransfer', { date: '2026-10-06', settingId: 'saving', kind: 'deposit', amount: 1000 });
  assert.equal(D.balance(b.state, 'saving'), 60000);
});

test('overdraft checks the historical ledger, and deposit edits/deletion cannot break later withdrawals', () => {
  const b = book();
  saving(b, { openingBalance: 0 });
  expense(b, { amount: 10000 });
  deposit(b, { date: '2026-10-10', amount: 5000 });
  b.attempt('saveTransfer', { date: '2026-10-09', settingId: 'saving', kind: 'withdrawal', amount: 1000, expenseId: 'expense' }, 'INSUFFICIENT_BALANCE');
  withdrawal(b, { date: '2026-10-10', amount: 5000 });
  assert.equal(D.balance(b.state, 'saving'), 0);
  b.attempt('saveTransfer', { id: 'deposit', amount: 4999 }, 'INSUFFICIENT_BALANCE');
  b.attempt('deleteTransfer', { id: 'deposit' }, 'INSUFFICIENT_BALANCE');
  b.attempt('saveSetting', { id: 'saving', openingBalance: 1000 }, 'CONFLICT');
  b.run('saveSetting', { id: 'saving', name: '積立の新しい名前', active: false });
  assert.equal(D.balance(b.state, 'saving'), 0);
  b.run('deleteTransfer', { id: 'withdrawal' });
  b.run('deleteTransfer', { id: 'deposit' });
  assert.equal(b.state.transfers.length, 0);
  invalid(() => D.balance(b.state, 'unknown'), 'NOT_FOUND');
});

test('receipt image hash and stable ID deduplicate uploads without replacing saved metadata', () => {
  const b = book();
  const first = receipt(b, { imageHash: 'HASH-123' });
  const second = receipt(b, { id: 'new-id', fileId: 'another-file', imageHash: 'hash-123' });
  assert.equal(first.id, second.id);
  assert.equal(second.fileId, 'private-drive-file');
  assert.equal(b.state.receipts.length, 1);
  assert.equal(second.status, 'pending');
  b.attempt('registerReceipt', { id: 'receipt', imageHash: 'different-hash' }, 'CONFLICT');
  b.run('setReceiptStatus', { receiptId: 'receipt', status: 'failed', reason: '画像解析を確認してください' });
  assert.equal(b.state.receipts[0].status, 'failed');
  b.attempt('setReceiptStatus', { receiptId: 'receipt', status: 'imported' });
  b.attempt('setReceiptStatus', { receiptId: 'receipt', status: 'unknown' });
});

test('mixed receipt import is atomic, preserves category and assigns billing month once', () => {
  const b = book();
  receipt(b);
  const result = b.run('importReceipt', mixed());
  assert.equal(result.imported, true);
  assert.equal(result.needsReview, false);
  assert.equal(result.receipt.status, 'imported');
  assert.equal(b.state.expenses.length, 2);
  assert.equal(b.state.expenses[0].receiptLineId, '1');
  assert.equal(b.state.expenses[1].receiptLineId, '2');
  assert.equal(b.state.expenses[0].accountingMonth, '2026-12');
  const summary = D.summarize(b.state, '2026-12');
  assert.equal(summary.expenses, 2200);
  assert.equal(summary.cardTotal, 2200);
  assert.equal(summary.categories['食費'], 1200);
  assert.equal(summary.categories['酒'], 1000);
  assert.equal(D.summarize(b.state, '2026-10').expenses, 0);
  const retry = b.run('importReceipt', mixed());
  assert.equal(retry.alreadyImported, true);
  assert.equal(retry.imported, false);
  assert.equal(b.state.expenses.length, 2);
});

test('one shopping receipt stores its merchant and individual products with quantities and line totals', () => {
  const b = book();
  receipt(b);
  const result = b.run('importReceipt', mixed({
    merchant: ' ヨーカドー ', useDate: '2026-10-04', paymentMethod: 'cash', total: 960,
    lines: [
      { lineId: 'lemon', description: 'レモンサワー', category: '酒', quantity: 1, amount: 130 },
      { lineId: 'beer', description: '一番搾り', category: '酒', quantity: 2, amount: 350 },
      { lineId: 'pork', description: 'トンカツ', category: '食費', quantity: 1, amount: 480 }
    ]
  }));
  assert.equal(result.imported, true);
  assert.equal(result.receipt.merchant, 'ヨーカドー');
  assert.equal(result.receipt.purchaseDate, '2026-10-04');
  assert.equal(result.receipt.expenseIds.length, 3);
  assert.equal(b.state.receipts.length, 1);
  assert.deepEqual(plain(result.expenses.map(row => [row.description, row.category, row.quantity, row.amount])), [
    ['レモンサワー', '酒', 1, 130], ['一番搾り', '酒', 2, 350], ['トンカツ', '食費', 1, 480]
  ]);
  const summary = D.summarize(b.state, '2026-10');
  assert.equal(summary.expenses, 960);
  assert.equal(summary.categories['酒'], 480);
  assert.equal(summary.categories['食費'], 480);
  assert.deepEqual(Object.keys(summary.categories), ['食費', '酒', '趣味', '外食', '被服費', '美容', '積立', '必要経費', 'その他']);
  assert.equal(b.state.schemaVersion, 1);
  const retried = b.run('importReceipt', mixed({ merchant: '違う店', quantity: 99 }));
  assert.equal(retried.alreadyImported, true);
  assert.equal(retried.receipt.merchant, 'ヨーカドー');
  assert.equal(b.state.expenses.length, 3);
  assert.deepEqual(plain(retried.receipt.expenseIds), plain(result.receipt.expenseIds));
});

test('unknown merchant and quantity remain absent and historical records still validate', () => {
  const b = book();
  receipt(b);
  const result = b.run('importReceipt', mixed());
  assert.equal(Object.hasOwn(result.receipt, 'merchant'), false);
  assert.equal(result.expenses.every(row => !Object.hasOwn(row, 'quantity')), true);
  const historical = plain(b.state);
  const before = JSON.stringify(historical);
  assert.equal(D.summarize(historical, '2026-12').expenses, 2200);
  assert.equal(JSON.stringify(historical), before);
  b.run('upsertExpense', { id: result.expenses[0].id, memo: '数量不明のまま訂正' });
  assert.equal(Object.hasOwn(b.state.expenses[0], 'quantity'), false);
  const blank = book();
  receipt(blank);
  assert.equal(Object.hasOwn(blank.run('importReceipt', mixed({ merchant: '   ' })).receipt, 'merchant'), false);
});

test('quantity may be edited, retained or cleared without changing an expense line total', () => {
  const b = book();
  expense(b, { amount: 350, quantity: 2 });
  assert.equal(D.summarize(b.state, '2026-10').expenses, 350);
  b.run('upsertExpense', { id: 'expense', description: '一番搾り' });
  assert.equal(b.state.expenses[0].quantity, 2);
  b.run('upsertExpense', { id: 'expense', quantity: 3 });
  assert.equal(b.state.expenses[0].quantity, 3);
  assert.equal(b.state.expenses[0].amount, 350);
  b.run('upsertExpense', { id: 'expense', quantity: null });
  assert.equal(Object.hasOwn(b.state.expenses[0], 'quantity'), false);
  assert.equal(D.summarize(b.state, '2026-10').expenses, 350);
  b.run('upsertExpense', { id: 'expense', quantity: Number.MAX_SAFE_INTEGER });
  assert.equal(b.state.expenses[0].quantity, Number.MAX_SAFE_INTEGER);
  assert.equal(D.summarize(b.state, '2026-10').expenses, 350);
  for (const quantity of [0, -1, 1.5, '2', true, Number.MAX_SAFE_INTEGER + 1]) {
    b.attempt('upsertExpense', { id: 'expense', quantity });
  }
});

test('invalid extracted quantities or merchant strings require review without partially importing', () => {
  const cases = [
    ...[0, -1, 1.5, '2', null, true, Number.MAX_SAFE_INTEGER + 1].map(quantity => ({
      lines: [{ lineId: '1', amount: 1200, category: '食費', quantity: 1 }, { lineId: '2', amount: 1000, category: '酒', quantity }]
    })),
    ...['店'.repeat(121), '店\u0000名', 123, null].map(merchant => ({ merchant }))
  ];
  for (const patch of cases) {
    const b = book();
    receipt(b);
    const result = b.run('importReceipt', mixed(patch));
    assert.equal(result.needsReview, true, JSON.stringify(patch));
    assert.equal(b.state.expenses.length, 0);
    assert.equal(Object.hasOwn(result.receipt, 'purchaseDate'), false);
    assert.equal(Object.hasOwn(result.receipt, 'merchant'), false);
    assert.equal(result.receipt.expenseIds.length, 0);
    assert.equal(b.run('importReceipt', mixed({ merchant: '店'.repeat(120) })).imported, true);
  }
  const b = book();
  receipt(b);
  b.run('importReceipt', mixed({ merchant: 'ヨーカドー', lines: [{ lineId: '1', amount: 2200, category: '食費', quantity: 2 }] }));
  for (const quantity of [0, null, '2']) {
    const stored = plain(b.state);
    stored.expenses[0].quantity = quantity;
    invalid(() => D.summarize(stored, '2026-12'));
  }
  const invalidMerchant = plain(b.state);
  invalidMerchant.receipts[0].merchant = '店'.repeat(121);
  invalid(() => D.summarize(invalidMerchant, '2026-12'));
});

test('receipt reanalysis preserves manually corrected and cleared quantities and deleted products', () => {
  const b = book();
  receipt(b);
  const input = mixed({
    merchant: 'ヨーカドー', total: 960,
    lines: [
      { lineId: '1', amount: 130, category: '酒', description: 'レモンサワー', quantity: 1 },
      { lineId: '2', amount: 350, category: '酒', description: '一番搾り', quantity: 2 },
      { lineId: '3', amount: 480, category: '食費', description: 'トンカツ', quantity: 1 }
    ]
  });
  b.run('importReceipt', input);
  const ids = plain(b.state.receipts[0].expenseIds);
  b.run('upsertExpense', { id: ids[0], quantity: 3, manualEdited: false });
  b.run('upsertExpense', { id: ids[1], quantity: null, manualEdited: false });
  b.run('deleteExpense', { id: ids[2] });
  b.run('setReceiptStatus', { receiptId: 'receipt', status: 'needsReview', reason: '再解析' });
  const outcome = b.run('importReceipt', { ...input, merchant: '別の店', lines: input.lines.map(line => ({ ...line, quantity: 99 })) });
  assert.equal(outcome.alreadyImported, true);
  assert.equal(b.state.expenses.length, 3);
  assert.equal(b.state.expenses[0].quantity, 3);
  assert.equal(Object.hasOwn(b.state.expenses[1], 'quantity'), false);
  assert.equal(b.state.expenses[2].deleted, true);
  assert.equal(b.state.expenses.every(row => row.manualEdited), true);
  assert.equal(b.state.receipts[0].merchant, 'ヨーカドー');
  assert.deepEqual(plain(b.state.receipts[0].expenseIds), ids);
  assert.equal(D.summarize(b.state, '2026-12').expenses, 480);
});

test('receipt purchase date comes only from printed date, independently of upload and manual corrections', () => {
  const b = book('2026-10-05T03:00:00.000Z');
  const uploadedAt = '2026-10-05T03:00:00.000Z';
  receipt(b, { id: 'sep27', imageHash: 'printed-sep27', uploadedAt });
  receipt(b, { id: 'sep28', imageHash: 'printed-sep28', uploadedAt });
  const first = b.run('importReceipt', mixed({ receiptId: 'sep27', useDate: '2026-09-27' }));
  const second = b.run('importReceipt', mixed({ receiptId: 'sep28', useDate: '2026-09-28' }));
  assert.equal(first.receipt.purchaseDate, '2026-09-27');
  assert.equal(second.receipt.purchaseDate, '2026-09-28');
  assert.equal(first.expenses[0].useDate, '2026-09-27');
  assert.equal(first.expenses[0].accountingMonth, '2026-10');
  assert.equal(second.expenses[0].useDate, '2026-09-28');
  assert.equal(second.expenses[0].accountingMonth, '2026-11');
  assert.equal(D.summarize(b.state, '2026-10').cardTotal, 2200);
  assert.equal(D.summarize(b.state, '2026-11').cardTotal, 2200);
  receipt(b, { id: 'missing-date', imageHash: 'printed-date-missing', uploadedAt });
  const missing = b.run('importReceipt', mixed({ receiptId: 'missing-date', useDate: undefined }));
  assert.equal(missing.needsReview, true);
  assert.equal(missing.receipt.status, 'needsReview');
  assert.equal(missing.receipt.purchaseDate, undefined);
  assert.equal(missing.receipt.uploadedAt, uploadedAt);
  assert.equal(missing.expenses.length, 0);
  assert.equal(b.state.expenses.length, 4);
  b.run('upsertExpense', { id: first.expenses[0].id, useDate: '2026-10-28' });
  assert.equal(b.state.expenses[0].accountingMonth, '2026-12');
  assert.equal(b.state.receipts[0].purchaseDate, '2026-09-27');
  const reimport = b.run('importReceipt', mixed({ receiptId: 'sep27', useDate: '2026-10-05' }));
  assert.equal(reimport.alreadyImported, true);
  assert.equal(reimport.receipt.purchaseDate, '2026-09-27');
  assert.equal(b.state.expenses[0].useDate, '2026-10-28');
  const invalidSource = plain(b.state);
  invalidSource.receipts[0].purchaseDate = '2026-02-29';
  invalid(() => D.summarize(invalidSource, '2026-10'));
});

test('missing receipt date, amount, category or total mismatch requires review and imports zero lines', () => {
  const cases = [
    { useDate: undefined }, { useDate: '2026-02-29' }, { paymentMethod: 'unknown' }, { total: undefined }, { total: 2201 },
    { lines: [] }, { lines: [{ lineId: '1', amount: undefined, category: '食費' }] },
    { lines: [{ lineId: '1', amount: 2200, category: 'unknown' }] },
    { lines: [{ lineId: '1', amount: 1200, category: '食費' }, { lineId: '1', amount: 1000, category: '酒' }] },
    { lines: [{ lineId: '1', amount: 2200.5, category: '食費' }] },
    { lines: [{ amount: 2200, category: '食費' }] }
  ];
  for (const patch of cases) {
    const b = book();
    receipt(b);
    const result = b.run('importReceipt', mixed(patch));
    assert.equal(result.needsReview, true, JSON.stringify(patch));
    assert.equal(result.receipt.status, 'needsReview');
    assert.ok(result.receipt.reason.length > 0);
    assert.equal(result.expenses.length, 0);
    assert.equal(b.state.expenses.length, 0);
    assert.equal(b.state.receipts[0].expenseIds.length, 0);
    assert.equal(b.run('importReceipt', mixed()).imported, true);
    assert.equal(b.state.expenses.length, 2);
  }
});

test('receipt retries never overwrite manual edits or resurrect deleted lines', () => {
  const b = book();
  receipt(b);
  b.run('importReceipt', mixed());
  const [firstId, secondId] = b.state.receipts[0].expenseIds;
  b.run('upsertExpense', { id: firstId, amount: 1300, category: '趣味', description: '訂正', manualEdited: false });
  b.run('deleteExpense', { id: secondId });
  assert.equal(b.state.expenses[0].manualEdited, true);
  b.run('setReceiptStatus', { receiptId: 'receipt', status: 'needsReview', reason: '再確認' });
  b.run('importReceipt', mixed({ total: 5000, lines: [{ lineId: '1', amount: 5000, category: '食費', description: '別の解析結果' }] }));
  assert.equal(b.state.expenses.length, 2);
  assert.equal(b.state.expenses[0].amount, 1300);
  assert.equal(b.state.expenses[0].category, '趣味');
  assert.equal(b.state.expenses[0].description, '訂正');
  assert.equal(b.state.expenses[1].deleted, true);
  assert.equal(D.summarize(b.state, '2026-12').expenses, 1300);
  assert.equal(b.state.receipts[0].expenseIds.length, 2);
  b.attempt('upsertExpense', { id: firstId, receiptId: null }, 'CONFLICT');
  b.attempt('upsertExpense', { id: secondId, amount: 1000 }, 'CONFLICT');
  b.run('deleteExpense', { id: firstId });
  b.run('importReceipt', mixed());
  assert.equal(D.summarize(b.state, '2026-12').expenses, 0);
});

test('a receipt import ID collision cannot partially append earlier valid lines', () => {
  const b = book();
  receipt(b);
  expense(b, { id: 'receipt:receipt:2' });
  const before = JSON.stringify(b.state);
  b.attempt('importReceipt', mixed(), 'CONFLICT');
  assert.equal(JSON.stringify(b.state), before);
  assert.equal(b.state.expenses.length, 1);
  assert.equal(b.state.receipts[0].status, 'pending');
  assert.equal(b.state.receipts[0].expenseIds.length, 0);
});

test('durable operation replay returns its original result before revision checks without increments', () => {
  const b = book();
  const command = { type: 'upsertExpense', payload: { id: 'expense', useDate: '2026-10-05', amount: 1000 }, operationId: 'once', expectedRevision: 0 };
  const initial = D.execute(b.state, command, b.options);
  assert.equal(initial.state.revision, 1);
  assert.equal(initial.state.operations.length, 1);
  assert.equal(initial.state.operations[0].id, 'once');
  const edited = D.execute(initial.state, { type: 'upsertExpense', payload: { id: 'expense', amount: 2000 }, operationId: 'edit', expectedRevision: 1 }, b.options);
  const replay = D.execute(edited.state, command, b.options);
  assert.equal(replay.state.revision, 2);
  assert.equal(replay.state.operations.length, 2);
  assert.equal(replay.state.expenses[0].amount, 2000);
  assert.equal(replay.result.amount, 1000);
  assert.equal(replay.result.version, 1);
  replay.result.amount = 123;
  assert.equal(replay.state.operations[0].result.amount, 1000);
  initial.result.amount = 999;
  assert.equal(initial.state.expenses[0].amount, 1000);
  assert.equal(initial.state.operations[0].result.amount, 1000);
  invalid(() => D.execute(edited.state, { ...command, operationId: 'different' }, b.options), 'CONFLICT');
  const reloaded = plain(edited.state);
  assert.equal(D.execute(reloaded, command, b.options).result.amount, 1000);
});

test('missing operation IDs, unknown commands and stale edits cannot mutate state', () => {
  const b = book();
  invalid(() => D.execute(b.state, { type: 'saveIncome', payload: { month: '2026-10', amount: 1 } }, b.options));
  b.attempt('unknown', {});
  expense(b);
  b.attempt('upsertExpense', { id: 'expense', amount: 2000 }, 'CONFLICT', { expectedRevision: 0 });
  assert.equal(b.state.expenses[0].amount, 1000);
  b.run('upsertExpense', { id: 'expense', amount: 2000 }, { expectedRevision: b.state.revision });
  assert.equal(b.state.expenses[0].amount, 2000);
});

test('secure ID generation accepts injected UUIDs and browser crypto but never Math.random fallback', () => {
  const result = D.execute(D.emptyState(), { type: 'saveIncome', payload: { month: '2026-10', amount: 1 }, operationId: 'generate' }, { now: NOW });
  assert.match(result.result.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  const noCrypto = load({});
  invalid(() => noCrypto.execute(noCrypto.emptyState(), { type: 'saveIncome', payload: { month: '2026-10', amount: 1 }, operationId: 'generate' }, { now: NOW }));
  assert.equal(noCrypto.execute(noCrypto.emptyState(), { type: 'saveIncome', payload: { month: '2026-10', amount: 1 }, operationId: 'generate' }, { now: NOW, uuid: () => 'server-uuid' }).result.id, 'server-uuid');
  invalid(() => D.execute(D.emptyState(), { type: 'saveIncome', payload: { month: '2026-10', amount: 1 }, operationId: 'generate' }, { now: NOW, uuid: () => '' }));
});

test('JPY aggregate overflow is rejected rather than rounded', () => {
  const b = book();
  expense(b, { amount: Number.MAX_SAFE_INTEGER });
  assert.equal(D.summarize(b.state, '2026-10').expenses, Number.MAX_SAFE_INTEGER);
  b.attempt('upsertExpense', { id: 'second', useDate: '2026-10-05', amount: 1 });
  assert.equal(D.summarize(b.state, '2026-10').expenses, Number.MAX_SAFE_INTEGER);
  const c = book();
  saving(c, { openingBalance: Number.MAX_SAFE_INTEGER });
  c.attempt('saveTransfer', { date: '2026-10-05', settingId: 'saving', kind: 'deposit', amount: 1 });
});

test('all persisted record IDs fit the shared server limit; oversized receipt lines require review', () => {
  const b = book('2026-10-31T03:00:00.000Z');
  saving(b);
  b.run('materializeMonth', { month: '2026-10' });
  deposit(b);
  b.run('saveIncome', { month: '2026-10', amount: 200000 });
  b.run('saveBill', { month: '2026-10', confirmedAmount: 0 });
  receipt(b);
  b.run('importReceipt', mixed());
  for (const table of ['settings', 'plans', 'expenses', 'transfers', 'incomes', 'bills', 'receipts', 'operations']) {
    for (const row of b.state[table]) assert.ok(typeof row.id === 'string' && row.id.length <= 200, table);
  }
  const c = book();
  receipt(c);
  const review = c.run('importReceipt', mixed({ total: 1, lines: [{ lineId: '日本語'.repeat(30), amount: 1, category: '食費' }] }));
  assert.equal(review.needsReview, true);
  assert.equal(c.state.expenses.length, 0);
  assert.equal(c.state.receipts[0].status, 'needsReview');
  c.attempt('saveIncome', { id: 'i'.repeat(201), month: '2026-10', amount: 1 });
  invalid(() => D.execute(c.state, { type: 'materializeMonth', payload: { month: '2026-10' }, operationId: 'o'.repeat(201) }, c.options));
});

test('historical materialization returns only existing snapshots after new or edited settings', () => {
  const b = book('2026-09-30T03:00:00.000Z');
  saving(b, { plannedAmount: 100 });
  b.run('materializeMonth', { month: '2026-09' });
  const september = JSON.stringify(b.state.plans);
  b.options.now = '2026-10-05T03:00:00.000Z';
  saving(b, { id: 'new-saving', name: '10月開始の積立', plannedAmount: 500 });
  assert.equal(b.run('materializeMonth', { month: '2026-09' }).length, 1);
  assert.equal(JSON.stringify(b.state.plans), september);
  assert.equal(D.summarize(b.state, '2026-09').savingsPlanned, 100);
  assert.equal(b.run('materializeMonth', { month: '2026-10' }).length, 2);
  assert.equal(b.run('materializeMonth', { month: '2026-11' }).length, 2);
  const currentAndFuture = JSON.stringify(b.state.plans.filter(row => row.month !== '2026-09'));
  b.run('saveSetting', { id: 'saving', plannedAmount: 900 });
  assert.equal(b.run('materializeMonth', { month: '2026-08' }).length, 0);
  assert.equal(D.summarize(b.state, '2026-08').savingsPlanned, 0);
  assert.equal(b.run('materializeMonth', { month: '2026-09' }).length, 1);
  assert.equal(D.summarize(b.state, '2026-09').savingsPlanned, 100);
  b.run('materializeMonth', { month: '2026-10' });
  b.run('materializeMonth', { month: '2026-11' });
  assert.equal(JSON.stringify(b.state.plans.filter(row => row.month !== '2026-09')), currentAndFuture);
  assert.equal(D.summarize(b.state, '2026-10').savingsPlanned, 600);
  assert.equal(D.summarize(b.state, '2026-11').savingsPlanned, 600);
  b.run('savePlan', { month: '2026-09', settingId: 'saving', plannedAmount: 200 });
  assert.equal(D.summarize(b.state, '2026-09').savingsPlanned, 200);
});

test('historical fixed actual requires an existing snapshot; manual fixed entries remain allowed', () => {
  const b = book('2026-09-30T03:00:00.000Z');
  fixed(b, { plannedAmount: 100, paymentMethod: 'bank' });
  b.run('materializeMonth', { month: '2026-09' });
  const planId = b.state.plans[0].id;
  b.options.now = '2026-10-05T03:00:00.000Z';
  b.run('saveSetting', { id: 'fixed', plannedAmount: 900 });
  b.attempt('upsertExpense', { id: 'missing', useDate: '2026-08-05', amount: 200, paymentMethod: 'bank', settingId: 'fixed' });
  assert.equal(b.state.expenses.length, 0);
  assert.equal(b.state.plans.length, 1);
  assert.equal(D.summarize(b.state, '2026-08').fixedPlanned, 0);
  const actual = expense(b, { id: 'existing-plan', useDate: '2026-09-05', amount: 100, paymentMethod: 'bank', settingId: 'fixed' });
  assert.equal(actual.planId, planId);
  assert.equal(D.summarize(b.state, '2026-09').fixedPlanned, 100);
  assert.equal(D.summarize(b.state, '2026-09').fixedTotal, 100);
  b.attempt('upsertExpense', { id: actual.id, accountingMonth: '2026-08' });
  assert.equal(b.state.expenses[0].accountingMonth, '2026-09');
  expense(b, { id: 'manual-past', useDate: '2026-08-05', amount: 200, fixed: true });
  assert.equal(D.summarize(b.state, '2026-08').fixedTotal, 200);
  assert.equal(D.summarize(b.state, '2026-08').fixedPlanned, 0);
  assert.equal(b.state.plans.length, 1);
});

test('retrospective plan guard uses the JST month boundary', () => {
  const b = book('2026-09-30T14:59:59.999Z');
  saving(b, { plannedAmount: 100 });
  assert.equal(b.run('materializeMonth', { month: '2026-09' }).length, 1);
  b.options.now = '2026-09-30T15:00:00.000Z';
  saving(b, { id: 'new-saving', plannedAmount: 500 });
  assert.equal(b.run('materializeMonth', { month: '2026-09' }).length, 1);
  assert.equal(b.run('materializeMonth', { month: '2026-10' }).length, 2);
  assert.equal(D.summarize(b.state, '2026-09').savingsPlanned, 100);
  assert.equal(D.summarize(b.state, '2026-10').savingsPlanned, 600);
});

test('invalid stored relationships are rejected without attempting to repair or overwrite data', () => {
  const b = book();
  saving(b);
  expense(b);
  const state = plain(b.state);
  state.expenses[0].fundingSettingId = 'missing';
  invalid(() => D.execute(state, { type: 'saveIncome', payload: { month: '2026-10', amount: 1 }, operationId: 'bad-state' }, b.options), 'NOT_FOUND');
  const duplicate = plain(b.state);
  duplicate.incomes.push({ id: 'a', month: '2026-10', amount: 1 }, { id: 'b', month: '2026-10', amount: 2 });
  invalid(() => D.summarize(duplicate, '2026-10'), 'CONFLICT');
});

test('indexed validation preserves missing-reference, mismatched-link and duplicate errors', () => {
  const b = book('2026-10-31T03:00:00.000Z');
  fixed(b, { paymentMethod: 'cash' });
  saving(b);
  b.run('materializeMonth', { month: '2026-10' });
  b.run('upsertExpense', { id: b.state.expenses[0].id, paymentMethod: 'bank' });
  expense(b);
  receipt(b);
  b.run('importReceipt', mixed());
  withdrawal(b, { amount: 400 });
  const [firstReceiptExpense, secondReceiptExpense] = b.state.receipts[0].expenseIds;
  const corruptions = [
    [state => state.expenses.push(plain(state.expenses[0])), 'CONFLICT', 'expensesのIDが重複しています。'],
    [state => state.receipts.push(plain(state.receipts[0])), 'CONFLICT', 'receiptsのIDが重複しています。'],
    [state => state.settings.push(plain(state.settings[0])), 'CONFLICT', 'settingsのIDが重複しています。'],
    [state => state.plans.push({ ...state.plans[0], id: 'duplicate-plan' }), 'CONFLICT', '月別計画が重複しています。'],
    [state => { state.receipts[0].expenseIds[0] = 'missing-expense'; }, 'NOT_FOUND', 'レシート明細が見つかりません。'],
    [state => { state.receipts[0].expenseIds.push(firstReceiptExpense); }, 'CONFLICT', 'レシート明細リンクが重複しています。'],
    [state => { state.receipts[0].expenseIds[0] = 'expense'; }, 'INVALID_INPUT', 'レシート明細の関連が一致しません。'],
    [state => { state.receipts[0].expenseIds = [secondReceiptExpense]; }, 'INVALID_INPUT', 'レシートに明細リンクがありません。'],
    [state => {
      state.receipts[0].expenseIds = [secondReceiptExpense];
      state.expenses.find(row => row.id === firstReceiptExpense).receiptId = 'missing-receipt';
    }, 'NOT_FOUND', 'レシートが見つかりません。'],
    [state => {
      const first = state.expenses.find(row => row.id === firstReceiptExpense);
      state.expenses.find(row => row.id === secondReceiptExpense).receiptLineId = first.receiptLineId;
    }, 'CONFLICT', '同じレシート行が重複しています。'],
    [state => { state.expenses[0].planId = 'missing-plan'; }, 'NOT_FOUND', '固定費計画が見つかりません。'],
    [state => { state.plans[0].settingId = 'missing-setting'; }, 'NOT_FOUND', '設定が見つかりません。'],
    [state => { state.expenses[0].fundingSettingId = 'missing-funding'; }, 'NOT_FOUND', '積立設定が見つかりません。'],
    [state => { state.transfers[0].settingId = 'missing-saving'; }, 'NOT_FOUND', '積立設定が見つかりません。'],
    [state => { state.transfers[0].expenseId = 'missing-purchase'; }, 'NOT_FOUND', '購入明細が見つかりません。']
  ];
  for (const [corrupt, code, message] of corruptions) {
    const state = plain(b.state);
    corrupt(state);
    const before = JSON.stringify(state);
    assert.throws(() => D.summarize(state, '2026-10'), error => error.code === code && error.message === message, message);
    assert.equal(JSON.stringify(state), before);
  }
});

test('per-table indexes accept IDs matching object prototype names without mixing records', () => {
  const b = book();
  saving(b, { id: '__proto__' });
  receipt(b, { id: 'constructor' });
  const imported = b.run('importReceipt', mixed({ receiptId: 'constructor' }));
  b.run('upsertExpense', { id: imported.expenses[0].id, fundingSettingId: '__proto__' });
  withdrawal(b, { settingId: '__proto__', expenseId: imported.expenses[0].id, date: '2026-12-01', amount: 400 });
  const summary = D.summarize(b.state, '2026-12');
  assert.equal(summary.cardTotal, 2200);
  assert.equal(summary.savingsPending, 800);
  assert.equal(summary.savings[0].balance, 49600);
});

test('new categories work for manual edits, fixed plans and mixed receipt imports without changing savings records', () => {
  const b=book('2026-10-05T03:00:00.000Z');
  saving(b);
  expense(b,{category:'被服費',amount:3000});
  b.run('upsertExpense',{id:'expense',category:'美容'});
  fixed(b,{category:'積立',paymentMethod:'cash',plannedAmount:2000});
  b.run('materializeMonth',{month:'2026-10'});
  const plan=b.state.plans.find(p=>p.kind==='fixed');
  assert.equal(plan.category,'固定費');
  const fixedActual=b.state.expenses.find(e=>e.planId===plan.id);
  b.run('upsertExpense',{id:fixedActual.id,memo:'分類の確認'});
  receipt(b);
  const payload=mixed({useDate:'2026-10-05',paymentMethod:'cash',total:1200,lines:[
    {lineId:'clothes',amount:400,category:'被服費',description:'靴下'},
    {lineId:'beauty',amount:500,category:'美容',description:'化粧品'},
    {lineId:'saving',amount:300,category:'積立',description:'分類の確認'}
  ]});
  b.run('importReceipt',payload);
  b.run('importReceipt',payload);
  const s=D.summarize(b.state,'2026-10');
  assert.equal(s.categories['被服費'],400);
  assert.equal(s.categories['美容'],3500);
  assert.equal(s.categories['積立'],300);
  assert.equal(s.categories['固定費'],2000);
  assert.equal(s.expenses,6200);
  assert.equal(b.state.expenses.length,5);
  assert.equal(b.state.transfers.length,0);
  assert.equal(s.savingsDeposited,0);
  assert.equal(s.savings[0].balance,50000);
});

test('outflow category order is independent of the backward-compatible ordinary purchase choices', () => {
  assert.deepEqual(plain(D.CATEGORIES), ['食費','酒','趣味','外食','被服費','美容','積立','必要経費','その他']);
  assert.deepEqual(plain(D.OUTFLOW_CATEGORIES), ['食費','酒','外食','趣味','被服費','美容','必要経費','積立','固定費','その他']);
  assert.equal(Object.isFrozen(D.OUTFLOW_CATEGORIES),true);
  const s=D.summarize(D.emptyState(),'2026-10');
  assert.deepEqual(Object.keys(s.outflowCategories),plain(D.OUTFLOW_CATEGORIES));
  assert.deepEqual(Object.keys(s.categories),plain(D.CATEGORIES));
});

test('all nine legacy categories remain valid on settings, plans and fixed expenses without read-time or unrelated-write changes', () => {
  for(const category of D.CATEGORIES){
    const b=book('2026-09-20T03:00:00.000Z');
    saving(b);fixed(b,{paymentMethod:'cash'});
    b.run('materializeMonth',{month:'2026-09'});
    expense(b,{useDate:'2026-09-05',fixed:true,amount:1000,category});
    const legacy=plain(b.state);
    legacy.settings.forEach(row=>row.category=category);
    legacy.plans.forEach(row=>row.category=category);
    legacy.expenses.forEach(row=>row.category=category);
    const before=JSON.stringify(legacy);
    const s=D.summarize(legacy,'2026-09');
    assert.equal(JSON.stringify(legacy),before,category);
    assert.equal(s.categories[category],1000,'purchase-only classification keeps its stored legacy category');
    assert.deepEqual(Object.keys(s.categories),plain(D.CATEGORIES));
    assert.equal(s.outflowCategories['固定費'],1000);
    assert.equal(s.outflowCategories[category],0);
    assert.equal(s.outflowItems[0].category,'固定費');
    assert.equal(s.salaryOutflow,1000);
    const reconciled=D.reconcileBankFixedExpenses(legacy,b.options);
    assert.equal(reconciled.changed,false);
    assert.equal(JSON.stringify(reconciled.state),before);
    const edited=D.execute(legacy,{type:'saveIncome',operationId:'unrelated-write',payload:{month:'2026-09',amount:5000}},b.options).state;
    for(const table of ['settings','plans','expenses'])assert.deepEqual(plain(edited[table]),legacy[table]);
    assert.equal(JSON.stringify(legacy),before);
  }
});

test('settings and explicitly edited or newly created plans derive category from kind while legacy snapshots stay frozen', () => {
  const b=book('2026-09-20T03:00:00.000Z');
  assert.equal(saving(b,{category:'食費'}).category,'積立');
  assert.equal(fixed(b,{category:'積立',paymentMethod:'cash'}).category,'固定費');
  b.run('materializeMonth',{month:'2026-10'});
  const legacy=plain(b.state);
  legacy.settings.forEach(row=>row.category='趣味');
  legacy.plans.forEach(row=>row.category='食費');
  const oldPlans=JSON.stringify(legacy.plans);
  const newer=D.execute(legacy,{type:'materializeMonth',operationId:'new-plans',payload:{month:'2026-11'}},b.options).state;
  assert.equal(JSON.stringify(newer.plans.filter(row=>row.month!=='2026-11')),oldPlans);
  for(const plan of newer.plans.filter(row=>row.month==='2026-11'))assert.equal(plan.category,plan.kind==='fixed'?'固定費':'積立');
  for(const kind of ['fixed','saving']){
    const changed=D.execute(legacy,{type:'saveSetting',operationId:'setting-'+kind,payload:{id:kind,category:'その他',memo:'変更'}},b.options).state;
    assert.equal(changed.settings.find(row=>row.id===kind).category,kind==='fixed'?'固定費':'積立');
    assert.equal(JSON.stringify(changed.plans),oldPlans,'setting edits never rewrite prior month snapshots');
    const plan=legacy.plans.find(row=>row.kind===kind&&row.month==='2026-10');
    const edited=D.execute(legacy,{type:'savePlan',operationId:'plan-'+kind,payload:{id:plan.id,plannedAmount:plan.plannedAmount}},b.options).state;
    assert.equal(edited.plans.find(row=>row.id===plan.id).category,kind==='fixed'?'固定費':'積立');
    assert.deepEqual(plain(edited.settings),legacy.settings);
  }
  const paid=D.reconcileBankFixedExpenses(legacy,{...b.options,now:'2026-10-05T03:00:00.000Z'});
  assert.equal(paid.createdExpenseIds.length,1);
  assert.equal(paid.state.expenses[0].category,'固定費');
  assert.equal(paid.state.plans.find(row=>row.kind==='fixed'&&row.month==='2026-10').category,'食費');
  assert.equal(D.reconcileBankFixedExpenses(paid.state,{...b.options,now:'2026-10-05T03:00:00.000Z'}).changed,false);
});

test('fixed attributes control new writes and manual category selection never silently creates a fixed expense', () => {
  const b=book();
  expense(b,{category:'食費',fixed:true});
  assert.equal(b.state.expenses[0].category,'固定費');
  b.run('upsertExpense',{id:'expense',category:'美容',memo:'変更'});
  assert.equal(b.state.expenses[0].category,'固定費');
  b.run('upsertExpense',{id:'expense',fixed:false});
  assert.equal(b.state.expenses[0].fixed,false);
  assert.equal(b.state.expenses[0].category,'その他');
  b.attempt('upsertExpense',{id:'expense',category:'固定費'});
  b.attempt('upsertExpense',{id:'manual-fixed-category',useDate:'2026-10-05',amount:1000,category:'固定費'});
  for(const category of D.CATEGORIES){
    const row=expense(b,{id:'ordinary-'+category,category});
    assert.equal(row.category,category);
    assert.equal(row.fixed,false);
  }
});

test('legacy fixed outflows subtract partial, full and cross-month savings funding once and keep deposit totals separate', () => {
  const b=book('2026-11-05T03:00:00.000Z');
  saving(b);
  expense(b,{id:'partial',useDate:'2026-10-05',amount:10000,fixed:true,fundingSettingId:'saving',category:'必要経費'});
  expense(b,{id:'full',useDate:'2026-10-05',amount:10000,fixed:true,fundingSettingId:'saving',category:'積立'});
  expense(b,{id:'ordinary',useDate:'2026-10-05',amount:1000,category:'必要経費'});
  withdrawal(b,{expenseId:'partial',date:'2026-11-02',amount:4000});
  withdrawal(b,{id:'full-withdrawal',expenseId:'full',date:'2026-11-02',amount:10000});
  deposit(b,{date:'2026-10-06',amount:2000});
  const legacy=plain(b.state);
  legacy.settings[0].category='必要経費';
  legacy.expenses.find(row=>row.id==='partial').category='必要経費';
  legacy.expenses.find(row=>row.id==='full').category='積立';
  const before=JSON.stringify(legacy);
  const s=D.summarize(legacy,'2026-10');
  assert.equal(s.expenses,21000);
  assert.equal(s.fixedTotal,20000);
  assert.equal(s.categories['必要経費'],11000);
  assert.equal(s.categories['積立'],10000);
  assert.equal(s.outflowCategories['固定費'],6000);
  assert.equal(s.outflowCategories['必要経費'],1000);
  assert.equal(s.outflowCategories['積立'],2000);
  assert.equal(s.salaryOutflow,9000);
  assert.equal(Object.values(s.outflowCategories).reduce((total,n)=>total+n,0),s.salaryOutflow);
  assert.equal(s.outflowItems.reduce((total,row)=>total+row.amount,0),s.salaryOutflow);
  assert.equal(s.outflowItems.some(row=>row.id==='full'),false);
  assert.equal(s.outflowItems.find(row=>row.id==='partial').savingsCovered,4000);
  assert.equal(D.summarize(legacy,'2026-11').salaryOutflow,0);
  assert.equal(JSON.stringify(legacy),before);
});
