/* Shared by the PWA and Apps Script. Money is whole JPY; dates are JST calendar dates. */
var HouseholdDomain = (function () {
  'use strict';

  var CATEGORIES = Object.freeze(['食費', '酒', '趣味', '外食', '必要経費', 'その他']);
  var PAYMENT_METHODS = Object.freeze(['cash', 'bank', 'card']);
  var TABLES = ['expenses', 'settings', 'plans', 'transfers', 'incomes', 'bills', 'receipts', 'operations'];

  function fail(code, message) {
    var error = new Error(message);
    error.name = 'HouseholdDomainError';
    error.code = code;
    throw error;
  }
  function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
  function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', label + 'を確認してください。');
    return value;
  }
  function copy(value) {
    try { return JSON.parse(JSON.stringify(value)); }
    catch (_) { fail('INVALID_INPUT', '保存できない形式のデータです。'); }
  }
  function text(value, label, required, maximum) {
    if (typeof value !== 'string' || value.length > (maximum || 5000) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
      fail('INVALID_INPUT', label + 'を確認してください。');
    }
    if (required && !value.trim()) fail('INVALID_INPUT', label + 'が必要です。');
    return value;
  }
  function identifier(value, label) { return text(value, label || 'ID', true, 200); }
  function amount(value, label, positive) {
    if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) fail('INVALID_INPUT', (label || '金額') + 'は' + (positive ? '1円以上' : '0円以上') + 'の整数で入力してください。');
    return value;
  }
  function quantity(value) {
    if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_INPUT', '数量は1以上の整数で入力してください。');
    return value;
  }
  function add(a, b) {
    var sum = a + b;
    if (!Number.isSafeInteger(sum)) fail('INVALID_INPUT', '金額の合計が安全に扱える範囲を超えています。');
    return sum;
  }
  function sum(rows, key) { return rows.reduce(function (total, row) { return add(total, row[key]); }, 0); }
  function oneOf(value, values, label) {
    if (values.indexOf(value) < 0) fail('INVALID_INPUT', label + 'を選んでください。');
    return value;
  }
  function bool(value, label) {
    if (typeof value !== 'boolean') fail('INVALID_INPUT', label + 'を確認してください。');
    return value;
  }
  function month(value) {
    if (typeof value !== 'string' || !/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value)) fail('INVALID_INPUT', '対象月はYYYY-MMで入力してください。');
    return value;
  }
  function date(value) {
    if (typeof value !== 'string' || !/^(?!0000)\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) fail('INVALID_INPUT', '日付はYYYY-MM-DDで入力してください。');
    var year = Number(value.slice(0, 4));
    var m = Number(value.slice(5, 7));
    var day = Number(value.slice(8, 10));
    var days = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (day > days[m - 1]) fail('INVALID_INPUT', '存在する日付を入力してください。');
    return value;
  }
  function plusMonths(value, count) {
    month(value);
    var index = Number(value.slice(0, 4)) * 12 + Number(value.slice(5)) - 1 + count;
    var year = Math.floor(index / 12);
    if (year < 1 || year > 9999) fail('INVALID_INPUT', '対象月が扱える範囲を超えています。');
    return String(year).padStart(4, '0') + '-' + String(index % 12 + 1).padStart(2, '0');
  }
  function cardMonth(useDate) { date(useDate); return plusMonths(useDate.slice(0, 7), Number(useDate.slice(8)) <= 27 ? 1 : 2); }
  function timestamp(now) {
    var value = typeof now === 'function' ? now() : now;
    var clock = value == null ? new Date() : new Date(value);
    if (!Number.isFinite(clock.getTime())) fail('INVALID_INPUT', '現在時刻を確認してください。');
    return clock.toISOString();
  }
  function todayJst(now) {
    var clock = new Date(timestamp(now));
    var shifted = new Date(clock.getTime() + 9 * 60 * 60 * 1000);
    return date(shifted.toISOString().slice(0, 10));
  }
  function emptyState() {
    return { schemaVersion: 1, revision: 0, expenses: [], settings: [], plans: [], transfers: [], incomes: [], bills: [], receipts: [], operations: [] };
  }
  function byId(rows, id, label) {
    identifier(id, label + 'ID');
    var row = rows.find(function (item) { return item.id === id; });
    if (!row) fail('NOT_FOUND', label + 'が見つかりません。');
    return row;
  }
  function optionalId(value, label) { return value == null || value === '' ? undefined : identifier(value, label); }
  function unique(rows, key, label) {
    var seen = new Set();
    rows.forEach(function (row) {
      var value = key(row);
      if (seen.has(value)) fail('CONFLICT', label + 'が重複しています。');
      seen.add(value);
    });
  }
  function replace(rows, row) {
    var index = rows.findIndex(function (item) { return item.id === row.id; });
    if (index < 0) rows.push(row); else rows[index] = row;
    return row;
  }
  function createId(context) {
    var id;
    if (context.uuid) id = context.uuid();
    else if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') id = globalThis.crypto.randomUUID();
    else if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
      var bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      var hex = Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
      id = hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    } else fail('INVALID_INPUT', '安全なID生成機能が必要です。');
    return identifier(id);
  }
  function newId(rows, p, context) {
    var id = own(p, 'id') ? identifier(p.id) : createId(context);
    if (rows.some(function (row) { return row.id === id; })) fail('CONFLICT', 'IDが重複しています。');
    return id;
  }
  function value(p, old, key, fallback) { return own(p, key) ? p[key] : old && own(old, key) ? old[key] : fallback; }

  function savingsLedger(state, settingId) {
    var setting = byId(state.settings, settingId, '積立設定');
    if (setting.kind !== 'saving') fail('INVALID_INPUT', '積立の設定を選んでください。');
    var current = amount(setting.openingBalance, '開始残高', false);
    var ordered = state.transfers.filter(function (row) { return row.settingId === settingId; }).slice().sort(function (a, b) {
      return a.date.localeCompare(b.date) || (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === 'deposit' ? -1 : 1);
    });
    ordered.forEach(function (row) {
      current = add(current, row.kind === 'deposit' ? row.amount : -row.amount);
      if (current < 0) fail('INSUFFICIENT_BALANCE', setting.name + 'の積立残高が不足しています。');
    });
    return current;
  }
  function balance(state, settingId) { return savingsLedger(state, settingId); }

  // Revalidate the whole ledger after every edit, so changing an expense or a past
  // deposit cannot leave its previously valid withdrawals invalid.
  function validateState(state, today) {
    object(state, '家計簿');
    if (state.schemaVersion !== 1) fail('INVALID_INPUT', '対応していない保存形式です。');
    amount(state.revision, 'リビジョン', false);
    var indexes = Object.create(null);
    TABLES.forEach(function (key) {
      if (!Array.isArray(state[key])) fail('INVALID_INPUT', '保存データを確認してください。');
      state[key].forEach(function (row) { object(row, '保存レコード'); identifier(key === 'operations' ? row.operationId : row.id); });
      unique(state[key], function (row) { return key === 'operations' ? row.operationId : row.id; }, key + 'のID');
      if (key === 'settings' || key === 'plans' || key === 'expenses' || key === 'receipts') {
        indexes[key] = new Map(state[key].map(function (row) { return [row.id, row]; }));
      }
    });
    function lookup(table, id, label) {
      identifier(id, label + 'ID');
      var row = indexes[table].get(id);
      if (!row) fail('NOT_FOUND', label + 'が見つかりません。');
      return row;
    }
    state.operations.forEach(function (row) {
      identifier(row.id, '操作履歴ID');
      if (row.id !== row.operationId) fail('INVALID_INPUT', '操作履歴IDが一致しません。');
    });
    state.settings.forEach(function (row) {
      oneOf(row.kind, ['fixed', 'saving'], '設定種別');
      text(row.name, '名前', true, 120);
      amount(row.plannedAmount, '予定額', false);
      amount(row.openingBalance, '開始残高', false);
      if (row.targetAmount != null) amount(row.targetAmount, '目標額', false);
      oneOf(row.paymentMethod, PAYMENT_METHODS, '支払方法');
      oneOf(row.category, CATEGORIES, '分類');
      text(row.memo, 'メモ', false);
      bool(row.active, '設定の有効状態');
      if (row.kind === 'fixed' && row.openingBalance !== 0) fail('INVALID_INPUT', '固定費に開始残高は設定できません。');
    });
    unique(state.plans, function (row) { return JSON.stringify([row.month, row.settingId]); }, '月別計画');
    state.plans.forEach(function (row) {
      month(row.month);
      var setting = lookup('settings', row.settingId, '設定');
      if (row.kind !== setting.kind) fail('INVALID_INPUT', '月別計画の設定種別が一致しません。');
      text(row.name, '計画の名前', true, 120);
      amount(row.plannedAmount, '月別予定額', false);
      oneOf(row.paymentMethod, PAYMENT_METHODS, '支払方法');
      oneOf(row.category, CATEGORIES, '分類');
      text(row.memo, 'メモ', false);
    });
    var receiptLinks = new Map();
    state.receipts.forEach(function (row) {
      text(row.imageHash, '画像ハッシュ', true, 200);
      oneOf(row.status, ['pending', 'needsReview', 'imported', 'failed'], 'レシート状態');
      text(row.reason, '確認理由', false);
      text(row.fileId, '画像ファイルID', false);
      text(row.fileName, 'ファイル名', false);
      text(row.mimeType, 'ファイル形式', false, 200);
      if (!row.uploadedAt || timestamp(row.uploadedAt) !== row.uploadedAt) fail('INVALID_INPUT', 'アップロード日時を確認してください。');
      if (row.purchaseDate != null) date(row.purchaseDate);
      if (own(row, 'merchant')) text(row.merchant, '店名', true, 120);
      if (!Array.isArray(row.expenseIds)) fail('INVALID_INPUT', 'レシート明細リンクを確認してください。');
      unique(row.expenseIds.map(function (id) { return { id: id }; }), function (entry) { return entry.id; }, 'レシート明細リンク');
      row.expenseIds.forEach(function (id) {
        var expense = lookup('expenses', id, 'レシート明細');
        if (expense.receiptId !== row.id) fail('INVALID_INPUT', 'レシート明細の関連が一致しません。');
      });
      if (row.status === 'imported' && row.expenseIds.length === 0) fail('INVALID_INPUT', '取込済みのレシートには明細が必要です。');
      receiptLinks.set(row.id, new Set(row.expenseIds));
    });
    unique(state.receipts, function (row) { return row.imageHash.toLowerCase(); }, 'レシート画像');
    var fixedActual = new Set();
    var receiptLines = new Set();
    state.expenses.forEach(function (row) {
      date(row.useDate); month(row.accountingMonth);
      amount(row.amount, '支出額', true);
      if (own(row, 'quantity')) quantity(row.quantity);
      oneOf(row.category, CATEGORIES, '分類');
      oneOf(row.paymentMethod, PAYMENT_METHODS, '支払方法');
      bool(row.fixed, '固定費属性'); bool(row.manualEdited, '手修正状態');
      amount(row.version, '明細バージョン', true);
      if (row.deleted != null) bool(row.deleted, '削除状態');
      text(row.description, '内容', false, 2000); text(row.memo, 'メモ', false);
      if (row.fundingSettingId) {
        var funding = lookup('settings', row.fundingSettingId, '積立設定');
        if (funding.kind !== 'saving') fail('INVALID_INPUT', '購入資金には積立の設定を選んでください。');
      }
      if (row.planId || row.settingId) {
        var plan = lookup('plans', row.planId, '固定費計画');
        if (plan.kind !== 'fixed' || plan.settingId !== row.settingId || plan.month !== row.accountingMonth || !row.fixed) fail('INVALID_INPUT', '固定費実績と月別計画の関連を確認してください。');
        if (!row.deleted) {
          if (fixedActual.has(row.planId)) fail('CONFLICT', 'この固定費計画にはすでに実績があります。既存の明細を編集してください。');
          fixedActual.add(row.planId);
        }
      }
      if (row.receiptId || row.receiptLineId) {
        var receipt = lookup('receipts', row.receiptId, 'レシート');
        identifier(row.receiptLineId, 'レシート行ID');
        if (!receiptLinks.get(receipt.id).has(row.id)) fail('INVALID_INPUT', 'レシートに明細リンクがありません。');
        var lineKey = JSON.stringify([row.receiptId, row.receiptLineId]);
        if (receiptLines.has(lineKey)) fail('CONFLICT', '同じレシート行が重複しています。');
        receiptLines.add(lineKey);
      }
    });
    var funded = new Map();
    state.transfers.forEach(function (row) {
      date(row.date); month(row.month);
      if (row.month !== row.date.slice(0, 7)) fail('INVALID_INPUT', '資金移動の日付と対象月が一致しません。');
      if (today && row.date > today) fail('INVALID_INPUT', '未来日の資金移動は実績に登録できません。');
      amount(row.amount, '資金移動額', true); text(row.memo, 'メモ', false);
      oneOf(row.kind, ['deposit', 'withdrawal'], '資金移動種別');
      var setting = lookup('settings', row.settingId, '積立設定');
      if (setting.kind !== 'saving') fail('INVALID_INPUT', '資金移動には積立の設定を選んでください。');
      if (row.expenseId) {
        if (row.kind !== 'withdrawal') fail('INVALID_INPUT', '購入に関連付けられるのは取り崩しだけです。');
        var expense = lookup('expenses', row.expenseId, '購入明細');
        if (expense.deleted) fail('INVALID_INPUT', '削除した購入明細には取り崩しを関連付けられません。');
        if (expense.fundingSettingId && expense.fundingSettingId !== row.settingId) fail('INVALID_INPUT', '購入で指定した積立と取り崩し元が一致しません。');
        if (expense.paymentMethod === 'card' && row.month !== expense.accountingMonth) fail('INVALID_INPUT', 'カード購入の取り崩しは請求の計上月に登録してください。');
        var used = add(funded.get(expense.id) || 0, row.amount);
        if (used > expense.amount) fail('INVALID_INPUT', '購入額を超える取り崩しは登録できません。');
        funded.set(expense.id, used);
      }
    });
    state.settings.filter(function (row) { return row.kind === 'saving'; }).forEach(function (row) { savingsLedger(state, row.id); });
    ['incomes', 'bills'].forEach(function (table) {
      unique(state[table], function (row) { return row.month; }, '月別の' + table);
      state[table].forEach(function (row) {
        month(row.month);
        amount(table === 'incomes' ? row.amount : row.confirmedAmount, table === 'incomes' ? '給与' : '確定請求額', false);
        if (table === 'bills') text(row.memo, 'メモ', false);
      });
    });
    // A single valid integer can still overflow a monthly total. Reject such an
    // edit before persistence instead of leaving a month that cannot be displayed.
    var months = new Set();
    ['expenses', 'plans', 'transfers', 'incomes', 'bills'].forEach(function (table) {
      state[table].forEach(function (row) { if (!row.deleted) months.add(table === 'expenses' ? row.accountingMonth : row.month); });
    });
    months.forEach(function (target) {
      var actual = sum(state.expenses.filter(function (row) { return !row.deleted && row.accountingMonth === target; }), 'amount');
      var wage = sum(state.incomes.filter(function (row) { return row.month === target; }), 'amount');
      sum(state.plans.filter(function (row) { return row.month === target && row.kind === 'saving'; }), 'plannedAmount');
      sum(state.plans.filter(function (row) { return row.month === target && row.kind === 'fixed'; }), 'plannedAmount');
      var deposited = sum(state.transfers.filter(function (row) { return row.month === target && row.kind === 'deposit'; }), 'amount');
      sum(state.transfers.filter(function (row) { return row.month === target && row.kind === 'withdrawal'; }), 'amount');
      var covered = 0;
      state.expenses.forEach(function (row) { if (!row.deleted && row.accountingMonth === target) covered = add(covered, funded.get(row.id) || 0); });
      var salaryExpenses = add(actual, -covered);
      var salaryOutflow = add(salaryExpenses, deposited);
      add(wage, -salaryOutflow);
    });
  }

  function snapshot(state, setting, targetMonth, context) {
    var existing = state.plans.find(function (row) { return row.month === targetMonth && row.settingId === setting.id; });
    if (existing) return existing;
    if (targetMonth < todayJst(context.now).slice(0, 7)) fail('INVALID_INPUT', 'この過去月には保存済みの固定費計画がありません。設定に関連付けず、固定費の明細として登録してください。');
    if (!setting.active) fail('INVALID_INPUT', '停止した設定から新しい月別計画は作成できません。');
    var plan = {
      id: newId(state.plans, {}, context), month: targetMonth, settingId: setting.id,
      kind: setting.kind, name: setting.name, plannedAmount: setting.plannedAmount,
      paymentMethod: setting.paymentMethod, category: setting.category, memo: setting.memo
    };
    state.plans.push(plan);
    return plan;
  }
  function materializeMonth(state, p, context) {
    var target = month(p.month);
    // A past view cannot reconstruct a plan from today's settings. Preserve only
    // snapshots actually recorded for that month, including missing settings.
    if (target < todayJst(context.now).slice(0, 7)) return state.plans.filter(function (plan) { return plan.month === target; });
    state.settings.filter(function (setting) { return setting.active; }).forEach(function (setting) { snapshot(state, setting, target, context); });
    return state.plans.filter(function (plan) { return plan.month === target; });
  }
  function saveSetting(state, p, context) {
    var old = p.id ? state.settings.find(function (row) { return row.id === p.id; }) : undefined;
    var row = {
      id: old ? old.id : newId(state.settings, p, context),
      kind: value(p, old, 'kind', undefined), name: value(p, old, 'name', ''),
      plannedAmount: value(p, old, 'plannedAmount', 0), paymentMethod: value(p, old, 'paymentMethod', 'bank'),
      category: value(p, old, 'category', 'その他'), openingBalance: value(p, old, 'openingBalance', 0),
      memo: value(p, old, 'memo', ''), active: value(p, old, 'active', true)
    };
    var target = value(p, old, 'targetAmount', undefined);
    if (target != null) row.targetAmount = target;
    if (old && row.kind !== old.kind) fail('CONFLICT', '設定種別は変更できません。別の設定を作成してください。');
    if (old && row.openingBalance !== old.openingBalance && state.transfers.some(function (transfer) { return transfer.settingId === old.id; })) fail('CONFLICT', '資金移動を記録した積立の開始残高は変更できません。');
    return replace(state.settings, row);
  }
  function savePlan(state, p) {
    var plan;
    if (p.id || p.planId) plan = byId(state.plans, p.id || p.planId, '月別計画');
    else {
      month(p.month); identifier(p.settingId, '設定ID');
      plan = state.plans.find(function (row) { return row.month === p.month && row.settingId === p.settingId; });
      if (!plan) fail('NOT_FOUND', '先に対象月の計画を作成してください。');
    }
    if ((own(p, 'month') && p.month !== plan.month) || (own(p, 'settingId') && p.settingId !== plan.settingId)) fail('CONFLICT', '月別計画の対象月と設定は変更できません。');
    // Only this explicit action overrides a frozen month. Master-setting edits never do.
    plan.plannedAmount = amount(p.plannedAmount, '月別予定額', false);
    if (own(p, 'memo')) plan.memo = text(p.memo, 'メモ', false);
    return plan;
  }
  function upsertExpense(state, p, context) {
    var old = p.id ? state.expenses.find(function (row) { return row.id === p.id; }) : undefined;
    if (old && old.deleted) fail('CONFLICT', '削除した明細は復活できません。新しい明細として登録してください。');
    var useDate = date(value(p, old, 'useDate', undefined));
    var method = oneOf(value(p, old, 'paymentMethod', 'cash'), PAYMENT_METHODS, '支払方法');
    var recalculated = !old || useDate !== old.useDate || method !== old.paymentMethod;
    var accounting = own(p, 'accountingMonth') ? month(p.accountingMonth) : recalculated ? method === 'card' ? cardMonth(useDate) : useDate.slice(0, 7) : old.accountingMonth;
    var row = {
      id: old ? old.id : newId(state.expenses, p, context), useDate: useDate, accountingMonth: accounting,
      amount: amount(value(p, old, 'amount', undefined), '支出額', true),
      category: oneOf(value(p, old, 'category', 'その他'), CATEGORIES, '分類'), paymentMethod: method,
      fixed: bool(value(p, old, 'fixed', false), '固定費属性'),
      description: text(value(p, old, 'description', ''), '内容', false, 2000),
      memo: text(value(p, old, 'memo', ''), 'メモ', false),
      manualEdited: Boolean(old && old.manualEdited), version: old ? add(old.version, 1) : 1
    };
    // Missing quantity stays unknown; an explicit null clears a previous value.
    var itemQuantity = value(p, old, 'quantity', undefined);
    if (itemQuantity != null) row.quantity = quantity(itemQuantity);
    var settingId = optionalId(value(p, old, 'settingId', undefined), '固定費設定ID');
    var planId = optionalId(value(p, old, 'planId', undefined), '固定費計画ID');
    // An explicit setting change/detachment also detaches the previous plan.
    if (own(p, 'settingId') && !own(p, 'planId') && (!old || settingId !== old.settingId)) planId = undefined;
    if (planId) {
      var plan = byId(state.plans, planId, '固定費計画');
      if (settingId && plan.settingId !== settingId) fail('INVALID_INPUT', '固定費の設定と計画が一致しません。');
      settingId = plan.settingId;
    }
    if (settingId) {
      var setting = byId(state.settings, settingId, '固定費設定');
      if (setting.kind !== 'fixed') fail('INVALID_INPUT', '固定費には固定費設定を選んでください。');
      // Moving an existing fixed actual to another month creates/uses that month's snapshot.
      if (!planId || (old && accounting !== old.accountingMonth && !own(p, 'planId'))) planId = snapshot(state, setting, accounting, context).id;
      row.settingId = settingId; row.planId = planId; row.fixed = true;
    } else if (planId) fail('INVALID_INPUT', '固定費設定を確認してください。');
    var funding = optionalId(value(p, old, 'fundingSettingId', undefined), '購入資金の積立ID');
    if (funding) row.fundingSettingId = funding;
    var receiptId = optionalId(value(p, old, 'receiptId', undefined), 'レシートID');
    var lineId = optionalId(value(p, old, 'receiptLineId', undefined), 'レシート行ID');
    if (old && old.receiptId && (receiptId !== old.receiptId || lineId !== old.receiptLineId)) fail('CONFLICT', 'レシートから取り込んだ明細の関連は変更できません。');
    if (receiptId || lineId) {
      var receipt = byId(state.receipts, receiptId, 'レシート');
      identifier(lineId, 'レシート行ID');
      row.receiptId = receiptId; row.receiptLineId = lineId; row.manualEdited = true;
      if (receipt.expenseIds.indexOf(row.id) < 0) receipt.expenseIds.push(row.id);
    }
    return replace(state.expenses, row);
  }
  function deleteExpense(state, p) {
    var row = byId(state.expenses, p.id || p.expenseId, '購入明細');
    if (state.transfers.some(function (transfer) { return transfer.expenseId === row.id; })) fail('CONFLICT', '関連する取り崩しを取り消してから明細を削除してください。');
    if (!row.deleted) { row.deleted = true; row.version = add(row.version, 1); if (row.receiptId) row.manualEdited = true; }
    return row;
  }
  function saveMonthly(state, p, context, table, key, label) {
    var rows = state[table];
    var old = p.id ? rows.find(function (row) { return row.id === p.id; }) : undefined;
    var target = month(value(p, old, 'month', undefined));
    var sameMonth = rows.find(function (row) { return row.month === target; });
    if (old && old.month !== target) fail('CONFLICT', label + 'の対象月は変更できません。');
    if (sameMonth && p.id && p.id !== sameMonth.id) fail('CONFLICT', '同じ月の' + label + 'がすでにあります。');
    old = old || sameMonth;
    var row = { id: old ? old.id : newId(rows, p, context), month: target };
    row[key] = amount(p[key], label, false);
    if (table === 'bills') row.memo = text(value(p, old, 'memo', ''), 'メモ', false);
    return replace(rows, row);
  }
  function saveTransfer(state, p, context) {
    var old = p.id ? state.transfers.find(function (row) { return row.id === p.id; }) : undefined;
    var transferDate = date(value(p, old, 'date', undefined));
    if (own(p, 'month') && p.month !== transferDate.slice(0, 7)) fail('INVALID_INPUT', '資金移動の日付と対象月が一致しません。');
    var row = {
      id: old ? old.id : newId(state.transfers, p, context), date: transferDate, month: transferDate.slice(0, 7),
      settingId: identifier(value(p, old, 'settingId', undefined), '積立設定ID'),
      kind: oneOf(value(p, old, 'kind', undefined), ['deposit', 'withdrawal'], '資金移動種別'),
      amount: amount(value(p, old, 'amount', undefined), '資金移動額', true), memo: text(value(p, old, 'memo', ''), 'メモ', false)
    };
    var expenseId = optionalId(value(p, old, 'expenseId', undefined), '購入明細ID');
    if (expenseId) row.expenseId = expenseId;
    return replace(state.transfers, row);
  }
  function deleteTransfer(state, p) {
    var row = byId(state.transfers, p.id || p.transferId, '資金移動');
    state.transfers = state.transfers.filter(function (entry) { return entry.id !== row.id; });
    return Object.assign({}, row, { deleted: true });
  }
  function registerReceipt(state, p, context) {
    var hash = text(p.imageHash, '画像ハッシュ', true, 200).trim().toLowerCase();
    var existingId = p.id ? state.receipts.find(function (row) { return row.id === p.id; }) : undefined;
    if (existingId && existingId.imageHash !== hash) fail('CONFLICT', '同じIDで別の画像は登録できません。');
    var existingHash = state.receipts.find(function (row) { return row.imageHash === hash; });
    if (existingHash) return existingHash;
    var receipt = {
      id: newId(state.receipts, p, context), imageHash: hash,
      fileId: text(p.fileId || '', '画像ファイルID', false), fileName: text(p.fileName || '', 'ファイル名', false),
      mimeType: text(p.mimeType || '', 'ファイル形式', false, 200), status: 'pending', reason: '',
      uploadedAt: timestamp(p.uploadedAt || context.now), expenseIds: []
    };
    state.receipts.push(receipt);
    return receipt;
  }
  function setReceiptStatus(state, p) {
    var receipt = byId(state.receipts, p.receiptId || p.id, 'レシート');
    var status = oneOf(p.status, ['pending', 'needsReview', 'imported', 'failed'], 'レシート状態');
    if (status === 'pending' && (receipt.expenseIds.length || receipt.status === 'imported')) {
      fail('CONFLICT', '取込済みのレシートは再解析待ちに戻せません。明細を編集してください。');
    }
    receipt.status = status;
    receipt.reason = status === 'pending' ? '' : text(p.reason || '', '確認理由', false);
    return receipt;
  }
  function importReceipt(state, p) {
    var receipt = byId(state.receipts, p.receiptId, 'レシート');
    // Keep links (including tombstones) forever. Reanalysis cannot overwrite a manual
    // correction or resurrect a deleted line, even under a new operation ID.
    if (receipt.expenseIds.length) {
      return { receipt: receipt, expenses: receipt.expenseIds.map(function (id) { return byId(state.expenses, id, 'レシート明細'); }), imported: false, alreadyImported: true, needsReview: receipt.status === 'needsReview' };
    }
    var normalized;
    try {
      var useDate = date(p.useDate);
      var method = oneOf(p.paymentMethod, PAYMENT_METHODS, '支払方法');
      var total = amount(p.total, 'レシート合計', true);
      var merchant = own(p, 'merchant') ? text(p.merchant, '店名', false, 120).trim() : '';
      if (!Array.isArray(p.lines) || p.lines.length === 0) fail('INVALID_INPUT', 'レシート明細がありません。');
      normalized = p.lines.map(function (line) {
        object(line, 'レシート明細');
        var lineId = identifier(line.lineId, 'レシート行ID');
        var id = identifier('receipt:' + encodeURIComponent(receipt.id) + ':' + encodeURIComponent(lineId), '取込明細ID');
        var normalizedLine = { id: id, lineId: lineId, amount: amount(line.amount, '明細金額', true), category: oneOf(line.category, CATEGORIES, '分類'), description: text(line.description || '', '内容', false, 2000) };
        if (own(line, 'quantity')) normalizedLine.quantity = quantity(line.quantity);
        return normalizedLine;
      });
      unique(normalized, function (line) { return line.lineId; }, 'レシート行ID');
      if (sum(normalized, 'amount') !== total) fail('INVALID_INPUT', 'レシート合計と明細の合計が一致しません。');
      text(p.memo || '', 'メモ', false);
    } catch (error) {
      if (error.code !== 'INVALID_INPUT' && error.code !== 'CONFLICT') throw error;
      receipt.status = 'needsReview'; receipt.reason = error.message;
      return { receipt: receipt, expenses: [], imported: false, alreadyImported: false, needsReview: true };
    }
    var expenses = normalized.map(function (line) {
      var id = line.id;
      if (state.expenses.some(function (expense) { return expense.id === id; })) fail('CONFLICT', 'レシート明細のIDが既存の明細と重複しています。');
      var expense = {
        id: id, useDate: useDate, accountingMonth: method === 'card' ? cardMonth(useDate) : useDate.slice(0, 7),
        amount: line.amount, category: line.category, paymentMethod: method, fixed: false,
        receiptId: receipt.id, receiptLineId: line.lineId, description: line.description, memo: p.memo || '', manualEdited: false, version: 1
      };
      // amount is already the line total, including all units. Never multiply it.
      if (own(line, 'quantity')) expense.quantity = line.quantity;
      return expense;
    });
    state.expenses = state.expenses.concat(expenses);
    receipt.expenseIds = expenses.map(function (expense) { return expense.id; });
    // This is the date printed on the receipt, supplied by the reviewed extraction.
    // Upload/capture timestamps never substitute for it; later expense edits do not change it.
    receipt.purchaseDate = useDate;
    if (merchant) receipt.merchant = merchant;
    receipt.status = 'imported'; receipt.reason = '';
    return { receipt: receipt, expenses: expenses, imported: true, alreadyImported: false, needsReview: false };
  }

  function execute(input, command, options) {
    object(command, '操作');
    var operationId = identifier(command.operationId, '操作ID');
    object(input, '家計簿');
    if (!Array.isArray(input.operations)) fail('INVALID_INPUT', '操作履歴を確認してください。');
    var previous = input.operations.find(function (operation) { return operation.operationId === operationId; });
    if (previous) return { state: copy(input), result: copy(previous.result) };
    var state = copy(input);
    var context = Object.assign({}, options || {});
    if (context.uuid != null && typeof context.uuid !== 'function') fail('INVALID_INPUT', 'ID生成機能を確認してください。');
    var now = timestamp(context.now);
    context.now = now;
    var today = todayJst(now);
    validateState(state, today);
    if (own(command, 'expectedRevision')) {
      amount(command.expectedRevision, '想定リビジョン', false);
      if (command.expectedRevision !== state.revision) fail('CONFLICT', '他の更新が反映されています。最新データを読み込んでから保存してください。');
    }
    var p = object(command.payload || {}, '操作内容');
    var result;
    switch (command.type) {
      case 'upsertExpense': result = upsertExpense(state, p, context); break;
      case 'deleteExpense': result = deleteExpense(state, p); break;
      case 'saveSetting': result = saveSetting(state, p, context); break;
      case 'materializeMonth': result = materializeMonth(state, p, context); break;
      case 'savePlan': result = savePlan(state, p); break;
      case 'saveIncome': result = saveMonthly(state, p, context, 'incomes', 'amount', '給与'); break;
      case 'saveBill': result = saveMonthly(state, p, context, 'bills', 'confirmedAmount', '確定請求額'); break;
      case 'saveTransfer': result = saveTransfer(state, p, context); break;
      case 'deleteTransfer': result = deleteTransfer(state, p); break;
      case 'registerReceipt': result = registerReceipt(state, p, context); break;
      case 'importReceipt': result = importReceipt(state, p); break;
      case 'setReceiptStatus': result = setReceiptStatus(state, p); break;
      default: fail('INVALID_INPUT', '未対応の操作です。');
    }
    validateState(state, today);
    state.revision = add(state.revision, 1);
    var storedResult = copy(result);
    state.operations.push({ id: operationId, operationId: operationId, type: command.type, result: storedResult, appliedAt: now, revision: state.revision });
    // result and the durable operation cache are independently owned snapshots.
    return { state: state, result: copy(storedResult) };
  }

  function summarize(state, targetMonth) {
    month(targetMonth);
    validateState(state);
    var expenses = state.expenses.filter(function (expense) { return !expense.deleted && expense.accountingMonth === targetMonth; });
    var plans = state.plans.filter(function (plan) { return plan.month === targetMonth; });
    var transfers = state.transfers.filter(function (transfer) { return transfer.month === targetMonth; });
    var income = sum(state.incomes.filter(function (row) { return row.month === targetMonth; }), 'amount');
    var expenseTotal = sum(expenses, 'amount');
    var cardTotal = sum(expenses.filter(function (expense) { return expense.paymentMethod === 'card'; }), 'amount');
    var fixedTotal = sum(expenses.filter(function (expense) { return expense.fixed; }), 'amount');
    var savingsPlanned = sum(plans.filter(function (plan) { return plan.kind === 'saving'; }), 'plannedAmount');
    var savingsDeposited = sum(transfers.filter(function (transfer) { return transfer.kind === 'deposit'; }), 'amount');
    var savingsWithdrawn = sum(transfers.filter(function (transfer) { return transfer.kind === 'withdrawal'; }), 'amount');
    // Only purchase-linked withdrawals cover a purchase. Moving savings to cash
    // without a purchase never increases salary. Attribute coverage to the
    // purchase accounting month even when a cash withdrawal has a different date.
    var withdrawnByExpense = new Map();
    state.transfers.forEach(function (transfer) {
      if (transfer.kind === 'withdrawal' && transfer.expenseId) withdrawnByExpense.set(transfer.expenseId, add(withdrawnByExpense.get(transfer.expenseId) || 0, transfer.amount));
    });
    var savingsFunded = 0;
    expenses.forEach(function (expense) { savingsFunded = add(savingsFunded, withdrawnByExpense.get(expense.id) || 0); });
    var salaryExpenses = add(expenseTotal, -savingsFunded);
    var salaryOutflow = add(salaryExpenses, savingsDeposited);
    var monthlyRemaining = add(income, -salaryOutflow);
    var categories = {};
    CATEGORIES.forEach(function (category) { categories[category] = sum(expenses.filter(function (expense) { return expense.category === category; }), 'amount'); });
    var pendingFunding = expenses.filter(function (expense) { return expense.fundingSettingId; }).map(function (expense) {
      var withdrawn = withdrawnByExpense.get(expense.id) || 0;
      return { expenseId: expense.id, settingId: expense.fundingSettingId, amount: expense.amount, withdrawn: withdrawn, pending: add(expense.amount, -withdrawn), accountingMonth: expense.accountingMonth, useDate: expense.useDate, paymentMethod: expense.paymentMethod, description: expense.description };
    }).filter(function (entry) { return entry.pending > 0; });
    var savings = state.settings.filter(function (setting) { return setting.kind === 'saving'; }).map(function (setting) {
      var plan = plans.find(function (entry) { return entry.settingId === setting.id; });
      return {
        settingId: setting.id, name: plan ? plan.name : setting.name, active: setting.active,
        planned: plan ? plan.plannedAmount : 0,
        deposited: sum(transfers.filter(function (transfer) { return transfer.settingId === setting.id && transfer.kind === 'deposit'; }), 'amount'),
        withdrawn: sum(transfers.filter(function (transfer) { return transfer.settingId === setting.id && transfer.kind === 'withdrawal'; }), 'amount'),
        pending: sum(pendingFunding.filter(function (entry) { return entry.settingId === setting.id; }), 'pending'),
        balance: balance(state, setting.id), openingBalance: setting.openingBalance, targetAmount: setting.targetAmount == null ? null : setting.targetAmount
      };
    });
    var bill = state.bills.find(function (row) { return row.month === targetMonth; });
    return {
      month: targetMonth, income: income, expenses: expenseTotal, cardTotal: cardTotal, fixedTotal: fixedTotal,
      fixedPlanned: sum(plans.filter(function (plan) { return plan.kind === 'fixed'; }), 'plannedAmount'),
      savingsPlanned: savingsPlanned, savingsDeposited: savingsDeposited, savingsWithdrawn: savingsWithdrawn,
      savingsPending: sum(pendingFunding, 'pending'), savingsFunded: savingsFunded, salaryExpenses: salaryExpenses,
      salaryOutflow: salaryOutflow, monthlyRemaining: monthlyRemaining, confirmedAmount: bill ? bill.confirmedAmount : null,
      billDifference: bill ? add(bill.confirmedAmount, -cardTotal) : null,
      categories: categories, savings: savings, plans: copy(plans), pendingFunding: pendingFunding
    };
  }

  return Object.freeze({ emptyState: emptyState, cardMonth: cardMonth, todayJst: todayJst, summarize: summarize, balance: balance, execute: execute, CATEGORIES: CATEGORIES, PAYMENT_METHODS: PAYMENT_METHODS });
}());
if (typeof module !== 'undefined' && module.exports) module.exports = HouseholdDomain;
