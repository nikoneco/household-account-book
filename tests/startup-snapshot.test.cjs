const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const context=vm.createContext({module:{exports:{}}});
vm.runInContext(fs.readFileSync(require.resolve('../shared/domain.js'),'utf8'),context);
globalThis.HouseholdDomain=context.module.exports;
const D=globalThis.HouseholdDomain,apiReady=import('../web/startup-snapshot.js');
const sessions=import('../web/session.js');
const config={clientId:'fixture',bridgeUrl:'https://script.google.com/macros/s/fixture/exec'};
function store(){const items=new Map();globalThis.localStorage={getItem:key=>items.get(key)||null,setItem:(key,value)=>items.set(key,value),removeItem:key=>items.delete(key)};return items;}
const session=()=>({session:'a'.repeat(64),expiresAt:Date.now()+30*86400000});
function fixture(){
 let state=D.emptyState(),id=0;
 const run=(type,payload)=>state=D.execute(state,{type,payload,operationId:'op-'+(++id)},{uuid:()=>String(++id),now:'2026-10-20T10:00:00.000Z'}).state;
 run('saveIncome',{month:'2026-10',amount:200000});
 run('registerReceipt',{fileId:'private-drive-id',fileName:'fixture.png',imageHash:'fixture-hash',mimeType:'image/png'});
 return state;
}
test('snapshot persists only allowlisted display state, digest binding and bounded expiry',async()=>{
 const api=await apiReady,s=await sessions,items=store(),saved=session(),state=fixture();s.saveSession(config,saved);
 state.access_token='oauth-secret';state.receipts[0].base64='image-bytes';state.receipts[0].analysis={raw:'secret'};
 assert.equal(await api.saveSnapshot(config,saved,state,'editor'),true);
 const raw=items.get(api.SNAPSHOT_STORAGE_KEY),cache=JSON.parse(raw);
 for(const secret of [saved.session,'oauth-secret','image-bytes','private-drive-id','fixture-hash','secret'])assert.equal(raw.includes(secret),false,secret);
 assert.deepEqual(Object.keys(cache).sort(),['binding','expiresAt','role','savedAt','state','version']);
 assert.match(cache.binding,/^[a-f0-9]{64}$/);assert.equal(cache.expiresAt-cache.savedAt,api.MAX_SNAPSHOT_MS);
 assert.deepEqual(cache.state.operations,[]);assert.equal((await api.readSnapshot(config,saved)).state.incomes[0].amount,200000);
 const soon={...saved,expiresAt:Date.now()+100000};s.saveSession(config,soon);await api.saveSnapshot(config,soon,state,'viewer');
 assert.equal(JSON.parse(items.get(api.SNAPSHOT_STORAGE_KEY)).expiresAt,soon.expiresAt);
 delete globalThis.localStorage;
});
test('bad JSON, future/expired/mismatched target/session and malformed nested state fall back without exceptions',async()=>{
 const api=await apiReady,s=await sessions,items=store(),saved=session();s.saveSession(config,saved);await api.saveSnapshot(config,saved,fixture(),'editor');
 const raw=items.get(api.SNAPSHOT_STORAGE_KEY),valid=JSON.parse(raw);
 const corruptions=[null,{...valid,version:2},{...valid,role:'admin'},{...valid,savedAt:Date.now()+86400000},{...valid,expiresAt:Date.now()-1},{...valid,expiresAt:saved.expiresAt+1},{...valid,expiresAt:valid.savedAt+api.MAX_SNAPSHOT_MS+1}];
 for(const edit of [state=>state.expenses={},state=>state.receipts=[null],state=>state.receipts[0].uploadedAt='bad-date',state=>state.receipts[0].expenseIds=null,state=>state.receipts[0].analysisNotes=[null],state=>state.receipts[0].analysisNotes=[{requestedAt:'broken'}],state=>state.incomes[0].amount=-1,state=>state.receipts[0].archiveError={}]){
  const candidate=structuredClone(valid);edit(candidate.state);corruptions.push(candidate);
 }
 for(const value of ['bad JSON',...corruptions]){items.set(api.SNAPSHOT_STORAGE_KEY,typeof value==='string'?value:JSON.stringify(value));assert.equal(await api.readSnapshot(config,saved),null);assert.equal(items.has(api.SNAPSHOT_STORAGE_KEY),false);}
 for(const [target,token] of [[{...config,clientId:'other'},saved],[config,{...saved,session:'b'.repeat(64)}]]){items.set(api.SNAPSHOT_STORAGE_KEY,raw);assert.equal(await api.readSnapshot(target,token),null);}
 items.set(api.SNAPSHOT_STORAGE_KEY,raw);assert.equal(await api.readSnapshot(config,{...saved,expiresAt:1}),null);
 delete globalThis.localStorage;
});
test('storage restrictions, session loss during digest and older writes are harmless',async()=>{
 const api=await apiReady,s=await sessions,items=store(),saved=session(),state=fixture();s.saveSession(config,saved);
 const writing=api.saveSnapshot(config,saved,state,'editor');s.clearSession();assert.equal(await writing,false);assert.equal(items.has(api.SNAPSHOT_STORAGE_KEY),false);
 s.saveSession(config,saved);await api.saveSnapshot(config,saved,state,'editor');assert.equal(await api.saveSnapshot(config,saved,D.emptyState(),'editor'),false);
 Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw Error('blocked');}});
 assert.equal(await api.readSnapshot(config,saved),null);assert.equal(await api.saveSnapshot(config,saved,state,'editor'),false);assert.doesNotThrow(()=>api.clearSnapshot());
 delete globalThis.localStorage;
});
test('session replacement during snapshot digest returns no old data and retains the newer session/cache',async()=>{
 const api=await apiReady,s=await sessions,items=store(),first=session(),next={...first,session:'b'.repeat(64)};
 s.saveSession(config,first);await api.saveSnapshot(config,first,fixture(),'editor');
 const original=crypto.subtle.digest;let release,ready,count=0;
 const waiting=new Promise(resolve=>{ready=resolve;});
 crypto.subtle.digest=async function(...args){const result=await original.apply(this,args);if(++count===1){await new Promise(resolve=>{release=resolve;ready();});}return result;};
 try{
  const reading=api.readSnapshot(config,first);await waiting;
  s.saveSession(config,next);await api.saveSnapshot(config,next,fixture(),'viewer');
  const newCache=items.get(api.SNAPSHOT_STORAGE_KEY);release();
  assert.equal(await reading,null);assert.deepEqual(s.readSession(config),next);
  assert.equal(items.get(api.SNAPSHOT_STORAGE_KEY),newCache);assert.equal((await api.readSnapshot(config,next)).role,'viewer');
 }finally{crypto.subtle.digest=original;delete globalThis.localStorage;}
});
