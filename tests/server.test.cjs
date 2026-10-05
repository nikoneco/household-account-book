'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../gas/Server.gs'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const tableNames = ['Expenses', 'Settings', 'Plans', 'Transfers', 'Incomes', 'Bills', 'Receipts', 'Operations'];
const keys = tableNames.map(name => name.toLowerCase());
const channel = 'a'.repeat(64);
const jpeg = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const upload = (operationId = 'upload-one', bytes = jpeg) => ({ operationId, imageHash: hash(bytes), fileName: 'レシート.jpg', mimeType: 'image/jpeg', base64: bytes.toString('base64') });
function realDomain() {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../shared/domain.js'), 'utf8'), context);
  return context.HouseholdDomain;
}

function receiptInbox(options = {}) {
  const h = harness({ domain: realDomain(), ...options });
  const session = h.login().session;
  const receipt = h.call('rpc', { session, operation: 'uploadReceipt', payload: upload() }).result;
  const payload = { receiptId: receipt.id, useDate: '2026-09-01', paymentMethod: 'cash', total: 1200,
    lines: [{ lineId: 'food', amount: 500, category: '食費', description: '食材' }, { lineId: 'hobby', amount: 700, category: '趣味', description: '趣味用品' }] };
  const inbox = h.sheets.get('HB_ReceiptInbox');
  const append = (id, value, status = '', error = '') => { inbox.rows.push([id, typeof value === 'string' ? value : JSON.stringify(value), status, error]); return inbox.rows.length - 1; };
  const load = () => h.call('rpc', { session, operation: 'load' });
  return { h, session, receipt, payload, inbox, append, load };
}

function harness(options = {}) {
  const harnessOptionsHook = options.onBatchRead;
  const props = {
    HOUSEHOLD_SPREADSHEET_ID: 'private-sheet', HOUSEHOLD_RECEIPT_FOLDER_ID: 'private-folder',
    HOUSEHOLD_ALLOWED_EMAIL: 'wife@example.test', HOUSEHOLD_OAUTH_CLIENT_ID: 'client.apps.googleusercontent.com',
    HOUSEHOLD_OAUTH_CLIENT_SECRET: 'server-secret', HOUSEHOLD_PWA_ORIGIN: 'https://example.github.io',
    ...(options.props || {})
  };
  const io = { sheet: 0, drive: 0, create: 0, batches: [], batchReads: [], exchanges: [], lockTaken: 0, lockReleased: 0 };
  const cache = new Map();
  const sheets = new Map();
  let sequence = 1;
  let batchFault = options.batchFault;
  let descriptionFault = options.descriptionFault;
  let responseStatus = 200;
  let claims = { aud: props.HOUSEHOLD_OAUTH_CLIENT_ID, iss: 'https://accounts.google.com', exp: Math.floor(Date.now() / 1000) + 3600, sub: 'wife-sub', email: 'wife@example.test', email_verified: true };
  const blob = (value, type = 'application/octet-stream', name = '') => {
    const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
    return { getBytes: () => Array.from(bytes), getDataAsString: () => bytes.toString('utf8'), getContentType: () => type, getName: () => name };
  };
  function sheet(name, rows) {
    const result = {
      name, rows: clone(rows), sid: sequence++, maxRows: Math.max(100, rows.length),
      getSheetId() { return this.sid; }, getMaxRows() { return this.maxRows; },
      getLastRow() { let i = this.rows.length; while (i && this.rows[i - 1].every(value => value === '')) i--; return i; },
      getDataRange() { return { getValues: () => clone(this.rows.length ? this.rows : [['']]) }; },
      getRange(row, column, rowCount, columnCount) { return { setValues(values) {
        for (let r = 0; r < rowCount; r++) {
          while (result.rows.length < row + r) result.rows.push(['', '']);
          for (let c = 0; c < columnCount; c++) result.rows[row - 1 + r][column - 1 + c] = values[r][c];
        }
      } }; }
    };
    sheets.set(name, result);
    return result;
  }
  const empty = () => ({ schemaVersion: 1, revision: 0, ...Object.fromEntries(keys.map(key => [key, []])) });
  const state = options.state || empty();
  if (!options.uninitialized) {
    for (const name of tableNames) sheet('HB_' + name, [['id', 'json'], ...state[name.toLowerCase()].map(record => [name === 'Operations' ? record.operationId : record.id, JSON.stringify(record)])]);
    sheet('HB_Meta', [['id', 'json'], ['meta', JSON.stringify({ id: 'meta', schemaVersion: 1, revision: state.revision })]]);
    sheet('HB_ReceiptInbox', [['id', 'json', 'status', 'error']]);
  }
  sheet('シート1', [['unrelated', '=SUM(1,2)']]);
  const book = { getSheetByName: name => sheets.get(name), insertSheet: name => sheet(name, []) };
  const iterator = items => { let index = 0; return { hasNext: () => index < items.length, next: () => items[index++] }; };
  const files = new Map();
  const folder = {
    access: 'PRIVATE', editors: [], viewers: [], getId: () => 'private-folder',
    getSharingAccess() { return this.access; }, getEditors() { return this.editors; }, getViewers() { return this.viewers; },
    getFilesByName(name) { io.drive++; return iterator(Array.from(files.values()).filter(file => file.name === name)); },
    createFile(value) {
      io.drive++; io.create++;
      const file = {
        id: 'file-' + io.create, name: value.getName(), mimeType: value.getContentType(), bytes: Buffer.from(value.getBytes()),
        access: 'PRIVATE', editors: [], viewers: [], parents: [folder], trashed: false,
        getId() { return this.id; }, getMimeType() { return this.mimeType; },
        getSharingAccess() { return this.access; }, getEditors() { return this.editors; }, getViewers() { return this.viewers; },
        getBlob() { io.drive++; return blob(this.bytes, this.mimeType, this.name); },
        isTrashed() { return this.trashed; }, getParents() { return iterator(this.parents); },
        setDescription(value) { if (descriptionFault) { descriptionFault = false; throw Error('simulated lost metadata write'); } this.description = value; }
      };
      files.set(file.id, file);
      return file;
    }
  };
  const domain = {
    emptyState: empty,
    summarize() {},
    execute(current, command, context) {
      const state = clone(current);
      const prior = state.operations.find(operation => operation.operationId === command.operationId);
      if (prior) return { state, result: prior.result };
      if (command.expectedRevision !== undefined && command.expectedRevision !== state.revision) throw Error('REVISION_CONFLICT: concurrent save');
      let result;
      if (command.type === 'registerReceipt') {
        result = state.receipts.find(receipt => receipt.imageHash === command.payload.imageHash);
        if (!result) { result = { id: context.uuid(), ...command.payload, uploadedAt: context.now(), reason: '', expenseIds: [] }; state.receipts.push(result); }
      } else if (command.type === 'tamperReceipt') {
        state.receipts[0].fileId = command.payload.fileId; result = state.receipts[0];
      } else { result = { id: context.uuid(), ...command.payload }; state.expenses.push(result); }
      state.revision++;
      state.operations.push({ id: context.uuid(), operationId: command.operationId, type: command.type, result });
      return { state, result };
    }
  };
  const context = {
    HouseholdDomain: options.domain || domain,
    PropertiesService: { getScriptProperties: () => ({ getProperty: name => props[name] || null, getProperties: () => ({ ...props }) }) },
    CacheService: { getScriptCache: () => ({ put(key, value, ttl) { assert.ok(ttl > 0 && ttl <= 3600); cache.set(key, { value, expiry: Date.now() + ttl * 1000 }); }, get(key) { const item = cache.get(key); return item && item.expiry > Date.now() ? item.value : null; }, remove: key => cache.delete(key) }) },
    LockService: { getScriptLock: () => ({ tryLock() { io.lockTaken++; return !options.busy; }, releaseLock() { io.lockReleased++; } }) },
    Utilities: { getUuid: () => crypto.randomUUID(), newBlob: blob, base64Decode: value => Array.from(Buffer.from(value, 'base64')), base64DecodeWebSafe: value => Array.from(Buffer.from(value, 'base64url')), base64Encode: bytes => Buffer.from(bytes).toString('base64'), DigestAlgorithm: { SHA_256: 'sha256' }, computeDigest: (algorithm, bytes) => Array.from(crypto.createHash(algorithm).update(Buffer.from(bytes)).digest()) },
    UrlFetchApp: { fetch(url, request) {
      io.exchanges.push({ url, request: clone(request) });
      const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      return { getResponseCode: () => responseStatus, getContentText: () => JSON.stringify({ id_token: encode({ alg: 'RS256' }) + '.' + encode(claims) + '.signature', access_token: 'NEVER-RETURN', refresh_token: 'NEVER-RETURN-REFRESH' }) };
    } },
    SpreadsheetApp: { openById(id) { io.sheet++; assert.equal(id, 'private-sheet'); return book; }, flush() {} },
    Sheets: { Spreadsheets: { Values: { batchGet(id, options) {
      io.sheet++; assert.equal(id, 'private-sheet'); io.batchReads.push(clone(options));
      const result = { valueRanges: options.ranges.map(range => {
        const match = range.match(/^([^!]+)!([A-Z])(\d+):([A-Z])(\d*)$/);
        assert.ok(match, 'recognized test A1 range');
        const sheet = sheets.get(match[1]);
        const startRow = Number(match[3]) - 1, endRow = match[5] ? Number(match[5]) : sheet.rows.length;
        const startColumn = match[2].charCodeAt(0) - 65, endColumn = match[4].charCodeAt(0) - 64;
        const values = sheet.rows.slice(startRow, endRow).map(row => {
          const output = Array.from({ length: endColumn - startColumn }, (_, index) => row[startColumn + index] ?? '');
          while (output.length && output.at(-1) === '') output.pop();
          return output;
        });
        while (values.length && !values.at(-1).length) values.pop();
        return { range, values };
      }) };
      if (typeof harnessOptionsHook === 'function') harnessOptionsHook(io.batchReads.length, sheets);
      return result;
    } }, batchUpdate(body, id) {
      io.sheet++; assert.equal(id, 'private-sheet'); io.batches.push(clone(body));
      if (batchFault === 'before') { batchFault = null; throw Error('simulated atomic rejection'); }
      const next = new Map(Array.from(sheets.values()).map(item => [item.sid, { rows: clone(item.rows), maxRows: item.maxRows }]));
      for (const request of body.requests) {
        if (request.appendDimension) { next.get(request.appendDimension.sheetId).maxRows += request.appendDimension.length; continue; }
        const update = request.updateCells;
        assert.equal(update.fields, 'userEnteredValue');
        const staged = next.get(update.range.sheetId);
        assert.ok(update.range.endRowIndex <= staged.maxRows, 'grid expansion precedes row writes');
        const sourceSheet = Array.from(sheets.values()).find(sheet => sheet.sid === update.range.sheetId);
        assert.equal(update.range.startColumnIndex, sourceSheet.name === 'HB_ReceiptInbox' ? 2 : 0);
        assert.equal(update.range.endColumnIndex, sourceSheet.name === 'HB_ReceiptInbox' ? 4 : 2);
        for (let r = update.range.startRowIndex; r < update.range.endRowIndex; r++) {
          const relativeRow = r - update.range.startRowIndex;
          const values = (update.rows[relativeRow] && update.rows[relativeRow].values || []).map(cell => {
            assert.equal(typeof cell.userEnteredValue.stringValue, 'string');
            assert.equal(cell.userEnteredValue.formulaValue, undefined);
            return cell.userEnteredValue.stringValue;
          });
          while (values.length < update.range.endColumnIndex - update.range.startColumnIndex) values.push('');
          while (staged.rows.length <= r) staged.rows.push(['', '']);
          for (let column = update.range.startColumnIndex; column < update.range.endColumnIndex; column++) staged.rows[r][column] = values[column - update.range.startColumnIndex];
        }
      }
      for (const item of sheets.values()) Object.assign(item, next.get(item.sid));
      if (batchFault === 'after') { batchFault = null; throw Error('simulated lost commit response'); }
    } } },
    DriveApp: { Access: { PRIVATE: 'PRIVATE' }, getFolderById(id) { io.drive++; assert.equal(id, 'private-folder'); return folder; }, getFileById(id) { io.drive++; if (!files.has(id)) throw Error('missing'); return files.get(id); } },
    HtmlService: { XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' }, createTemplateFromFile: () => ({ evaluate() { return { setTitle() { return this; }, setXFrameOptionsMode() { return this; } }; } }) }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const call = (name, ...args) => context[name](...args);
  function login(extraClaims = {}) {
    claims = { ...claims, ...extraClaims };
    const prepared = call('authPrepare', channel);
    return call('authLogin', { code: 'only-once-code', state: prepared.state, channel });
  }
  const storedState = () => {
    const result = empty();
    for (const name of tableNames) result[name.toLowerCase()] = sheets.get('HB_' + name).rows.slice(1).filter(row => row[1]).map(row => JSON.parse(row[1]));
    result.revision = JSON.parse(sheets.get('HB_Meta').rows[1][1]).revision;
    return result;
  };
  return { call, login, props, io, cache, sheets, folder, files, context, storedState, setClaims: value => { claims = { ...claims, ...value }; }, setStatus: value => { responseStatus = value; }, setBatchFault: value => { batchFault = value; } };
}

test('anonymous read, write, upload and image cannot touch Sheets or Drive', () => {
  const h = harness();
  for (const operation of ['load', 'mutate', 'uploadReceipt', 'receiptImage']) {
    for (const session of [undefined, 'x', 'a'.repeat(64)]) assert.throws(() => h.call('rpc', { session, operation, payload: {} }), /AUTH_REQUIRED/);
  }
  assert.equal(h.io.sheet, 0); assert.equal(h.io.drive, 0);
});

test('only directly exchanged Google token authenticates, popup redirect uses exact Pages origin', () => {
  const h = harness(); const auth = h.login();
  assert.equal(auth.role, 'editor'); assert.equal(auth.session.length, 64);
  assert.equal(auth.access_token, undefined); assert.equal(auth.refresh_token, undefined);
  const exchange = h.io.exchanges[0];
  assert.equal(exchange.url, 'https://oauth2.googleapis.com/token');
  assert.equal(exchange.request.payload.redirect_uri, 'https://example.github.io');
  assert.equal(exchange.request.payload.client_secret, 'server-secret');
  assert.equal(exchange.request.followRedirects, false); assert.equal(exchange.request.validateHttpsCertificates, true);
  assert.equal(h.io.sheet, 0); assert.equal(h.io.drive, 0);
  assert.equal(h.call('rpc', { session: auth.session, operation: 'load' }).revision, 0);
});

test('audience, issuer, expiry, authorized party, email and verification failures all deny before IO', () => {
  for (const bad of [{ aud: 'other-client' }, { iss: 'https://evil.test' }, { exp: 1 }, { azp: 'other-client' }, { email: 'other@example.test' }, { email_verified: false }]) {
    const h = harness(); assert.throws(() => h.login(bad), /AUTH_FORBIDDEN/); assert.equal(h.io.sheet + h.io.drive, 0);
  }
  const h = harness({ props: { HOUSEHOLD_ALLOWED_EMAIL: '', HOUSEHOLD_ALLOWED_SUB: 'different-sub' } });
  assert.throws(() => h.login(), /AUTH_FORBIDDEN/);
});

test('configured editor emails accept comma-separated and numbered entries, normalize case/spaces', () => {
  const h = harness({ props: { HOUSEHOLD_ALLOWED_EMAIL: '  WIFE@EXAMPLE.TEST  ', HOUSEHOLD_ALLOWED_SUB: 'wife-sub' } });
  assert.equal(h.login({ email: 'Wife@Example.Test' }).role, 'editor');
  assert.throws(() => harness({ props: { HOUSEHOLD_ALLOWED_EMAIL: '', HOUSEHOLD_ALLOWED_SUB: '' } }).login(), /NOT_CONFIGURED/);
  const editors = harness({ props: { HOUSEHOLD_ALLOWED_EMAIL: ' WIFE@EXAMPLE.TEST, Husband@Example.Test, ', HOUSEHOLD_ALLOWED_EMAIL_1: 'additional@example.test', HOUSEHOLD_ALLOWED_EMAIL_2: ' wife@example.test ', HOUSEHOLD_ALLOWED_SUB: 'wife-sub' } });
  assert.equal(editors.login({ email: 'husband@example.test', sub: 'husband-sub' }).role, 'editor');
  assert.equal(editors.login({ email: 'additional@example.test', sub: 'third-sub' }).role, 'editor');
  assert.throws(() => editors.login({ email: 'unknown@example.test' }), /AUTH_FORBIDDEN/);
  assert.throws(() => editors.login({ email: 'husband@example.test', email_verified: false }), /AUTH_FORBIDDEN/);
});

test('login state is channel-bound, expires and is consumed once including failed exchange', () => {
  const h = harness(); const prepared = h.call('authPrepare', channel);
  assert.throws(() => h.call('authLogin', { code: 'code', state: prepared.state, channel: 'b'.repeat(64) }), /AUTH_STATE/);
  assert.equal(h.io.exchanges.length, 0);
  h.call('authLogin', { code: 'code', state: prepared.state, channel });
  assert.throws(() => h.call('authLogin', { code: 'code', state: prepared.state, channel }), /AUTH_STATE/);
  const expired = h.call('authPrepare', channel);
  h.cache.get('login:' + hash(expired.state)).value = JSON.stringify({ channel, expiresAt: 1 });
  assert.throws(() => h.call('authLogin', { code: 'code', state: expired.state, channel }), /AUTH_STATE/);
  const badExchange = h.call('authPrepare', channel); h.setStatus(400);
  assert.throws(() => h.call('authLogin', { code: 'code', state: badExchange.state, channel }), /AUTH_FAILED/);
  h.setStatus(200);
  assert.throws(() => h.call('authLogin', { code: 'code', state: badExchange.state, channel }), /AUTH_STATE/);
});

test('viewer reads but cannot mutate or upload, role changes and logout revoke immediately', () => {
  const h = harness({ props: { HOUSEHOLD_VIEWER_EMAILS: 'husband@example.test' } });
  const auth = h.login({ sub: 'husband-sub', email: 'husband@example.test' });
  assert.equal(auth.role, 'viewer');
  assert.equal(h.call('rpc', { session: auth.session, operation: 'load' }).revision, 0);
  const before = h.io.sheet + h.io.drive;
  for (const operation of ['mutate', 'uploadReceipt']) assert.throws(() => h.call('rpc', { session: auth.session, operation, payload: upload() }), /FORBIDDEN/);
  assert.equal(h.io.sheet + h.io.drive, before);
  h.props.HOUSEHOLD_VIEWER_EMAILS = '';
  assert.throws(() => h.call('rpc', { session: auth.session, operation: 'load' }), /AUTH_REQUIRED/);
  const editor = harness(); const session = editor.login().session;
  editor.call('authLogout', session);
  assert.throws(() => editor.call('rpc', { session, operation: 'load' }), /AUTH_REQUIRED/);
  assert.equal(editor.io.sheet + editor.io.drive, 0);
});

test('session expiry and allowlist changes are checked before every data access', () => {
  const h = harness(); const auth = h.login();
  const key = 'session:' + hash(auth.session);
  const record = JSON.parse(h.cache.get(key).value); record.expiresAt = 1; h.cache.get(key).value = JSON.stringify(record);
  assert.throws(() => h.call('rpc', { session: auth.session, operation: 'load' }), /AUTH_REQUIRED/);
  const second = h.login(); h.props.HOUSEHOLD_ALLOWED_EMAIL = 'replacement@example.test';
  assert.throws(() => h.call('rpc', { session: second.session, operation: 'load' }), /AUTH_REQUIRED/);
  assert.equal(h.io.sheet + h.io.drive, 0);
});

test('private initialization is explicit, only adds owned tables and preserves unrelated content', () => {
  const h = harness({ uninitialized: true }); const auth = h.login();
  assert.throws(() => h.call('rpc', { session: auth.session, operation: 'load' }), /NOT_INITIALIZED/);
  const before = clone(h.sheets.get('シート1').rows);
  h.call('setupHousehold_');
  assert.deepEqual(h.sheets.get('シート1').rows, before);
  assert.equal(h.sheets.size, 11); assert.equal(h.storedState().revision, 0);
  h.call('setupHousehold_'); assert.equal(h.sheets.size, 11);
  h.sheets.get('HB_Expenses').rows = [['unexpected', 'existing data']];
  assert.throws(() => h.call('setupHousehold_'), /STORE_INVALID/);
  assert.deepEqual(h.sheets.get('HB_Expenses').rows, [['unexpected', 'existing data']]);
});

test('only changed normalized rows commit in one atomic batch using literal cell values', () => {
  const h = harness(); const session = h.login().session;
  const payload = { type: 'upsertExpense', operationId: 'save-one', expectedRevision: 0, payload: { label: '=IMPORTDATA("https://evil.test")', amount: 100 } };
  const result = h.call('rpc', { session, operation: 'mutate', payload });
  assert.equal(result.state.revision, 1); assert.equal(h.io.batches.length, 1);
  assert.equal(h.io.batches[0].requests.filter(request => request.updateCells).length, 3);
  assert.equal(h.io.batches[0].requests.filter(request => request.updateCells).reduce((sum, request) => sum + request.updateCells.rows.length * 2, 0), 6);
  assert.equal(h.storedState().expenses[0].label, payload.payload.label);
  assert.deepEqual(h.sheets.get('シート1').rows, [['unrelated', '=SUM(1,2)']]);
  h.call('rpc', { session, operation: 'mutate', payload });
  assert.equal(h.storedState().expenses.length, 1); assert.equal(h.storedState().revision, 1);
  assert.equal(h.io.batches.length, 1);
  assert.equal(h.io.lockTaken, h.io.lockReleased);
});

test('atomic batch rejection changes no table; lost success response retry is idempotent', () => {
  for (const fault of ['before', 'after']) {
    const h = harness({ batchFault: fault }); const session = h.login().session;
    const request = { session, operation: 'mutate', payload: { type: 'upsertExpense', operationId: 'save-one', payload: { amount: 100 } } };
    assert.throws(() => h.call('rpc', request), /SAVE_FAILED/);
    assert.equal(h.storedState().expenses.length, fault === 'before' ? 0 : 1);
    h.call('rpc', request);
    assert.equal(h.storedState().expenses.length, 1); assert.equal(h.storedState().revision, 1);
    assert.equal(h.io.lockTaken, h.io.lockReleased);
  }
});

test('same image upload reuses private file after failed Sheets commit and lost description write', () => {
  for (const options of [{ batchFault: 'before' }, { batchFault: 'after' }, { descriptionFault: true }]) {
    const h = harness(options); const session = h.login().session;
    const request = { session, operation: 'uploadReceipt', payload: upload() };
    assert.throws(() => h.call('rpc', request), /SAVE_FAILED|UPLOAD_FAILED/);
    const result = h.call('rpc', request);
    assert.equal(h.io.create, 1); assert.equal(result.state.receipts.length, 1);
    assert.equal(result.result.imageHash, hash(jpeg)); assert.equal(result.result.status, 'pending');
    assert.equal(result.state.operations.length, 0);
    assert.equal(h.storedState().operations.length, 1);
    const beforeReplay = h.io.batches.length;
    h.call('rpc', request);
    assert.equal(h.io.batches.length, beforeReplay, 'replayed receipt operation does not write Sheets');
    h.call('rpc', { ...request, payload: upload('upload-two') });
    assert.equal(h.io.create, 1); assert.equal(h.storedState().receipts.length, 1);
  }
});

test('outward state omits operation caches while durable server replay result remains intact', () => {
  const h = harness({ domain: realDomain() }); const session = h.login().session;
  const command = { type: 'saveIncome', operationId: 'income-private-cache', payload: { month: '2026-09', amount: 300000 } };
  const changed = h.call('rpc', { session, operation: 'mutate', payload: command });
  const durable = h.storedState();
  assert.equal(changed.state.operations.length, 0); assert.equal(durable.operations.length, 1);
  const loaded = h.call('rpc', { session, operation: 'load' });
  assert.equal(loaded.operations.length, 0); assert.equal(loaded.incomes[0].amount, 300000);
  assert.deepEqual(clone(h.context.HouseholdDomain.summarize(loaded, '2026-09')), clone(h.context.HouseholdDomain.summarize(durable, '2026-09')));
  const beforeReplay = h.io.batches.length;
  const replayed = h.call('rpc', { session, operation: 'mutate', payload: command });
  assert.deepEqual(clone(replayed.result), clone(changed.result));
  assert.equal(replayed.state.operations.length, 0); assert.equal(h.storedState().operations.length, 1);
  assert.equal(h.io.batches.length, beforeReplay);
});

test('delta appends only new rows, grows only full grid and reuses nine-table read snapshot', () => {
  const domain = realDomain();
  const state = clone(domain.emptyState());
  const template = domain.execute(domain.emptyState(), { type: 'upsertExpense', operationId: 'template', payload: { id: 'template', useDate: '2026-09-01', amount: 100, category: '食費', paymentMethod: 'cash', fixed: false } }, { now: '2026-10-05T00:00:00.000Z' }).result;
  for (let index = 0; index < 100; index++) {
    const expense = { ...clone(template), id: 'existing-' + index };
    state.expenses.push(expense);
    state.operations.push({ id: 'old-operation-' + index, operationId: 'old-operation-' + index, type: 'upsertExpense', result: clone(expense), appliedAt: '2026-09-01T12:00:00.000Z', revision: index + 1 });
  }
  state.revision = 100;
  const h = harness({ domain, state }); const session = h.login().session;
  const unchangedExpenses = clone(h.sheets.get('HB_Expenses').rows);
  const unchangedOperations = clone(h.sheets.get('HB_Operations').rows);
  let reads = 0;
  for (const sheet of h.sheets.values()) {
    const original = sheet.getDataRange;
    sheet.getDataRange = function () { reads++; return original.call(this); };
  }
  h.sheets.get('HB_Operations').maxRows = 101;
  const changed = h.call('rpc', { session, operation: 'mutate', payload: { type: 'saveIncome', operationId: 'new-income', payload: { month: '2026-09', amount: 300000 } } });
  assert.equal(reads, 9, 'delta persistence does not re-read tables');
  assert.equal(changed.state.operations.length, 0); assert.equal(h.io.batches.length, 1);
  const requests = h.io.batches[0].requests;
  const appends = requests.filter(request => request.appendDimension);
  assert.equal(appends.length, 1); assert.equal(appends[0].appendDimension.sheetId, h.sheets.get('HB_Operations').sid);
  assert.equal(appends[0].appendDimension.length, 1);
  assert.equal(requests.filter(request => request.updateCells).length, 3);
  assert.equal(requests.filter(request => request.updateCells).reduce((total, request) => total + request.updateCells.rows.length * 2, 0), 6);
  assert.ok(Buffer.byteLength(JSON.stringify(h.io.batches[0])) < 1800, 'batch size depends on new rows, not 100 historical records');
  assert.deepEqual(h.sheets.get('HB_Expenses').rows, unchangedExpenses);
  assert.deepEqual(h.sheets.get('HB_Operations').rows.slice(0, 101), unchangedOperations);
  assert.equal(h.sheets.get('HB_Operations').maxRows, 102);
});

test('unchanged stored JSON formatting survives an unrelated delta save', () => {
  const h = harness({ domain: realDomain() }); const session = h.login().session;
  h.call('rpc', { session, operation: 'mutate', payload: { type: 'saveIncome', operationId: 'income', payload: { month: '2026-09', amount: 1000 } } });
  const income = h.sheets.get('HB_Incomes');
  income.rows[1][1] = JSON.stringify(JSON.parse(income.rows[1][1]), null, 2);
  const originalJson = income.rows[1][1];
  h.call('rpc', { session, operation: 'mutate', payload: { type: 'saveBill', operationId: 'bill', payload: { month: '2026-09', confirmedAmount: 500 } } });
  assert.equal(income.rows[1][1], originalJson);
  const writtenIds = h.io.batches.at(-1).requests.filter(request => request.updateCells).map(request => request.updateCells.range.sheetId);
  assert.ok(!writtenIds.includes(income.sid));
});

test('upload recomputes hash, sniffs MIME, bounds bytes and cannot adopt public storage', () => {
  const h = harness(); const session = h.login().session;
  for (const payload of [{ ...upload(), imageHash: 'b'.repeat(64) }, { ...upload(), mimeType: 'image/png' }, { ...upload(), base64: 'not-base64' }, upload('bad', Buffer.from('<svg onload="steal()"></svg>')), { ...upload(), base64: 'AAAA'.repeat(Math.ceil(8 * 1024 * 1024 / 3) + 1) }]) {
    assert.throws(() => h.call('rpc', { session, operation: 'uploadReceipt', payload }), /INVALID_IMAGE/);
  }
  assert.equal(h.io.drive, 0);
  h.folder.access = 'ANYONE';
  assert.throws(() => h.call('rpc', { session, operation: 'uploadReceipt', payload: upload() }), /STORAGE_NOT_PRIVATE/);
  assert.equal(h.io.create, 0);
});

test('receipt image read is ID-scoped, integrity-checked, private, and available to viewer', () => {
  const h = harness({ props: { HOUSEHOLD_VIEWER_EMAILS: 'husband@example.test' } }); const editor = h.login().session;
  const result = h.call('rpc', { session: editor, operation: 'uploadReceipt', payload: upload() });
  const receipt = result.result;
  const viewer = h.login({ email: 'husband@example.test', sub: 'husband-sub' }).session;
  const image = h.call('rpc', { session: viewer, operation: 'receiptImage', payload: { receiptId: receipt.id } });
  assert.equal(image.dataUrl, 'data:image/jpeg;base64,' + jpeg.toString('base64'));
  assert.throws(() => h.call('rpc', { session: viewer, operation: 'receiptImage', payload: { receiptId: receipt.fileId } }), /IMAGE_NOT_FOUND/);
  const file = h.files.get(receipt.fileId);
  file.access = 'ANYONE';
  assert.throws(() => h.call('rpc', { session: viewer, operation: 'receiptImage', payload: { receiptId: receipt.id } }), /STORAGE_NOT_PRIVATE/);
  file.access = 'PRIVATE'; file.parents = [];
  assert.throws(() => h.call('rpc', { session: viewer, operation: 'receiptImage', payload: { receiptId: receipt.id } }), /IMAGE_NOT_FOUND/);
  file.parents = [h.folder]; file.bytes = Buffer.from([255, 216, 255, 225, 255, 217]);
  assert.throws(() => h.call('rpc', { session: viewer, operation: 'receiptImage', payload: { receiptId: receipt.id } }), /INVALID_IMAGE/);
});

test('client mutation cannot register receipts or replace trusted Drive references', () => {
  const h = harness(); const session = h.login().session;
  assert.throws(() => h.call('rpc', { session, operation: 'mutate', payload: { type: 'registerReceipt' } }), /FORBIDDEN/);
  const uploaded = h.call('rpc', { session, operation: 'uploadReceipt', payload: upload() });
  assert.throws(() => h.call('rpc', { session, operation: 'mutate', payload: { type: 'tamperReceipt', operationId: 'tamper', payload: { fileId: 'arbitrary-private-file' } } }), /FORBIDDEN/);
  assert.equal(h.storedState().receipts[0].fileId, uploaded.result.fileId);
});

test('real shared domain persists expenses, operation rows and receipt metadata with retry and revision conflict', () => {
  const domain = realDomain();
  const h = harness({ domain }); const session = h.login().session;
  const command = { type: 'upsertExpense', operationId: 'real-save-1', expectedRevision: 0, payload: { useDate: '2026-09-01', amount: 1200, category: '食費', paymentMethod: 'cash', description: '夕食', fixed: false } };
  const saved = h.call('rpc', { session, operation: 'mutate', payload: command });
  assert.equal(saved.state.expenses.length, 1); assert.equal(h.storedState().operations[0].operationId, 'real-save-1');
  assert.equal(h.call('rpc', { session, operation: 'load' }).revision, 1);
  h.call('rpc', { session, operation: 'mutate', payload: command });
  assert.equal(h.storedState().revision, 1);
  assert.throws(() => h.call('rpc', { session, operation: 'mutate', payload: { ...command, operationId: 'real-save-2' } }), /CONFLICT:/);
  const image = h.call('rpc', { session, operation: 'uploadReceipt', payload: upload('real-image-1') });
  assert.equal(image.result.fileId, 'file-1'); assert.equal(image.result.status, 'pending');
  h.call('rpc', { session, operation: 'uploadReceipt', payload: upload('real-image-1') });
  assert.equal(h.storedState().receipts.length, 1); assert.equal(h.io.create, 1);
  assert.throws(() => h.call('rpc', { session, operation: 'uploadReceipt', payload: upload('real-save-1') }), /CONFLICT:/);
  assert.equal(h.io.create, 1);
});

test('real domain receipt import and status changes preserve image reference; unsafe inputs have tagged errors', () => {
  const h = harness({ domain: realDomain() }); const session = h.login().session;
  const image = h.call('rpc', { session, operation: 'uploadReceipt', payload: upload() });
  const status = h.call('rpc', { session, operation: 'mutate', payload: { type: 'setReceiptStatus', operationId: 'status-one', payload: { receiptId: image.result.id, status: 'needsReview', reason: '見直し' } } });
  assert.equal(status.result.fileId, image.result.fileId);
  assert.throws(() => h.call('rpc', { session, operation: 'mutate', payload: { type: 'upsertExpense', operationId: 'invalid-one', payload: { amount: -1 } } }), /INVALID_INPUT:/);
  const imported = h.call('rpc', { session, operation: 'mutate', payload: { type: 'importReceipt', operationId: 'import-one', payload: { receiptId: image.result.id, useDate: '2026-09-01', paymentMethod: 'cash', total: 1200, lines: [{ lineId: 'line-1', amount: 1200, category: '食費', description: '食材' }] } } });
  assert.equal(imported.state.expenses.length, 1); assert.equal(imported.result.receipt.fileId, image.result.fileId);
  assert.equal(imported.state.receipts[0].status, 'imported');
});

test('invalid pre-existing domain data is rejected without overwriting tables', () => {
  const h = harness({ domain: realDomain() }); const session = h.login().session;
  h.sheets.get('HB_Expenses').rows.push(['bad-record', JSON.stringify({ id: 'bad-record', amount: -1 })]);
  const before = clone(h.sheets.get('HB_Expenses').rows);
  assert.throws(() => h.call('rpc', { session, operation: 'load' }), /STORE_INVALID/);
  assert.throws(() => h.call('rpc', { session, operation: 'mutate', payload: { type: 'saveIncome', operationId: 'save', payload: { month: '2026-09', amount: 1000 } } }), /STORE_INVALID/);
  assert.equal(h.io.batches.length, 0); assert.deepEqual(h.sheets.get('HB_Expenses').rows, before);
});

test('deleting a real transfer clears the owned table tail without touching other sheets', () => {
  const h = harness({ domain: realDomain() }); const session = h.login().session;
  const mutate = (type, operationId, payload) => h.call('rpc', { session, operation: 'mutate', payload: { type, operationId, payload } });
  const setting = mutate('saveSetting', 'create-saving', { kind: 'saving', name: '旅行', plannedAmount: 100, openingBalance: 0, paymentMethod: 'bank', category: '趣味', active: true, memo: '' }).result;
  const transfer = mutate('saveTransfer', 'deposit', { settingId: setting.id, kind: 'deposit', amount: 100, date: '2026-09-01', memo: '' }).result;
  assert.equal(h.sheets.get('HB_Transfers').getLastRow(), 2);
  mutate('deleteTransfer', 'remove-deposit', { id: transfer.id });
  assert.equal(h.storedState().transfers.length, 0);
  assert.equal(h.sheets.get('HB_Transfers').getLastRow(), 1);
  assert.deepEqual(h.sheets.get('HB_Transfers').rows[1], ['', '']);
  assert.deepEqual(h.sheets.get('シート1').rows, [['unrelated', '=SUM(1,2)']]);
});

test('editor load imports inbox and commits financial rows and C:D statuses together without changing sources', () => {
  const f = receiptInbox();
  const row = f.append('daily-stable-id', f.payload);
  const source = f.inbox.rows[row].slice(0, 2);
  const before = f.h.io.batches.length;
  const loaded = f.load();
  assert.equal(loaded.expenses.length, 2); assert.equal(loaded.receipts[0].purchaseDate, '2026-09-01');
  assert.equal(loaded.operations.length, 0);
  assert.equal(f.inbox.rows[row][2], 'processed'); assert.equal(f.inbox.rows[row][3], '');
  assert.deepEqual(f.inbox.rows[row].slice(0, 2), source);
  assert.equal(f.h.io.batches.length, before + 1);
  const journal = f.h.storedState().operations.find(operation => operation.operationId === 'inbox:daily-stable-id');
  assert.equal(journal.inboxHash.length, 64);
  const batch = f.h.io.batches.at(-1);
  assert.ok(batch.requests.some(request => request.updateCells.range.sheetId === f.h.sheets.get('HB_Expenses').sid));
  const status = batch.requests.find(request => request.updateCells.range.sheetId === f.inbox.sid).updateCells;
  assert.equal(status.range.startColumnIndex, 2); assert.equal(status.range.endColumnIndex, 4);
  assert.equal(status.range.startRowIndex, row);
  assert.deepEqual(f.h.sheets.get('シート1').rows, [['unrelated', '=SUM(1,2)']]);
  const after = f.h.io.batches.length;
  f.load(); assert.equal(f.h.io.batches.length, after, 'completed source row is not reprocessed');
  assert.ok(f.h.io.batchReads.at(-1).ranges.every(range => !/A\d+:B\d+/.test(range)), 'completed raw JSON is not requested again');
});

test('inbox malformed JSON and unknown receipt fail safely; invalid total/date need review without expenses', () => {
  const f = receiptInbox();
  const malformed = f.append('malformed', '{"receiptId":');
  const unknown = f.append('unknown', { ...f.payload, receiptId: 'not-a-known-receipt' });
  const total = f.append('bad-total', { ...f.payload, total: 999 });
  const date = f.append('bad-date', { ...f.payload, useDate: '2026-02-30' });
  const loaded = f.load();
  assert.equal(loaded.expenses.length, 0);
  assert.equal(f.inbox.rows[malformed][2], 'failed'); assert.equal(f.inbox.rows[unknown][2], 'failed');
  assert.equal(f.inbox.rows[total][2], 'needsReview'); assert.match(f.inbox.rows[total][3], /合計/);
  assert.equal(f.inbox.rows[date][2], 'needsReview'); assert.match(f.inbox.rows[date][3], /日/);
  assert.equal(loaded.receipts[0].status, 'needsReview');
  const before = f.h.io.batches.length; f.load(); assert.equal(f.h.io.batches.length, before);
  const corrected = f.append('corrected-new-id', f.payload); f.load();
  assert.equal(f.inbox.rows[corrected][2], 'processed'); assert.equal(f.h.storedState().expenses.length, 2);
});

test('inbox unreadable reviewReason never guesses a date or overwrites imported/deleted manual lines', () => {
  const f = receiptInbox();
  const unreadable = f.append('unreadable-photo', { receiptId: f.receipt.id, reviewReason: '日付が不鮮明です。元画像を確認してください。' });
  let state = f.load();
  assert.equal(state.expenses.length, 0); assert.equal(state.receipts[0].purchaseDate, undefined);
  assert.equal(f.inbox.rows[unreadable][2], 'needsReview'); assert.equal(state.receipts[0].reason, '日付が不鮮明です。元画像を確認してください。');
  f.append('reviewed-extraction', f.payload); state = f.load();
  const expense = state.expenses[0];
  f.h.call('rpc', { session: f.session, operation: 'mutate', payload: { type: 'upsertExpense', operationId: 'manual-fix', payload: { ...clone(expense), amount: 1111, description: '手修正後' } } });
  f.append('repeat-extraction', f.payload); state = f.load();
  assert.equal(state.expenses[0].amount, 1111); assert.equal(state.expenses[0].description, '手修正後');
  f.h.call('rpc', { session: f.session, operation: 'mutate', payload: { type: 'deleteExpense', operationId: 'manual-delete', payload: { id: expense.id } } });
  const lateReview = f.append('late-unreadable', { receiptId: f.receipt.id, reviewReason: '読めません' });
  state = f.load();
  assert.equal(state.expenses[0].deleted, true); assert.equal(state.expenses.length, 2);
  assert.equal(state.receipts[0].status, 'imported'); assert.equal(f.inbox.rows[lateReview][2], 'processed');
});

test('stable inbox ID retries deduplicate; same ID with changed JSON explicitly fails', () => {
  const f = receiptInbox();
  const first = f.append('duplicate-id', f.payload);
  const duplicate = f.append('duplicate-id', JSON.stringify(f.payload, null, 2));
  f.load();
  assert.equal(f.inbox.rows[first][2], 'processed'); assert.equal(f.inbox.rows[duplicate][2], 'processed');
  assert.equal(f.h.storedState().expenses.length, 2);
  assert.equal(f.h.storedState().operations.filter(operation => operation.operationId === 'inbox:duplicate-id').length, 1);
  const beforeRevision = f.h.storedState().revision;
  const different = f.append('duplicate-id', { ...f.payload, total: 1000 }); f.load();
  assert.equal(f.inbox.rows[different][2], 'failed'); assert.match(f.inbox.rows[different][3], /異なる解析/);
  assert.equal(f.h.storedState().revision, beforeRevision);
});

test('inbox financial state and status are all-or-none on batch failure and lost response', () => {
  for (const fault of ['before', 'after']) {
    const f = receiptInbox(); const row = f.append('atomic-inbox', f.payload);
    f.h.setBatchFault(fault);
    assert.throws(() => f.load(), /SAVE_FAILED/);
    assert.equal(f.h.storedState().expenses.length, fault === 'before' ? 0 : 2);
    assert.equal(f.inbox.rows[row][2], fault === 'before' ? '' : 'processed');
    const batches = f.h.io.batches.length;
    f.load();
    assert.equal(f.h.storedState().expenses.length, 2); assert.equal(f.inbox.rows[row][2], 'processed');
    assert.equal(f.h.storedState().operations.filter(operation => operation.operationId === 'inbox:atomic-inbox').length, 1);
    assert.equal(f.h.io.batches.length, batches + (fault === 'before' ? 1 : 0));
  }
});

test('inbox consumes at most20 sources, leaves half-written rows and external new append tail intact', () => {
  const f = receiptInbox();
  const incomplete = f.append('half-written', '');
  f.inbox.rows.push(['', JSON.stringify(f.payload), '', '']);
  for (let index = 0; index < 25; index++) f.append('bounded-' + index, f.payload);
  f.load();
  assert.equal(f.inbox.rows[incomplete][2], ''); assert.equal(f.inbox.rows[2][2], '');
  assert.equal(f.inbox.rows.filter(row => row[2] === 'processed').length, 19);
  assert.ok(f.h.io.batchReads.at(-1).ranges.length <= 20);
  f.load();
  assert.equal(f.inbox.rows.filter(row => row[2] === 'processed').length, 25); assert.equal(f.h.storedState().expenses.length, 2);
  const external = receiptInbox({ onBatchRead(count, sheets) {
    if (count === 1) sheets.get('HB_ReceiptInbox').rows.push(['arrived-after-snapshot', '{}', '', '']);
  } });
  external.append('existing', external.payload); external.load();
  assert.equal(external.inbox.rows.at(-1)[0], 'arrived-after-snapshot'); assert.equal(external.inbox.rows.at(-1)[2], '');
});

test('inbox skip source replaced between snapshots and viewer never consumes pending rows', () => {
  const changed = receiptInbox({ onBatchRead(count, sheets) {
    if (count === 1) sheets.get('HB_ReceiptInbox').rows[1][0] = 'changed-external-id';
  } });
  changed.append('original-id', changed.payload); const before = changed.h.io.batches.length;
  changed.load(); assert.equal(changed.h.io.batches.length, before); assert.equal(changed.inbox.rows[1][2], '');
  const f = receiptInbox({ props: { HOUSEHOLD_VIEWER_EMAILS: 'viewer@example.test' } });
  const row = f.append('viewer-must-not-import', f.payload);
  const session = f.h.login({ sub: 'viewer-sub', email: 'viewer@example.test' }).session;
  const reads = f.h.io.batchReads.length, writes = f.h.io.batches.length;
  const viewed = f.h.call('rpc', { session, operation: 'load' });
  assert.equal(viewed.expenses.length, 0); assert.equal(f.inbox.rows[row][2], '');
  assert.equal(f.h.io.batchReads.length, reads); assert.equal(f.h.io.batches.length, writes);
});

test('oversized or malformed inbox values fail rows without blocking a later valid extraction', () => {
  const f = receiptInbox();
  const oversized = f.append('too-big', ' '.repeat(49001));
  const malformedId = f.append('bad\nidentifier', f.payload);
  const invalidReview = f.append('invalid-review', { receiptId: f.receipt.id, reviewReason: '' });
  const valid = f.append('valid-after-bad', f.payload);
  f.load();
  for (const row of [oversized, malformedId, invalidReview]) assert.equal(f.inbox.rows[row][2], 'failed');
  assert.equal(f.inbox.rows[valid][2], 'processed'); assert.equal(f.h.storedState().expenses.length, 2);
});

test('bridge checks exact top origin and channel, routes narrow methods, hides unknown service errors', () => {
  const html = fs.readFileSync(path.join(__dirname, '../gas/Bridge.html'), 'utf8');
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace('<?!= bridgeConfig ?>', JSON.stringify({ channel, origin: 'https://example.github.io' }));
  const sent = []; const calls = []; let receive; let success; let failure;
  const top = { postMessage(message, origin) { sent.push({ message: clone(message), origin }); } };
  const runner = {
    withSuccessHandler(fn) { success = fn; return this; }, withFailureHandler(fn) { failure = fn; return this; },
    rpc(payload) { calls.push(['rpc', payload]); }, authPrepare(value) { calls.push(['authPrepare', value]); }, authLogin(value) { calls.push(['authLogin', value]); }, authLogout(value) { calls.push(['authLogout', value]); }
  };
  vm.runInNewContext(code, { window: { top, addEventListener(name, fn) { receive = fn; } }, google: { script: { run: runner } } });
  assert.equal(sent[0].message.type, 'household:ready'); assert.equal(sent[0].origin, 'https://example.github.io');
  const data = { type: 'household:request', channel, id: 'request1', method: 'rpc', payload: { operation: 'load', session: 'private' } };
  receive({ origin: 'https://evil.test', source: top, data });
  receive({ origin: 'https://example.github.io', source: {}, data });
  receive({ origin: 'https://example.github.io', source: top, data: { ...data, channel: 'b'.repeat(64) } });
  receive({ origin: 'https://example.github.io', source: top, data: { ...data, method: 'setupHousehold_' } });
  assert.equal(calls.length, 0);
  receive({ origin: 'https://example.github.io', source: top, data });
  receive({ origin: 'https://example.github.io', source: top, data });
  assert.equal(calls.length, 1);
  failure({ message: 'private-sheet secret stack trace' });
  assert.equal(sent.at(-1).message.error.code, 'FAILED'); assert.ok(!JSON.stringify(sent.at(-1)).includes('private-sheet'));
  receive({ origin: 'https://example.github.io', source: top, data: { ...data, id: 'request2', method: 'authLogin', payload: { code: 'code', state: 'state', channel: 'evil' } } });
  assert.equal(calls.at(-1)[1].channel, channel);
  success({ session: 'test-session' }); assert.equal(sent.at(-1).message.ok, true);
});
