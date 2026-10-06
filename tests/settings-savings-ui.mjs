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
  for(const [kind,name,amount] of [
    ['saving','コンタクトレンズ',100,'積立'],['fixed','通信費',100,'必要経費'],
    ['saving','乳液',100,'美容'],['fixed','衣類の定期購入',100,'被服費'],
    ['saving','たかちゃん誕生日',0,'積立']
  ]){
    const f=page.locator('#setting-form');await f.locator('[name=kind]').selectOption(kind);
    await f.locator('[name=name]').fill(name);await f.locator('[name=plannedAmount]').fill(String(amount));
    assert.equal(await f.locator('[name=category]').count(),0,'Monthly classification follows kind, with no selector');
    if(kind==='saving')await f.locator('[name=openingBalance]').fill('1000');
    await f.getByRole('button',{name:'項目を追加',exact:true}).click();await ready();
    await page.locator('.setting-row').filter({hasText:name}).waitFor();
    if(kind==='saving')await page.locator('.monthly-form').filter({hasText:name}).waitFor();
    await ready();
  }
  assert.deepEqual(await page.locator('[data-setting-kind]').evaluateAll(ns=>ns.map(n=>n.dataset.settingKind)),['saving','fixed']);
  assert.deepEqual(await page.locator('[data-setting-total]').evaluateAll(ns=>ns.map(n=>n.dataset.settingTotal)),['saving','fixed']);
  for(const kind of ['saving','fixed']){
    const group=page.locator(`[data-setting-kind=${kind}]`);
    for(const text of await group.locator('.setting-row .muted').allTextContents())assert.ok(text.includes(kind==='saving'?'積立':'固定費'),text);
    await group.getByRole('button',{name:'編集',exact:true}).first().click();
    assert.equal(await page.locator('#setting-form [name=category]').count(),0,'Editing has no classification selector either');
    await click('キャンセル');
  }
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
  const order=['食費','酒','外食','趣味','被服費','美容','必要経費','積立','固定費','その他'];
  assert.deepEqual(await page.locator('.outflow-category').evaluateAll(ns=>ns.map(n=>n.dataset.category)),order);
  const outflow=category=>page.locator('.outflow-category').filter({has:page.locator(`summary > span`,{hasText:new RegExp('^'+category+'$')})});
  assert.equal(await outflow('固定費').locator('summary strong').innerText(),'¥200');
  assert.equal(await outflow('積立').locator('summary strong').innerText(),'¥140');
  assert.equal(await outflow('必要経費').locator('summary strong').innerText(),'¥0');
  assert.equal(await page.locator('[data-outflow-total]').innerText(),'¥340');
  const requests=[];page.on('request',r=>requests.push(r.url()));
  await page.context().setOffline(true);
  await outflow('固定費').locator('summary').click();
  await outflow('積立').locator('summary').click();
  await outflow('その他').locator('summary').click();
  await row('コンタクトレンズ').locator('summary').click();
  await row('たかちゃん誕生日').locator('summary').click();
  assert.equal(await outflow('固定費').locator('.outflow-entry').count(),2);
  assert.equal(await outflow('積立').locator('.outflow-entry').count(),2);
  assert.equal(await outflow('その他').locator('.hint').innerText(),'この分類の出費はありません。');
  assert.deepEqual(requests,[],'Accordion expansion uses only loaded device data');
  await page.context().setOffline(false);
  const hierarchy=await page.evaluate(()=>{
    const bg=n=>getComputedStyle(n).backgroundColor;
    const q=s=>document.querySelector(s);
    return {outflowHeading:bg(q('[data-category="固定費"] summary')),outflowBody:bg(q('[data-category="固定費"] .outflow-category-items')),outflowStripe:bg(q('[data-category="固定費"] .outflow-entry:nth-child(2)')),savingHeading:bg(q('.saving-item[open] summary')),savingBody:bg(q('.saving-item[open] .saving-item-body')),savingStripe:bg(q('.saving-item[open] .account-line:nth-child(2)'))};
  });
  assert.notEqual(hierarchy.outflowHeading,hierarchy.outflowBody);
  assert.notEqual(hierarchy.outflowStripe,hierarchy.outflowBody);
  assert.notEqual(hierarchy.savingHeading,hierarchy.savingBody);
  assert.notEqual(hierarchy.savingStripe,hierarchy.savingBody);
  const textColors=await page.locator('.outflow-category[open] summary,.outflow-entry,.outflow-entry .muted,.saving-item[open] summary,.saving-item[open] .account-line,.saving-item[open] .hint').evaluateAll(ns=>ns.map(n=>{
    let parent=n,bg;while(parent){bg=getComputedStyle(parent).backgroundColor;if(bg!=='rgba(0, 0, 0, 0)')break;parent=parent.parentElement;}
    return {fg:getComputedStyle(n).color,bg};
  }));
  const minContrast=Math.min(...textColors.map(c=>contrast(c.fg,c.bg)));
  assert.ok(minContrast>=4.5,`Accordion text minimum contrast ${minContrast}`);
  await outflow('固定費').locator('summary').focus();
  const focusColors=await outflow('固定費').locator('summary').evaluate(n=>({fg:getComputedStyle(n).outlineColor,bg:getComputedStyle(n).backgroundColor,width:getComputedStyle(n).outlineWidth}));
  assert.notEqual(focusColors.width,'0px');assert.ok(contrast(focusColors.fg,focusColors.bg)>=3);
  if(!origin.includes('github')){
    const markup=await page.locator('#outflow-breakdown,.saving-item').evaluateAll(ns=>ns.map(n=>n.outerHTML).join(''));
    const classes=['is-hover','is-focus-visible','is-active'];
    const states=classes.map(c=>`<details class="outflow-category"><summary class="category outflow-category-summary ${c}"><span>食費</span><meter class="bar" min="0" max="100" value="50"></meter><strong>¥50</strong></summary></details>`).join('');
    await writeFile('.local/accordion-reading-surfaces.preview.html',`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>内訳の表示状態</title><style>${await readFile('web/style.css','utf8')}</style><body><main class="app-shell"><h1>開閉・空・入金ボタン無効・操作状態</h1>${markup}${states}</main></body></html>`);
    await writeFile('.local/classification-release/ui-contrast.json',JSON.stringify({minTextContrast:minContrast,focusContrast:contrast(focusColors.fg,focusColors.bg),hierarchy},null,2));
  }
  for(const width of [320,375,414,768]){
    await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.ok(await row('コンタクトレンズ').locator('summary').evaluate(n=>n.getBoundingClientRect().height>=44));
  }
  await page.setViewportSize({width:375,height:844});
  await page.screenshot({path:output+'/'+(origin.includes('github')?'public':'local')+'-savings.png',fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('PASS: separate fixed/saving groups and colors, contrast, independent native accordions, closed balances, complete/partial/zero/excess/deleted deposit badges, 320/375/414/768px.');
}finally{await browser.close();}
