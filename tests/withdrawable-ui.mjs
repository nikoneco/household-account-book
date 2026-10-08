// UI integration with synthetic demo data only; no Google login or cloud writes.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.HOUSEHOLD_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.HOUSEHOLD_PREVIEW_URL||'http://127.0.0.1:4283';
const output=process.env.HOUSEHOLD_QA_OUTPUT||path.join(os.tmpdir(),'household-withdrawable-qa');
await mkdir(output,{recursive:true});
const transportSource=await readFile(new URL('../web/transport.js',import.meta.url),'utf8');
const browser=await chromium.launch({headless:true,channel:process.env.HOUSEHOLD_BROWSER_CHANNEL||'chrome'});
try {
 for(const bill of [null,80000,0,250000,Number.MAX_SAFE_INTEGER]) {
  const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const seed=`
   const D=globalThis.HouseholdDomain;
   let seedId=0;
   const seed=(type,payload)=>{state=D.execute(state,{type,payload,operationId:'seed-'+(++seedId)}).state;};
   seed('saveIncome',{month:'2026-10',amount:${bill===Number.MAX_SAFE_INTEGER?0:300000}});
   seed('saveIncome',{month:'2026-09',amount:200000});
   seed('saveBill',{month:'2026-09',confirmedAmount:1000});
   seed('saveSetting',{id:'saving',kind:'saving',name:'積立',active:true,plannedAmount:0,openingBalance:30000,paymentMethod:'bank'});
   for(const [id,method,amount,fixed,date] of [
    ['bank','bank',5000,false,'2026-10-04'],['fixed','bank',60000,true,'2026-10-01'],
    ['funded','bank',7000,false,'2026-10-04'],['cash','cash',900,false,'2026-10-04'],
    ['card','card',20000,false,'2026-10-04'],['deleted','bank',4000,false,'2026-10-04'],
    ['previous','bank',1000,false,'2026-09-01']
   ]) seed('upsertExpense',{id,paymentMethod:method,amount,fixed,useDate:date,accountingMonth:date.slice(0,7),category:'食費',description:id,...(id==='funded'?{fundingSettingId:'saving'}:{})});
   seed('deleteExpense',{id:'deleted'});
   seed('saveTransfer',{id:'withdrawal',settingId:'saving',kind:'withdrawal',date:'2026-10-04',amount:7000,expenseId:'funded'});
   seed('registerReceipt',{id:'receipt',imageHash:'fixture-hash',fileName:'サンプルレシート.png'});
   seed('importReceipt',{receiptId:'receipt',merchant:'サンプル店',useDate:'2026-10-04',paymentMethod:'bank',total:2000,lines:[{lineId:'one',category:'食費',description:'レシートの銀行払い',amount:2000}]});
   ${bill===null?'':`seed('saveBill',{month:'2026-10',confirmedAmount:${bill}});`}
  `;
  const anchor='let state = globalThis.HouseholdDomain.emptyState();';
  assert.ok(transportSource.includes(anchor));
  await page.route('**/runtime-config.json',route=>route.fulfill({status:404,body:''}));
  await page.route('**/web/transport.js',route=>route.fulfill({contentType:'text/javascript',body:transportSource.replace(anchor,anchor+seed)}));
  await page.goto(origin,{waitUntil:'networkidle'});
  assert.equal(await page.title(),'家計簿');
  await page.getByRole('button',{name:'サンプルで試す',exact:true}).click();
  await page.getByRole('button',{name:'ホーム',exact:true}).click();
  await page.locator('#month').fill('2026-10');
  const panel=page.locator('#withdrawable'),value=panel.locator('[data-withdrawable-amount]');
  assert.equal(await page.locator('.ledger-foot').count(),0);
  assert.equal(await panel.locator('[data-bank-total]').innerText(),'− ¥74,000','Fixed, receipt and savings-funded bank expenses counted, deleted/other month excluded');
  assert.equal(await value.innerText(),bill===null?'カード未確定':'¥'+(BigInt(bill===Number.MAX_SAFE_INTEGER?0:300000)-BigInt(bill)-74000n).toLocaleString('ja-JP'));
  assert.equal(await value.evaluate(el=>el.classList.contains('negative')),bill===250000||bill===Number.MAX_SAFE_INTEGER);
  assert.equal(await page.locator('#card-reconciliation + #withdrawable').count(),1);
  if(bill===80000) {
   const heights=()=>page.evaluate(()=>{
    const left=document.querySelector('#outflow-breakdown').getBoundingClientRect();
    const right=document.querySelector('.home-finance-side').getBoundingClientRect();
    return {left:left.height,right:right.height,top:Math.abs(left.top-right.top),overflow:document.documentElement.scrollWidth>innerWidth};
   });
   let h=await heights();assert.ok(Math.abs(h.left-h.right)<2);assert.ok(h.top<2);assert.equal(h.overflow,false);
   await page.screenshot({path:path.join(output,'desktop.png'),fullPage:true});
   await page.locator('.outflow-category[data-category="食費"] summary').click();
   h=await heights();assert.ok(Math.abs(h.left-h.right)<2,'Desktop columns stay aligned when details expand');
   for(const width of [320,390,640]) {
    await page.setViewportSize({width,height:900});
    const expanded=(await panel.boundingBox()).height;
    await page.locator('.outflow-category[data-category="食費"] summary').click();
    const collapsed=(await panel.boundingBox()).height;
    assert.ok(Math.abs(expanded-collapsed)<2,'Mobile panel height independent of breakdown expansion');
    assert.equal((await heights()).overflow,false);
    if(width===390) await page.screenshot({path:path.join(output,'mobile.png'),fullPage:true});
    await page.locator('.outflow-category[data-category="食費"] summary').click();
   }
   await page.locator('#bill-form [name=confirmedAmount]').fill('90000');
   await page.locator('#bill-form').getByRole('button',{name:'請求額を保存',exact:true}).click();
   await page.getByRole('status').filter({hasText:'保存しました。'}).waitFor();
   assert.equal(await value.innerText(),'¥136,000','Saved bill updates withdrawal without navigation');
  }
  await page.locator('#month').fill('2026-09');
  assert.equal(await value.innerText(),'¥198,000','Uses selected month salary, confirmed bill and bank expenses');
  assert.equal(await panel.locator('[data-bank-total]').innerText(),'− ¥1,000');
  assert.deepEqual(errors,[]);
  await context.close();
 }
 console.log('PASS: missing/zero/confirmed/negative/maximum-integer bill, bank expenses incl. fixed/receipt/funded, deleted and other-month exclusion, monthly switch, saved bill redraw, desktop matching heights and mobile natural heights.');
} finally {await browser.close();}
