// Own-browser sample data only. Can verify the published UI without cloud writes.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const {chromium}=createRequire(import.meta.url)(process.env.HOUSEHOLD_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.HOUSEHOLD_UI_ORIGIN||'http://127.0.0.1:4283/';
const output='C:/Users/aqua_/AppData/Local/Temp/household-settings-savings';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
const contrast=(a,b)=>{
  const luminance=c=>c.match(/\d+/g).slice(0,3).map(Number).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((s,n,i)=>s+n*[.2126,.7152,.0722][i],0);
  const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
};
try{
  const page=await browser.newPage({viewport:{width:375,height:844},serviceWorkers:'block'}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin,{waitUntil:'networkidle'});
  const click=name=>page.getByRole('button',{name,exact:true}).click();
  const ready=()=>page.waitForFunction(()=>document.querySelector('#main').getAttribute('aria-busy')==='false');
  await click('サンプルで試す');await click('毎月の設定');
  for(const [kind,name,amount,category] of [
    ['saving','コンタクトレンズ',100,'積立'],['fixed','通信費',100,'必要経費'],
    ['saving','乳液',100,'美容'],['fixed','衣類の定期購入',100,'被服費'],
    ['saving','たかちゃん誕生日',0,'積立']
  ]){
    const f=page.locator('#setting-form');await f.locator('[name=kind]').selectOption(kind);
    await f.locator('[name=name]').fill(name);await f.locator('[name=plannedAmount]').fill(String(amount));
    await f.locator('[name=category]').selectOption(category);
    if(kind==='saving')await f.locator('[name=openingBalance]').fill('1000');
    await f.getByRole('button',{name:'項目を追加',exact:true}).click();await ready();
    await page.locator('.setting-row').filter({hasText:name}).waitFor();
    if(kind==='saving')await page.locator('.monthly-form').filter({hasText:name}).waitFor();
    await ready();
  }
  assert.deepEqual(await page.locator('[data-setting-kind]').evaluateAll(ns=>ns.map(n=>n.dataset.settingKind)),['fixed','saving']);
  assert.deepEqual(await page.locator('[data-setting-kind=fixed] h3').allTextContents(),['通信費','衣類の定期購入']);
  assert.deepEqual(await page.locator('[data-setting-kind=saving] h3').allTextContents(),['コンタクトレンズ','乳液','たかちゃん誕生日']);
  const fixed=page.locator('[data-setting-kind=fixed]'),saving=page.locator('[data-setting-kind=saving]');
  const surfaces=await page.locator('[data-setting-kind]').evaluateAll(ns=>ns.map(n=>getComputedStyle(n).backgroundColor));
  assert.notEqual(surfaces[0],surfaces[1]);
  if(!origin.includes('github')){
    const groups=await page.locator('[data-setting-kind]').evaluateAll(ns=>ns.map(n=>n.outerHTML).join(''));
    await writeFile('.local/settings-groups-preview.html',`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>毎月の設定・表示確認</title><style>${await readFile('web/style.css','utf8')}</style><body><main class="app-shell"><h1>毎月の設定</h1>${groups}</main></body></html>`);
  }
  for(const group of [fixed,saving]){
    const colors=await group.evaluate(n=>({fg:getComputedStyle(n.querySelector('h2')).color,bg:getComputedStyle(n).backgroundColor}));
    assert.ok(contrast(colors.fg,colors.bg)>=4.5,JSON.stringify(colors));
  }
  for(const width of [320,375,414,768]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
  await page.setViewportSize({width:375,height:844});
  await page.screenshot({path:output+'/'+(origin.includes('github')?'public':'local')+'-settings.png',fullPage:true});
  await click('ホーム');
  const row=name=>page.locator('details.saving-item').filter({hasText:name});
  assert.equal(await page.locator('details.saving-item[open]').count(),0);
  assert.equal(await page.locator('.saving-item-paid').count(),0);
  assert.equal(await row('コンタクトレンズ').locator('strong.number').innerText(),'¥1,000');
  await row('コンタクトレンズ').locator('summary').focus();await page.keyboard.press('Enter');
  assert.equal(await row('コンタクトレンズ').getAttribute('open'),'');
  assert.equal(await row('乳液').getAttribute('open'),null);
  await page.keyboard.press('Space');assert.equal(await row('コンタクトレンズ').getAttribute('open'),null);
  await row('コンタクトレンズ').locator('summary').click();
  await row('コンタクトレンズ').getByRole('button',{name:'この金額で入金',exact:true}).click();await ready();
  assert.equal(await row('コンタクトレンズ').locator('summary .saving-item-paid').innerText(),'入金済');
  assert.equal(await row('コンタクトレンズ').locator('strong.number').innerText(),'¥1,100');
  await click('入金・取り崩し');
  const f=page.locator('#transfer-form');
  const id=await f.locator('[name=settingId] option').filter({hasText:'乳液'}).getAttribute('value');
  await f.locator('[name=settingId]').selectOption(id);await f.locator('[name=amount]').fill('40');
  await f.getByRole('button',{name:'実際の移動を保存',exact:true}).click();await ready();await click('ホーム');
  assert.equal(await row('乳液').locator('.saving-item-paid').count(),0,'Partial deposit is not paid');
  assert.equal(await row('たかちゃん誕生日').locator('.saving-item-paid').count(),0,'Zero plan is not paid');
  await row('乳液').locator('summary').click();
  assert.equal(await row('乳液').locator('.account-line').filter({hasText:'今月の積立入金'}).innerText(),'今月の積立入金\n¥40');
  await click('入金・取り崩し');await f.locator('[name=settingId]').selectOption(id);
  await f.locator('[name=amount]').fill('70');await f.getByRole('button',{name:'実際の移動を保存',exact:true}).click();await ready();await click('ホーム');
  assert.equal(await row('乳液').locator('summary .saving-item-paid').innerText(),'入金済','Over plan deposit is paid');
  await click('履歴');page.once('dialog',d=>d.accept());
  await page.locator('.entry').filter({hasText:'乳液'}).filter({hasText:'¥70'}).getByRole('button',{name:'削除',exact:true}).click();await ready();await click('ホーム');
  assert.equal(await row('乳液').locator('.saving-item-paid').count(),0,'Deleted deposit removes badge');
  for(const width of [320,375,414,768]){
    await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.ok(await row('コンタクトレンズ').locator('summary').evaluate(n=>n.getBoundingClientRect().height>=44));
  }
  await page.setViewportSize({width:375,height:844});
  await page.screenshot({path:output+'/'+(origin.includes('github')?'public':'local')+'-savings.png',fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('PASS: separate fixed/saving groups and colors, contrast, independent native accordions, closed balances, complete/partial/zero/excess/deleted deposit badges, 320/375/414/768px.');
}finally{await browser.close();}
