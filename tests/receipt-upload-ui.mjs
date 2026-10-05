// Synthetic local-only upload regression. Never logs in or writes to Google.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.HOUSEHOLD_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.HOUSEHOLD_PREVIEW_URL||'http://127.0.0.1:4283';
const output=process.env.HOUSEHOLD_QA_OUTPUT||path.join(os.tmpdir(),'household-receipt-qa');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
const page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/runtime-config.json',r=>r.fulfill({status:404,body:'Not configured'}));
let source=await readFile(new URL('../web/transport.js',import.meta.url),'utf8');
source=source.replace('async uploadReceipt(payload) {',`async uploadReceipt(payload) {
      globalThis.__uploadCalls??=[];globalThis.__uploadCalls.push({name:payload.fileName,id:payload.operationId,hash:payload.imageHash});
      globalThis.__activeUploads=(globalThis.__activeUploads||0)+1;
      globalThis.__maxUploads=Math.max(globalThis.__maxUploads||0,globalThis.__activeUploads);
      try {
      await new Promise(resolve=>setTimeout(resolve,150));`);
source=source.replace('return response;\n    },\n    receiptImage:',`if(payload.fileName==='two.png'&&!globalThis.__lostUpload){globalThis.__lostUpload=true;throw Object.assign(new Error('通信テスト：保存応答が失われました。'),{code:'TIMEOUT'});}
      return response;
      } finally { globalThis.__activeUploads--; }
    },
    receiptImage:`);
await page.route('**/web/transport.js',r=>r.fulfill({contentType:'text/javascript',body:source}));
const click=name=>page.getByRole('button',{name,exact:true}).click();
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlFkAAAAASUVORK5CYII=','base64');
const files=['one.png','two.png','three.png'].map((name,i)=>({name,mimeType:'image/png',buffer:Buffer.concat([png,Buffer.from([i])])}));
try{
 await page.goto(origin);await click('サンプルで試す');await click('登録');await page.getByRole('tab',{name:'レシート',exact:true}).click();
 assert.equal(await page.locator('#receipt-camera').getAttribute('capture'),'environment');
 assert.equal(await page.locator('#receipt-files').getAttribute('multiple'),'');
 assert.equal(await page.getByRole('button',{name:'画像を保存',exact:true}).isEnabled(),false);
 await page.locator('#receipt-files').setInputFiles(files);
 await page.getByText('3枚選択',{exact:true}).waitFor();
 await click('画像を保存');
 await page.locator('.upload-list').getByText('送信中',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'写真を選ぶ',exact:true}).isEnabled(),false);
 await page.screenshot({path:path.join(output,'upload-progress-mobile.png'),fullPage:true});
 await page.locator('#error').getByText('2枚の画像を保存しました。1枚を保存できませんでした。写真ごとの表示を確認してください。',{exact:true}).waitFor();
 assert.equal(await page.locator('.upload-list li').count(),1);
 assert.equal(await page.locator('.upload-list').getByText('two.png',{exact:true}).count(),1);
 assert.equal(await page.locator('.upload-list').getByText('保存済み',{exact:true}).count(),0);
 assert.equal(await page.locator('.upload-progress').count(),0);
 await page.getByText('1枚は再送待ち',{exact:true}).waitFor();
 await page.screenshot({path:path.join(output,'upload-partial-failure-mobile.png'),fullPage:true});
 await click('失敗した写真を再送');await page.locator('#message').getByText('1枚の画像を保存しました。',{exact:true}).waitFor();
 assert.equal(await page.locator('.upload-list').count(),0);
 assert.equal(await page.getByRole('button',{name:'画像を保存',exact:true}).isEnabled(),false);
 assert.equal(await page.getByRole('button',{name:'失敗した写真を再送',exact:true}).isVisible(),false);
 assert.equal(await page.getByRole('button',{name:'選択をクリア',exact:true}).isVisible(),false);
 await page.screenshot({path:path.join(output,'upload-success-cleared-mobile.png'),fullPage:true});
 const calls=await page.evaluate(()=>globalThis.__uploadCalls);
 assert.deepEqual(calls.map(c=>c.name),['one.png','two.png','three.png','two.png']);
 assert.equal(calls[1].id,calls[3].id);assert.equal(calls[1].hash,calls[3].hash);
 assert.equal(await page.evaluate(()=>globalThis.__maxUploads),1);
 assert.equal(await page.locator('.receipt-row').count(),3,'Lost success response does not create another receipt');
 await click('ホーム');await click('登録');await page.getByRole('tab',{name:'レシート',exact:true}).click();
 assert.equal(await page.locator('.upload-list').count(),0);
 assert.equal(await page.locator('.receipt-row').count(),3);
 await page.locator('#receipt-camera').setInputFiles(files[0]);
 await page.locator('#receipt-camera').setInputFiles(files[1]);
 await page.getByText('2枚選択',{exact:true}).waitFor();
 await click('選択をクリア');
 await page.locator('#receipt-files').setInputFiles([{name:'unsupported.heic',mimeType:'image/heic',buffer:Buffer.from('not an image')},files[0]]);
 await click('画像を保存');await page.locator('#error').waitFor({state:'visible'});
 assert.equal(await page.locator('.upload-list li').count(),1,'Only the invalid image remains for retry');
 assert.equal(await page.locator('.upload-list').getByText('unsupported.heic',{exact:true}).count(),1);
 assert.equal(await page.locator('.upload-list').getByText('one.png',{exact:true}).count(),0,'Successful later photo leaves the selection');
 for(const width of [320,390,768]){
  await page.setViewportSize({width,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,`No horizontal overflow at ${width}`);
 }
 await page.setViewportSize({width:390,height:844});
 await click('選択をクリア');await page.locator('#receipt-files').setInputFiles(files);
 await click('画像を保存');await page.locator('.upload-list').getByText('送信中',{exact:true}).waitFor();
 const sent=await page.evaluate(()=>globalThis.__uploadCalls.length);await click('ログアウト');
 await page.getByRole('heading',{name:'ログイン',exact:true}).waitFor();
 await page.waitForTimeout(250);
 assert.equal(await page.evaluate(()=>globalThis.__uploadCalls.length),sent,'Logout stops remaining uploads and stale responses');
 assert.equal(await page.locator('.upload-list').count(),0);
 assert.deepEqual(errors,[]);
 console.log('PASS: camera capture hint, multi-selection, serial progress, partial failure, stable-ID retry without duplicates, invalid file isolation, navigation, logout, 320/390/768 layout. Physical phone camera remains unverified.');
}finally{await browser.close();}
