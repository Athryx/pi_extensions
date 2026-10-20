const {test}=require('node:test');
const assert=require('node:assert/strict');
const {load,host}=require('../subagents/test-helper.cjs');
async function fixture(){
  const api=await load('../shared/provider-tools.ts');
  const {createEventBus}=await host('dist/core/event-bus.js');
  const handlers=new Map(),events=createEventBus();
  const pi={events,on(name,handler){handlers.set(name,[...(handlers.get(name)??[]),handler]);}};
  const emit=(name,event={})=>{let result;for(const handler of handlers.get(name)??[]){const next=handler(event,{});if(next?.message)event.message=next.message;if(next!==undefined)result=next;}return result;};
  return{...api,pi,events,emit,handlers};
}
const message=(stopReason='pending')=>({role:'assistant',content:[],stopReason,timestamp:1});
const call=(id,summary='argument',status='running')=>({id,label:'provider action',summary,status});

test('multiple provider adapters share a frame, update live message clones and persist data without fake local calls',async()=>{
  const f=await fixture();const first=f.createProviderToolReporter(f.pi,'one'),second=f.createProviderToolReporter(f.pi,'two');
  assert.equal(f.handlers.get('before_provider_request').length,1);assert.equal(f.handlers.get('message_end').length,1);
  let changes=0;f.events.on(f.PROVIDER_TOOLS_CHANGED,()=>changes++);
  f.emit('before_provider_request');const a=first.begin(),b=second.begin();const live=message();f.emit('message_start',{message:live});
  a.update(call('same','first'));b.update(call('same','second'));assert.equal(changes,2);
  a.update(call('same','first'));assert.equal(changes,2,'repeated snapshots do not redraw');
  assert.deepEqual(f.providerToolCalls(live).map(c=>[c.id,c.summary]),[['one:same','first'],['two:same','second']]);
  const clone=message();f.emit('message_update',{message:clone});assert.equal(clone.providerToolCalls,live.providerToolCalls);
  a.update(call('same','updated','completed'));assert.equal(f.providerToolCalls(live)[0].summary,'updated','tools can update before any text delta');
  const final=f.emit('message_end',{message:message('stop')}).message;
  assert.deepEqual(final.content,[]);assert.equal(final.providerToolCalls.calls.length,2);assert.ok(final.providerToolCalls.calls.every(c=>c.status==='completed'));
  assert.deepEqual(JSON.parse(JSON.stringify(final)).providerToolCalls,final.providerToolCalls);
  assert.equal(a.update(call('late')),false,'completed streams cannot change saved metadata');
});

test('aborts/errors close running rows, lifecycle boundaries reject stale updates and new responses do not inherit history',async()=>{
  for(const [stopReason,status]of [['aborted','cancelled'],['error','error'],['length','cancelled']]){
    const f=await fixture(),reporter=f.createProviderToolReporter(f.pi,'demo');f.emit('before_provider_request');const stream=reporter.begin();
    stream.update(call('done','done','completed'));stream.update(call('pending'));
    const saved=f.emit('message_end',{message:message(stopReason)}).message;
    assert.equal(f.providerToolCalls(saved)[0].status,'completed');assert.equal(f.providerToolCalls(saved)[1].status,status);
    f.emit('before_provider_request');const next=reporter.begin();next.update(call('new'));
    assert.equal(f.providerToolCalls(saved).length,2);assert.equal(stream.update(call('late')),false);
    f.emit('model_select');assert.equal(next.update(call('also stale')),false);
    f.emit('before_provider_request');const after=reporter.begin();after.update(call('fresh'));
    const current=message();f.emit('message_start',{message:current});assert.equal(f.providerToolCalls(current).length,1);
    f.emit('session_before_tree');assert.equal(after.update(call('stale tree')),false);
    f.emit('session_shutdown');assert.equal(after.update(call('stale shutdown')),false);
  }
});

test('generic provider metadata is bounded, rejects malformed values and does not add metadata to unused responses',async()=>{
  const f=await fixture();assert.throws(()=>f.createProviderToolReporter(f.pi,'bad namespace'));
  const reporter=f.createProviderToolReporter(f.pi,'demo');f.emit('before_provider_request');
  assert.equal(f.emit('message_end',{message:message('stop')}),undefined);
  f.emit('before_provider_request');const stream=reporter.begin();
  for(const invalid of [{},null,{...call('x'),status:'bad'},call(''),call('x'.repeat(513))])assert.equal(stream.update(invalid),false);
  stream.update({...call('long','a'.repeat(10000)),label:'b'.repeat(200)});
  for(let n=0;n<255;n++)assert.equal(stream.update(call('row'+n)),true);assert.equal(stream.update(call('overflow')),false);
  const saved=f.emit('message_end',{message:message('stop')}).message;
  assert.equal(f.providerToolCalls(saved).length,256);assert.equal(f.providerToolCalls(saved)[0].summary.length,8192);assert.equal(f.providerToolCalls(saved)[0].label.length,120);
  assert.deepEqual(f.providerToolCalls({providerToolCalls:{version:2,calls:[]}}),[]);assert.deepEqual(f.providerToolCalls(undefined),[]);
});
