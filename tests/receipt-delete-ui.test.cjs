'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

// Run the actual app renderer, click listener and mutation/retry logic with a
// small DOM double. No Google login, network, or production data is involved.
function app(receipts, role = 'editor') {
  const listeners = {}, nodes = new Map(), commands = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, textContent: '', disabled: false, setAttribute() {} });
    return nodes.get(id);
  };
  const context = vm.createContext({ crypto: webcrypto, Intl, console,
    document: { querySelector: node, querySelectorAll: () => [], addEventListener: (type, handler) => { listeners[type] = handler; } },
    window: { addEventListener() {} }, confirm: () => true, URL: { revokeObjectURL() {} }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../shared/domain.js'), 'utf8'), context);
  const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^await initializeConfig\(\);$/m, '').replace("if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});", '');
  vm.runInContext(source, context);
  context.receipts = receipts; context.role = role;
  vm.runInContext(`state={...D.emptyState(),receipts};globalThis.serverState=JSON.parse(JSON.stringify(state));sessionRole=role;render=()=>{globalThis.rendered=renderReceipts();};updateReceiptUploads=()=>{};`, context);
  context.transportStub = { mutate: async command => {
    commands.push(JSON.parse(JSON.stringify(command)));
    const failure = context.failure; context.failure = null;
    if (failure && !context.commitBeforeFailure) throw failure;
    const response = vm.runInContext('D.execute(globalThis.serverState, globalThis.activeCommand)', context);
    context.serverState = response.state;
    if (failure) throw failure;
    return response;
  } };
  vm.runInContext('transport=transportStub;', context);
  const original = context.transportStub.mutate;
  context.transportStub.mutate = command => { context.activeCommand = command; return original(command); };
  const click = (id, action = 'delete-receipt') => listeners.click({ preventDefault() {}, target: { closest: selector => selector==='button' ? ({ id: action==='retry' ? 'retry' : '', dataset: { action, id } }) : null } });
  return { context, commands, node, click, render: () => vm.runInContext('renderReceipts()', context), state: () => vm.runInContext('state', context), storedState: () => context.serverState };
}
const receipt = (id, status='pending', extra={}) => ({ id, status, imageHash:'hash-'+id, fileId:'private-'+id, fileName:id+'.jpg', mimeType:'image/jpeg', reason:'', uploadedAt:'2026-10-01T00:00:00.000Z', expenseIds:[], ...extra });

test('receipt list exposes delete only for unimported editor records and hides tombstones', () => {
  const rows = [receipt('pending'),receipt('review','needsReview'),receipt('failed','failed'),receipt('imported','imported',{expenseIds:['linked']}),receipt('linked','needsReview',{expenseIds:['linked']}),receipt('deleted','pending',{deleted:true})];
  const editor = app(rows).render();
  assert.equal((editor.match(/data-action="delete-receipt"/g)||[]).length, 3);
  for (const id of ['pending','review','failed']) assert.match(editor, new RegExp(`data-action="delete-receipt" data-id="${id}"`));
  assert.doesNotMatch(editor, /deleted\.jpg/);
  assert.doesNotMatch(app(rows,'viewer').render(), /data-action="(?:delete-receipt|receipt-pending)"/);
});

test('delete confirmation cancellation and viewer/stale clicks never mutate; success removes the row', async () => {
  const a = app([receipt('one')]);
  a.context.confirm = () => false; await a.click('one'); assert.equal(a.commands.length, 0);
  let confirmed = ''; a.context.confirm = text => {confirmed=text;return true;};
  await a.click('one');
  assert.match(confirmed, /元に戻せません/); assert.equal(a.commands[0].type, 'deleteReceipt');
  assert.equal(a.commands[0].expectedRevision, 0); assert.equal(a.state().receipts[0].deleted, true);
  assert.doesNotMatch(a.context.rendered, /one\.jpg/); assert.equal(a.node('#message').textContent, 'レシートを削除しました。');
  await a.click('one'); assert.equal(a.commands.length, 1);
  const viewer = app([receipt('one')],'viewer'); await viewer.click('one'); assert.equal(viewer.commands.length, 0);
});

test('ambiguous delete response keeps the row until same-command retry succeeds', async () => {
  const a = app([receipt('one')]);
  a.context.failure = Object.assign(new Error('通信失敗'), { code:'TIMEOUT' });
  await a.click('one'); assert.equal(a.node('#pending').hidden, false); assert.equal(a.state().receipts[0].deleted, undefined);
  await a.click('one'); assert.equal(a.commands.length, 1, 'Pending mutation blocks another delete');
  await a.click('', 'retry');
  assert.deepEqual(a.commands[1],a.commands[0]); assert.equal(a.node('#pending').hidden, true);
  assert.equal(a.state().receipts[0].deleted, true); assert.doesNotMatch(a.context.rendered, /one\.jpg/);
});

for (const commitBeforeFailure of [false, true]) test(`SAVE_FAILED ${commitBeforeFailure?'after committed delete':'before commit'} preserves the operation for durable retry`, async () => {
  const a = app([receipt('one')]);
  a.context.failure = Object.assign(new Error('保存を確認できませんでした。再読み込み後、同じ操作を再試行してください。'), { code:'SAVE_FAILED' });
  a.context.commitBeforeFailure = commitBeforeFailure;
  await a.click('one');
  assert.equal(a.node('#pending').hidden, false, 'The app exposes its retry control');
  assert.equal(a.state().receipts[0].deleted, undefined, 'Unconfirmed save keeps the visible row');
  assert.equal(a.storedState().receipts[0].deleted, commitBeforeFailure ? true : undefined);
  assert.equal(a.storedState().revision, commitBeforeFailure ? 1 : 0);
  await a.click('one'); assert.equal(a.commands.length, 1, 'A new delete cannot replace the pending operation');
  await a.click('', 'retry');
  assert.deepEqual(a.commands[1], a.commands[0], 'Operation ID, expected revision and payload are identical');
  assert.equal(a.node('#pending').hidden, true);
  assert.equal(a.state().receipts[0].deleted, true); assert.doesNotMatch(a.context.rendered, /one\.jpg/);
  assert.equal(a.storedState().revision, 1, 'A committed response replay does not save twice');
  assert.equal(a.storedState().operations.length, 1);
  assert.equal(a.storedState().operations[0].operationId, a.commands[0].operationId);
  assert.equal(a.node('#message').textContent, 'レシートを削除しました。');
});


test('saved receipts group imported at the end, keep each group order and omit an empty inner accordion', () => {
  const row=receipt('done','imported',{expenseIds:['linked']});
  const mixed=app([receipt('first'),row,receipt('second')]).render();
  assert.match(mixed,/<details id="imported-receipts" class="imported-receipts"><summary>取込済み（1件）/);
  assert.ok(mixed.indexOf('second.jpg')<mixed.indexOf('first.jpg'));assert.ok(mixed.indexOf('first.jpg')<mixed.indexOf('done.jpg'));
  assert.doesNotMatch(app([receipt('one')]).render(),/imported-receipts/);
  assert.match(app([row]).render(),/取込済み（1件）/);
  assert.match(app([]).render(),/保存したレシートは、ここに並びます/);
});
