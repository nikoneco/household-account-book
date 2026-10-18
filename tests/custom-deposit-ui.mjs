// Sample data only: custom deposits never reach the production ledger.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
const {chromium}=createRequire(import.meta.url)(process.env.HOUSEHOLD_PLAYWRIGHT_MODULE||'playwright');
const output=process.env.HOUSEHOLD_QA_OUTPUT||path.join(os.tmpdir(),'household-custom-deposit');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:process.env.HOUSEHOLD_BROWSER_CHANNEL||'chrome'});
try{
  const page=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install({time:new Date('2026-09-18T23:30:00+09:00')});
  await page.route('**/runtime-config.json',r=>r.fulfill({status:404,body:'Local sample fixture'}));
  let app=(await readFile(new URL('../web/app.js',import.meta.url),'utf8')).replaceAll('\r\n','\n');
  app=app.replace('\nawait initializeConfig();\n','\nglobalThis.__customTest={transport:()=>transport,role:value=>{sessionRole=value;render();}};\nawait initializeConfig();\n');
  await page.route('**/web/app.js*',r=>r.fulfill({contentType:'text/javascript',body:app}));
  await page.goto(process.env.HOUSEHOLD_PREVIEW_URL||'http://127.0.0.1:4283/');
  assert.equal(await page.title(),'家計簿');
  const click=name=>page.getByRole('button',{name,exact:true}).click();
  const ready=()=>page.waitForFunction(()=>document.querySelector('#main').getAttribute('aria-busy')==='false');
  const state=()=>page.evaluate(()=>__customTest.transport().load());
  await click('サンプルで試す');await click('毎月の設定');
  for(const [name,amount,opening] of [['旅行積立',5000,100],['ゼロ予定',0,0]]){
    const f=page.locator('#setting-form');await f.locator('[name=kind]').selectOption('saving');
    await f.locator('[name=name]').fill(name);await f.locator('[name=plannedAmount]').fill(String(amount));
    await f.locator('[name=openingBalance]').fill(String(opening));
    await f.getByRole('button',{name:'項目を追加'}).click();await ready();
    await page.waitForFunction(count=>document.querySelectorAll('.monthly-form').length===count,name==='旅行積立'?1:2);
  }
  await page.clock.setFixedTime(new Date('2026-10-18T23:30:00+09:00'));
  await click('ホーム');await page.locator('#month').fill('2026-10');await ready();
  const row=page.locator('.saving-row').filter({hasText:'旅行積立'}),form=row.locator('.custom-deposit-form');
  const opener=row.getByRole('button',{name:'金額を変更して入金',exact:true});
  const openRow=async()=>{if(await row.getAttribute('open')===null)await row.locator('summary').click();};
  const openCustom=async()=>{await openRow();await opener.click();};
  const save=async amount=>{await form.locator('[name=amount]').fill(String(amount));await form.getByRole('button',{name:'入金する',exact:true}).click();await ready();};
  await openCustom();assert.equal(await opener.getAttribute('aria-expanded'),'true');
  assert.equal(await form.locator('[name=amount]').inputValue(),'5000');
  assert.equal(await form.locator('[name=amount]').evaluate(e=>e===document.activeElement),true);
  assert.equal(await form.locator('[data-deposit-date]').innerText(),'2026-10-18');
  for(const value of ['', '0', '-1', '1.5', '9007199254740992']){
    await form.locator('[name=amount]').fill(value);
    assert.equal(await form.evaluate(e=>e.checkValidity()),false,value+' must be rejected');
    await form.getByRole('button',{name:'入金する',exact:true}).click();
    assert.equal((await state()).transfers.length,0);
  }
  await form.locator('[name=amount]').fill('1500');await form.getByRole('button',{name:'キャンセル'}).click();
  assert.equal(await form.isVisible(),false);assert.equal(await opener.getAttribute('aria-expanded'),'false');
  assert.equal(await opener.evaluate(e=>e===document.activeElement),true);assert.equal((await state()).transfers.length,0);
  await openCustom();assert.equal(await form.locator('[name=amount]').inputValue(),'5000');
  for(const width of [320,390,768,1280]){
    await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  }
  await page.setViewportSize({width:390,height:844});await row.screenshot({path:path.join(output,'custom-deposit-input.png')});
  await save(2500);let data=await state();
  assert.equal(data.transfers[0].date,'2026-10-18');assert.equal(data.transfers[0].amount,2500);
  assert.equal(data.transfers[0].month,'2026-10');assert.equal(await row.locator('.saving-item-paid').count(),0);
  const setting=data.settings.find(s=>s.name==='旅行積立');
  assert.equal(setting.plannedAmount,5000);assert.equal(data.plans.find(p=>p.month==='2026-10'&&p.settingId===setting.id).plannedAmount,5000);
  await openCustom();await save(3000);await openRow();
  assert.equal(await row.locator('summary .saving-item-paid').innerText(),'入金済');
  assert.equal(await row.getByRole('button',{name:'入金済み',exact:true}).isEnabled(),false);
  assert.equal(await opener.isEnabled(),true,'Paid items can receive an additional deposit');
  await openCustom();await save(1);assert.equal((await state()).transfers.length,3);
  const zero=page.locator('.saving-row').filter({hasText:'ゼロ予定'});await zero.locator('summary').click();
  assert.equal(await zero.getByRole('button',{name:'この金額で入金'}).isEnabled(),false);
  await zero.getByRole('button',{name:'金額を変更して入金'}).click();
  const zeroForm=zero.locator('.custom-deposit-form');assert.equal(await zeroForm.locator('[name=amount]').inputValue(),'');
  await zeroForm.locator('[name=amount]').fill('700');await zeroForm.getByRole('button',{name:'入金する',exact:true}).click();await ready();
  assert.equal((await state()).transfers.at(-1).amount,700);assert.equal(await zero.locator('.saving-item-paid').count(),0);
  for(const [target,amount] of [['2026-11',4321],['2026-09',1234]]){
    await page.locator('#month').fill(target);await ready();await openCustom();
    assert.equal(await form.locator('[data-deposit-date]').innerText(),target+'-01');await save(amount);
    data=await state();assert.equal(data.transfers.at(-1).date,target+'-01');assert.equal(data.transfers.at(-1).month,target);
  }
  await page.locator('#month').fill('2026-11');await ready();await openCustom();
  await page.evaluate(()=>{
    const t=__customTest.transport(),original=t.mutate;globalThis.__customCommands=[];
    t.mutate=async command=>{
      if(command.type!=='saveTransfer')return original(command);
      __customCommands.push(structuredClone(command));
      if(__customCommands.length===1){await new Promise(resolve=>globalThis.__releaseCustom=resolve);await original(command);throw Object.assign(new Error('通信テスト: 保存結果を確認できません。'),{code:'TIMEOUT'});}
      return original(command);
    };
  });
  await form.locator('[name=amount]').fill('876');await form.getByRole('button',{name:'入金する',exact:true}).click();
  assert.equal(await opener.isEnabled(),false);assert.equal(await form.locator('[name=amount]').getAttribute('readonly'),'');
  await page.evaluate(()=>__releaseCustom());await page.locator('#pending').waitFor({state:'visible'});
  assert.equal(await opener.isEnabled(),false);assert.equal(await form.getByRole('button',{name:'キャンセル'}).isEnabled(),false);
  await click('同じ内容で再試行');await ready();data=await state();
  const commands=await page.evaluate(()=>__customCommands);assert.equal(commands.length,2);assert.deepEqual(commands[0],commands[1]);
  assert.equal(data.transfers.length,7);assert.equal(data.transfers.at(-1).amount,876);assert.equal(data.transfers.at(-1).date,'2026-11-01');
  await page.evaluate(()=>__customTest.role('viewer'));await openRow();
  assert.equal(await opener.isVisible(),false);await row.locator('[data-action="custom-deposit"]').dispatchEvent('click');assert.equal(await form.isVisible(),false);
  assert.equal((await state()).transfers.length,7);assert.deepEqual(errors,[]);
  console.log('PASS: inline custom amount, focus/cancel/reset, invalid values, unchanged plans, partial/paid/extra/zero deposits, today/past/future dates, busy/pending immutable retry, viewer guard and 320/390/768/1280px.');
  console.log('Screenshot: '+path.join(output,'custom-deposit-input.png'));
}finally{await browser.close();}
