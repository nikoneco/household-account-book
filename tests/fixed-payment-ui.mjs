import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.HOUSEHOLD_PLAYWRIGHT_MODULE);
const origin=process.env.HOUSEHOLD_UI_ORIGIN||'http://127.0.0.1:4283/';
const output='C:/Users/aqua_/AppData/Local/Temp/household-fixed-payments';await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{
 const page=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin,{waitUntil:'networkidle'});
 const click=name=>page.getByRole('button',{name,exact:true}).click();
 const ready=()=>page.waitForFunction(()=>document.querySelector('#main').getAttribute('aria-busy')==='false');
 await click('サンプルで試す');await click('毎月の設定');
 const month=await page.locator('#month').inputValue();
 for(const [method,label,amount] of [['cash','現金固定費',1000],['bank','銀行固定費',2000],['card','カード固定費',3000]]){
  const f=page.locator('#setting-form');await f.locator('[name=kind]').selectOption('fixed');
  await f.locator('[name=name]').fill(label);await f.locator('[name=plannedAmount]').fill(String(amount));
  await f.locator('[name=paymentMethod]').selectOption(method);await f.getByRole('button',{name:'項目を追加',exact:true}).click();await ready();
 }
 await click('履歴');
 assert.equal(await page.locator('.entry').count(),3);
 for(const name of ['現金固定費','銀行固定費','カード固定費']){
  const row=page.locator('.entry').filter({hasText:name});await row.getByRole('button',{name:'編集',exact:true}).click();
  const f=page.locator('#expense-form');assert.equal(await f.locator('[name=useDate]').inputValue(),month+'-01');
  assert.equal(await f.locator('[name=accountingMonth]').inputValue(),month);
  await click('キャンセル');await click('履歴');
 }
 await click('ホーム');assert.equal(await page.locator('.big-money').innerText(),'¥-6,000');
 const cardPanel=page.locator('.panel').filter({has:page.getByRole('heading',{name:'カードの照合',exact:true})});
 assert.match(await cardPanel.innerText(),/¥3,000/);
 await click('登録');await page.getByRole('tab',{name:'支出',exact:true}).click();
 const f=page.locator('#expense-form');await f.locator('[name=useDate]').fill(month+'-28');await f.locator('[name=paymentMethod]').selectOption('card');
 const billingMonth=await f.locator('[name=accountingMonth]').inputValue();assert.notEqual(billingMonth,month);
 await f.locator('.expense-options summary').click();await f.locator('[name=fixed]').check();
 assert.equal(await f.locator('[name=useDate]').inputValue(),month+'-01');assert.equal(await f.locator('[name=accountingMonth]').inputValue(),month);
 await f.locator('[name=amount]').fill('400');await f.locator('[name=description]').fill('固定費の補足');
 await f.getByRole('button',{name:'支出を保存',exact:true}).click();await ready();
 await click('履歴');assert.equal(await page.locator('.entry').count(),4);
 for(const width of [320,390,768]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:output+(origin.includes('github')?'/public.png':'/local.png'),fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('PASS: all three fixed payment methods automatically appear once on day one in the same month; normal card month, manual fixed date, edit and responsive views.');
}finally{await browser.close();}
