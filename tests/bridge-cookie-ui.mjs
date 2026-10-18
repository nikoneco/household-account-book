// Real loopback HTTP requests: browser interception reports the profile's cookie
// jar even for credentialless frames, so it cannot prove cookies were omitted.
// Only endpoint validation and the handshake origin are mapped to loopback;
// application UI, transport lifecycle, session storage and browser cookies are real.
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.HOUSEHOLD_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(import.meta.dirname,'..');
const transport=await readFile(path.join(root,'web/transport.js'),'utf8');
const domain={};vm.runInNewContext(await readFile(path.join(root,'shared/domain.js'),'utf8'),domain);
const state=domain.HouseholdDomain.emptyState(),sessions=new Set(),requests=[],calls=[];
let base,failNextBridge=false;
function mappedTransport(legacy=false){
 let source=transport.replace("url.protocol !== 'https:' || url.hostname !== 'script.google.com'",`url.origin !== '${base}'`)
  .replace("event.origin === 'https://script.google.com'",`event.origin === '${base}'`)
  .replace('environment.timeoutMs || 45000','environment.timeoutMs || 900');
 assert.notEqual(source,transport);
 if(legacy)source=source.replace("if ('credentialless' in iframe) iframe.credentialless = true;",'');
 return source;
}
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,base),send=(body,type='text/html',status=200)=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(body);};
  if(url.pathname==='/runtime-config.json')return send(JSON.stringify({mode:'google',clientId:'fixture',bridgeUrl:base+'/macros/s/fixture/exec'}),'application/json');
  if(url.pathname==='/web/transport.js')return send(mappedTransport(),'text/javascript');
  if(url.pathname==='/macros/s/fixture/exec'){
   const cookieSent=(req.headers.cookie||'').includes('routing_fixture='),forcedFailure=failNextBridge;failNextBridge=false;
   requests.push({cookieSent,forcedFailure,status:cookieSent?302:forcedFailure?404:200});
   if(cookieSent){res.writeHead(302,{location:'/macros/u/1/s/fixture/exec'});res.end();return;}
   if(forcedFailure)return send('fixture unavailable','text/html',404);
   const channel=JSON.stringify(url.searchParams.get('channel'));
   return send(`<!doctype html><title>Fixture bridge</title><script>
    window.addEventListener('message',async e=>{const r=e.data;if(e.source!==parent||e.origin!==location.origin||r?.type!=='household:request'||r.channel!==${channel})return;
     const value=await fetch('/fixture/rpc',{method:'POST',body:JSON.stringify({method:r.method,payload:r.payload})}).then(r=>r.json());
     parent.postMessage({type:'household:response',channel:${channel},id:r.id,...value},location.origin);});
    parent.postMessage({type:'household:ready',channel:${channel}},location.origin);
   <\/script>`);
  }
  if(url.pathname==='/macros/u/1/s/fixture/exec')return send('fixture wrong account route','text/html',404);
  if(url.pathname==='/fixture/rpc'&&req.method==='POST'){
   let body='';for await(const chunk of req)body+=chunk;
   const r=JSON.parse(body);calls.push({method:r.method,operation:r.payload?.operation});
   const expiry=Date.now()+30*86400000;let result;
   if(r.method==='authPrepare')result={state:'fixture-state'};
   else if(r.method==='authLogin'){sessions.add('a'.repeat(64));result={session:'a'.repeat(64),expiresAt:expiry,role:'editor'};}
   else if(r.method==='authLogout'){sessions.delete(r.payload.session);result={loggedOut:true};}
   else if(r.method==='rpc'){
    if(!sessions.has(r.payload.session))return send(JSON.stringify({ok:false,error:{code:'AUTH_REQUIRED',message:'fixture expired'}}),'application/json');
    if(r.payload.operation==='bootstrap')result={role:'editor',expiresAt:expiry,state};
    else if(r.payload.operation==='load')result=state;
    else throw Error('Unexpected fixture operation');
   }else throw Error('Unexpected fixture method');
   return send(JSON.stringify({ok:true,result}),'application/json');
  }
  const relative=url.pathname==='/'?'index.html':url.pathname.slice(1);
  assert.ok(['index.html','sw.js','manifest.webmanifest'].includes(relative)||/^(web|shared|assets)\/[\w./-]+$/.test(relative));
  const target=path.resolve(root,relative);assert.ok(target.startsWith(root+path.sep));
  let content=await readFile(target);
  if(relative==='index.html')content=Buffer.from(content.toString().replace('frame-src https://accounts.google.com',`frame-src ${base} https://accounts.google.com`));
  return send(content,types[path.extname(relative)]||'application/octet-stream');
 }catch{res.writeHead(404);res.end('Fixture not found');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,channel:'chrome'}),errors=[];
const out=path.join(os.tmpdir(),'household-cookie-isolation');await mkdir(out,{recursive:true});
async function fixture({cookie=true,legacy=false,unsupported=false,width=390}={}){
 const context=await browser.newContext({viewport:{width,height:844},serviceWorkers:'block'});
 if(cookie)await context.addCookies([{name:'routing_fixture',value:'wrong-account-slot',url:base}]);
 if(unsupported)await context.addInitScript(()=>{delete HTMLIFrameElement.prototype.credentialless;});
 if(legacy)await context.route('**/web/transport.js',r=>r.fulfill({contentType:'text/javascript',body:mappedTransport(true)}));
 await context.route('https://accounts.google.com/gsi/client',r=>r.fulfill({contentType:'text/javascript',body:"globalThis.google={accounts:{oauth2:{initCodeClient:o=>({requestCode(){void o.callback({code:'fixture-google-code'});}})}}};"}));
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base);
 await page.getByRole('button',{name:'Googleでログイン',exact:true}).waitFor();
 return {page,context};
}
async function registered(page){await page.getByRole('tab',{name:'レシート',exact:true}).waitFor();assert.equal(await page.locator('#navigation').isVisible(),true);}
try{
 // Control: the same synthetic profile cookie sends the normal bridge to 404.
 let h=await fixture({legacy:true});await h.page.getByRole('button',{name:'Googleでログイン',exact:true}).click();
 await h.page.getByRole('button',{name:'接続を再試行',exact:true}).waitFor();
 assert.ok(requests.some(r=>r.cookieSent&&r.status===302));await h.context.close();
 const start=requests.length,loginCount=()=>calls.filter(r=>r.method==='authLogin').length;
 h=await fixture();assert.equal(await h.page.locator('iframe[title="家計簿の安全な接続"]').evaluate(f=>f.credentialless),true);
 await h.page.getByRole('button',{name:'Googleでログイン',exact:true}).click();await registered(h.page);
 assert.equal(await h.page.evaluate(()=>document.cookie.includes('routing_fixture=')),true);
 const before=loginCount();await h.page.reload();await registered(h.page);assert.equal(loginCount(),before);
 assert.ok(calls.some(r=>r.operation==='bootstrap'));
 assert.ok(requests.slice(start).every(r=>!r.cookieSent&&r.status===200));
 // A failed restore retains the existing token and reconnects without a popup.
 const saved=await h.page.evaluate(()=>localStorage.getItem('household.session.v1'));
 failNextBridge=true;await h.page.reload();
 await h.page.getByRole('button',{name:'接続を再試行',exact:true}).waitFor();
 assert.equal(await h.page.evaluate(()=>localStorage.getItem('household.session.v1')),saved);
 await h.page.getByRole('button',{name:'接続を再試行',exact:true}).click();await registered(h.page);
 assert.equal(loginCount(),before);
 await h.page.screenshot({path:path.join(out,'01-isolated-login-mobile.png')});
 await h.page.setViewportSize({width:1280,height:900});await h.page.screenshot({path:path.join(out,'02-restored-desktop.png')});
 await h.page.locator('#logout').click();await h.page.getByRole('button',{name:'Googleでログイン',exact:true}).waitFor();
 await h.page.waitForFunction(()=>localStorage.getItem('household.session.v1')===null);await h.context.close();
 // A connection timeout before first login offers a fresh transport on retry.
 failNextBridge=true;h=await fixture();await h.page.getByRole('button',{name:'Googleでログイン',exact:true}).click();
 await h.page.getByRole('button',{name:'接続を再試行',exact:true}).waitFor();
 assert.equal(await h.page.getByRole('button',{name:'Googleでログイン',exact:true}).isDisabled(),true);
 await h.page.screenshot({path:path.join(out,'03-connection-retry.png')});
 await h.page.getByRole('button',{name:'接続を再試行',exact:true}).click();
 await h.page.getByRole('button',{name:'Googleでログイン',exact:true}).click();await registered(h.page);await h.context.close();
 // Unsupported-feature fixture retains the pre-existing anonymous transport.
 h=await fixture({cookie:false,unsupported:true,width:1280});
 assert.equal(await h.page.locator('iframe[title="家計簿の安全な接続"]').evaluate(f=>'credentialless' in f),false);
 await h.page.getByRole('button',{name:'Googleでログイン',exact:true}).click();await registered(h.page);await h.context.close();
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({pass:true,browser:browser.version(),normalCookieRoute:'302 to 404',isolatedCookieOmitted:true,loginAndReload:true,logout:true,reconnectBeforeLogin:true,reconnectSavedSession:true,unsupportedFeatureFallback:true,pageErrors:0,evidence:out}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
