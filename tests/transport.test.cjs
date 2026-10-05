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
