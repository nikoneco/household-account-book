// Local intercepted fixtures: no Google sign-in or cloud requests.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.HOUSEHOLD_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,channel:'chrome'});
const page=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});
const failures=[];page.on('pageerror',e=>failures.push(e.message));
const source=(await readFile(new URL('../web/transport.js',import.meta.url),'utf8')).replace('export function createTransport(','function unusedRealTransport(');
await page.route('**/web/transport.js',r=>r.fulfill({contentType:'text/javascript',body:source+`
export function createTransport(){
 const t=createDemoTransport();
 const stage=name=>new Promise((resolve,reject)=>{globalThis.__stage=name;globalThis.__resolveStage=resolve;globalThis.__rejectStage=reject;});
 const snapshot=()=>({session:'a'.repeat(64),expiresAt:Date.now()+30*86400000,role:'editor'});
 globalThis.__calls=[];globalThis.__prepareCount=0;
 return {...t,prepareLogin:async()=>{globalThis.__calls.push('prepare');const count=++globalThis.__prepareCount;await stage('prepare');return {state:'fixture-'+count};},login:async(code,state)=>{globalThis.__calls.push('exchange');globalThis.__exchangeState=state;await stage('exchange');if(globalThis.__authStateOnce){globalThis.__authStateOnce=false;throw Object.assign(new Error('fresh challenge'),{code:'AUTH_STATE'});}return snapshot();},restore:async(saved,options)=>{globalThis.__calls.push(options?.load?'bootstrap':'restore');globalThis.__restoredOptions=options;await stage('restore');const deny=sessionStorage.getItem('fixture-deny');if(deny)throw Object.assign(new Error('ログインし直してください。'),{code:deny});return {...saved,role:'editor',...(options?.load?{state:await t.load()}:{})};},load:async()=>{globalThis.__calls.push('load');await stage('load');return t.load();}};
}`}));
await page.route('**/runtime-config.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({mode:'google',clientId:'fixture',bridgeUrl:'https://script.google.com/macros/s/fixture/exec'})}));
await page.route('https://accounts.google.com/gsi/client',r=>r.fulfill({contentType:'text/javascript',body:`globalThis.google={accounts:{oauth2:{initCodeClient:options=>({requestCode:()=>{globalThis.__prepareBeforePopup=globalThis.__stage==='prepare';globalThis.__completePopup=()=>{globalThis.__loginCompletion=options.callback({code:'fixture'});};if(!globalThis.__deferPopup)globalThis.__completePopup();}})}}};`}));
const stage=async name=>page.waitForFunction(expected=>globalThis.__stage===expected,name);
const loading=async()=>{
 await page.getByRole('heading',{name:'読み込み中',exact:true}).waitFor();
 assert.equal(await page.locator('#main').getAttribute('aria-busy'),'true');
 assert.equal(await page.locator('#google-login').count(),0);
 assert.equal(await page.locator('#demo-login').count(),0);
 await page.getByRole('status').filter({hasText:'家計簿を読み込んでいます…'}).waitFor();
};
const resolve=()=>page.evaluate(()=>globalThis.__resolveStage());
const registration=async()=>{
 await page.getByRole('tab',{name:'レシート',exact:true}).waitFor();
 assert.equal(await page.locator('[data-page=register]').getAttribute('aria-current'),'page');
 assert.equal(await page.getByRole('tab',{name:'レシート',exact:true}).getAttribute('aria-selected'),'true');
};
try{
 await page.goto(process.env.HOUSEHOLD_PREVIEW_URL||'http://127.0.0.1:4283');
 await page.getByRole('button',{name:'Googleでログイン',exact:true}).waitFor();
 for(const failing of ['prepare','exchange','load']){
  await page.getByRole('button',{name:'Googleでログイン',exact:true}).click();
  for(const name of ['prepare','exchange','load']){
   await stage(name);await loading();
   if(name===failing){await page.evaluate(()=>globalThis.__rejectStage(new Error('接続を確認して、もう一度お試しください。')));break;}
   await resolve();
  }
  await page.getByRole('alert').filter({hasText:'接続を確認して'}).waitFor();
  await page.getByRole('heading',{name:failing==='load'?'再接続':'ログイン',exact:true}).waitFor();
  assert.equal(await page.locator('#main').getAttribute('aria-busy'),'false');
  assert.equal(await page.getByRole('button',{name:'Googleでログイン',exact:true}).isEnabled(),true);
  assert.equal(await page.locator('#navigation').isVisible(),false);
 }
 await page.getByRole('button',{name:'Googleでログイン',exact:true}).click();
 for(const name of ['prepare','exchange','load']){
  await stage(name);await loading();
  if(name==='prepare')assert.equal(await page.evaluate(()=>globalThis.__prepareBeforePopup),true);
  if(name==='load'){
   const out=path.join(os.tmpdir(),'household-ui-qa');await mkdir(out,{recursive:true});
   await page.screenshot({path:path.join(out,'11-login-loading.png')});
  }
  await resolve();
 }
 await registration();
 assert.equal(await page.locator('#main').getAttribute('aria-busy'),'false');
 assert.equal(await page.locator('#navigation').isVisible(),true);
 assert.equal(await page.getByRole('heading',{name:'読み込み中'}).count(),0);
 await page.getByRole('button',{name:'ホーム',exact:true}).click();
 await page.getByText('今月の残り',{exact:true}).waitFor();
 await page.reload();
 await stage('restore');await loading();assert.equal(await page.locator('#navigation').isVisible(),false);
 await resolve();
 await registration();
 assert.deepEqual(await page.evaluate(()=>globalThis.__calls),['bootstrap']);
 assert.deepEqual(await page.evaluate(()=>globalThis.__restoredOptions),{load:true});
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('household.session.v1')));
 assert.deepEqual(Object.keys(saved).sort(),['expiresAt','session','target']);
 assert.equal(saved.session,'a'.repeat(64));
 // Invalid local expiry is removed without restoring; server rejections also remove it.
 await page.evaluate(()=>{const value=JSON.parse(localStorage.getItem('household.session.v1'));value.expiresAt=1;localStorage.setItem('household.session.v1',JSON.stringify(value));});
 await page.reload();await page.getByRole('heading',{name:'ログイン',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>localStorage.getItem('household.session.v1')),null);
 for(const denied of ['AUTH_REQUIRED','AUTH_FORBIDDEN','UNAUTHENTICATED','UNAUTHORIZED']){
  await page.evaluate(({saved,denied})=>{localStorage.setItem('household.session.v1',JSON.stringify(saved));sessionStorage.setItem('fixture-deny',denied);},{saved,denied});
  await page.reload();await stage('restore');await loading();await resolve();
  await page.getByRole('heading',{name:'ログイン',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('household.session.v1')),null);
 }
 await page.evaluate(()=>sessionStorage.removeItem('fixture-deny'));
 // A transient bootstrap failure keeps the token and retries one combined request.
 await page.evaluate(saved=>localStorage.setItem('household.session.v1',JSON.stringify(saved)),saved);
 await page.reload();await stage('restore');
 await page.evaluate(()=>globalThis.__rejectStage(Object.assign(new Error('一時的に接続できません。'),{code:'TIMEOUT'})));
 await page.getByRole('button',{name:'読み込みを再試行',exact:true}).waitFor();
 await page.getByRole('heading',{name:'再接続',exact:true}).waitFor();
 assert.equal(await page.locator('#logout').isVisible(),true);
 assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('household.session.v1'))),saved);
 const retryOut=path.join(os.tmpdir(),'household-ui-qa');await mkdir(retryOut,{recursive:true});await page.screenshot({path:path.join(retryOut,'12-restore-retry.png')});
 await page.getByRole('button',{name:'読み込みを再試行',exact:true}).click();await stage('restore');await loading();await resolve();await registration();
 assert.deepEqual(await page.evaluate(()=>globalThis.__calls),['bootstrap']);
 await page.locator('#logout').click();await page.getByRole('button',{name:'Googleでログイン',exact:true}).waitFor();
 // Explicit logout wins over every pending login stage and a pending restore.
 for(const pending of ['prepare','exchange','load','restore']){
  if(pending==='restore'){
   await page.evaluate(saved=>localStorage.setItem('household.session.v1',JSON.stringify(saved)),saved);
   await page.reload();await stage('restore');
  }else{
   await page.getByRole('button',{name:'Googleでログイン',exact:true}).click();
   for(const name of ['prepare','exchange','load']){await stage(name);if(name===pending)break;await resolve();}
  }
  await loading();await page.evaluate(()=>globalThis.__oldResolve=globalThis.__resolveStage);
  await page.locator('#logout').click();await page.getByRole('button',{name:'Googleでログイン',exact:true}).waitFor();
  await page.evaluate(()=>globalThis.__oldResolve());
  if(pending!=='restore')await page.evaluate(()=>globalThis.__loginCompletion);
  await page.getByRole('heading',{name:'ログイン',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('household.session.v1')),null);
  assert.equal(await page.locator('#navigation').isVisible(),false);
  await page.reload();await page.getByRole('button',{name:'Googleでログイン',exact:true}).waitFor();
 }
 // Logout also wins when the Google popup has not invoked its callback yet.
 await page.evaluate(()=>{globalThis.__deferPopup=true;});
 await page.getByRole('button',{name:'Googleでログイン',exact:true}).click();await stage('prepare');
 await page.evaluate(()=>{globalThis.__latePopup=globalThis.__completePopup;globalThis.__latePrepare=globalThis.__resolveStage;});
 await page.locator('#logout').click();await page.getByRole('button',{name:'Googleでログイン',exact:true}).waitFor();
 await page.waitForFunction(()=>globalThis.__calls.length===0);
 await page.evaluate(()=>{globalThis.__latePrepare();globalThis.__latePopup();});
 await page.evaluate(()=>globalThis.__loginCompletion);
 assert.deepEqual(await page.evaluate(()=>globalThis.__calls),[]);
 assert.equal(await page.evaluate(()=>localStorage.getItem('household.session.v1')),null);
 assert.equal(await page.locator('#navigation').isVisible(),false);
 // The challenge starts at click; a long popup refreshes it before exchange.
 await page.evaluate(()=>{globalThis.__deferPopup=true;});
 await page.getByRole('button',{name:'Googleでログイン',exact:true}).click();await stage('prepare');await resolve();
 assert.equal(await page.evaluate(()=>globalThis.__prepareBeforePopup),true);
 await page.evaluate(()=>{const original=Date.now;Date.now=()=>original()+100000;globalThis.__completePopup();});
 await stage('prepare');await resolve();await stage('exchange');
 assert.equal(await page.evaluate(()=>globalThis.__exchangeState), 'fixture-2');
 await resolve();await stage('load');await resolve();await registration();
 await page.locator('#logout').click();await page.getByRole('button',{name:'Googleでログイン',exact:true}).waitFor();
 // Eviction/expiry detected by the server refreshes once without reusing stale state.
 await page.evaluate(()=>{globalThis.__deferPopup=false;globalThis.__authStateOnce=true;});
 await page.getByRole('button',{name:'Googleでログイン',exact:true}).click();
 await stage('prepare');await resolve();await stage('exchange');await resolve();
 await stage('prepare');await resolve();await stage('exchange');await resolve();await stage('load');await resolve();await registration();
 assert.equal(await page.evaluate(()=>globalThis.__prepareCount),2);
 await page.locator('#logout').click();await page.getByRole('button',{name:'Googleでログイン',exact:true}).waitFor();
 // Browser storage restrictions are nonfatal: login works for this page only.
 await page.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Storage unavailable','SecurityError');}}));
 await page.reload();await page.getByRole('button',{name:'Googleでログイン',exact:true}).click();
 for(const name of ['prepare','exchange','load']){await stage(name);await loading();await resolve();}
 await registration();
 await page.reload();await page.getByRole('heading',{name:'ログイン',exact:true}).waitFor();
 // Exercise the real transport with an intercepted in-memory server: failed
 // bootstrap keeps a revocation candidate, and the retry screen's logout revokes it.
 const revokePage=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});
 revokePage.on('pageerror',e=>failures.push(e.message));
 await revokePage.route('**/runtime-config.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({mode:'google',clientId:'fixture',bridgeUrl:'https://script.google.com/macros/s/fixture/exec'})}));
 await revokePage.route('https://accounts.google.com/gsi/client',r=>r.fulfill({contentType:'text/javascript',body:`globalThis.google={accounts:{oauth2:{initCodeClient:()=>({requestCode(){}})}}};`}));
 await revokePage.route('**/web/transport.js',r=>r.fulfill({contentType:'text/javascript',body:source+`
export function createTransport(config){
 const listeners=new Set();let channel;
 globalThis.__revokeCalls=[];
 const emit=data=>{for(const fn of listeners)fn({data,origin:'https://fixture.googleusercontent.com',source:sender});};
 const reply=(message,ok,result)=>emit({type:'household:response',channel,id:message.id,ok,...(ok?{result}:{error:result})});
 const sender={postMessage(message){
  if(message.method==='authLogout'){
   sessionStorage.setItem('fixture-revoked',message.payload.session);globalThis.__revokeCalls.push(message.payload.session);reply(message,true,{loggedOut:true});
  }else if(message.method==='rpc'){
   if(sessionStorage.getItem('fixture-revoked')===message.payload.session){reply(message,false,{code:'AUTH_REQUIRED',message:'revoked'});return;}
   globalThis.__stage='restore';globalThis.__rejectStage=()=>reply(message,false,{code:'BUSY',message:'一時的に接続できません。'});
   globalThis.__resolveStage=()=>reply(message,true,{role:'editor',expiresAt:Date.now()+30*86400000,state:globalThis.HouseholdDomain.emptyState()});
  }
 }};
 return unusedRealTransport(config,{
  window:{addEventListener(_,fn){listeners.add(fn);},removeEventListener(_,fn){listeners.delete(fn);}},
  document:{createElement(){return {contentWindow:{},remove(){}};},body:{append(frame){channel=new URL(frame.src).searchParams.get('channel');queueMicrotask(()=>emit({type:'household:ready',channel}));}}},crypto:globalThis.crypto
 });
}`}));
 await revokePage.goto(process.env.HOUSEHOLD_PREVIEW_URL||'http://127.0.0.1:4283');
 await revokePage.getByRole('button',{name:'Googleでログイン',exact:true}).waitFor();
 await revokePage.evaluate(saved=>localStorage.setItem('household.session.v1',JSON.stringify(saved)),saved);
 await revokePage.reload();await revokePage.waitForFunction(()=>globalThis.__stage==='restore');
 await revokePage.evaluate(()=>globalThis.__rejectStage());
 await revokePage.getByRole('heading',{name:'再接続',exact:true}).waitFor();
 assert.equal(await revokePage.locator('#logout').isVisible(),true);
 assert.deepEqual(await revokePage.evaluate(()=>JSON.parse(localStorage.getItem('household.session.v1'))),saved);
 await revokePage.locator('#logout').click();
 await revokePage.waitForFunction(()=>sessionStorage.getItem('fixture-revoked')==='a'.repeat(64));
 assert.equal(await revokePage.evaluate(()=>localStorage.getItem('household.session.v1')),null);
 // Reintroducing the old stored token after reload cannot restore a revoked session.
 await revokePage.evaluate(saved=>localStorage.setItem('household.session.v1',JSON.stringify(saved)),saved);
 await revokePage.reload();await revokePage.getByRole('heading',{name:'ログイン',exact:true}).waitFor();
 assert.equal(await revokePage.evaluate(()=>localStorage.getItem('household.session.v1')),null);
 assert.equal(await revokePage.locator('#navigation').isVisible(),false);
 await revokePage.close();
 assert.deepEqual(failures,[]);
 console.log('PASS: staged login errors/loading; reload restores and loads ledger in one RPC; transient retry keeps session; popup preparation overlaps and refreshes; bounded session only; local expiry and server denials clear storage; logout wins over prepare/exchange/load/restore and reload; storage unavailable login; no page errors. Local fixtures only.');
}finally{await browser.close();}
