// Local sample only; decisions and deposits never reach production.
import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {readFile,mkdir} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
const {chromium}=createRequire(import.meta.url)(process.env.HOUSEHOLD_PLAYWRIGHT_MODULE||'playwright');
const output=path.join(os.tmpdir(),'household-skipped-deposit');await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{
 const page=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.clock.install({time:new Date('2026-10-18T16:00:00+09:00')});
 await page.route('**/runtime-config.json',r=>r.fulfill({status:404,body:'Local fixture'}));
 let app=(await readFile(new URL('../web/app.js',import.meta.url),'utf8')).replaceAll('\r\n','\n');
 app=app.replace('\nawait initializeConfig();\n','\nglobalThis.__skipTest={transport:()=>transport,role:value=>{sessionRole=value;render();}};\nawait initializeConfig();\n');
 await page.route('**/web/app.js*',r=>r.fulfill({contentType:'text/javascript',body:app}));await page.goto('http://127.0.0.1:4283/');
 const click=name=>page.getByRole('button',{name,exact:true}).click(),ready=()=>page.waitForFunction(()=>document.querySelector('#main').getAttribute('aria-busy')==='false');
 const state=()=>page.evaluate(()=>__skipTest.transport().load());
 await click('サンプルで試す');await click('毎月の設定');
 for(const [name,amount] of [['旅行',5000],['ゼロ予定',0],['競合',1000]]){
  const f=page.locator('#setting-form');await f.locator('[name=kind]').selectOption('saving');await f.locator('[name=name]').fill(name);
  await f.locator('[name=plannedAmount]').fill(String(amount));await f.locator('[name=openingBalance]').fill('100');
  await f.getByRole('button',{name:'項目を追加'}).click();await ready();
  await page.waitForFunction(count=>document.querySelectorAll('.monthly-form').length===count,name==='旅行'?1:name==='ゼロ予定'?2:3);
 }
 await click('ホーム');const row=page.locator('.saving-row').filter({hasText:'旅行'});
 const open=async()=>{if(await row.getAttribute('open')===null)await row.locator('summary').click();};
 const toggle=async name=>{await open();await row.getByRole('button',{name,exact:true}).click();await ready();};
 await toggle('今月入金無し');assert.equal(await row.getAttribute('open'),null);assert.equal(await row.locator('summary .saving-item-skipped').innerText(),'入金なし');
 assert.equal(await row.locator('summary strong').innerText(),'¥100');assert.equal(await page.locator('.big-money').innerText(),'¥0');
 let data=await state();assert.equal(data.transfers.length,0);assert.equal(data.plans.find(p=>p.name==='旅行').plannedAmount,5000);
 await open();assert.equal(await row.getByRole('button',{name:'この金額で入金'}).isEnabled(),false);
 assert.equal(await row.getByRole('button',{name:'金額を変更して入金'}).isEnabled(),false);
 await row.locator('[data-action="custom-deposit"]').dispatchEvent('click');assert.equal(await row.locator('.custom-deposit-form').isVisible(),false);
 await click('毎月の設定');await click('ホーム');assert.equal(await row.locator('.saving-item-skipped').innerText(),'入金なし');
 await page.locator('#month').fill('2026-11');await ready();assert.equal(await row.locator('.saving-item-skipped').count(),0);
 await toggle('今月入金無し');await toggle('入金無しを取り消す');assert.equal(await row.locator('.saving-item-skipped').count(),0);
 await page.locator('#month').fill('2026-10');await ready();assert.equal(await row.locator('.saving-item-skipped').innerText(),'入金なし');
 await toggle('入金無しを取り消す');
 await page.evaluate(()=>{
  const t=__skipTest.transport(),original=t.mutate;globalThis.__skipCommands=[];
  t.mutate=async command=>{
   if(command.type!=='setDepositSkipped')return original(command);__skipCommands.push(structuredClone(command));
   if(__skipCommands.length===1){await new Promise(resolve=>globalThis.__releaseSkip=resolve);await original(command);throw Object.assign(new Error('通信テスト: 結果不明'),{code:'TIMEOUT'});}return original(command);
  };
 });
 await open();await row.getByRole('button',{name:'今月入金無し',exact:true}).click();
 assert.equal(await row.getByRole('button',{name:'今月入金無し',exact:true}).isEnabled(),false);
 await page.evaluate(()=>__releaseSkip());await page.locator('#pending').waitFor({state:'visible'});
 await page.locator('#month').fill('2026-11');assert.equal(await page.locator('#month').inputValue(),'2026-10');
 await click('同じ内容で再試行');await ready();
 const commands=await page.evaluate(()=>__skipCommands);assert.deepEqual(commands[0],commands[1]);
 assert.equal(await row.locator('.saving-item-skipped').innerText(),'入金なし');
 for(const width of [320,375,390,768,1280]){await page.setViewportSize({width,height:844});await open();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
 await page.setViewportSize({width:390,height:844});await row.screenshot({path:path.join(output,'skipped-month-mobile.png')});
 // A real deposit through the existing manual form supersedes the decision.
 data=await state();const id=data.settings.find(s=>s.name==='旅行').id;
 await click('入金・取り崩し');const f=page.locator('#transfer-form');await f.locator('[name=settingId]').selectOption(id);
 await f.locator('[name=amount]').fill('1000');await f.getByRole('button',{name:'実際の移動を保存'}).click();await ready();await click('ホーム');await open();
 assert.equal(await row.locator('.saving-item-skipped').count(),0);assert.equal(await row.getByRole('button',{name:'今月入金無し',exact:true}).isEnabled(),false);
 assert.equal(await row.getByRole('button',{name:'金額を変更して入金'}).isEnabled(),true);
 const zero=page.locator('.saving-row').filter({hasText:'ゼロ予定'});await zero.locator('summary').click();await zero.getByRole('button',{name:'今月入金無し'}).click();await ready();
 assert.equal(await zero.locator('.saving-item-skipped').innerText(),'入金なし');
 await page.locator('#month').fill('2026-09');await ready();await toggle('今月入金無し');
 data=await state();assert.equal(data.plans.find(p=>p.month==='2026-09'&&p.settingId===id).plannedAmount,0);assert.equal(data.transfers.length,1);
 await page.evaluate(()=>__skipTest.role('viewer'));await open();assert.equal(await row.locator('[data-action="toggle-deposit-skip"]').isVisible(),false);
 const revision=(await state()).revision;await row.locator('[data-action="toggle-deposit-skip"]').dispatchEvent('click');assert.equal((await state()).revision,revision);
 assert.deepEqual(errors,[]);console.log('PASS: persistent monthly decision across navigation, other-month isolation, collapsed badge, undo, unchanged budgets/balances, zero/missing past plan, busy/pending immutable retry, manual deposit clears decision, existing-deposit/viewer guards, 320/375/390/768/1280px.');
 console.log('Screenshot: '+path.join(output,'skipped-month-mobile.png'));
}finally{await browser.close();}
