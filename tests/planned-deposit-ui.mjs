// Local demo only: exercises planned deposits without Google login or cloud writes.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.HOUSEHOLD_PLAYWRIGHT_MODULE||'playwright');
const output=process.env.HOUSEHOLD_QA_OUTPUT||path.join(os.tmpdir(),'household-ui-qa');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:process.env.HOUSEHOLD_BROWSER_CHANNEL||'chrome'});
try {
  const page=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install({time:new Date('2026-10-05T23:30:00+09:00')});
  await page.route('**/runtime-config.json',r=>r.fulfill({status:404,body:'Local fixture'}));
  let app=(await readFile(new URL('../web/app.js',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
  app=app.replace('\nawait initializeConfig();\n','\nglobalThis.__householdTest={transport:()=>transport,refresh:async()=>{state=await transport.load();render();}};\nawait initializeConfig();\n');
  await page.route('**/web/app.js',r=>r.fulfill({contentType:'text/javascript',body:app}));
  await page.goto(process.env.HOUSEHOLD_PREVIEW_URL||'http://127.0.0.1:4283/');
  const click=name=>page.getByRole('button',{name,exact:true}).click();
  const saved=()=>page.locator('#message').filter({hasText:'保存しました。'}).waitFor();
  const state=()=>page.evaluate(()=>globalThis.__householdTest.transport().load());
  await click('サンプルで試す');
  await click('登録');
  assert.equal(await page.getByRole('tab',{name:'レシート'}).getAttribute('aria-selected'),'true');
  for(const tab of ['支出','積立']){
    await page.getByRole('tab',{name:tab,exact:true}).click();await click('履歴');await click('登録');
    assert.equal(await page.getByRole('tab',{name:'レシート'}).getAttribute('aria-selected'),'true');
  }
  await click('毎月の設定');
  const form=page.locator('#setting-form');
  assert.equal(await form.locator('[name=openingBalance]').isVisible(),false);
  assert.equal(await form.locator('[name=targetAmount]').isEnabled(),false);
  await form.locator('[name=name]').fill('固定の確認');
  await form.locator('[name=plannedAmount]').fill('0');
  await form.locator('[name=memo]').fill('種類を変えても保持');
  await form.locator('[name=kind]').selectOption('saving');
  await form.locator('[name=openingBalance]').fill('500');
  await form.locator('[name=targetAmount]').fill('9000');
  await form.locator('[name=kind]').selectOption('fixed');
  assert.equal(await form.locator('[name=openingBalance]').isVisible(),false);
  assert.equal(await form.locator('[name=name]').inputValue(),'固定の確認');
  assert.equal(await form.locator('[name=memo]').inputValue(),'種類を変えても保持');
  await form.locator('[name=kind]').selectOption('saving');
  assert.equal(await form.locator('[name=openingBalance]').inputValue(),'500');
  await form.locator('[name=kind]').selectOption('fixed');
  await form.getByRole('button',{name:'項目を追加'}).click();await saved();
  await page.waitForFunction(()=>document.querySelector('#main').getAttribute('aria-busy')==='false');
  const fixed=(await state()).settings.find(s=>s.name==='固定の確認');
  assert.equal(fixed.openingBalance,0);assert.equal(fixed.targetAmount,0);
  assert.equal(await page.locator('.monthly-form').count(),0,'Fixed plans do not appear in savings plans list');
  await form.locator('[name=kind]').selectOption('saving');
  await form.locator('[name=name]').fill('予定額の積立');
  await form.locator('[name=plannedAmount]').fill('9000');
  await form.locator('[name=openingBalance]').fill('500');
  await form.getByRole('button',{name:'項目を追加'}).click();
  await page.locator('.monthly-form').waitFor();
  await page.locator('.monthly-form [name=plannedAmount]').fill('12345');
  await page.getByRole('button',{name:'この月の予定を保存'}).click();await saved();
  await form.locator('[name=kind]').selectOption('saving');
  await form.locator('[name=name]').fill('ゼロ予定');
  await form.locator('[name=plannedAmount]').fill('0');
  await form.getByRole('button',{name:'項目を追加'}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.monthly-form').length===2);
  await click('ホーム');
  const row=page.locator('.saving-row').filter({hasText:'予定額の積立'});
  const openRow=async()=>{if(await row.getAttribute('open')===null)await row.locator('summary').click();};
  assert.equal(await row.getAttribute('open'),null);
  await openRow();
  const deposit=row.getByRole('button',{name:'この金額で入金'});
  assert.equal(await row.locator('.saving-plan strong').innerText(),'¥12,345');
  assert.equal(await page.locator('.saving-row').filter({hasText:'ゼロ予定'}).getByRole('button',{name:'この金額で入金',includeHidden:true}).isEnabled(),false);
  await page.locator('#month').fill('2026-11');
  await openRow();
  assert.equal(await deposit.isEnabled(),false);
  await row.getByText('予定額での入金は今月の表示で使えます。',{exact:false}).waitFor();
  await page.locator('#month').fill('2026-09');
  await openRow();
  assert.equal(await deposit.isEnabled(),false);
  assert.equal((await state()).transfers.length,0);
  await page.locator('#month').fill('2026-10');
  await openRow();
  // Hold the real demo save, then lose its response. Retry must use the same command.
  await page.evaluate(()=>{
    const t=globalThis.__householdTest.transport(),original=t.mutate;
    globalThis.__depositCommands=[];
    t.mutate=async command=>{
      if(command.type!=='saveTransfer')return original(command);
      globalThis.__depositCommands.push(structuredClone(command));
      if(globalThis.__depositCommands.length===1){
        await new Promise(resolve=>globalThis.__releaseDeposit=resolve);
        await original(command);
        throw Object.assign(new Error('通信テスト: 入金の保存結果を確認できません。'),{code:'TIMEOUT'});
      }
      return original(command);
    };
  });
  await deposit.click();
  assert.equal(await deposit.isEnabled(),false,'Busy deposit is disabled');
  await page.evaluate(()=>globalThis.__releaseDeposit());
  await page.locator('#pending').waitFor({state:'visible'});
  assert.equal(await deposit.isEnabled(),false,'Uncertain save blocks a new deposit');
  await click('登録');
  assert.equal(await page.locator('#receipt-form').count(),0,'Navigation remains on pending deposit');
  await click('同じ内容で再試行');
  await page.locator('#message').filter({hasText:'予定額の積立に¥12,345を入金しました（2026-10-05）。'}).waitFor();
  const data=await state(),commands=await page.evaluate(()=>globalThis.__depositCommands);
  assert.equal(data.transfers.length,1,'Retry did not create a second transfer');
  assert.equal(data.transfers[0].amount,12345,'Uses displayed month plan, not setting default');
  assert.equal(data.transfers[0].date,'2026-10-05','Actual date uses today JST');
  assert.equal(data.transfers[0].month,'2026-10');
  assert.deepEqual(commands[0],commands[1],'Exact operation ID, revision, amount and date retained');
  assert.equal(await row.locator('summary .saving-item-paid').innerText(),'入金済');
  await openRow();
  assert.equal(await row.getByRole('button',{name:'入金済み'}).isEnabled(),false);
  assert.equal(await row.locator('strong.number').innerText(),'¥12,845');
  assert.equal(await page.locator('.big-money').innerText(),'¥-12,345');
  await click('入金・取り崩し');
  assert.equal(await page.locator('#transfer-form').isVisible(),true,'Intentional transfer action keeps transfer form');
  await click('ホーム');
  await openRow();
  for(const width of [320,375,414,768]){
    await page.setViewportSize({width,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.ok(await row.getByRole('button',{name:'入金済み'}).evaluate(el=>el.getBoundingClientRect().height>=44));
  }
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:path.join(output,'11-planned-deposit-mobile.png'),fullPage:true});
  await page.evaluate(async()=>{
    const t=globalThis.__householdTest.transport();
    for(const [type,payload] of [
      ['saveSetting',{id:'bank-fixed-ui',kind:'fixed',name:'自動銀行固定費',plannedAmount:7000,paymentMethod:'bank',category:'必要経費'}],
      ['materializeMonth',{month:'2026-10'}]
    ]){const current=await t.load();await t.mutate({type,payload,operationId:crypto.randomUUID(),expectedRevision:current.revision});}
    await globalThis.__householdTest.refresh();
  });
  const bankPlan=(await state()).plans.find(p=>p.settingId==='bank-fixed-ui');
  assert.equal(bankPlan.bankAutoHandled,true);
  await click('登録');await page.getByRole('tab',{name:'支出',exact:true}).click();
  assert.equal(await page.locator('#expense-form [name=planId] option').evaluateAll((nodes,id)=>nodes.some(node=>node.value===id),bankPlan.id),false,'Automatically paid bank plans cannot be reselected for a new expense');
  await click('履歴');
  await page.locator('.entry').filter({hasText:'自動銀行固定費'}).getByRole('button',{name:'編集',exact:true}).click();
  assert.equal(await page.locator('#expense-form [name=planId]').inputValue(),bankPlan.id,'Intentional actual editing retains its fixed plan');
  assert.equal(await page.getByRole('tab',{name:'支出',exact:true}).getAttribute('aria-selected'),'true','Explicit expense edit keeps expense tab');
  assert.deepEqual(errors,[]);
  console.log('PASS: receipt default navigation, saving-only fields/plans, exact planned deposit with JST date, zero/other-month guards, busy/pending/idempotent retry, saved balance, mobile widths and automatic bank actual edit/duplicate-selection guards.');
  console.log('Screenshot: '+path.join(output,'11-planned-deposit-mobile.png'));
} finally {await browser.close();}
