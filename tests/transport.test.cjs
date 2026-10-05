const {test}=require('node:test');
const assert=require('node:assert/strict');
let api;
const apiReady=import('../web/transport.js').then(value=>api=value);
function harness(timeoutMs=1000) {
 const listeners=new Set(), sent=[], frames=[];
 const win={addEventListener(_,fn){listeners.add(fn)},removeEventListener(_,fn){listeners.delete(fn)}};
 const source={postMessage(message,origin){sent.push({message,origin}); if (h.onSend) h.onSend(message)}};
 const document={createElement(){return {remove(){this.removed=true},contentWindow:{}}},body:{append(frame){frames.push(frame)}}};
 const h={sent,frames,source,win,document,emit(data,origin='https://example-script.googleusercontent.com',sender=source){for(const fn of listeners)fn({data,origin,source:sender})},listeners};
 h.transport=api.createTransport({bridgeUrl:'https://script.google.com/macros/s/example/exec'},{window:win,document,crypto:globalThis.crypto,timeoutMs});
 h.channel=new URL(frames[0].src).searchParams.get('channel');
 h.ready=()=>h.emit({type:'household:ready',channel:h.channel});
 h.respond=(message,result)=>h.emit({type:'household:response',channel:h.channel,id:message.id,ok:true,result});
 return h;
}
test('Google origin handshake pins source; forged ready and response cannot resolve',async()=>{
 await apiReady; const h=harness();
 const preparation=h.transport.prepareLogin();
 h.emit({type:'household:ready',channel:h.channel},'https://evil.example');
 await new Promise(resolve=>setImmediate(resolve)); assert.equal(h.sent.length,0);
 h.ready(); await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.sent.length,1); const request=h.sent[0].message;
 h.emit({type:'household:response',channel:h.channel,id:request.id,ok:true,result:{state:'forged'}},'https://evil.example');
 h.emit({type:'household:response',channel:h.channel,id:request.id,ok:true,result:{state:'forged'}},'https://example-script.googleusercontent.com',{});
 h.emit({type:'household:response',channel:'wrong',id:request.id,ok:true,result:{state:'forged'}});
 h.respond(request,{state:'trusted'}); assert.equal((await preparation).state,'trusted'); h.transport.close();
});
test('anonymous data operations reject locally; session never enters iframe URL',async()=>{
 await apiReady;const h=harness();h.ready();
 await assert.rejects(h.transport.load(),{code:'UNAUTHENTICATED'});
 h.onSend=message=>h.respond(message,{session:'private-session',expiresAt:1});
 await h.transport.login('one-use-code','state');
 assert.ok(!h.frames[0].src.includes('private-session'));
 assert.ok(!h.frames[0].src.includes('one-use-code'));
 await h.transport.logout();await assert.rejects(h.transport.load(),{code:'UNAUTHENTICATED'});
 h.transport.close();assert.equal(h.listeners.size,0);assert.equal(h.frames[0].removed,true);
});
test('ambiguous timeout retry uses same operation ID, revision and payload',async()=>{
 await apiReady;const h=harness(20);h.ready();let mutationCount=0;
 h.onSend=message=>{if(message.method==='authLogin')h.respond(message,{session:'session'});else if(++mutationCount===2)h.respond(message,{state:{revision:2},result:{id:'stable'}})};
 await h.transport.login('code','state');
 const command={type:'saveIncome',operationId:'same-op',expectedRevision:1,payload:{month:'2026-10',amount:250000}};
 const promise=h.transport.mutate(command); command.payload.amount=1;
 const result=await promise;assert.equal(result.result.id,'stable');
 const payloads=h.sent.filter(x=>x.message.method==='rpc').map(x=>x.message.payload.payload);
 assert.equal(payloads.length,2);assert.deepEqual(payloads[0],payloads[1]);assert.equal(payloads[0].payload.amount,250000);h.transport.close();
});
test('server authentication rejection discards session',async()=>{
 await apiReady;const h=harness();h.ready();
 h.onSend=message=>{if(message.method==='authLogin')h.respond(message,{session:'session'});else h.emit({type:'household:response',channel:h.channel,id:message.id,ok:false,error:{code:'UNAUTHENTICATED',message:'expired'}})};
 await h.transport.login('code','state');await assert.rejects(h.transport.load(),{code:'UNAUTHENTICATED'});const count=h.sent.length;
 await assert.rejects(h.transport.load(),{code:'UNAUTHENTICATED'});assert.equal(h.sent.length,count);h.transport.close();
});
test('connection rejects invalid endpoint and close cancels pending work',async()=>{
 await apiReady;assert.throws(()=>api.createTransport({bridgeUrl:'https://evil.example/exec'},{window:{},document:{},crypto:globalThis.crypto}),{code:'CONFIGURATION'});
 const h=harness();const waiting=h.transport.prepareLogin();h.transport.close();await assert.rejects(waiting,{code:'CLOSED'});
});

test('restore validates session on server before allowing ledger requests',async()=>{
 await apiReady;const h=harness();h.ready();const saved={session:'a'.repeat(64),expiresAt:Date.now()+3600000};
 const restored=h.transport.restore(saved);
 await assert.rejects(h.transport.load(),{code:'UNAUTHENTICATED'});
 await new Promise(resolve=>setImmediate(resolve));
 const request=h.sent.at(-1).message;
 assert.equal(request.method,'rpc');assert.equal(request.payload.operation,'sessionInfo');assert.equal(request.payload.session,saved.session);
 h.respond(request,{role:'viewer',expiresAt:saved.expiresAt});
 assert.deepEqual(await restored,{...saved,role:'viewer'});
 h.onSend=message=>h.respond(message,{revision:0});await h.transport.load();
 assert.equal(h.sent.at(-1).message.payload.operation,'load');h.transport.close();
});

test('logout prevents pending login and restore responses from reauthenticating',async()=>{
 await apiReady;
 for(const action of ['login','restore']){
  const h=harness();h.ready();
  const pending=action==='login'?h.transport.login('code','state'):h.transport.restore({session:'a'.repeat(64)});
  await new Promise(resolve=>setImmediate(resolve));const request=h.sent.at(-1).message;
  h.onSend=message=>h.respond(message,{loggedOut:true});
  await h.transport.logout();
  h.respond(request,{session:'a'.repeat(64),role:'editor',expiresAt:Date.now()+3600000});
  await assert.rejects(pending,{code:'CLOSED'});await assert.rejects(h.transport.load(),{code:'UNAUTHENTICATED'});
  h.transport.close();
 }
});

test('logout during restore revokes the saved token before close; a fresh transport cannot restore it',async()=>{
 await apiReady;const h=harness();h.ready();
 const saved={session:'a'.repeat(64),expiresAt:Date.now()+3500000};
 const serverSessions=new Set([saved.session]);
 const serve=client=>message=>{
  if(message.method==='authLogout'){
   assert.equal(message.payload.session,saved.session);serverSessions.delete(message.payload.session);
   client.respond(message,{loggedOut:true});
  }else if(!serverSessions.has(message.payload.session)){
   client.emit({type:'household:response',channel:client.channel,id:message.id,ok:false,error:{code:'AUTH_REQUIRED',message:'revoked'}});
  }else client.respond(message,{role:'editor',expiresAt:saved.expiresAt});
 };
 const restoring=h.transport.restore(saved);
 const rejected=assert.rejects(restoring,{code:'CLOSED'});
 await new Promise(resolve=>setImmediate(resolve));const validation=h.sent.at(-1).message;
 await assert.rejects(h.transport.load(),{code:'UNAUTHENTICATED'});
 h.onSend=serve(h);await h.transport.logout();
 assert.equal(h.sent.at(-1).message.method,'authLogout');assert.equal(serverSessions.size,0);
 // Even a previously valid, late validation result cannot repopulate the client.
 h.respond(validation,{role:'editor',expiresAt:saved.expiresAt});await rejected;
 h.transport.close();
 const fresh=harness();fresh.ready();fresh.onSend=serve(fresh);
 await assert.rejects(fresh.transport.restore(saved),{code:'AUTH_REQUIRED'});
 await assert.rejects(fresh.transport.load(),{code:'UNAUTHENTICATED'});fresh.transport.close();
});

test('an older restore rejection cannot clear a newer login or its pending restore token',async()=>{
 await apiReady;const h=harness();h.ready();
 const stale=h.transport.restore({session:'a'.repeat(64)});
 const staleRejected=assert.rejects(stale,{code:'AUTH_REQUIRED'});
 await new Promise(resolve=>setImmediate(resolve));const old=h.sent.at(-1).message;
 h.onSend=message=>h.respond(message,{session:'b'.repeat(64),role:'editor',expiresAt:Date.now()+3500000});
 await h.transport.login('code','state');
 h.emit({type:'household:response',channel:h.channel,id:old.id,ok:false,error:{code:'AUTH_REQUIRED',message:'old rejection'}});
 await staleRejected;
 h.onSend=message=>h.respond(message,{revision:0});await h.transport.load();
 assert.equal(h.sent.at(-1).message.payload.session,'b'.repeat(64));h.transport.close();
 const fresh=harness();fresh.ready();
 const first=fresh.transport.restore({session:'a'.repeat(64)});const firstRejected=assert.rejects(first,{code:'AUTH_REQUIRED'});
 await new Promise(resolve=>setImmediate(resolve));const firstRequest=fresh.sent.at(-1).message;
 const second=fresh.transport.restore({session:'b'.repeat(64)});const secondRejected=assert.rejects(second,{code:'CLOSED'});
 await new Promise(resolve=>setImmediate(resolve));const secondRequest=fresh.sent.at(-1).message;
 fresh.emit({type:'household:response',channel:fresh.channel,id:firstRequest.id,ok:false,error:{code:'AUTH_REQUIRED',message:'old rejection'}});await firstRejected;
 fresh.onSend=message=>fresh.respond(message,{loggedOut:true});await fresh.transport.logout();
 assert.equal(fresh.sent.at(-1).message.payload.session,'b'.repeat(64));
 fresh.respond(secondRequest,{role:'editor',expiresAt:Date.now()+3500000});await secondRejected;fresh.transport.close();
});
