// Browser plugin not available. Real Chrome with local synthetic data only.
// Flow: review count on every page -> notice opens/focuses receipt -> request
// reanalysis removes each review -> zero hides notice; logout hides private UI.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import vm from 'node:vm';
const require=createRequire(import.meta.url),{chromium}=require(process.env.HOUSEHOLD_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.HOUSEHOLD_PREVIEW_URL||'http://127.0.0.1:4383';
const output=process.env.HOUSEHOLD_QA_OUTPUT||path.join(os.tmpdir(),'household-review-info-qa');await mkdir(output,{recursive:true});
const runtime={};vm.runInNewContext(await readFile(new URL('../shared/domain.js',import.meta.url),'utf8'),runtime);
const D=runtime.HouseholdDomain;let seed=D.emptyState(),number=0;
const run=(type,payload)=>seed=D.execute(seed,{type,payload,operationId:'seed-'+(++number)},{now:'2026-10-21T03:00:00.000Z',uuid:()=>`fixture-${++number}`}).state;
for(const id of ['review-one','review-two','pending','imported','failed','deleted'])run('registerReceipt',{id,imageHash:id,fileName:id+'.jpg'});
for(const id of ['review-one','review-two','deleted'])run('setReceiptStatus',{id,status:'needsReview',reason:'支払方法の確認が必要です。'});
run('setReceiptStatus',{id:'failed',status:'failed',reason:'保存失敗'});run('deleteReceipt',{id:'deleted'});
run('importReceipt',{receiptId:'imported',useDate:'2026-10-20',paymentMethod:'cash',total:100,lines:[{lineId:'one',amount:100,category:'食費',description:'テスト商品'}]});
let source=await readFile(new URL('../web/transport.js',import.meta.url),'utf8');
source=source.replace('let state = globalThis.HouseholdDomain.emptyState();',`let state = ${JSON.stringify(seed)};`);
const app=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
const hook=`\nglobalThis.__reviewFixture={phase(value){dataPhase=value;setBusy(false);},busy(value){setBusy(value);},pending(value){pendingCommand=value?{type:'fixture'}:null;setBusy(false);},role(value){sessionRole=value;render();}};`;
const browser=await chromium.launch({headless:true,channel:'chrome'}),errors=[];
const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'}),page=await context.newPage();
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/runtime-config.json',r=>r.fulfill({status:404,body:'Not configured'}));
await page.route('**/web/transport.js',r=>r.fulfill({contentType:'text/javascript',body:source}));
await page.route('**/web/app.js*',r=>r.fulfill({contentType:'text/javascript',body:app+hook}));
await page.route('https://**/*',r=>r.abort());
const click=name=>page.getByRole('button',{name,exact:true}).click();
try{
 await page.goto(origin);assert.equal(await page.title(),'家計簿');assert.equal(await page.locator('#receipt-review-info').isVisible(),false);
 await click('サンプルで試す');await page.getByText('確認待ちのレシート：2件',{exact:true}).waitFor();
 const info=page.locator('#receipt-review-info'),opener=page.locator('#receipt-review-open');
 for(const name of ['ホーム','登録','履歴','毎月の設定']){await click(name);assert.equal(await info.isVisible(),true);assert.equal(await page.locator('#receipt-review-text').innerText(),'確認待ちのレシート：2件');}
 await click('ホーム');
 const requests=[];const observe=request=>requests.push(request.url());page.on('request',observe);
 await click('確認する');
 assert.equal(await page.getByRole('tab',{name:'レシート',exact:true}).getAttribute('aria-selected'),'true');
 assert.equal(await page.locator('#saved-receipts').getAttribute('open'),'');
 assert.equal(await page.evaluate(()=>document.activeElement?.dataset.receiptStatus),'needsReview');
 page.off('request',observe);assert.deepEqual(requests,[]);
 for(const width of [320,390,768,1280]){
  await page.setViewportSize({width,height:900});await click('ホーム');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.ok((await info.boundingBox()).y<(await page.locator('main').boundingBox()).y);
  if([390,1280].includes(width))await page.screenshot({path:path.join(output,'notice-'+width+'.png')});
 }
 await page.evaluate(()=>__reviewFixture.phase('refreshing'));assert.match(await info.innerText(),/前回の情報では/);assert.equal(await opener.isEnabled(),true);
 await click('確認する');assert.equal(await page.locator('#receipt-form button[type=submit]').isEnabled(),false);
 await page.evaluate(()=>__reviewFixture.phase('error'));assert.match(await info.innerText(),/前回の情報では/);
 await page.evaluate(()=>__reviewFixture.phase('ready'));await click('ホーム');
 for(const flag of ['busy','pending']){
  await page.evaluate(flag=>__reviewFixture[flag](true),flag);assert.equal(await opener.isEnabled(),false);
  await page.dispatchEvent('#receipt-review-open','click');assert.equal(await page.getByRole('tab',{name:'レシート',exact:true}).count(),0);
  await page.evaluate(flag=>__reviewFixture[flag](false),flag);
 }
 await page.evaluate(()=>__reviewFixture.role('viewer'));assert.equal(await info.isVisible(),true);assert.equal(await opener.isVisible(),false);
 await page.dispatchEvent('#receipt-review-open','click');assert.equal(await page.getByRole('tab',{name:'レシート',exact:true}).count(),0);
 await page.evaluate(()=>__reviewFixture.role('editor'));
 for(const remaining of [1,0]){
  await click('確認する');await page.locator('.receipt-row[data-receipt-status="needsReview"]').first().getByRole('button',{name:'再解析を依頼',exact:true}).click();
  await page.locator('#receipt-reanalysis-form textarea').fill('現金で支払いました。');await page.locator('#receipt-reanalysis-form button[type=submit]').click();
  await page.getByText('解析待ちにしました。次の定期処理で補足を参考に解析します。',{exact:true}).waitFor();
  if(remaining)assert.equal(await page.locator('#receipt-review-text').innerText(),`確認待ちのレシート：${remaining}件`);
  else assert.equal(await info.isVisible(),false);
 }
 await click('ログアウト');await page.getByRole('heading',{name:'ログイン',exact:true}).waitFor();assert.equal(await info.isVisible(),false);
 assert.deepEqual(errors,[]);
 console.log('PASS: review-only count, every page, no-request focused jump, cached/error qualifier, busy/pending/viewer guards,2->1->0 reanalysis,logout,320/390/768/1280px. '+output);
}finally{await context.close();await browser.close();}
