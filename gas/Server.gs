/* Private configuration belongs in Script Properties. Nothing runs on load. */
var HOUSEHOLD_TABLES_ = {
  expenses: 'HB_Expenses', settings: 'HB_Settings', plans: 'HB_Plans',
  transfers: 'HB_Transfers', incomes: 'HB_Incomes', bills: 'HB_Bills',
  receipts: 'HB_Receipts', operations: 'HB_Operations'
};
var HOUSEHOLD_META_ = 'HB_Meta';
var HOUSEHOLD_INBOX_ = 'HB_ReceiptInbox';
var HOUSEHOLD_MAX_IMAGE_ = 8 * 1024 * 1024;
var HOUSEHOLD_SESSION_SECONDS_ = 3600;

function doGet(e) {
  var channel = channel_(e && e.parameter && e.parameter.channel);
  var origin = pwaOrigin_();
  var template = HtmlService.createTemplateFromFile('Bridge');
  // A JSON string literal with HTML metacharacters escaped cannot end a script.
  template.bridgeConfig = safeJson_({ channel: channel, origin: origin });
  return template.evaluate().setTitle('家計簿通信')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function authPrepare(channel) {
  channel = channel_(channel);
  authConfig_();
  return locked_(function () {
    var state = randomToken_();
    CacheService.getScriptCache().put('login:' + sha256_(state),
      JSON.stringify({ channel: channel, expiresAt: Date.now() + 120000 }), 120);
    return { state: state };
  });
}

function authLogin(input) {
  object_(input);
  var channel = channel_(input.channel);
  var state = token_(input.state);
  var code = boundedString_(input.code, 4096, 'AUTH_REQUIRED');
  var config = authConfig_();
  // Consume before exchange. A failed exchange needs a fresh challenge/code.
  locked_(function () {
    var cache = CacheService.getScriptCache();
    var key = 'login:' + sha256_(state);
    var raw = cache.get(key);
    if (!raw) fail_('AUTH_STATE', 'ログインを最初からやり直してください。');
    var challenge = parseJson_(raw, 'AUTH_STATE');
    if (challenge.channel !== channel || challenge.expiresAt <= Date.now()) {
      fail_('AUTH_STATE', 'ログインを最初からやり直してください。');
    }
    cache.remove(key);
  });
  var response;
  try {
    response = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
      method: 'post', contentType: 'application/x-www-form-urlencoded',
      payload: { code: code, client_id: config.clientId, client_secret: config.clientSecret,
        grant_type: 'authorization_code', redirect_uri: config.origin },
      // Do not send the secret to a redirected endpoint or expose errors/tokens.
      followRedirects: false, validateHttpsCertificates: true, muteHttpExceptions: true
    });
  } catch (error) { fail_('AUTH_FAILED', 'Googleログインをやり直してください。'); }
  if (response.getResponseCode() !== 200) fail_('AUTH_FAILED', 'Googleログインをやり直してください。');
  var body = parseJson_(response.getContentText(), 'AUTH_FAILED');
  // Only decode a token received HERE directly from Google's HTTPS token endpoint.
  // See Google OpenID Connect: server flow, step 5. Never accept a client JWT.
  var claims = directGoogleClaims_(body.id_token, config);
  var role = accountRole_(claims, config);
  var session = randomToken_();
  var expiresAt = Math.min(Date.now() + HOUSEHOLD_SESSION_SECONDS_ * 1000, claims.exp * 1000);
  CacheService.getScriptCache().put('session:' + sha256_(session),
    JSON.stringify({ sub: claims.sub, email: claims.email, email_verified: claims.email_verified, role: role, expiresAt: expiresAt }),
    Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)));
  return { session: session, expiresAt: expiresAt, role: role };
}

function authLogout(session) {
  token_(session);
  CacheService.getScriptCache().remove('session:' + sha256_(session));
  return { loggedOut: true };
}

function rpc(request) {
  object_(request);
  // This check precedes every Sheets/Drive call, including malformed operations.
  var identity = authenticate_(request.session);
  var allowed = ['sessionInfo', 'load', 'mutate', 'uploadReceipt', 'receiptImage'];
  if (allowed.indexOf(request.operation) < 0) fail_('UNKNOWN_OPERATION', 'この操作には対応していません。');
  // Restore authorization before touching any financial data. Never extend the expiry.
  if (request.operation === 'sessionInfo') return { role: identity.role, expiresAt: identity.expiresAt };
  if (identity.role !== 'editor' && ['mutate', 'uploadReceipt'].indexOf(request.operation) >= 0) {
    fail_('FORBIDDEN', '閲覧アカウントでは変更できません。');
  }
  return locked_(function () {
    var identity = authenticate_(request.session);
    if (identity.role !== 'editor' && ['mutate', 'uploadReceipt'].indexOf(request.operation) >= 0) fail_('FORBIDDEN', '閲覧アカウントでは変更できません。');
    var store = loadStore_();
    if (request.operation === 'load') {
      if (identity.role === 'editor') syncBankFixedExpenses_(store);
      // The financial/inbox transaction must finish before any Drive mutation.
      var state = identity.role === 'editor' ? archiveImportedReceipts_(store, consumeInbox_(store)) : store.state;
      return clientState_(state);
    }
    if (request.operation === 'mutate') {
      object_(request.payload);
      // Drive file IDs and trusted receipt hashes can only enter via image upload.
      if (request.payload.type === 'registerReceipt') fail_('FORBIDDEN', '画像はアップロードから登録してください。');
      var changed = domainExecute_(store.state, request.payload);
      trustedReceiptReferences_(store.state, changed.state);
      persistStore_(store, changed.state);
      return clientChange_(changed);
    }
    if (request.operation === 'uploadReceipt') return uploadReceipt_(store, request.payload);
    return receiptImage_(store.state, request.payload);
  });
}

function clientState_(state) {
  // The durable operation results belong only on the server. The UI needs the
  // real records and revision, but never the duplicate retry ledger payloads.
  return Object.assign({}, state, { operations: [] });
}

function syncBankFixedExpenses_(store) {
  var changed = HouseholdDomain.reconcileBankFixedExpenses(store.state, domainContext_());
  persistStore_(store, changed.state);
  if (changed.changed) {
    // Later inbox processing uses the same locked transaction snapshot, without
    // comparing against pre-catch-up rows or overwriting the new revision.
    store.state = changed.state;
    Object.keys(HOUSEHOLD_TABLES_).forEach(function (key) {
      store.rows[key] = [['id', 'json']].concat(changed.state[key].map(function (row) {
        return [key === 'operations' ? row.operationId : row.id, JSON.stringify(row)];
      }));
    });
    store.rows.meta = [['id', 'json'], ['meta', JSON.stringify({ id: 'meta', schemaVersion: changed.state.schemaVersion, revision: changed.state.revision })]];
  }
  return { created: changed.createdExpenseIds.length, revision: changed.state.revision };
}

// The editor's trigger picker requires a public name. Accept only a native GAS
// enum by identity, never the string "FULL" or a client-serialized enum copy.
// Fail closed if GAS ever changes enums to primitives. Check before any IO.
function processBankFixedExpensesDaily(event) {
  var full = ScriptApp.AuthMode && ScriptApp.AuthMode.FULL;
  if (!event || typeof event !== 'object' || Array.isArray(event) || !full || typeof full !== 'object' ||
      event.authMode !== full || typeof event.triggerUid !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(event.triggerUid) ||
      typeof event.timezone !== 'string' || !event.timezone || event.timezone.length > 200 ||
      !Number.isInteger(event.year) || event.year < 1 || event.year > 9999 ||
      !Number.isInteger(event.month) || event.month < 1 || event.month > 12 ||
      !Number.isInteger(event['day-of-month']) || event['day-of-month'] < 1 || event['day-of-month'] > 31 ||
      !Number.isInteger(event.hour) || event.hour < 0 || event.hour > 23 ||
      !Number.isInteger(event.minute) || event.minute < 0 || event.minute > 59) {
    fail_('FORBIDDEN', 'この処理は所有者の時間トリガー専用です。');
  }
  return processBankFixedExpensesDaily_();
}

// Owner-only editor helper. The underscore keeps direct access off
// google.script.run; both functions are absent from the RPC allowlist.
function processBankFixedExpensesDaily_() {
  return locked_(function () { return syncBankFixedExpenses_(loadStore_()); });
}

function clientChange_(changed) { return { state: clientState_(changed.state), result: changed.result }; }

function authConfig_() {
  var properties = PropertiesService.getScriptProperties();
  var values = properties.getProperties();
  var editorEmails = [];
  Object.keys(values).filter(function (name) { return name === 'HOUSEHOLD_ALLOWED_EMAIL' || /^HOUSEHOLD_ALLOWED_EMAIL_[1-9][0-9]*$/.test(name); }).forEach(function (name) {
    String(values[name]).split(',').map(email_).filter(function (value) { return !!value; }).forEach(function (email) {
      if (editorEmails.indexOf(email) < 0) editorEmails.push(email);
    });
  });
  var config = {
    clientId: properties.getProperty('HOUSEHOLD_OAUTH_CLIENT_ID'),
    clientSecret: properties.getProperty('HOUSEHOLD_OAUTH_CLIENT_SECRET'),
    sub: (properties.getProperty('HOUSEHOLD_ALLOWED_SUB') || '').trim(),
    emails: editorEmails,
    viewers: (properties.getProperty('HOUSEHOLD_VIEWER_EMAILS') || '').split(',').map(email_).filter(function (value) { return !!value; }),
    origin: pwaOrigin_()
  };
  if (!config.clientId || !config.clientSecret || (!config.sub && !config.emails.length)) {
    fail_('NOT_CONFIGURED', '管理者による非公開の認証設定が必要です。');
  }
  if (config.emails.concat(config.viewers).some(function (value) { return !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(value); })) {
    fail_('NOT_CONFIGURED', '許可アカウントの設定形式を確認してください。');
  }
  return config;
}

function pwaOrigin_() {
  var origin = PropertiesService.getScriptProperties().getProperty('HOUSEHOLD_PWA_ORIGIN');
  // Exact origin only: no path, query, fragment, credentials, wildcard or slash.
  if (typeof origin !== 'string' || !/^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/.test(origin)) {
    fail_('NOT_CONFIGURED', 'HTTPSの公開元originを設定してください。');
  }
  return origin;
}

function directGoogleClaims_(idToken, config) {
  if (typeof idToken !== 'string' || idToken.length > 16000) fail_('AUTH_FAILED', 'Googleログインをやり直してください。');
  var parts = idToken.split('.');
  if (parts.length !== 3 || !parts.every(function (part) { return /^[A-Za-z0-9_-]+$/.test(part); })) {
    fail_('AUTH_FAILED', 'Googleログインをやり直してください。');
  }
  var claims;
  try { claims = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[1])).getDataAsString('UTF-8')); }
  catch (error) { fail_('AUTH_FAILED', 'Googleログインをやり直してください。'); }
  if (!claims || claims.aud !== config.clientId ||
      ['accounts.google.com', 'https://accounts.google.com'].indexOf(claims.iss) < 0 ||
      !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= Date.now() ||
      typeof claims.sub !== 'string' || !claims.sub ||
      (claims.azp && claims.azp !== config.clientId)) {
    fail_('AUTH_FORBIDDEN', 'このGoogleアカウントでは利用できません。');
  }
  return claims;
}

function email_(value) { return String(value).trim().toLowerCase(); }

function accountRole_(claims, config) {
  var email = email_(claims.email || '');
  var verified = claims.email_verified === true;
  // Email lists are primary. Legacy sub-only configuration remains supported;
  // adding more editors must not accidentally restrict all of them to one sub.
  if (config.emails.length ? (verified && config.emails.indexOf(email) >= 0) : (config.sub && claims.sub === config.sub)) return 'editor';
  if (verified && email && config.viewers.indexOf(email) >= 0) return 'viewer';
  fail_('AUTH_FORBIDDEN', 'このGoogleアカウントでは利用できません。');
}

function authenticate_(session) {
  session = token_(session);
  var raw = CacheService.getScriptCache().get('session:' + sha256_(session));
  if (!raw) fail_('AUTH_REQUIRED', 'Googleログインが必要です。');
  var record = parseJson_(raw, 'AUTH_REQUIRED');
  if (!Number.isSafeInteger(record.expiresAt) || record.expiresAt <= Date.now()) {
    fail_('AUTH_REQUIRED', 'Googleログインが必要です。');
  }
  var role;
  try { role = accountRole_(record, authConfig_()); }
  catch (error) { fail_('AUTH_REQUIRED', 'Googleログインが必要です。'); }
  // Promotion needs a new login; demotion/revocation applies immediately.
  record.role = role === 'editor' && record.role === 'editor' ? 'editor' : 'viewer';
  return record;
}

function configuredId_(name) {
  var value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) fail_('NOT_CONFIGURED', '管理者による非公開の保存先設定が必要です。');
  return value;
}

function trustedReceiptReferences_(before, after) {
  after.receipts.forEach(function (receipt) {
    var original = before.receipts.find(function (item) { return item.id === receipt.id; });
    if (!original || ['fileId', 'imageHash', 'mimeType'].some(function (key) { return original[key] !== receipt[key]; })) {
      fail_('FORBIDDEN', '画像の参照情報はアップロードから登録してください。');
    }
  });
}

function loadStore_() {
  var id = configuredId_('HOUSEHOLD_SPREADSHEET_ID');
  var book = SpreadsheetApp.openById(id);
  var state = HouseholdDomain.emptyState();
  var sheets = {};
  var rows = {};
  Object.keys(HOUSEHOLD_TABLES_).concat(['meta']).forEach(function (key) {
    var name = key === 'meta' ? HOUSEHOLD_META_ : HOUSEHOLD_TABLES_[key];
    var sheet = book.getSheetByName(name);
    if (!sheet) fail_('NOT_INITIALIZED', '管理者による家計簿テーブルの初期化が必要です。');
    var values = sheet.getDataRange().getValues();
    tableHeader_(values);
    var snapshot = values.map(function (row) { return [row[0] || '', row[1] || '']; });
    var seen = Object.create(null);
    var records = values.slice(1).map(function (row, index) {
      if (row.every(function (cell) { return cell === ''; })) return null;
      if (typeof row[0] !== 'string' || !row[0] || typeof row[1] !== 'string' || row.slice(2).some(function (v) { return v !== ''; })) {
        fail_('STORE_INVALID', '家計簿テーブルの形式を確認してください。');
      }
      var record = parseJson_(row[1], 'STORE_INVALID');
      if (!record || typeof record !== 'object' || Array.isArray(record) || (key === 'operations' ? record.operationId : record.id) !== row[0] || seen[row[0]]) {
        fail_('STORE_INVALID', '家計簿テーブルのIDを確認してください。');
      }
      seen[row[0]] = true;
      // Compare parsed record content, so harmless JSON whitespace is preserved
      // when a different row changes. Reuse this snapshot; do not read again.
      snapshot[index + 1] = [row[0], JSON.stringify(record)];
      return record;
    }).filter(function (record) { return record !== null; });
    if (key === 'meta') {
      if (records.length !== 1 || records[0].id !== 'meta' || records[0].schemaVersion !== 1 ||
          !Number.isSafeInteger(records[0].revision) || records[0].revision < 0) {
        fail_('STORE_INVALID', '家計簿のバージョン情報を確認してください。');
      }
      state.schemaVersion = records[0].schemaVersion;
      state.revision = records[0].revision;
    } else state[key] = records;
    sheets[key] = sheet;
    rows[key] = snapshot;
  });
  // Shared validation covers monetary, link and operation invariants as well as
  // table syntax. Never return or overwrite an invalid pre-existing household.
  try { HouseholdDomain.summarize(state, new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7)); }
  catch (error) { fail_('STORE_INVALID', '家計簿の記録の整合性を管理者が確認してください。'); }
  return { id: id, book: book, state: state, sheets: sheets, rows: rows };
}

function tableHeader_(values) {
  if (!values.length || values[0][0] !== 'id' || values[0][1] !== 'json' ||
      values[0].slice(2).some(function (value) { return value !== ''; })) {
    fail_('STORE_INVALID', '家計簿テーブルの見出しを確認してください。');
  }
}

function persistStore_(store, state, extraRequests) {
  if (!state || state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0) {
    fail_('STORE_INVALID', '家計簿の保存形式が不正です。');
  }
  // Replayed operations return the already committed state. Do not re-write it.
  if (state.revision === store.state.revision && (!extraRequests || !extraRequests.length)) return;
  var requests = [];
  Object.keys(HOUSEHOLD_TABLES_).concat(['meta']).forEach(function (key) {
    var records = key === 'meta' ? [{ id: 'meta', schemaVersion: state.schemaVersion, revision: state.revision }] : state[key];
    if (!Array.isArray(records) || records.length > 20000) fail_('STORE_LIMIT', '家計簿テーブルの容量を確認してください。');
    var sheet = store.sheets[key];
    var ids = Object.create(null);
    var rows = [['id', 'json']];
    records.forEach(function (record) {
      var recordId = record && (key === 'operations' ? record.operationId : record.id);
      if (!record || typeof recordId !== 'string' || !recordId || recordId.length > 200 || ids[recordId]) {
        fail_('STORE_INVALID', '家計簿テーブルのIDが不正です。');
      }
      ids[recordId] = true;
      var json = JSON.stringify(record);
      if (json.length > 49000) fail_('STORE_LIMIT', '1件の保存内容が大きすぎます。');
      rows.push([recordId, json]);
    });
    var before = store.rows[key];
    var groups = [];
    var group = null;
    for (var index = 0; index < Math.max(rows.length, before.length); index++) {
      var oldRow = before[index] || ['', ''];
      var newRow = rows[index] || ['', ''];
      if (oldRow[0] === newRow[0] && oldRow[1] === newRow[1]) { group = null; continue; }
      if (!group) { group = { start: index, rows: [] }; groups.push(group); }
      // Omitted userEnteredValue clears a removed tail. Only A:B values change;
      // cell formatting, notes and every unrelated table are preserved.
      group.rows.push(index < rows.length ? {
        values: newRow.map(function (value) { return { userEnteredValue: { stringValue: value } }; })
      } : { values: [] });
    }
    if (!groups.length) return;
    var sheetId = sheet.getSheetId();
    var maxRows = sheet.getMaxRows();
    if (rows.length > maxRows) requests.push({ appendDimension: { sheetId: sheetId, dimension: 'ROWS', length: rows.length - maxRows } });
    groups.forEach(function (group) {
      requests.push({ updateCells: {
        range: { sheetId: sheetId, startRowIndex: group.start, endRowIndex: group.start + group.rows.length, startColumnIndex: 0, endColumnIndex: 2 },
        rows: group.rows, fields: 'userEnteredValue'
      } });
    });
  });
  if (extraRequests && extraRequests.length) requests = requests.concat(extraRequests);
  // Google Sheets batchUpdate validates all requests and applies them atomically.
  try { if (requests.length) Sheets.Spreadsheets.batchUpdate({ requests: requests }, store.id); }
  catch (error) { fail_('SAVE_FAILED', '保存を確認できませんでした。再読み込み後、同じ操作を再試行してください。'); }
}

function inboxHeader_(values) {
  var header = values && values[0];
  if (!header || ['id', 'json', 'status', 'error'].some(function (name, index) { return header[index] !== name; }) ||
      header.slice(4).some(function (value) { return value !== ''; })) {
    fail_('STORE_INVALID', 'レシート受信表の見出しを管理者が確認してください。');
  }
}

// Owner editor helper: reconcile receipt results without running other monthly
// automation. The underscore excludes it from google.script.run and RPC.
function processReceiptInbox_() {
  return locked_(function () {
    var store = loadStore_();
    var state = archiveImportedReceipts_(store, consumeInbox_(store));
    return { revision: state.revision };
  });
}

function consumeInbox_(store) {
  var sheet = store.book.getSheetByName(HOUSEHOLD_INBOX_);
  if (!sheet) fail_('NOT_INITIALIZED', '管理者によるレシート受信表の初期化が必要です。');
  // Do not download completed extraction JSON on each load. First read only IDs
  // and statuses; then fetch at most 20 pending source rows in one batch request.
  var metadata = Sheets.Spreadsheets.Values.batchGet(store.id, {
    ranges: [HOUSEHOLD_INBOX_ + '!A1:D1', HOUSEHOLD_INBOX_ + '!A2:A', HOUSEHOLD_INBOX_ + '!C2:C'],
    valueRenderOption: 'UNFORMATTED_VALUE'
  }).valueRanges;
  if (!metadata || metadata.length !== 3) fail_('STORE_INVALID', 'レシート受信表を確認できませんでした。');
  inboxHeader_(metadata[0].values || []);
  var ids = metadata[1].values || [];
  var statuses = metadata[2].values || [];
  var candidates = [];
  for (var index = 0; index < ids.length && candidates.length < 20; index++) {
    var id = ids[index] && ids[index][0];
    var status = statuses[index] && statuses[index][0];
    // A half-written row is left pending. Failed/review rows require a corrected
    // NEW stable source ID; they are not retried on every app opening.
    if (id !== undefined && id !== '' && (!status || status === 'pending')) candidates.push({ row: index + 2, id: id });
  }
  if (!candidates.length) return store.state;
  var sources = Sheets.Spreadsheets.Values.batchGet(store.id, {
    ranges: candidates.map(function (candidate) { return HOUSEHOLD_INBOX_ + '!A' + candidate.row + ':B' + candidate.row; }),
    valueRenderOption: 'UNFORMATTED_VALUE'
  }).valueRanges;
  if (!sources || sources.length !== candidates.length) fail_('STORE_INVALID', 'レシート受信内容を確認できませんでした。');
  var current = store.state;
  var requests = [];
  var sheetId = sheet.getSheetId();
  candidates.forEach(function (candidate, index) {
    var row = sources[index].values && sources[index].values[0];
    // The external writer is append-only and does not hold the GAS lock. Never
    // mark a row whose source changed between our two snapshots, or is partial.
    if (!row || row[0] !== candidate.id || row[1] === undefined || row[1] === '') return;
    var status = 'failed';
    var reason = '解析JSONの形式を確認し、修正した内容を新しいIDで追記してください。';
    try {
      if (typeof row[0] !== 'string' || !row[0].trim() || row[0].length > 190 || /[\u0000-\u001f\u007f]/.test(row[0]) ||
          typeof row[1] !== 'string' || row[1].length > 49000) throw new Error('INBOX_FORMAT');
      var payload = JSON.parse(row[1]);
      object_(payload);
      var operationId = 'inbox:' + row[0];
      var sourceHash = sha256_(JSON.stringify(payload));
      var previous = current.operations.find(function (operation) { return operation.operationId === operationId; });
      if (previous && previous.inboxHash !== sourceHash) {
        reason = '同じIDで異なる解析結果は取り込めません。新しいIDで追記してください。';
        throw new Error('INBOX_CONFLICT');
      }
      var receipt = current.receipts.find(function (item) { return item.id === payload.receiptId; });
      if (!receipt) {
        reason = '対象レシートが見つかりません。アプリのレシートIDを確認してください。';
        throw new Error('INBOX_RECEIPT');
      }
      if (previous) {
        // An inbox row is a history of this extraction, not the receipt's
        // current state. A reset C cell must not replay an old review result or
        // mark it processed after the receipt was reset or a correction imported.
        var savedReceipt = previous.type === 'setReceiptStatus' ? previous.result : previous.result && previous.result.receipt;
        if (!savedReceipt || savedReceipt.id !== receipt.id) throw new Error('INBOX_CONFLICT');
        status = savedReceipt.expenseIds.length ? 'processed' : (savedReceipt.status === 'needsReview' ? 'needsReview' : 'processed');
        reason = status === 'needsReview' ? savedReceipt.reason || '' : '';
      } else {
        var command = { type: 'importReceipt', operationId: operationId, payload: payload };
        if (payload.reviewReason !== undefined && !receipt.expenseIds.length) {
          if (typeof payload.reviewReason !== 'string' || !payload.reviewReason.trim() || payload.reviewReason.length > 1000) throw new Error('INBOX_FORMAT');
          command.type = 'setReceiptStatus';
          command.payload = { receiptId: receipt.id, status: 'needsReview', reason: payload.reviewReason };
        }
        var changed = domainExecute_(current, command);
        var journal = changed.state.operations.find(function (operation) { return operation.operationId === operationId; });
        journal.inboxHash = sourceHash;
        // A row must fit the existing single-cell operation journal before joining
        // this atomic group. An oversized extraction cannot block other valid rows.
        if (JSON.stringify(journal).length > 49000) {
          reason = '解析結果が大きすぎます。分類ごとにまとめて短くした解析結果を、新しいIDで追記してください。';
          throw new Error('INBOX_LIMIT');
        }
        trustedReceiptReferences_(current, changed.state);
        current = changed.state;
        var updated = current.receipts.find(function (item) { return item.id === receipt.id; });
        status = updated.expenseIds.length ? 'processed' : (updated.status === 'needsReview' ? 'needsReview' : 'processed');
        reason = status === 'needsReview' ? updated.reason : '';
      }
    } catch (error) {
      // Expected bad rows are recorded, while unrelated service/program errors
      // remain failures of the complete request instead of silently discarding it.
      var message = String(error && error.message || '');
      if (!/^INBOX_/.test(message) && !/^(?:INVALID_INPUT|NOT_FOUND|CONFLICT|INSUFFICIENT_BALANCE):/.test(message) && !(error instanceof SyntaxError)) throw error;
    }
    requests.push({ updateCells: {
      range: { sheetId: sheetId, startRowIndex: candidate.row - 1, endRowIndex: candidate.row, startColumnIndex: 2, endColumnIndex: 4 },
      rows: [{ values: [{ userEnteredValue: { stringValue: status } }, { userEnteredValue: { stringValue: reason } }] }],
      fields: 'userEnteredValue'
    } });
  });
  persistStore_(store, current, requests);
  if (requests.length || current.revision !== store.state.revision) {
    // persistStore_ writes compact rows after a successful inbox transaction.
    store.archiveReceiptRows = [['id', 'json']].concat(current.receipts.map(function (receipt) { return [receipt.id, JSON.stringify(receipt)]; }));
    store.archiveMetaRows = [['id', 'json'], ['meta', JSON.stringify({ id: 'meta', schemaVersion: current.schemaVersion, revision: current.revision })]];
  }
  return current;
}

function archiveImportedReceipts_(store, state) {
  var archiveId = PropertiesService.getScriptProperties().getProperty('HOUSEHOLD_RECEIPT_ARCHIVE_FOLDER_ID');
  // Backward compatibility: an unset optional destination performs no Drive IO.
  if (!archiveId) return state;
  var imported = Object.create(null);
  state.operations.forEach(function (operation) {
    var result = operation.result;
    if (operation.type === 'importReceipt' && /^inbox:/.test(operation.operationId) &&
        /^[a-f0-9]{64}$/.test(operation.inboxHash || '') && result && result.receipt && !result.needsReview) {
      imported[result.receipt.id] = true;
    }
  });
  var candidates = state.receipts.filter(function (receipt) {
    return imported[receipt.id] && receipt.status === 'imported' && receipt.expenseIds.length && receipt.archiveStatus !== 'archived';
  });
  // New imports are not held behind a backlog of repeatedly failing moves.
  var attempt = function (receipt) { return Number.isSafeInteger(receipt.archiveAttempt) && receipt.archiveAttempt >= 0 && receipt.archiveAttempt <= state.revision ? receipt.archiveAttempt : 0; };
  candidates.sort(function (a, b) { return Number(a.archiveStatus === 'failed') - Number(b.archiveStatus === 'failed') || attempt(a) - attempt(b); });
  candidates = candidates.slice(0, 20);
  if (!candidates.length) return state;
  var next = JSON.parse(JSON.stringify(state));
  var touched = [];
  candidates.forEach(function (candidate) {
    var receipt = next.receipts.find(function (item) { return item.id === candidate.id; });
    var status = 'archived', reason = '';
    try { archiveReceiptFile_(receipt, archiveId); }
    catch (error) {
      // Neither Drive responses nor exception strings may reveal IDs or tokens.
      status = 'failed'; reason = '処理済フォルダへの移動を確認できませんでした。次の読み込みで再試行します。';
    }
    if (receipt.archiveStatus !== status || (receipt.archiveError || '') !== reason || receipt.archiveAttempt !== state.revision + 1) {
      receipt.archiveStatus = status;
      receipt.archiveError = reason;
      receipt.archiveAttempt = state.revision + 1;
      touched.push(receipt);
    }
  });
  if (!touched.length) return state;
  // If no inbox batch ran, physical rows may contain gaps. Update only the
  // matching receipt JSON cells and metadata, never compact unrelated tables.
  var receiptRows = store.archiveReceiptRows || store.rows.receipts;
  var metaRows = store.archiveMetaRows || store.rows.meta;
  next.revision++;
  try {
    var requests = touched.map(function (receipt) {
      var row = receiptRows.findIndex(function (values) { return values[0] === receipt.id; });
      if (row < 1) fail_('SAVE_FAILED', '画像の移動状態を保存できませんでした。');
      return { updateCells: { range: { sheetId: store.sheets.receipts.getSheetId(), startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 1, endColumnIndex: 2 },
        rows: [{ values: [{ userEnteredValue: { stringValue: JSON.stringify(receipt) } }] }], fields: 'userEnteredValue' } };
    });
    var metaRow = metaRows.findIndex(function (values) { return values[0] === 'meta'; });
    if (metaRow < 1) fail_('SAVE_FAILED', '画像の移動状態を保存できませんでした。');
    requests.push({ updateCells: { range: { sheetId: store.sheets.meta.getSheetId(), startRowIndex: metaRow, endRowIndex: metaRow + 1, startColumnIndex: 1, endColumnIndex: 2 },
      rows: [{ values: [{ userEnteredValue: { stringValue: JSON.stringify({ id: 'meta', schemaVersion: state.schemaVersion, revision: next.revision }) } }] }], fields: 'userEnteredValue' } });
    Sheets.Spreadsheets.batchUpdate({ requests: requests }, store.id);
  }
  catch (error) {
    // Ledger reads still succeed. The next load discovers actual parents even
    // if the move, or its status write, succeeded with a lost response.
    next.revision = state.revision;
    touched.forEach(function (receipt) {
      receipt.archiveStatus = 'failed';
      receipt.archiveError = '移動状態を保存できませんでした。次の読み込みで確認します。';
    });
  }
  return next;
}

function archiveReceiptFile_(receipt, archiveId) {
  var folder = receiptFolder_();
  if (archiveId === folder.getId()) fail_('ARCHIVE_FAILED', '処理済フォルダの設定を確認してください。');
  var archive = DriveApp.getFolderById(archiveId);
  privateItem_(archive);
  if (archive.isTrashed()) fail_('ARCHIVE_FAILED', '処理済フォルダを確認してください。');
  var file = receiptFile_(receipt, folder);
  var iterator = file.getParents(), parents = [];
  while (iterator.hasNext()) parents.push(iterator.next().getId());
  var inPool = parents.indexOf(folder.getId()) >= 0;
  var inArchive = parents.indexOf(archiveId) >= 0;
  if (inArchive && !inPool) return;
  if (!inPool) fail_('ARCHIVE_FAILED', '画像の保存先を確認してください。');
  // Only Pool is removed; other parents, content, name and permissions remain.
  // DriveApp.moveTo would remove every parent and is deliberately not used.
  var url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(receipt.fileId) +
    '?removeParents=' + encodeURIComponent(folder.getId()) + '&fields=id%2Cparents';
  if (!inArchive) url += '&addParents=' + encodeURIComponent(archiveId);
  var response = UrlFetchApp.fetch(url, {
    method: 'patch', headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    contentType: 'application/json', payload: '{}', muteHttpExceptions: true,
    followRedirects: false, validateHttpsCertificates: true
  });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) fail_('ARCHIVE_FAILED', '画像の移動を確認してください。');
  var result = parseJson_(response.getContentText(), 'ARCHIVE_FAILED');
  if (!result || result.id !== receipt.fileId || !Array.isArray(result.parents) || result.parents.indexOf(archiveId) < 0 ||
      result.parents.indexOf(folder.getId()) >= 0 || parents.some(function (id) { return id !== folder.getId() && result.parents.indexOf(id) < 0; })) {
    fail_('ARCHIVE_FAILED', '画像の移動を確認してください。');
  }
}

function uploadReceipt_(store, input) {
  object_(input);
  boundedString_(input.operationId, 200, 'INVALID_INPUT');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.operationId)) fail_('INVALID_INPUT', '操作番号が不正です。');
  if (typeof input.imageHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.imageHash)) fail_('INVALID_IMAGE', '画像の識別情報が不正です。');
  var validated = imageInput_(input);
  if (validated.hash !== input.imageHash) fail_('INVALID_IMAGE', '画像の内容と識別情報が一致しません。');
  var previous = store.state.operations.find(function (operation) { return operation.operationId === input.operationId; });
  if (previous && (previous.type !== 'registerReceipt' || !previous.result || previous.result.imageHash !== validated.hash)) {
    fail_('CONFLICT', 'この操作番号は別の保存に使用されています。');
  }
  var receipt = store.state.receipts.find(function (item) { return item.imageHash === validated.hash; });
  var folder = receiptFolder_();
  var file;
  if (receipt) {
    file = receiptFile_(receipt, folder);
    var savedBytes = file.getBlob().getBytes();
    if (savedBytes.length > HOUSEHOLD_MAX_IMAGE_ || sha256Bytes_(savedBytes) !== validated.hash || file.getMimeType() !== input.mimeType) {
      fail_('INVALID_IMAGE', '保存画像の内容が登録時と一致しません。');
    }
  } else {
    // The hash-bearing name is committed as part of createFile itself. If Drive
    // creation succeeds but Sheets fails (or its response is lost), a retry finds
    // that exact private file, re-hashes the bytes, and reuses it. No orphan delete.
    var name = 'hb-receipt-' + validated.hash + '.' + validated.extension;
    var files = folder.getFilesByName(name);
    while (files.hasNext()) {
      var candidate = files.next();
      if (candidate.isTrashed()) continue;
      privateItem_(candidate);
      var bytes = candidate.getBlob().getBytes();
      if (bytes.length <= HOUSEHOLD_MAX_IMAGE_ && sha256Bytes_(bytes) === validated.hash && candidate.getMimeType() === input.mimeType) {
        file = candidate;
        break;
      }
    }
    if (!file) {
      try { file = folder.createFile(Utilities.newBlob(validated.bytes, input.mimeType, name)); }
      catch (error) { fail_('UPLOAD_FAILED', '画像保存を確認できませんでした。同じ画像で再試行してください。'); }
      // Verify privacy before attaching it to the household state.
      privateItem_(file);
      try { file.setDescription('household:receipt:v1:' + validated.hash); }
      catch (error) { fail_('UPLOAD_FAILED', '画像の確認情報を保存できませんでした。同じ画像で再試行してください。'); }
    }
  }
  var changed = domainExecute_(store.state, {
    type: 'registerReceipt', operationId: input.operationId,
    payload: { imageHash: validated.hash, fileId: file.getId(), mimeType: input.mimeType,
      fileName: validated.fileName, status: 'pending' }
  });
  persistStore_(store, changed.state);
  return clientChange_(changed);
}

function imageInput_(input) {
  if (['image/jpeg', 'image/png', 'image/webp'].indexOf(input.mimeType) < 0 ||
      typeof input.base64 !== 'string' || !input.base64.length ||
      input.base64.length > Math.ceil(HOUSEHOLD_MAX_IMAGE_ / 3) * 4 ||
      !validImageBase64_(input.base64)) {
    fail_('INVALID_IMAGE', '8MB以下のJPEG・PNG・WebP画像を選んでください。');
  }
  var bytes;
  try { bytes = Utilities.base64Decode(input.base64); }
  catch (error) { fail_('INVALID_IMAGE', '画像を読み取れませんでした。'); }
  if (!bytes.length || bytes.length > HOUSEHOLD_MAX_IMAGE_) fail_('INVALID_IMAGE', '画像が大きすぎます。');
  var actualMime = sniffImage_(bytes);
  if (actualMime !== input.mimeType) fail_('INVALID_IMAGE', '画像形式がファイル内容と一致しません。');
  var fileName = boundedString_(input.fileName, 160, 'INVALID_IMAGE').replace(/[\x00-\x1f\x7f/\\]/g, '_');
  return { bytes: bytes, hash: sha256Bytes_(bytes), fileName: fileName,
    extension: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[actualMime] };
}

function validImageBase64_(value) {
  if (value.length % 4 !== 0) return false;
  var padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  // Repeated four-character regexp groups overflow V8's stack on phone-sized
  // photos. Scan for invalid characters once, allowing padding only at the end.
  return !/[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding));
}

function sniffImage_(bytes) {
  function byte(i) { return bytes[i] & 255; }
  if (bytes.length >= 4 && byte(0) === 255 && byte(1) === 216 && byte(2) === 255) {
    // A JPEG can retain metadata or motion-photo data after its end marker.
    // Keep the original bytes, but still reject inputs with no end marker.
    for (var i = 3; i < bytes.length - 1; i++) {
      if (byte(i) === 255 && byte(i + 1) === 217) return 'image/jpeg';
    }
  }
  if (bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every(function (v, i) { return byte(i) === v; }) &&
      [73, 72, 68, 82].every(function (v, i) { return byte(12 + i) === v; })) return 'image/png';
  if (bytes.length >= 16 && [82, 73, 70, 70].every(function (v, i) { return byte(i) === v; }) &&
      [87, 69, 66, 80].every(function (v, i) { return byte(8 + i) === v; })) return 'image/webp';
  fail_('INVALID_IMAGE', '対応する画像形式を確認できませんでした。');
}

function receiptFolder_() {
  var folder = DriveApp.getFolderById(configuredId_('HOUSEHOLD_RECEIPT_FOLDER_ID'));
  privateItem_(folder);
  return folder;
}

function privateItem_(item) {
  if (item.getSharingAccess() !== DriveApp.Access.PRIVATE || item.getEditors().length || item.getViewers().length) {
    fail_('STORAGE_NOT_PRIVATE', 'レシート保存先の共有設定を管理者が確認してください。');
  }
}

function receiptFile_(receipt, folder) {
  if (!receipt || typeof receipt.fileId !== 'string' || !receipt.fileId) fail_('IMAGE_NOT_FOUND', '画像が見つかりません。');
  var file;
  try { file = DriveApp.getFileById(receipt.fileId); }
  catch (error) { fail_('IMAGE_NOT_FOUND', '画像が見つかりません。'); }
  if (file.isTrashed()) fail_('IMAGE_NOT_FOUND', '画像が見つかりません。');
  privateItem_(file);
  var parents = file.getParents();
  var inFolder = false;
  var archiveId = PropertiesService.getScriptProperties().getProperty('HOUSEHOLD_RECEIPT_ARCHIVE_FOLDER_ID');
  var inArchive = false;
  while (parents.hasNext()) {
    var parentId = parents.next().getId();
    if (parentId === folder.getId()) inFolder = true;
    if (archiveId && parentId === archiveId) inArchive = true;
  }
  if (!inFolder && inArchive) {
    // The existing fileId remains authoritative after an archive move. Only
    // the explicitly configured private archive is allowed alongside Pool.
    privateItem_(DriveApp.getFolderById(archiveId));
    inFolder = true;
  }
  if (!inFolder) fail_('IMAGE_NOT_FOUND', '画像の保存先が一致しません。');
  return file;
}

function receiptImage_(state, input) {
  object_(input);
  var id = boundedString_(input.receiptId, 200, 'INVALID_INPUT');
  var receipt = state.receipts.find(function (item) { return item.id === id; });
  if (!receipt) fail_('IMAGE_NOT_FOUND', '画像が見つかりません。');
  var file = receiptFile_(receipt, receiptFolder_());
  var bytes = file.getBlob().getBytes();
  if (bytes.length > HOUSEHOLD_MAX_IMAGE_ || sha256Bytes_(bytes) !== receipt.imageHash || sniffImage_(bytes) !== receipt.mimeType || file.getMimeType() !== receipt.mimeType) {
    fail_('INVALID_IMAGE', '保存画像の内容が登録時と一致しません。');
  }
  return { dataUrl: 'data:' + receipt.mimeType + ';base64,' + Utilities.base64Encode(bytes),
    mimeType: receipt.mimeType, fileName: receipt.fileName };
}

// MANUAL EDITOR ONLY. The trailing underscore keeps setup off google.script.run.
// Adds only absent/empty owned tabs. Never replaces unrelated sheets or data.
function setupHousehold_() {
  return locked_(function () {
    var book = SpreadsheetApp.openById(configuredId_('HOUSEHOLD_SPREADSHEET_ID'));
    var names = Object.keys(HOUSEHOLD_TABLES_).map(function (key) { return HOUSEHOLD_TABLES_[key]; }).concat([HOUSEHOLD_META_]);
    // Check every existing owned tab before adding or initializing anything.
    names.forEach(function (name) {
      var sheet = book.getSheetByName(name);
      if (sheet && sheet.getLastRow() > 0) tableHeader_(sheet.getDataRange().getValues());
    });
    var inbox = book.getSheetByName(HOUSEHOLD_INBOX_);
    if (inbox && inbox.getLastRow() > 0) inboxHeader_(inbox.getDataRange().getValues());
    names.forEach(function (name) {
      var sheet = book.getSheetByName(name) || book.insertSheet(name);
      if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, 2).setValues([['id', 'json']]);
      if (name === HOUSEHOLD_META_ && sheet.getLastRow() === 1) {
        // A header-only meta table is valid only for a wholly empty household.
        var nonempty = Object.keys(HOUSEHOLD_TABLES_).some(function (key) { return book.getSheetByName(HOUSEHOLD_TABLES_[key]).getLastRow() > 1; });
        if (nonempty) fail_('STORE_INVALID', '記録があるため初期バージョンを自動設定できません。');
        sheet.getRange(2, 1, 1, 2).setValues([['meta', JSON.stringify({ id: 'meta', schemaVersion: 1, revision: 0 })]]);
      }
    });
    inbox = inbox || book.insertSheet(HOUSEHOLD_INBOX_);
    if (inbox.getLastRow() === 0) inbox.getRange(1, 1, 1, 4).setValues([['id', 'json', 'status', 'error']]);
    SpreadsheetApp.flush();
    loadStore_();
    return { initialized: true };
  });
}

function locked_(callback) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) fail_('BUSY', '別の保存が処理中です。少し待って再試行してください。');
  try { return callback(); } finally { lock.releaseLock(); }
}

function domainContext_() { return { uuid: function () { return Utilities.getUuid(); }, now: function () { return new Date().toISOString(); } }; }
function domainExecute_(state, command) {
  try { return HouseholdDomain.execute(state, command, domainContext_()); }
  catch (error) {
    var messages = {
      INVALID_INPUT: '入力内容を確認してください。', CONFLICT: '別の保存が反映されています。再読み込み後にやり直してください。',
      REVISION_CONFLICT: '別の保存が反映されています。再読み込み後にやり直してください。', NOT_FOUND: '対象の記録が見つかりません。',
      INSUFFICIENT_BALANCE: '積立残高が不足しています。', DUPLICATE_OPERATION: '同じ操作番号で異なる内容を保存できません。',
      OPERATION_CONFLICT: '同じ操作番号で異なる内容を保存できません。'
    };
    if (error && messages[error.code]) fail_(error.code, messages[error.code]);
    throw error;
  }
}
function randomToken_() { return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''); }
function channel_(value) { if (typeof value !== 'string' || !/^[a-f0-9]{32,128}$/.test(value)) fail_('INVALID_CHANNEL', '通信を初期化し直してください。'); return value; }
function token_(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail_('AUTH_REQUIRED', 'Googleログインが必要です。'); return value; }
function object_(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail_('INVALID_INPUT', '入力内容が不正です。'); }
function boundedString_(value, max, code) { if (typeof value !== 'string' || !value.trim() || value.length > max) fail_(code, '入力内容が不正です。'); return value; }
function parseJson_(value, code) { try { return JSON.parse(value); } catch (error) { fail_(code, '保存または認証情報の形式が不正です。'); } }
function sha256_(value) { return sha256Bytes_(Utilities.newBlob(value).getBytes()); }
function sha256Bytes_(bytes) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes).map(function (byte) { return ('0' + ((byte + 256) % 256).toString(16)).slice(-2); }).join(''); }
function safeJson_(value) { return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
function fail_(code, message) { throw new Error(code + ': ' + message); }
