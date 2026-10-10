const {test}=require('node:test');
const assert=require('node:assert/strict');
async function setup(version='0.1.19'){
 const {initUpdates}=await import('../web/update.js');const handlers={},events={},nodes={},calls=[],navigations=[];let allowed=true,online=true,fail=false;
 for(const id of ['#app-update','#app-update-button','#app-update-note'])nodes[id]={hidden:true,disabled:false,textContent:'',addEventListener(name,fn){handlers[id+name]=fn}};
 const win={location:{href:'https://example.github.io/household-account-book/',replace(url){navigations.push(url)}},addEventListener(name,fn){events[name]=fn}};
 const doc={querySelector(id){return nodes[id]},visibilityState:'visible',addEventListener(name,fn){events[name]=fn}};
 const registration={async update(){calls.push('worker-update')},waiting:{state:'installed',addEventListener(){},removeEventListener(){},postMessage(value){calls.push(value);this.state='activated'}}};
 const nav={get onLine(){return online},serviceWorker:{register(url,options){calls.push({url,options});return Promise.resolve(registration)}}};
 const fetch=async(url,options)=>{calls.push({url:String(url),options});if(fail)throw Error('offline');return {ok:true,async text(){return `const CACHE = 'household-shell-v${version}';`}}};
 initUpdates({window:win,document:doc,navigator:nav,fetch,canUpdate:()=>allowed});await new Promise(resolve=>setImmediate(resolve));
 return {handlers,events,nodes,calls,navigations,registration,setAllowed(v){allowed=v},setFailure(v){fail=v},setOnline(v){online=v}};
}
test('update notice checks uncached public release but never reloads automatically',async()=>{
 const h=await setup();assert.equal(h.nodes['#app-update'].hidden,false);assert.equal(h.navigations.length,0);assert.equal(h.calls[0].options.updateViaCache,'none');assert.equal(h.calls[1].options.cache,'no-cache');
 h.setAllowed(false);await h.handlers['#app-update-buttonclick']();assert.equal(h.navigations.length,0);assert.match(h.nodes['#app-update-note'].textContent,/保存結果/);
 h.setAllowed(true);await h.handlers['#app-update-buttonclick']();assert.equal(h.navigations[0],'https://example.github.io/household-account-book/?v=0.1.19');assert.ok(h.calls.some(c=>c.type==='ACTIVATE_UPDATE'));
});
test('same and older cached versions never offer a downgrade',async()=>{for(const version of ['0.1.18','0.1.17']){const h=await setup(version);assert.equal(h.nodes['#app-update'].hidden,true);assert.equal(h.navigations.length,0)}});
test('failed update preserves page and allows retry',async()=>{const h=await setup();h.setFailure(true);await h.handlers['#app-update-buttonclick']();assert.equal(h.navigations.length,0);assert.equal(h.nodes['#app-update-button'].disabled,false);assert.match(h.nodes['#app-update-note'].textContent,/更新できません/);h.setFailure(false);await h.handlers['#app-update-buttonclick']();assert.equal(h.navigations.length,1)});

test('saving that starts during update blocks navigation',async()=>{const h=await setup();h.registration.update=async()=>{h.setAllowed(false)};await h.handlers['#app-update-buttonclick']();assert.equal(h.navigations.length,0);assert.equal(h.nodes['#app-update-button'].disabled,false)});

test('worker update rejection preserves page and allows retry',async()=>{const h=await setup();h.registration.update=async()=>{throw Error('install failed')};await h.handlers['#app-update-buttonclick']();assert.equal(h.navigations.length,0);assert.equal(h.nodes['#app-update-button'].disabled,false);assert.match(h.nodes['#app-update-note'].textContent,/更新できません/)});
