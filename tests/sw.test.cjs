const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function setup(online=true){
 const listeners={},cached=[],deleted=[];
 const response={ok:true,type:'basic',clone(){return this}};
 const context=vm.createContext({URL,Set,Promise,self:{registration:{scope:'https://example.github.io/household-account-book/'},addEventListener(type,fn){listeners[type]=fn}},
 caches:{async open(){return {async addAll(urls){cached.push(...urls)},async put(request){cached.push(request.url)}}},async keys(){return ['household-shell-old','household-shell-v0.1.0','household-shell-v0.1.1','household-shell-v0.1.2','household-shell-v0.1.3','household-shell-v0.1.4','household-shell-v0.1.5','household-shell-v0.1.6','household-shell-v0.1.7','household-shell-v0.1.8','household-shell-v0.1.9','household-shell-v0.1.10','household-shell-v0.1.11','household-shell-v0.1.12','household-shell-v0.1.13','household-shell-v0.1.14','household-shell-v0.1.15','household-shell-v0.1.16','kurashi-shell-v1','other-app-private']},async delete(key){deleted.push(key)},async match(){return 'offline-shell'}},
 fetch:async()=>{if(!online)throw new Error('offline');return response}});
 vm.runInContext(fs.readFileSync(require.resolve('../sw.js'),'utf8'),context);
 return {listeners,cached,deleted};
}
test('service worker bypasses configuration, private API, images, login and external requests',()=>{
 const {listeners}=setup();
 for(const [url,method] of [
  ['https://example.github.io/household-account-book/runtime-config.json','GET'],
  ['https://example.github.io/household-account-book/api/state','GET'],
  ['https://example.github.io/household-account-book/api/session','GET'],
  ['https://example.github.io/household-account-book/private-receipt.png','GET'],
  ['https://accounts.google.com/gsi/client','GET'],
  ['https://script.google.com/macros/s/example/exec','GET'],
  ['https://example.github.io/household-account-book/index.html','POST']
 ]){
  let handled=false;listeners.fetch({request:{url,method},respondWith(){handled=true}});assert.equal(handled,false,url);
 }
});
test('offline shell fallback and activation retain other applications caches',async()=>{
 const h=setup(false);let pending;
 h.listeners.fetch({request:{url:'https://example.github.io/household-account-book/index.html',method:'GET'},respondWith(promise){pending=promise}});
 assert.equal(await pending,'offline-shell');
 h.listeners.activate({waitUntil(promise){pending=promise}});await pending;
 assert.deepEqual(h.deleted,['household-shell-old','household-shell-v0.1.0','household-shell-v0.1.1','household-shell-v0.1.2','household-shell-v0.1.3','household-shell-v0.1.4','household-shell-v0.1.5','household-shell-v0.1.6','household-shell-v0.1.7','household-shell-v0.1.8','household-shell-v0.1.9','household-shell-v0.1.10','household-shell-v0.1.11','household-shell-v0.1.12','household-shell-v0.1.13','household-shell-v0.1.14','household-shell-v0.1.15','household-shell-v0.1.16']);
 h.listeners.install({waitUntil(promise){pending=promise}});await pending;
 assert.ok(h.cached.includes('./index.html'));
 assert.ok(h.cached.includes('./web/session.js')); // Public code only, never a session response.
 assert.ok(h.cached.every(value=>!/(runtime-config|receipt|api\/session|state)/.test(value)));
});
