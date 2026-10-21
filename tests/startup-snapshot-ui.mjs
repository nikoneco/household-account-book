// Browser plugin not available. Local Playwright + synthetic transport only.
// Flow: saved-session reload -> instant read-only preview -> delayed bootstrap
// -> fresh data, retaining current drafts, selected photos, navigation and focus.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.HOUSEHOLD_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.HOUSEHOLD_PREVIEW_URL||'http://127.0.0.1:4383';
const output=process.env.HOUSEHOLD_QA_OUTPUT||path.join(os.tmpdir(),'household-startup-qa');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'}),errors=[];
const original=(await readFile(new URL('../web/transport.js',import.meta.url),'utf8')).replace('export function createTransport(','function unusedRealTransport(');
const fixture=original+`
export function createTransport(){
 const D=globalThis.HouseholdDomain;
 if(!globalThis.__ledger){
  let state=D.emptyState(),op=0;
  const run=(type,payload)=>state=D.execute(state,{type,payload,operationId:'seed-'+(++op)},{uuid:()=> 'seed-id-'+(++op),now:'2026-10-20T10:00:00.000Z'}).state;
  run('saveIncome',{month:'2026-10',amount:200000});
  run('upsertExpense',{id:'existing-expense',useDate:'2026-10-10',accountingMonth:'2026-10',amount:2000,category:'食費',paymentMethod:'cash',fixed:false,description:'Fixture lunch',memo:''});
  run('registerReceipt',{fileId:'fixture-drive',fileName:'saved.png',imageHash:'saved-hash',mimeType:'image/png'});
  run('saveSetting',{id:'saving',kind:'saving',name:'Fixture saving',plannedAmount:5000,openingBalance:10000,targetAmount:0,paymentMethod:'bank',category:'積立',memo:'',active:true});
  globalThis.__ledger=state;
 }
 globalThis.__calls??=[];globalThis.__pending??=[];globalThis.__created=(globalThis.__created||0)+1;
 const t={
  prepareLogin:async()=>({state:'fixture'}),login:async()=>({session:'a'.repeat(64),expiresAt:Date.now()+30*86400000,role:'editor'}),
  restore:(saved,options)=>{globalThis.__calls.push('bootstrap');return new Promise((resolve,reject)=>globalThis.__pending.push({saved,options,resolve:role=>resolve({...saved,role:role||'editor',state:structuredClone(globalThis.__ledger)}),reject}));},
  load:async()=>{globalThis.__calls.push('load');if(globalThis.__deferConflictLoad)return new Promise((resolve,reject)=>{globalThis.__conflictLoad={resolve,reject};});return structuredClone(globalThis.__ledger);},
  mutate:async command=>{globalThis.__calls.push(command.type);if(globalThis.__conflict){globalThis.__conflict=false;throw Object.assign(new Error('conflict'),{code:'CONFLICT'});}const response=D.execute(globalThis.__ledger,command);globalThis.__ledger=response.state;return structuredClone(response);},
  uploadReceipt:async payload=>{globalThis.__calls.push('uploadReceipt');const response=D.execute(globalThis.__ledger,{type:'registerReceipt',operationId:payload.operationId,payload:{fileId:'upload-fixture',fileName:payload.fileName,imageHash:payload.imageHash,mimeType:payload.mimeType}});globalThis.__ledger=response.state;return structuredClone(response);},
  receiptImage:async()=>{globalThis.__calls.push('receiptImage');throw Object.assign(new Error('fixture missing'),{code:'NOT_FOUND'});},
  logout:async()=>{globalThis.__calls.push('logout');if(globalThis.__slowLogout)return new Promise(resolve=>{globalThis.__logoutRelease=resolve;});},close:()=>{globalThis.__closed=(globalThis.__closed||0)+1;}
 };return t;
}`;
const cfg={mode:'google',clientId:'fixture',bridgeUrl:'https://script.google.com/macros/s/fixture/exec'};
async function setup(viewport={width:390,height:844}){
 const context=await browser.newContext({viewport,serviceWorkers:'block'});
 await context.route('**/runtime-config.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify(cfg)}));
 await context.route('**/web/transport.js',r=>r.fulfill({contentType:'text/javascript',body:fixture}));
 await context.route('https://accounts.google.com/gsi/client',r=>r.fulfill({contentType:'text/javascript',body:`globalThis.google={accounts:{oauth2:{initCodeClient:()=>({requestCode(){}})}}};`}));
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.getByRole('heading',{name:'ログイン',exact:true}).waitFor();
 assert.equal(await page.title(),'家計簿');assert.equal(new URL(page.url()).origin,origin);
 return {context,page};
}
async function seed(page,{snapshot=true,expires=30*86400000,role='editor'}={}){
 await page.evaluate(async({cfg,snapshot,expires,role})=>{
  const sessions=await import('./web/session.js'),cache=await import('./web/startup-snapshot.js');
  const saved={session:'a'.repeat(64),expiresAt:Date.now()+expires};
  sessions.saveSession(cfg,saved);
  if(snapshot)await cache.saveSnapshot(cfg,saved,globalThis.__ledger,role);else cache.clearSnapshot();
 },{cfg,snapshot,expires,role});
}
const pending=(page,count=1)=>page.waitForFunction(count=>globalThis.__pending?.length>=count,count);
const resolve=(page,index=0,role='editor')=>page.evaluate(({index,role})=>globalThis.__pending[index].resolve(role),{index,role});
const fresh=page=>page.waitForFunction(()=>document.querySelector('#data-sync')?.dataset.status==='fresh');
const preview=async page=>{
 await pending(page);await page.locator('#data-sync[data-status=refreshing]').waitFor();
 assert.equal(await page.locator('#navigation').isVisible(),true);
 assert.equal(await page.getByRole('heading',{name:'読み込み中',exact:true}).count(),0);
 assert.equal(await page.locator('#main').getAttribute('aria-busy'),'false');
 assert.equal(await page.evaluate(()=>performance.getEntriesByName('household:snapshot-rendered').length),1);
};
const click=(page,name)=>page.getByRole('button',{name,exact:true}).click();
const cachedRevision=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('household.startup-snapshot.v1')).state.revision);
async function snapshotRevision(page,revision){await page.waitForFunction(revision=>JSON.parse(localStorage.getItem('household.startup-snapshot.v1'))?.state.revision===revision,revision);}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlFkAAAAASUVORK5CYII=','base64');
try{
 // Delayed latest data never blocks preview navigation; all write entrances stay shut.
 {
  const {context,page}=await setup();await seed(page);await page.reload();await preview(page);
  assert.deepEqual(await page.evaluate(()=>globalThis.__calls),['bootstrap']);
  await page.locator('#saved-receipts>summary').click();
  assert.equal(await page.locator('[data-action=receipt-image]').isDisabled(),true);
  await page.locator('[data-action=receipt-image]').dispatchEvent('click');
  await page.getByRole('tab',{name:'支出',exact:true}).click();
  await page.locator('#expense-form [name=amount]').fill('456');
  await page.locator('#expense-form [name=description]').fill('unfinished draft');
  const field=page.locator('#expense-form [name=description]');await field.focus();
  await field.evaluate(el=>el.setSelectionRange(3,8));
  await field.press('Enter');
  await page.locator('#expense-form').dispatchEvent('submit');
  await page.locator('#expense-form button[type=submit]').dispatchEvent('click');
  assert.equal(await page.locator('#expense-form button[type=submit]').isDisabled(),true);
  await page.evaluate(()=>{globalThis.__ledger.incomes[0].amount=210000;globalThis.__ledger.revision++;});
  await page.screenshot({path:path.join(output,'preview-mobile.png'),fullPage:true});
  await resolve(page);await fresh(page);
  assert.equal(await field.inputValue(),'unfinished draft');
  assert.equal(await page.locator('#expense-form [name=amount]').inputValue(),'456');
  assert.deepEqual(await field.evaluate(el=>[el===document.activeElement,el.selectionStart,el.selectionEnd]),[true,3,8]);
  assert.equal(await page.locator('[data-tab=expense]').getAttribute('aria-selected'),'true');
  // Latest missing monthly plans may materialize only after validation.
  await page.waitForFunction(()=>document.querySelector('#expense-form button[type=submit]')?.disabled===false);
  assert.equal(await page.evaluate(()=>globalThis.__calls.includes('upsertExpense')),false);
  assert.equal(await page.evaluate(()=>globalThis.__calls.includes('receiptImage')),false);
  await click(page,'ホーム');await page.getByText('¥210,000',{exact:true}).first().waitFor();
  const loads=await page.evaluate(()=>globalThis.__calls.filter(x=>x==='bootstrap'||x==='load').length);
  await click(page,'履歴');await click(page,'毎月の設定');await click(page,'登録');
  assert.equal(await page.evaluate(()=>globalThis.__calls.filter(x=>x==='bootstrap'||x==='load').length),loads);
  await context.close();
 }
 // Receipt files and current month/page survive refresh; upload refreshes the cache.
 {
  const {context,page}=await setup({width:1280,height:900});await seed(page);await page.reload();await preview(page);
  await page.locator('#receipt-files').setInputFiles({name:'selected.png',mimeType:'image/png',buffer:png});
  await page.getByText('1枚選択',{exact:true}).waitFor();
  await page.locator('#receipt-form').dispatchEvent('submit');
  await page.locator('#receipt-form button[type=submit]').dispatchEvent('click');
  assert.deepEqual(await page.evaluate(()=>globalThis.__calls),['bootstrap']);
  await resolve(page);await fresh(page);await page.getByText('1枚選択',{exact:true}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('#receipt-form button[type=submit]').disabled);
  await click(page,'画像を保存');await page.getByText('1枚の画像を保存しました。',{exact:true}).waitFor();
  const revision=await page.evaluate(()=>globalThis.__ledger.revision);await snapshotRevision(page,revision);
  await click(page,'ホーム');await page.locator('#month').fill('2026-09');
  await page.reload();await preview(page);await click(page,'ホーム');await page.locator('#month').fill('2026-09');
  await click(page,'給与を入力');await page.locator('#income-form [name=amount]').fill('123456');
  await resolve(page);await fresh(page);
  assert.equal(await page.locator('#month').inputValue(),'2026-09');
  assert.equal(await page.locator('[data-page=home]').getAttribute('aria-current'),'page');
  assert.equal(await page.locator('#income-form [name=amount]').inputValue(),'123456');
  assert.equal(await page.locator('#income-edit').isVisible(),true);
  await page.screenshot({path:path.join(output,'fresh-draft-desktop.png'),fullPage:false});
  await context.close();
 }
 // A failed refresh keeps a read-only preview; retry recreates the transport.
 {
  const {context,page}=await setup();await seed(page);await page.reload();await preview(page);
  await page.getByRole('tab',{name:'支出',exact:true}).click();await page.locator('#expense-form [name=amount]').fill('789');
  await page.evaluate(()=>globalThis.__pending[0].reject(Object.assign(new Error('offline'),{code:'CONNECTION'})));
  await page.locator('#data-sync[data-status=error]').waitFor();
  assert.equal(await page.locator('#navigation').isVisible(),true);
  await page.locator('#expense-form').dispatchEvent('submit');assert.deepEqual(await page.evaluate(()=>globalThis.__calls),['bootstrap']);
  await page.screenshot({path:path.join(output,'retry-mobile.png'),fullPage:true});
  await page.locator('#snapshot-retry').click();await pending(page,2);
  assert.equal(await page.evaluate(()=>globalThis.__created),2);assert.equal(await page.evaluate(()=>globalThis.__closed),1);
  await resolve(page,1);await fresh(page);assert.equal(await page.locator('#expense-form [name=amount]').inputValue(),'789');
  await context.close();
 }
 // Server auth rejection, explicit logout, cross-tab logout and expiry erase private UI/cache.
 for(const reason of ['AUTH_REQUIRED','AUTH_FORBIDDEN','UNAUTHENTICATED','UNAUTHORIZED','logout','cross-tab','expiry']){
  const {context,page}=await setup();await seed(page,{expires:reason==='expiry'?1300:30*86400000});await page.reload();await preview(page);
  if(reason==='logout')await click(page,'ログアウト');
  else if(reason==='cross-tab'){
   const other=await context.newPage();await other.goto(origin);await other.evaluate(()=>localStorage.removeItem('household.session.v1'));await other.close();
  }else if(reason!=='expiry')await page.evaluate(reason=>globalThis.__pending[0].reject(Object.assign(new Error('expired'),{code:reason})),reason);
  await page.getByRole('heading',{name:'ログイン',exact:true}).waitFor();
  await resolve(page);await page.waitForTimeout(20);
  assert.equal(await page.locator('#navigation').isVisible(),false,reason);
  assert.equal(await page.locator('#expense-form,#receipt-form,.receipt-row').count(),0,reason);
  assert.equal(await page.evaluate(()=>localStorage.getItem('household.startup-snapshot.v1')),null,reason);
  assert.equal(await page.evaluate(()=>localStorage.getItem('household.session.v1')),null,reason);
  await context.close();
 }
 // Viewer downgrade preserves current draft while enforcing role on every write path.
 {
  const {context,page}=await setup();await seed(page);await page.reload();await preview(page);
  await page.getByRole('tab',{name:'支出',exact:true}).click();await page.locator('#expense-form [name=amount]').fill('321');
  await resolve(page,0,'viewer');await fresh(page);
  assert.equal(await page.locator('#expense-form [name=amount]').inputValue(),'321');
  assert.equal(await page.locator('#mode-note').textContent(),'閲覧のみ');
  await page.locator('#expense-form').dispatchEvent('submit');
  assert.deepEqual(await page.evaluate(()=>globalThis.__calls),['bootstrap']);
  await click(page,'ホーム');await page.locator('[data-action=toggle-deposit-skip]').dispatchEvent('click');
  assert.deepEqual(await page.evaluate(()=>globalThis.__calls),['bootstrap']);
  await context.close();
 }
 // A changed existing record cannot be overwritten by a preserved stale edit.
 {
  const {context,page}=await setup();await seed(page);await page.reload();await preview(page);
  await click(page,'履歴');await page.locator('[data-action=expense-detail]').click();await click(page,'編集');
  await page.locator('#expense-form [name=description]').fill('my unfinished edit');
  await page.evaluate(()=>{globalThis.__ledger.expenses[0].amount=9999;globalThis.__ledger.revision++;});
  await resolve(page);await fresh(page);await page.getByText(/入力中の記録が別の場所で変更/).waitFor();
  assert.equal(await page.locator('#expense-form [name=description]').inputValue(),'my unfinished edit');
  assert.equal(await page.locator('#expense-form button[type=submit]').isDisabled(),true);
  await page.locator('#expense-form').dispatchEvent('submit');assert.equal(await page.evaluate(()=>globalThis.__calls.includes('upsertExpense')),false);
  await context.close();
 }
 // A model retained while its form is hidden must advance to the latest money.
 // Guarding the original DOM must also survive ordinary navigation: the new
 // form uses fresh models instead of reintroducing the old cached amounts.
 for(const kind of ['expense-hidden','expense-guard-rerender','setting-hidden','setting-guard-rerender']){
  const {context,page}=await setup();await seed(page);await page.reload();await preview(page);
  const setting=kind.startsWith('setting'),hidden=kind.endsWith('hidden');
  const form=page.locator(setting?'#setting-form':'#expense-form'),money=setting?'plannedAmount':'amount';
  if(setting){await click(page,'毎月の設定');await page.locator('[data-action=edit-setting]').click();await form.locator('[name=memo]').fill('my unfinished draft');}
  else{await click(page,'履歴');await page.locator('[data-action=expense-detail]').click();await click(page,'編集');await form.locator('[name=description]').fill('my unfinished draft');}
  const hide=async()=>{if(setting)await click(page,'ホーム');else await page.getByRole('tab',{name:'積立',exact:true}).click();};
  const reveal=async()=>{if(setting)await click(page,'毎月の設定');else await page.getByRole('tab',{name:'支出',exact:true}).click();};
  if(hidden)await hide();
  await page.evaluate(setting=>{
   const old=setting?__ledger.settings[0]:__ledger.expenses[0];
   const type=setting?'saveSetting':'upsertExpense',payload=setting?{...old,plannedAmount:8888}:{...old,amount:9999};
   globalThis.__ledger=HouseholdDomain.execute(__ledger,{type,payload,operationId:crypto.randomUUID()}).state;
  },setting);
  await resolve(page);await fresh(page);await page.waitForFunction(()=>document.querySelector('#main').getAttribute('aria-busy')==='false');
  if(!hidden){
   assert.equal(await form.locator('[name='+money+']').inputValue(),setting?'5000':'2000',kind+' preserves current draft');
   assert.equal(await form.locator('[type=submit]').isDisabled(),true);
   await form.dispatchEvent('submit');
   assert.equal(await page.evaluate(operation=>__calls.includes(operation),setting?'saveSetting':'upsertExpense'),false);
   await hide();
  }
  await reveal();
  assert.equal(await form.locator('[name='+money+']').inputValue(),setting?'8888':'9999',kind+' renders latest model');
  assert.equal(await form.locator('[type=submit]').isEnabled(),true);
  await form.locator('[type=submit]').click();await page.getByText('保存しました。',{exact:true}).waitFor();
  assert.equal(await page.evaluate(setting=>setting?__ledger.settings[0].plannedAmount:__ledger.expenses[0].amount,setting),setting?8888:9999,kind+' cannot replay old money');
  await context.close();
 }
 // A tombstone invalidates both visible and dormant edit models. Returning to
 // the expense tab offers a blank new entry and cannot recreate the old record.
 for(const hidden of [true,false]){
  const {context,page}=await setup();await seed(page);await page.reload();await preview(page);
  await click(page,'履歴');await page.locator('[data-action=expense-detail]').click();await click(page,'編集');
  await page.locator('#expense-form [name=description]').fill('deleted record draft');
  if(hidden)await page.getByRole('tab',{name:'積立',exact:true}).click();
  await page.evaluate(()=>{globalThis.__ledger=HouseholdDomain.execute(__ledger,{type:'deleteExpense',payload:{id:'existing-expense'},operationId:crypto.randomUUID()}).state;});
  await resolve(page);await fresh(page);await page.waitForFunction(()=>document.querySelector('#main').getAttribute('aria-busy')==='false');
  if(!hidden){await page.locator('#expense-form').dispatchEvent('submit');assert.equal(await page.locator('#expense-form [type=submit]').isDisabled(),true);await page.getByRole('tab',{name:'積立',exact:true}).click();}
  await page.getByRole('tab',{name:'支出',exact:true}).click();
  assert.equal(await page.locator('#expense-form [name=amount]').inputValue(),'');
  assert.equal(await page.locator('#expense-form [name=description]').inputValue(),'');
  await page.locator('#expense-form').dispatchEvent('submit');
  assert.equal(await page.evaluate(()=>__calls.includes('upsertExpense')),false);
  assert.deepEqual(await page.evaluate(()=>__ledger.expenses.map(({id,amount,deleted})=>({id,amount,deleted}))),[{id:'existing-expense',amount:2000,deleted:true}]);
  await context.close();
 }
 // Monthly drafts protect the exact displayed month, including a record that
 // did not exist in the preview. Memo-only bill edits must not replay old money.
 for(const {kind,absent,target} of [
  {kind:'income',absent:false,target:'2026-10'},
  {kind:'income',absent:true,target:'2026-09'},
  {kind:'bill',absent:false,target:'2026-10'},
  {kind:'bill',absent:true,target:'2026-09'}
 ]){
  const {context,page}=await setup();
  if(kind==='bill'&&!absent)await page.evaluate(()=>{const result=HouseholdDomain.execute(__ledger,{type:'saveBill',payload:{month:'2026-10',confirmedAmount:100000,memo:'cached memo'},operationId:crypto.randomUUID()});globalThis.__ledger=result.state;});
  await seed(page);await page.reload();await preview(page);await click(page,'ホーム');
  if(target!=='2026-10')await page.locator('#month').fill(target);
  if(kind==='income')await click(page,'給与を入力');
  const form=page.locator('#'+kind+'-form'),money=kind==='income'?'amount':'confirmedAmount';
  assert.equal(await form.getAttribute('data-target-month'),target);
  if(kind==='bill'&&!absent)await form.locator('[name=memo]').fill('unfinished memo only');
  else await form.locator('[name='+money+']').fill('201000');
  const entered=await form.locator('[name='+money+']').inputValue();
  await page.evaluate(({kind,target})=>{
   const type=kind==='income'?'saveIncome':'saveBill';
   const payload=kind==='income'?{month:target,amount:300000}:{month:target,confirmedAmount:150000,memo:'latest memo'};
   globalThis.__ledger=HouseholdDomain.execute(__ledger,{type,payload,operationId:crypto.randomUUID()}).state;
  },{kind,target});
  await resolve(page);await fresh(page);await page.getByText(/入力中の記録が別の場所で変更/).waitFor();
  assert.equal(await form.locator('[name='+money+']').inputValue(),entered);
  if(kind==='bill'&&!absent)assert.equal(await form.locator('[name=memo]').inputValue(),'unfinished memo only');
  assert.equal(await form.locator('[type=submit]').isDisabled(),true);
  await form.dispatchEvent('submit');await form.locator('[type=submit]').dispatchEvent('click');await form.locator('[name='+money+']').press('Enter');
  const operation=kind==='income'?'saveIncome':'saveBill';
  assert.equal(await page.evaluate(operation=>__calls.includes(operation),operation),false,kind+' '+(absent?'absent':'existing'));
  await click(page,'履歴');await click(page,'ホーム');if(kind==='income')await click(page,'給与を入力');
  assert.equal(await form.locator('[name='+money+']').inputValue(),kind==='income'?'300000':'150000');
  assert.equal(await form.locator('[type=submit]').isEnabled(),true);
  assert.equal(await page.locator('#month').inputValue(),target);
  await context.close();
 }
 // Updating a different month does not block a safe new monthly draft.
 {
  const {context,page}=await setup();await seed(page);await page.reload();await preview(page);await click(page,'ホーム');
  await page.locator('#month').fill('2026-09');await click(page,'給与を入力');await page.locator('#income-form [name=amount]').fill('54321');
  await page.evaluate(()=>{globalThis.__ledger.incomes[0].amount=310000;globalThis.__ledger.revision++;});
  await resolve(page);await fresh(page);assert.equal(await page.locator('#income-form [type=submit]').isEnabled(),true);
  await page.locator('#income-form [type=submit]').click();await page.getByText('保存しました。',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>__ledger.incomes.map(({month,amount})=>({month,amount}))),[{month:'2026-10',amount:310000},{month:'2026-09',amount:54321}]);
  await context.close();
 }
 // Actual separate-tab session replacement wins during a delayed snapshot
 // digest and during delayed bootstrap success/auth rejection. The newer tab's
 // credentials are never overwritten or revoked by the old session's response.
 for(const delay of ['digest','bootstrap-success','bootstrap-auth-error']){
  const {context,page}=await setup(),writer=await context.newPage();
  await writer.goto(origin);await writer.getByRole('heading',{name:'ログイン',exact:true}).waitFor();
  await seed(page);
  if(delay==='digest')await page.addInitScript(()=>{
   const digest=crypto.subtle.digest.bind(crypto.subtle);let count=0;
   crypto.subtle.digest=async(...args)=>{const result=await digest(...args);if(++count===1){globalThis.__digestWaiting=true;await new Promise(resolve=>{globalThis.__releaseDigest=resolve;});}return result;};
  });
  await page.reload();
  if(delay==='digest')await page.waitForFunction(()=>globalThis.__digestWaiting===true);else await preview(page);
  // writer shares the real origin/localStorage. No synthetic storage events.
  await writer.evaluate(async cfg=>{
   const sessions=await import('./web/session.js'),cache=await import('./web/startup-snapshot.js');
   globalThis.__newSession={session:'b'.repeat(64),expiresAt:Date.now()+30*86400000};
   sessions.saveSession(cfg,__newSession);
   globalThis.__ledger.incomes[0].amount=330000;
   await cache.saveSnapshot(cfg,__newSession,__ledger,'editor');
  },cfg);
  const count=delay==='digest'?1:2;
  await pending(page,count);
  assert.equal(await page.evaluate(index=>__pending[index].saved.session,count-1),'b'.repeat(64));
  if(delay==='digest')await page.evaluate(()=>__releaseDigest());
  else if(delay==='bootstrap-success')await resolve(page,0);
  else await page.evaluate(()=>__pending[0].reject(Object.assign(new Error('old session rejected'),{code:'AUTH_REQUIRED'})));
  await page.waitForTimeout(30);
  assert.equal(await page.locator('#data-sync').getAttribute('data-status')==='fresh',false);
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('household.session.v1')).session),'b'.repeat(64));
  assert.equal(await page.evaluate(()=>__calls.includes('logout')),false);
  assert.equal(await writer.evaluate(()=>JSON.parse(localStorage.getItem('household.session.v1')).session),'b'.repeat(64));
  await resolve(page,count-1);await fresh(page);
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('household.session.v1')).session),'b'.repeat(64));
  assert.equal(await page.evaluate(()=>__calls.includes('logout')),false);
  if(delay==='digest')assert.equal(await page.evaluate(()=>__pending.some(item=>item.saved.session==='a'.repeat(64))),false,'Old digest cannot start bootstrap');
  await context.close();
 }
 // A conflict load is owned by the request that started it. Even if explicit
 // logout revocation is slow, a later login in a real second page is unaffected
 // by the old load's auth error, transient error, or successful stale response.
 for(const outcome of ['AUTH_REQUIRED','TIMEOUT','success']){
  const {context,page}=await setup();await seed(page);await page.reload();await preview(page);await resolve(page);await fresh(page);
  await page.waitForFunction(()=>document.querySelector('#main').getAttribute('aria-busy')==='false');
  await page.getByRole('tab',{name:'支出',exact:true}).click();await page.locator('#expense-form [name=amount]').fill('333');
  await page.evaluate(()=>{globalThis.__conflict=true;globalThis.__deferConflictLoad=true;globalThis.__slowLogout=true;globalThis.__oldConflictState=structuredClone(__ledger);});
  await page.locator('#expense-form [type=submit]').click();await page.waitForFunction(()=>!!globalThis.__conflictLoad);
  await click(page,'ログアウト');await page.getByRole('heading',{name:'ログイン',exact:true}).waitFor();
  const writer=await context.newPage();await writer.goto(origin);await writer.getByRole('heading',{name:'ログイン',exact:true}).waitFor();
  await writer.evaluate(async cfg=>{const sessions=await import('./web/session.js');sessions.saveSession(cfg,{session:'b'.repeat(64),expiresAt:Date.now()+30*86400000});},cfg);
  await pending(page,2);
  await page.evaluate(()=>{globalThis.__ledger.incomes[0].amount=330000;globalThis.__ledger.revision++;});
  await resolve(page,1);await fresh(page);await snapshotRevision(page,await page.evaluate(()=>__ledger.revision));
  await click(page,'ホーム');await page.getByText('¥330,000',{exact:true}).first().waitFor();
  const before=await page.evaluate(()=>({session:localStorage.getItem('household.session.v1'),snapshot:localStorage.getItem('household.startup-snapshot.v1'),calls:[...__calls],message:document.querySelector('#message').textContent,error:document.querySelector('#error').textContent}));
  await page.evaluate(outcome=>{if(outcome==='success')__conflictLoad.resolve(__oldConflictState);else __conflictLoad.reject(Object.assign(new Error('old A load failure'),{code:outcome}));},outcome);
  await page.waitForTimeout(30);
  assert.equal(await page.locator('#data-sync').getAttribute('data-status'),'fresh',outcome);
  assert.equal(await page.locator('#navigation').isVisible(),true);
  await page.getByText('¥330,000',{exact:true}).first().waitFor();
  assert.deepEqual(await page.evaluate(()=>({session:localStorage.getItem('household.session.v1'),snapshot:localStorage.getItem('household.startup-snapshot.v1'),calls:[...__calls],message:document.querySelector('#message').textContent,error:document.querySelector('#error').textContent})),before,outcome+' has no effect on new owner');
  assert.equal(await page.locator('#pending').isVisible(),false);
  await page.evaluate(()=>__logoutRelease());await page.waitForTimeout(20);
  assert.equal(await page.locator('#data-sync').getAttribute('data-status'),'fresh');
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('household.session.v1')).session),'b'.repeat(64));
  await context.close();
 }
 // Conflict reload also refreshes a dormant/existing edit model and blocks an
 // old visible draft until the record is rendered again with latest values.
 {
  const {context,page}=await setup();await seed(page);await page.reload();await preview(page);await resolve(page);await fresh(page);
  await page.waitForFunction(()=>document.querySelector('#main').getAttribute('aria-busy')==='false');
  await click(page,'履歴');await page.locator('[data-action=expense-detail]').click();await click(page,'編集');
  await page.locator('#expense-form [name=description]').fill('conflicting draft');
  await page.evaluate(()=>{globalThis.__conflict=true;globalThis.__ledger=HouseholdDomain.execute(__ledger,{type:'upsertExpense',payload:{...__ledger.expenses[0],amount:9999},operationId:crypto.randomUUID()}).state;});
  await page.locator('#expense-form [type=submit]').click();await page.getByText(/入力中の記録が別の場所で変更/).waitFor();
  assert.equal(await page.locator('#expense-form [name=amount]').inputValue(),'2000');assert.equal(await page.locator('#expense-form [type=submit]').isDisabled(),true);
  const count=await page.evaluate(()=>__calls.filter(item=>item==='upsertExpense').length);
  await page.locator('#expense-form').dispatchEvent('submit');assert.equal(await page.evaluate(()=>__calls.filter(item=>item==='upsertExpense').length),count);
  await page.getByRole('tab',{name:'積立',exact:true}).click();await page.getByRole('tab',{name:'支出',exact:true}).click();
  assert.equal(await page.locator('#expense-form [name=amount]').inputValue(),'9999');await context.close();
 }
 // No snapshot/corrupt snapshot keep the old loading behavior; successful writes/conflict loads update it.
 for(const corrupt of [false,true]){
  const {context,page}=await setup();await seed(page,{snapshot:corrupt});
  if(corrupt)await page.evaluate(()=>{const key='household.startup-snapshot.v1',cache=JSON.parse(localStorage.getItem(key));cache.state.receipts[0].analysisNotes=[null];localStorage.setItem(key,JSON.stringify(cache));});
  await page.reload();await pending(page);await page.getByRole('heading',{name:'読み込み中',exact:true}).waitFor();
  assert.equal(await page.locator('#navigation').isVisible(),false);await resolve(page);await fresh(page);
  await page.waitForFunction(()=>document.querySelector('#main').getAttribute('aria-busy')==='false');
  await page.getByRole('tab',{name:'支出',exact:true}).click();await page.locator('#expense-form [name=amount]').fill('345');
  await page.locator('#expense-form button[type=submit]').click();await page.locator('#message').getByText('保存しました。',{exact:true}).waitFor();
  await snapshotRevision(page,await page.evaluate(()=>globalThis.__ledger.revision));
  const before=await cachedRevision(page);
  await page.locator('#expense-form [name=amount]').fill('346');
  await page.evaluate(()=>{globalThis.__conflict=true;globalThis.__ledger.revision+=2;});
  await page.locator('#expense-form button[type=submit]').click();await page.getByText(/最新情報を読み込みました/).waitFor();
  await snapshotRevision(page,before+2);
  assert.equal(await page.locator('#expense-form [name=amount]').inputValue(),'346');
  await context.close();
 }
 // Demo remains ephemeral even after a successful mutation.
 {
  const {context,page}=await setup();await click(page,'サンプルで試す');await page.getByRole('tab',{name:'支出',exact:true}).click();
  await page.locator('#expense-form [name=amount]').fill('1');await page.locator('#expense-form button[type=submit]').click();
  await page.getByText('保存しました。',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('household.startup-snapshot.v1')),null);await context.close();
 }
 assert.deepEqual(errors,[]);
 console.log('PASS: snapshot preview + delayed latest; memory-only navigation; drafts/photos/focus/month preserved; stale/error/viewer/keyboard/programmatic mutation guards; transport recreation; auth/expiry/logout races; monthly/dormant/rerender/deleted edit model protection; real separate-tab session replacement during digest/bootstrap; late conflict success/auth/transient failures cannot affect new login; corrupt/no-cache fallback; upload/mutation/conflict cache refresh; ephemeral demo. Local fixtures only. Screenshots: '+output);
}finally{await browser.close();}
