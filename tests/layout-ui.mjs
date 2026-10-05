// Local rendered-layout regression; no Google login or household data writes.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const engines = require(process.env.HOUSEHOLD_PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.HOUSEHOLD_LAYOUT_ENGINE || 'chromium';
const browser = await engines[engine].launch({headless:true,...(engine === 'chromium' ? {channel:'chrome'} : {})});
try {
  const page = await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/runtime-config.json',r=>r.fulfill({status:404,body:'Unconfigured local fixture'}));
  await page.goto(process.env.HOUSEHOLD_PREVIEW_URL || 'http://127.0.0.1:4283/');
  await page.getByRole('button',{name:'サンプルで試す',exact:true}).click();
  const verify = async (width, singleColumn = false) => {
    const result = await page.evaluate(() => {
      const rect = e => {const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
      const visible = e => Boolean(e.getClientRects().length) && getComputedStyle(e).visibility !== 'hidden';
      const fields = [...document.querySelectorAll('input[type=date],input[type=month]')].filter(visible).map(e=>({type:e.type,control:rect(e),label:rect(e.closest('label'))}));
      const grid=document.querySelector('.form-grid');
      const controls=grid ? [...grid.querySelectorAll('input,select,textarea')].filter(visible).map(rect) : [];
      const overlaps=controls.flatMap((a,i)=>controls.slice(i+1).filter(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1));
      return {width:innerWidth,scroll:document.documentElement.scrollWidth,fields,overlaps:overlaps.length,columns:grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0};
    });
    assert.equal(result.width,width);
    assert.ok(result.scroll<=width,JSON.stringify(result));
    assert.equal(result.overlaps,0,JSON.stringify(result));
    for(const {control:c,label:l} of result.fields) {
      assert.ok(c.left>=l.left-1 && c.right<=l.right+1 && c.right<=width+1,JSON.stringify(result));
    }
    if(singleColumn) assert.equal(result.columns,1);
  };
  for(const width of [320,375,390,414,768]) {
    await page.setViewportSize({width,height:844});
    await page.getByRole('button',{name:'ホーム',exact:true}).click(); await verify(width);
    await page.getByRole('button',{name:'登録',exact:true}).click();
    await page.getByRole('tab',{name:'支出',exact:true}).click(); await verify(width,width<=350);
    await page.getByRole('tab',{name:'積立',exact:true}).click(); await verify(width,width<=350);
  }
  assert.deepEqual(errors,[]);
  console.log(`PASS: ${engine} home month, expense date/amount, savings date; no overflow/overlap at 320/375/390/414/768px; single column at 320px.`);
} finally {await browser.close();}
