const {test} = require('node:test');
const assert = require('node:assert/strict');
const {join} = require('node:path');
const {load} = require('./test-helper.cjs');
const {fixture,until,sleep} = require('./groups.test.cjs');
const signal=()=>new AbortController().signal;
async function open(f,caller='main') {const {workflowAgentsAPI}=await load('workflow-agents.ts');return workflowAgentsAPI(f.workspace,caller).openRun({sourcePath:join(f.dir,'workflow.js'),signal:signal()});}
function controlledFactory(controls) {
  return async(w,r)=>{
    const controller=new AbortController();
    r.session={messages:[],extensionRunner:{emit:async()=>{}},dispose(){},abort:async()=>controller.abort(),prompt:async()=>{
      controls.started.push(r.identity.name);
      await new Promise(resolve=>{controls.release.set(r.identity.name,resolve);controller.signal.addEventListener('abort',resolve,{once:true});});
      const aborted=controller.signal.aborted;
      r.session.messages.push({role:'assistant',content:aborted?[]:[{type:'text',text:r.identity.name}],stopReason:aborted?'aborted':'stop',usage:{input:1,output:2,cacheRead:0,cacheWrite:0,totalTokens:3,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
      w.observe(r,{type:'agent_settled',aborted});
    }};
  };
}
test('object/YAML parity, strict atomic registration, local precedence and immutable catalog snapshots',async()=>{
  const f=await fixture({leaf:true});
  try {
    const run=await open(f); const {normalizeTemplate,parseTemplate}=await load('templates.ts');
    assert.deepEqual(normalizeTemplate({name:'a',skills:{extra_paths:['./skill']}},join(f.dir,'a.yaml')),parseTemplate('name: a\nskills: {extra_paths: [./skill]}',join(f.dir,'a.yaml')));
    await assert.rejects(run.registerAgents([{name:'a'},{name:'bad',unknown:true}]),/unknown/);
    await assert.rejects(run.agent('task','a',undefined,signal()),/disallowed/);
    await assert.rejects(run.registerAgents([{name:'a',subagents:{allowed:['denied']}}]),/disallowed/);
    await run.registerAgents([{name:'worker',description:'Local worker',prompt:'Local shadows YAML',subagents:{include_defaults:true}},{name:'helper',description:'Local helper',subagents:{allowed:['worker']}}]);
    const first=await run.agent('task','worker',undefined,signal());
    const record=f.workspace.get(first.name);
    assert.equal(record.template.prompt,'Local shadows YAML');
    const {promptIdentity} = await load('loadout.ts'), {publicTemplate,restoreRegistry} = await load('workflow-agents.ts');
    assert.equal(publicTemplate(record.template).description,'Local worker');
    const restoredRegistry = restoreRegistry(record.workflowRegistry.snapshot);
    assert.equal(restoredRegistry.templates.get('helper').description,'Local helper');
    assert.match(promptIdentity(record.identity,record.template,name=>f.workspace.resolveTemplate(record,name)).agent_workspace, /helper — Local helper/);
    assert.deepEqual(record.template.subagents.allowed,['worker','helper']);
    assert.ok(Object.isFrozen(record.template));
    await assert.rejects(run.registerAgents([{name:'worker'}]),/Duplicate/);
    await assert.rejects(run.registerAgents([{name:'huge',prompt:'x'.repeat(128*1024)}]),/128 KiB/);
    await run.registerAgents([{name:'later'}]);
    assert.deepEqual(record.template.subagents.allowed,['worker','helper']);
    assert.equal(f.templates.get('worker').prompt,'');
    assert.deepEqual(f.workspace.get('main').template.subagents.allowed,[]);
    await assert.rejects(f.workspace.create('main','leaked','task','worker'),/not permitted/);
    await run.close();
    await assert.rejects(run.registerAgents([{name:'late'}]),/closed/);
  } finally {await f.cleanup();}
});
test('global templates require caller permission, every launch isolated; unique long prefixes and final empty text',async()=>{
  const f=await fixture();
  try {
    const run=await open(f);
    await assert.rejects(run.agent('task','denied',undefined,signal()),/disallowed/);
    const first=await run.agent('task','worker','explicit',signal()), second=await run.agent('empty','worker','explicit',signal());
    assert.equal(first.name,'explicit-1');assert.equal(second.name,'explicit-2');assert.equal(second.text,'');assert.equal(first.usage.totalTokens,5);
    assert.notEqual(f.workspace.get(first.name).identity.groupId,f.workspace.get(second.name).identity.groupId);
    assert.equal(f.workspace.get(first.name).identity.parentName,null);assert.deepEqual(f.received,[]);
    const long=await run.agent('task','worker','A'.repeat(64),signal());assert.equal(long.name.length,64);assert.match(long.name,/-1$/);
    await assert.rejects(run.agent('task','worker','bad name',signal()),/Names/);
    await run.close();
    const next=await open(f);const third=await next.agent('task','worker','explicit',signal());assert.equal(third.name,'explicit-3');await next.close();
  } finally {await f.cleanup();}
});
test('FIFO acquisition shares global limits with ordinary creates and queued cancellation',async()=>{
  const controls={started:[],release:new Map()};const f=await fixture({max:1,factory:controlledFactory(controls)});
  try {
    const run=await open(f);const cancel=new AbortController();
    const a=run.agent('task','worker','a',signal()),b=run.agent('task','worker','b',cancel.signal),c=run.agent('task','worker','c',signal());
    const rejected=assert.rejects(b,/b-1.*worker.*cancelled/);
    await until(()=>controls.started.length===1);assert.deepEqual(controls.started,['a-1']);
    await assert.rejects(f.workspace.create('main','ordinary','task'),/capacity/);
    cancel.abort();await rejected;
    controls.release.get('a-1')();assert.equal((await a).name,'a-1');
    await until(()=>controls.started.length===2);assert.deepEqual(controls.started,['a-1','c-1']);
    controls.release.get('c-1')();await c;
    assert.equal(f.workspace.groups.size,5); // root, container and 3 reserved agent groups
    assert.ok([...f.workspace.groups.values()].some(g=>g.label==='Agent: b-1'&&g.status==='cancelled'));
    await run.close();
  } finally {for(const release of controls.release.values())release();await f.cleanup();}
});
test('synchronous workflow reservations defeat ordinary create races and restored names stay unique',async()=>{
  const f=await fixture({max:3});
  try {
    const run=await open(f);await run.registerAgents([{name:'local'}]);
    const operation=run.agent('task','local',undefined,signal());
    await assert.rejects(f.workspace.create('main','local-1','ordinary','worker'),/already used/);
    const result=await operation;await run.close();
    const members=f.manager.getBranch().filter(e=>e.type==='custom'&&e.customType==='subagents.member.v1');
    assert.equal(members.filter(e=>e.data.identity.name==='local-1').length,1);
    await f.workspace.close();const {Workspace}=await load('workspace.ts');
    const restored=new Workspace({...f.options,ephemeralSessions:f.workspace.ephemeralSessions});await restored.restore();
    const next=await open({...f,workspace:restored});await next.registerAgents([{name:'local'}]);
    assert.equal((await next.agent('task','local',undefined,signal())).name,'local-2');await next.close();await restored.close();
    f.manager.appendCustomEntry('subagents.member.v1',{...members[0].data,identity:{...members[0].data.identity,instanceId:'different-instance'}});
    const corrupt=new Workspace({...f.options,ephemeralSessions:f.workspace.ephemeralSessions});await assert.rejects(corrupt.restore(),/Conflicting agent membership/);await corrupt.close();
  } finally {await f.cleanup();}
});
test('true pre-group worker histories migrate into the root group only',async()=>{
  const f=await fixture();
  try {
    await f.workspace.create('main','legacy','task');await until(()=>!f.workspace.get('legacy').busy);
    const worker=f.workspace.get('legacy');delete worker.manager.getBranch().filter(e=>e.type==='custom'&&e.customType==='subagents.identity.v1').at(-1).data.groupId;
    const manager=f.sdk.SessionManager.inMemory(f.dir),identity={...f.options.identity};delete identity.groupId;
    manager.appendCustomEntry('subagents.identity.v1',identity);
    const oldIdentity={...worker.identity};delete oldIdentity.groupId;
    manager.appendCustomEntry('subagents.member.v1',{identity:oldIdentity,template:worker.template});
    const {Workspace}=await load('workspace.ts');const restored=new Workspace({...f.options,identity,context:{...f.options.context,sessionManager:manager},append:(key,data)=>manager.appendCustomEntry(key,data),ephemeralSessions:f.workspace.ephemeralSessions});
    await restored.restore();assert.equal(restored.get('legacy').identity.groupId,restored.rootGroupId);assert.deepEqual(restored.list('main',true).map(r=>r.name),['main','legacy']);await restored.close();
  } finally {await f.cleanup();}
});
test('active cancellation rejects with usage and cancels ordinary owned descendants, not unrelated work',async()=>{
  const controls={started:[],release:new Map()};const f=await fixture({max:4,factory:controlledFactory(controls)});
  try {
    await f.workspace.create('main','unrelated','task');
    const run=await open(f);await run.registerAgents([{name:'root',subagents:{allowed:['helper']}},{name:'helper'}]);
    const cancel=new AbortController();const task=run.agent('task','root',undefined,cancel.signal);let error;
    const observed=task.catch(e=>{error=e;});
    await until(()=>controls.started.includes('root-1'));
    await f.workspace.create('root-1','owned-child','task','helper');
    await until(()=>controls.started.includes('owned-child'));
    cancel.abort();await observed;
    assert.match(error.message,/root-1.*root.*interrupted|root-1.*root.*cancelled/);assert.ok(error.usage.totalTokens>=3);
    assert.equal(f.workspace.get('owned-child').status,'interrupted');assert.equal(f.workspace.get('unrelated').status,'running');
    await run.close();controls.release.get('unrelated')();
    await until(()=>!f.workspace.get('unrelated').busy);
  } finally {for(const release of controls.release.values())release();await f.cleanup();}
});
test('settled roots retain scoped descendant ownership, cancellation acknowledges cleanup and late usage',async()=>{
  let finishChild;const f=await fixture({max:3,factory:async(w,r)=>{
    let aborted=false;
    r.session={messages:[],extensionRunner:{emit:async()=>{}},dispose(){},abort:async()=>{aborted=true;if(r.identity.name==='helper-child') {await sleep(30);finishChild?.();}},prompt:async()=>{
      if(r.identity.name==='leader-1') await w.create(r.identity.name,'helper-child','task','helper');
      if(r.identity.name==='helper-child') await new Promise(resolve=>finishChild=resolve);
      r.session.messages.push({role:'assistant',content:[{type:'text',text:'done'}],stopReason:aborted?'aborted':'stop',usage:{input:0,output:r.identity.name==='helper-child'?100:5,cacheRead:0,cacheWrite:0,totalTokens:r.identity.name==='helper-child'?100:5,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
      w.observe(r,{type:'agent_settled',aborted});
    }};
  }});
  try {
    const run=await open(f);await run.registerAgents([{name:'leader',subagents:{allowed:['helper']}},{name:'helper'}]);
    const controller=new AbortController();const result=await run.agent('task','leader',undefined,controller.signal);
    assert.equal(f.workspace.get('helper-child').status,'running');assert.equal(result.usage.totalTokens,5);
    controller.abort();await run.cancelAgents(controller.signal);
    assert.equal(f.workspace.get('helper-child').status,'interrupted');assert.equal(result.usage.totalTokens,105);
    // Cancel the initial owned task again after a deliberate authorized newer run: its waiter must survive.
    const root=f.workspace.get(result.name);let interrupted=false;root.runId='newer-run';root.status='waiting';root.waiter={sequence:1,finish:()=>interrupted=true};
    await f.workspace.cancelOwnedRun(run.id);assert.equal(interrupted,false);root.waiter=undefined;root.status='idle';await run.close();
    assert.equal(result.usage.totalTokens,105);
  } finally {finishChild?.();await f.cleanup();}
});
test('nested headless roots reset local depth and nested capacity fails with actionable deadlock',async()=>{
  const controls={started:[],release:new Map()};const f=await fixture({max:1,depth:1,groupDepth:2,factory:controlledFactory(controls)});
  try {
    const run=await open(f);await run.registerAgents([{name:'local'}]);
    const task=run.agent('task','local',undefined,signal());void task.catch(()=>{});
    await until(()=>controls.started.length===1);
    const nested=await open(f,'local-1');await nested.registerAgents([{name:'nested'}]);
    await assert.rejects(nested.agent('task','nested',undefined,signal()),/capacity deadlock/);
    await nested.close();
    f.options.config.max_running=2;
    const next=await open(f,'local-1');await next.registerAgents([{name:'nested'}]);
    const deeper=next.agent('task','nested',undefined,signal());void deeper.catch(()=>{});await until(()=>controls.started.includes('nested-2'));
    assert.equal(f.workspace.get('nested-2').ownership.creationDepth,0);
    assert.equal(f.workspace.get('nested-2').ownership.depthScope,'group');
    const tooDeep=await open(f,'nested-2');await tooDeep.registerAgents([{name:'third'}]);
    await assert.rejects(tooDeep.agent('task','third',undefined,signal()),/group nesting depth/);await tooDeep.close();
    controls.release.get('nested-2')();await deeper;await next.close();controls.release.get('local-1')();await task;await run.close();
  } finally {for(const release of controls.release.values())release();await f.cleanup();}
});
test('local child depth limits reset across workflow groups, including workflows issued at the local limit',async()=>{
  const f=await fixture({depth:1,groupDepth:2});
  try {
    await f.workspace.create('main','ordinary-leader','task','leader');await until(()=>!f.workspace.get('ordinary-leader').busy);
    await assert.rejects(f.workspace.create('ordinary-leader','too-local','task','leader'),/agent nesting depth/);
    const run=await open(f,'ordinary-leader');await run.registerAgents([{name:'local',subagents:{allowed:['helper']}},{name:'helper',subagents:{allowed:['helper']}}]);
    const root=await run.agent('task','local',undefined,signal());
    assert.equal(f.workspace.get(root.name).ownership.creationDepth,0);
    await f.workspace.create(root.name,'child','task','helper');await until(()=>!f.workspace.get('child').busy);
    assert.equal(f.workspace.get('child').ownership.creationDepth,1);
    await assert.rejects(f.workspace.create('child','grandchild','task','helper'),/agent nesting depth/);
    const nested=await open(f,'child');await nested.registerAgents([{name:'reset',subagents:{allowed:['helper']}},{name:'helper'}]);
    const reset=await nested.agent('task','reset',undefined,signal());
    assert.equal(f.workspace.get(reset.name).ownership.creationDepth,0);
    await f.workspace.create(reset.name,'reset-child','task','helper');await until(()=>!f.workspace.get('reset-child').busy);
    await nested.close();await run.close();
  } finally {await f.cleanup();}
});
test('group limits count agents only, permit containers at zero and reject nested reservations before persistence',async()=>{
  for(const groupDepth of [0,1]) {
    const f=await fixture({groupDepth,depth:1});
    try {
      const run=await open(f);await run.registerAgents([{name:'local'}]);
      assert.equal(f.workspace.groups.size,2);
      if(groupDepth===0) {
        await assert.rejects(run.agent('task','local',undefined,signal()),/group nesting depth/);
        assert.equal(f.workspace.groups.size,2);assert.equal(f.workspace.records.size,1);
      } else {
        const root=await run.agent('task','local',undefined,signal());
        const sibling=await run.agent('task','local',undefined,signal());
        assert.equal(f.workspace.get(sibling.name).ownership.creationDepth,0);
        const nested=await open(f,root.name);await nested.registerAgents([{name:'nested'}]);
        const count=f.workspace.groups.size;
        await assert.rejects(nested.agent('task','nested',undefined,signal()),/group nesting depth/);
        assert.equal(f.workspace.groups.size,count);assert.equal(f.workspace.records.size,3);
        await nested.close();
      }
      await run.close();
    } finally {await f.cleanup();}
  }
});
test('new launches recheck group limits after FIFO wake and setup; ordinary setup rechecks local limits',async()=>{
  const controls={started:[],release:new Map()};const f=await fixture({max:1,factory:controlledFactory(controls)});
  try {
    const run=await open(f);await run.registerAgents([{name:'local'}]);
    const active=run.agent('task','local','active',signal());await until(()=>controls.started.length===1);
    const queued=run.agent('task','local','queued',signal());const rejected=assert.rejects(queued,/group nesting depth/);
    await until(()=>f.workspace.groups.size===4);
    f.options.config.max_group_depth=0;controls.release.get('active-1')();await active;await rejected;
    assert.deepEqual(controls.started,['active-1']);assert.equal(f.workspace.records.has('queued-1'),false);
    await run.close();
  } finally {for(const release of controls.release.values())release();await f.cleanup();}
  const g=await fixture({depth:2});
  try {
    await g.workspace.create('main','leader','task','leader');await until(()=>!g.workspace.get('leader').busy);
    const factory=g.options.workerFactory;let release,entered=false;
    g.options.workerFactory=async(...args)=>{entered=true;await new Promise(resolve=>release=resolve);return factory(...args);};
    const child=g.workspace.create('leader','child','task','worker');const rejected=assert.rejects(child,/agent nesting depth/);
    await until(()=>entered);g.options.config.max_depth=1;release();await rejected;assert.equal(g.workspace.records.has('child'),false);
    assert.equal(g.manager.getBranch().some(e=>e.type==='custom'&&e.customType==='subagents.member.v1'&&e.data.identity.name==='child'),false);
    assert.equal(g.workspace.get('leader').manager.getBranch().some(e=>e.type==='custom'&&e.customType==='subagents.member.v1'&&e.data.identity.name==='child'),false);
    entered=false;g.options.config.max_group_depth=1;
    const run=await open(g);await run.registerAgents([{name:'local'}]);
    const root=run.agent('task','local',undefined,signal());const rejectedRoot=assert.rejects(root,/group nesting depth/);
    await until(()=>entered);g.options.config.max_group_depth=0;release();await rejectedRoot;
    assert.equal(g.workspace.get('local-1').status,'error');await run.close();
  } finally {await g.cleanup();}
});
test('live group ancestry traversal fails closed on missing parents and cycles before agent reservation',async()=>{
  const f=await fixture();
  try {
    const run=await open(f);await run.registerAgents([{name:'local'}]);
    const container=[...f.workspace.groups.values()].find(g=>g.kind==='workflow');
    const original={...container};
    for(const parentGroupId of ['missing',container.id]) {
      f.workspace.groups.set(container.id,{...original,parentGroupId});
      await assert.rejects(run.agent('task','local',undefined,signal()),/Unknown agent group|Cyclic agent groups/);
      assert.equal(f.workspace.groups.size,2);assert.equal(f.workspace.records.size,1);
    }
    f.workspace.groups.set(container.id,original);await run.close();
  } finally {await f.cleanup();}
});
test('old cross-group ownership is validated and migrated in memory; new local metadata fails closed',async()=>{
  for(const legacy of [false,true,'mixed']) {
    const f=await fixture({depth:4,groupDepth:4});const {Workspace}=await load('workspace.ts');
    try {
      const run=await open(f);await run.registerAgents([{name:'outer',subagents:{allowed:['helper']}},{name:'helper',subagents:{allowed:['helper']}}]);
      const outer=await run.agent('task','outer',undefined,signal());
      await f.workspace.create(outer.name,'child','task','helper');await until(()=>!f.workspace.get('child').busy);
      const nested=await open(f,'child');await nested.registerAgents([{name:'inner',subagents:{allowed:['helper']}},{name:'helper'}]);
      const inner=await nested.agent('task','inner',undefined,signal());
      await f.workspace.create(inner.name,'deep-child','task','helper');await until(()=>!f.workspace.get('deep-child').busy);
      await nested.close();await run.close();await f.workspace.close();
      const members=f.manager.getBranch().filter(e=>e.type==='custom'&&e.customType==='subagents.member.v1');
      const globalDepth={[outer.name]:1,child:2,[inner.name]:3,'deep-child':4};
      if(legacy) for(const e of members) {
        if(legacy==='mixed' && [inner.name,'deep-child'].includes(e.data.identity.name)) continue;
        delete e.data.ownership.depthScope;e.data.ownership.creationDepth=globalDepth[e.data.identity.name];
      }
      const before=JSON.stringify(f.manager.getBranch());
      f.options.config.max_depth=1;f.options.config.max_group_depth=0;
      const restored=new Workspace({...f.options,ephemeralSessions:f.workspace.ephemeralSessions});await restored.restore();
      assert.equal(JSON.stringify(f.manager.getBranch()),before);
      for(const name of [outer.name,inner.name]) assert.deepEqual([restored.get(name).ownership.depthScope,restored.get(name).ownership.creationDepth],['group',0]);
      for(const name of ['child','deep-child']) assert.equal(restored.get(name).ownership.creationDepth,1);
      await restored.close();
      const target=members.find(e=>e.data.identity.name===inner.name);
      const original={...target.data.ownership};
      for(const patch of [{creationDepth:original.depthScope?3:0},{depthScope:'invalid'},{ownerInstanceId:'missing'},{inheritanceSourceInstanceId:'main-instance'},{ownerInstanceId:target.data.identity.instanceId,inheritanceSourceInstanceId:target.data.identity.instanceId}]) {
        target.data.ownership={...original,...patch};
        const corrupt=new Workspace({...f.options,ephemeralSessions:f.workspace.ephemeralSessions});
        await assert.rejects(corrupt.restore(),/ownership|depth scope/);await corrupt.close();
      }
      target.data.ownership=original;
    } finally {await f.cleanup();}
  }
});
test('real installed SDK fake-provider roots hide all four agent tools, persist local provenance, and resume without YAML',async()=>{
  const f=await fixture({real:true});
  try {
    const run=await open(f);await run.registerAgents([{name:'saved',prompt:'Immutable task',tools:{include_defaults:false,extra:['list_agents','send_message','wait_message','create_agent']},skills:{include_defaults:false}}]);
    const result=await run.agent('task','saved',undefined,signal());const record=f.workspace.get(result.name);
    assert.equal(result.text,'SDK final answer');assert.equal(result.usage.totalTokens,5);
    for(const tool of ['list_agents','send_message','wait_message','create_agent']) {
      const exposed=record.session.getAllTools().find(t=>t.name===tool);assert.ok(!exposed||exposed.exposure==='hidden');
    }
    assert.deepEqual(record.session.getActiveToolNames(),[]);assert.deepEqual(f.received,[]);
    await run.close();
    const cache=f.workspace.ephemeralSessions;await f.workspace.close();
    f.templates.delete('saved'); // it never entered the global map
    const {Workspace}=await load('workspace.ts');const restored=new Workspace({...f.options,ephemeralSessions:cache});await restored.restore();
    const saved=restored.get(result.name);assert.equal(saved.template.prompt,'Immutable task');assert.equal(saved.identity.parentName,null);assert.equal(saved.identity.groupId,record.identity.groupId);
    assert.ok(saved.workflowRegistry);assert.equal(saved.status,'idle');
    // Trusted fixture installs an authorized non-root group peer; no cross-group model bypass.
    const peer={...restored.get('main'),identity:{...restored.get('main').identity,name:'peer',instanceId:'peer',role:'worker',parentName:result.name,groupId:saved.identity.groupId},inbox:[],pending:[]};
    restored.records.set('peer',peer);
    await restored.send('peer',result.name,'resume');await until(()=>saved.session&&!saved.busy&&saved.status==='idle');
    assert.equal(saved.template.prompt,'Immutable task');assert.equal(saved.identity.parentName,null);assert.deepEqual(f.received,[]);
    restored.records.delete('peer');await restored.close();
  } finally {await f.cleanup();}
});
test('real SDK child reports create owned root continuations; scoped cancellation stops new roots/children and counts usage',async()=>{
  const f=await fixture({real:true,max:4});let releaseFirst;let rootRequests=0,secondHelperHeld=false;
  const config=f.options.context.modelRegistry.getRegisteredProviderConfig('groups-test');
  const usage=n=>({input:0,output:n,cacheRead:0,cacheWrite:0,totalTokens:n,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}});
  f.runtime.registerProvider('groups-test',{...config,streamSimple(model,context,options){
    const input=context.messages.filter(m=>m.role==='user').map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');
    const root=input.includes('root assigned'),first=input.includes('first helper assignment');
    const request=root?++rootRequests:0;
    const content=root&&(request===1||request===3)?[{type:'toolCall',id:'create-'+request,name:'create_agent',arguments:{name:request===1?'first-helper':'new-helper',task:request===1?'first helper assignment':'second helper assignment',agent_template:'helper'}}]:[{type:'text',text:root?'root final':'helper final'}];
    const output={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content,stopReason:'pending',usage:usage(root?(request===3?1000:5):100)};
    const stream=f.ai.createAssistantMessageEventStream();
    void(async()=>{
      stream.push({type:'start',partial:output});
      if(first)await new Promise(resolve=>{releaseFirst=resolve;options.signal.addEventListener('abort',resolve,{once:true});});
      if(root&&request===4||!root&&!first){if(!root)secondHelperHeld=true;await new Promise(resolve=>{if(options.signal.aborted)resolve();else options.signal.addEventListener('abort',resolve,{once:true});});}
      for(const [index,block]of content.entries())if(block.type==='toolCall'){stream.push({type:'toolcall_start',contentIndex:index,partial:output});stream.push({type:'toolcall_end',contentIndex:index,toolCall:block,partial:output});}else{stream.push({type:'text_start',contentIndex:index,partial:output});stream.push({type:'text_delta',contentIndex:index,delta:block.text,partial:output});stream.push({type:'text_end',contentIndex:index,content:block.text,partial:output});}
      output.stopReason=options.signal.aborted?'aborted':content.some(c=>c.type==='toolCall')?'toolUse':'stop';
      if(options.signal.aborted)stream.push({type:'error',reason:'aborted',error:output});else stream.push({type:'done',reason:output.stopReason,message:output});stream.end();
    })();return stream;
  }});
  try {
    const run=await open(f);await run.registerAgents([{name:'leader',tools:{include_defaults:false,extra:[]},skills:{include_defaults:false},subagents:{allowed:['helper']}},{name:'helper',tools:{include_defaults:false,extra:[]},skills:{include_defaults:false}}]);
    const controller=new AbortController();const completion=await run.agent('root assigned','leader',undefined,controller.signal);
    const leader=f.workspace.get(completion.name),firstRunId=leader.runId;await until(()=>!leader.busy&&releaseFirst);releaseFirst();
    await until(()=>rootRequests===4&&secondHelperHeld);
    assert.notEqual(leader.runId,firstRunId);assert.equal(leader.status,'running');assert.equal(f.workspace.group(leader.identity.groupId).status,'running');
    await run.cancelAgents(controller.signal);await run.close();
    assert.ok(!['starting','running','waiting'].includes(leader.status));assert.ok(!['starting','running','waiting'].includes(f.workspace.get('new-helper').status));
    const actual=[leader,f.workspace.get('first-helper'),f.workspace.get('new-helper')].reduce((sum,r)=>sum+r.manager.getBranch().reduce((n,e)=>n+(e.type==='message'&&e.message.usage?e.message.usage.totalTokens:0),0),0);
    assert.ok(actual>=1110);assert.equal(completion.usage.totalTokens,actual);assert.deepEqual(f.received,[]);
  } finally {releaseFirst?.();await f.cleanup();}
});
test('settled completion excludes intermediate text and survives projected-history compaction with usage deltas',async()=>{
  const usage=n=>({input:0,output:n,cacheRead:0,cacheWrite:0,totalTokens:n,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}});
  let release;const f=await fixture({factory:async(w,r)=>{
    const old={role:'assistant',content:[{type:'text',text:'old history'}],stopReason:'stop',usage:usage(100)};
    for(let i=0;i<20;i++)r.manager.appendMessage({...old,timestamp:i});
    r.session={messages:Array(20).fill(old),abort:async()=>release?.(),extensionRunner:{emit:async()=>{}},dispose(){},prompt:async()=>{
      const intermediate={...old,content:[{type:'text',text:'intermediate'}],usage:usage(2)};
      r.session.messages.push(intermediate);r.manager.appendMessage({...intermediate,timestamp:Date.now()});w.observe(r,{type:'message_end',message:intermediate});w.observe(r,{type:'agent_end',messages:[]});
      await new Promise(resolve=>release=resolve);
      const final={...old,content:[{type:'thinking',thinking:'hidden'},{type:'text',text:'final one'},{type:'text',text:'final two'}],usage:usage(5)};
      r.session.messages=[final];r.manager.appendMessage({...final,timestamp:Date.now()});w.observe(r,{type:'message_end',message:final});w.observe(r,{type:'agent_settled',aborted:false});
    }};
  }});
  try {
    const run=await open(f);let settled=false;const task=run.agent('task','worker',undefined,signal()).then(result=>{settled=true;return result;});
    await until(()=>release);await sleep(10);assert.equal(settled,false);release();const result=await task;
    assert.equal(result.text,'final one\nfinal two');assert.equal(result.usage.totalTokens,7);await run.close();assert.deepEqual(f.received,[]);
  } finally {release?.();await f.cleanup();}
});
test('startup failure retains inspectable group and releases capacity for FIFO followers',async()=>{
  const f=await fixture({max:1,factory:async(w,r)=>{if(r.identity.name==='bad-1')throw new Error('setup failure');r.session={messages:[],abort:async()=>{},extensionRunner:{emit:async()=>{}},dispose(){},prompt:async()=>w.observe(r,{type:'agent_settled',aborted:false})};}});
  try {
    const run=await open(f);const bad=run.agent('task','worker','bad',signal()),good=run.agent('task','worker','good',signal());
    await assert.rejects(bad,/bad-1.*worker.*setup failure/);assert.equal((await good).name,'good-1');assert.equal(f.workspace.get('bad-1').status,'error');
    assert.ok([...f.workspace.groups.values()].some(g=>g.agentName==='bad-1'&&g.status==='failed'));await run.close();
    const {Workspace}=await load('workspace.ts');const restored=new Workspace({...f.options,ephemeralSessions:f.workspace.ephemeralSessions});await restored.restore();assert.ok(restored.records.has('bad-1'));await restored.close();
  } finally {await f.cleanup();}
});
test('new group-tagged members fail closed on missing registry/ownership; legacy workers migrate',async()=>{
  const f=await fixture();
  try {
    const run=await open(f);await run.registerAgents([{name:'local'}]);const result=await run.agent('task','local',undefined,signal());await run.close();
    const {Workspace}=await load('workspace.ts');const member=f.manager.getBranch().filter(e=>e.type==='custom'&&e.customType==='subagents.member.v1').at(-1).data;
    f.manager.appendCustomEntry('subagents.member.v1',{...member,identity:{...member.identity,name:'corrupt'},registryId:undefined});
    const restored=new Workspace({...f.options,ephemeralSessions:f.workspace.ephemeralSessions});await assert.rejects(restored.restore(),/provenance/);await restored.close();
    f.manager.appendCustomEntry('subagents.workflow-registry.v1',{version:1,id:'bad',sourcePath:'relative.js',definitions:[],globals:[]});
    const invalid=new Workspace({...f.options,ephemeralSessions:f.workspace.ephemeralSessions});await assert.rejects(invalid.restore(),/source/);await invalid.close();
  } finally {await f.cleanup();}
});
