const {test}=require('node:test');
const assert=require('node:assert/strict');
const apiReady=import('../web/session.js');
const config={clientId:'fixture',bridgeUrl:'https://script.google.com/macros/s/fixture/exec'};
test('stored app session is bounded, target-scoped and excludes ledger/OAuth data',async()=>{
 const api=await apiReady,items=new Map();
 globalThis.localStorage={getItem:key=>items.get(key)||null,setItem:(key,value)=>items.set(key,value),removeItem:key=>items.delete(key)};
 const valid={session:'a'.repeat(64),expiresAt:Date.now()+3500000};
 assert.deepEqual(api.saveSession(config,{...valid,role:'editor',access_token:'oauth-fixture',expenses:[{amount:42}]}),{saved:true,reason:'stored'});
 const stored=JSON.parse(items.get(api.SESSION_STORAGE_KEY));
 assert.deepEqual(Object.keys(stored).sort(),['expiresAt','session','target']);
 assert.deepEqual(api.readSession(config),valid);
 assert.equal(api.readSession({...config,clientId:'other'}),null);assert.equal(items.size,0);
 for(const value of ['not-json',null,{...stored,expiresAt:1},{...stored,expiresAt:Date.now()+31*86400000},{...stored,session:'bad-token'}]){
  items.set(api.SESSION_STORAGE_KEY,typeof value==='string'?value:JSON.stringify(value));
  assert.equal(api.readSession(config),null);assert.equal(items.size,0);
 }
 api.saveSession(config,valid);api.clearSession();assert.equal(items.size,0);
 delete globalThis.localStorage;
});
test('unavailable browser storage is nonfatal and failed removal uses a signed-out marker',async()=>{
 const api=await apiReady;
 Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw Error('blocked');}});
 assert.equal(api.readSession(config),null);assert.deepEqual(api.saveSession(config,{session:'a'.repeat(64),expiresAt:Date.now()+10000}),{saved:false,reason:'storage'});
 assert.doesNotThrow(()=>api.clearSession());delete globalThis.localStorage;
 let value='old';globalThis.localStorage={removeItem(){throw Error('denied');},setItem(_,next){value=next;},getItem(){return value;}};
 api.clearSession();assert.equal(value,'null');assert.equal(api.readSession(config),null);delete globalThis.localStorage;
});
test('save reports precise nonsecret reasons and detects discarded writes',async()=>{
 const api=await apiReady,items=new Map();
 globalThis.localStorage={getItem:key=>items.get(key)||null,setItem:(key,value)=>items.set(key,value),removeItem:key=>items.delete(key)};
 const valid={session:'a'.repeat(64),expiresAt:Date.now()+3500000};
 for(const [value,reason] of [[{...valid,session:'invalid'},'token'],[{...valid,expiresAt:String(valid.expiresAt)},'number'],[{...valid,expiresAt:1},'late'],[{...valid,expiresAt:Date.now()+31*86400000},'too_far']]){
  const result=api.saveSession(config,value);
  assert.deepEqual(result,{saved:false,reason});assert.equal(items.size,0);
  assert.deepEqual(Object.keys(result).sort(),['reason','saved']);
 }
 // Server/client clock skew must not discard a newly issued 30-day session.
 const lifetime=30*86400000;
 assert.equal(api.validSession({...valid,expiresAt:lifetime+300001},0),false);
 assert.equal(api.validSession({...valid,expiresAt:lifetime+300000},0),true);
 assert.equal(api.validSession({...valid,expiresAt:lifetime},0),true);
 assert.equal(api.validSession({...valid,expiresAt:0},0),false);
 const skewed={...valid,expiresAt:Date.now()+lifetime+1500};
 assert.deepEqual(api.saveSession(config,skewed),{saved:true,reason:'stored'});
 assert.deepEqual(api.readSession(config),skewed);
 globalThis.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
 assert.deepEqual(api.saveSession(config,valid),{saved:false,reason:'storage-not-retained'});
 delete globalThis.localStorage;
});
