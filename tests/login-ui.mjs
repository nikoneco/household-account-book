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
 return {...t,prepareLogin:async()=>{await stage('prepare');return {state:'fixture'};},login:async()=>{await stage('exchange');return {role:'editor'};},load:async()=>{await stage('load');return t.load();}};
}`}));
await page.route('**/runtime-config.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({mode:'google',clientId:'fixture',bridgeUrl:'https://script.google.com/macros/s/fixture/exec'})}));
await page.route('https://accounts.google.com/gsi/client',r=>r.fulfill({contentType:'text/javascript',body:`globalThis.google={accounts:{oauth2:{initCodeClient:options=>({requestCode:()=>{globalThis.__loginCompletion=options.callback({code:'fixture'});}})}}};`}));
const stage=async name=>page.waitForFunction(expected=>globalThis.__stage===expected,name);
const loading=async()=>{
 await page.getByRole('heading',{name:'読み込み中',exact:true}).waitFor();
 assert.equal(await page.locator('#main').getAttribute('aria-busy'),'true');
 assert.equal(await page.locator('#google-login').count(),0);
 assert.equal(await page.locator('#demo-login').count(),0);
 await page.getByRole('status').filter({hasText:'家計簿を読み込んでいます…'}).waitFor();
};
const resolve=()=>page.evaluate(()=>globalThis.__resolveStage());
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
  await page.getByRole('heading',{name:'ログイン',exact:true}).waitFor();
  assert.equal(await page.locator('#main').getAttribute('aria-busy'),'false');
  assert.equal(await page.getByRole('button',{name:'Googleでログイン',exact:true}).isEnabled(),true);
  assert.equal(await page.locator('#navigation').isVisible(),false);
 }
 await page.getByRole('button',{name:'Googleでログイン',exact:true}).click();
 for(const name of ['prepare','exchange','load']){
  await stage(name);await loading();
  if(name==='load'){
   const out=path.join(os.tmpdir(),'household-ui-qa');await mkdir(out,{recursive:true});
   await page.screenshot({path:path.join(out,'11-login-loading.png')});
  }
  await resolve();
 }
 await page.getByText('今月の残り',{exact:true}).waitFor();
 assert.equal(await page.locator('#main').getAttribute('aria-busy'),'false');
 assert.equal(await page.locator('#navigation').isVisible(),true);
 assert.equal(await page.getByRole('heading',{name:'読み込み中'}).count(),0);
 await page.reload();
 await page.getByRole('heading',{name:'ログイン',exact:true}).waitFor();
 assert.deepEqual(failures,[]);
 console.log('PASS: loading across prepare/exchange/load, no duplicate login/demo controls, errors at each stage restore retry, successful home, reload returns sign-in. Local fixtures only.');
}finally{await browser.close();}
