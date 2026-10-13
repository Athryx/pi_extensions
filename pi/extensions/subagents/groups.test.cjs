const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, mkdir, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {load, host} = require('./test-helper.cjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(predicate) { for (let i=0;i<400;i++) { if (predicate()) return; await sleep(5); } throw new Error('Condition timed out'); }
async function fixture({leaf=false, max=2, depth=4, groupDepth=4, factory, real=false}={}) {
  const {Workspace} = await load('workspace.ts'), {normalizeTemplate} = await load('templates.ts');
  const sdk = await host('dist/index.js'), ai = await host('node_modules/@earendil-works/pi-ai/dist/index.js');
  const dir = await mkdtemp(join(tmpdir(), 'pi-groups-'));
  const agentDir = join(dir,'agent'); await mkdir(agentDir);
  const runtime = await sdk.ModelRuntime.create({authPath: join(agentDir,'auth.json'), modelsPath:null, refreshOnCreate:false});
  runtime.registerProvider('groups-test',{api:'groups-test',apiKey:'fake-key',baseUrl:'http://unused.invalid',models:[{id:'fake',name:'Fake',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000}],streamSimple(model,context,options) {
    const stream = ai.createAssistantMessageEventStream();
    const output={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content:[{type:'text',text:'SDK final answer'}],stopReason:'stop',usage:{input:2,output:3,cacheRead:0,cacheWrite:0,totalTokens:5,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    queueMicrotask(()=>{stream.push({type:'start',partial:output});stream.push({type:'done',reason:'stop',message:output});stream.end();}); return stream;
  }});
  const registry = new sdk.ModelRegistry(runtime), model = registry.find('groups-test','fake');
  const manager = sdk.SessionManager.inMemory(dir);
  const identity={version:1,workspaceId:'group-workspace',instanceId:'main-instance',name:'main',template:'main',role:'interactive',parentName:null};
  manager.appendCustomEntry('subagents.identity.v1',identity);
  const templates = new Map(['main','worker','leader','denied'].map(name=>[name,normalizeTemplate({name,tools:{include_defaults:false,extra:[]},skills:{include_defaults:false},subagents: name==='leader'||name==='main'&&!leaf ? {allowed:['worker','leader'],default:'worker'} : {allowed:[]}},join(dir,name+'.yaml'))]));
  const context={cwd:dir,sessionManager:manager,modelRegistry:registry,model,thinkingLevel:'off',isIdle:()=>false};
  const received=[];
  const events=[];
  const fakeFactory=async(workspace,record)=>{
    record.session={messages:[],abort:async()=>{events.push('abort:'+record.identity.name);},extensionRunner:{emit:async()=>{}},dispose(){},model,thinkingLevel:'off',sendCustomMessage:async()=>{},prompt:async(task)=>{
      events.push('start:'+record.identity.name);
      record.session.messages.push({role:'assistant',content:[{type:'thinking',thinking:'private'},...task==='empty'?[]:[{type:'text',text:'Final '+record.identity.name}]],stopReason:'stop',usage:{input:2,output:3,cacheRead:0,cacheWrite:0,totalTokens:5,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
      workspace.observe(record,{type:'agent_end',messages:[]});
      workspace.observe(record,{type:'agent_settled',aborted:false});
    }};
  };
  const options={cwd:dir,agentDir,trusted:true,config:{agent_paths:[],max_running:max,max_depth:depth,max_group_depth:groupDepth,worker_exclude_extensions:[]},identity,context,templates,append:(key,data)=>manager.appendCustomEntry(key,data),rootSend:envelope=>received.push(envelope),workerFactory:factory??(real?undefined:fakeFactory)};
  const workspace=new Workspace(options);
  return {workspace,options,manager,templates,received,events,dir,sdk,ai,runtime,fixture,cleanup:async()=>{await workspace.close();await rm(dir,{recursive:true,force:true});}};
}
module.exports={fixture,until,sleep};
if (require.main === module) {
  test('ordinary agents remain in root group and all=true never flattens child groups', async()=>{
    const f=await fixture(); const {workflowAgentsAPI}=await load('workflow-agents.ts');
    try {
      await f.workspace.create('main','ordinary','task'); await until(()=>!f.workspace.get('ordinary').busy);
      const run=workflowAgentsAPI(f.workspace,'main').openRun({sourcePath:join(f.dir,'test.js'),signal:new AbortController().signal});
      await run.registerAgents([{name:'local',subagents:{allowed:['helper']}},{name:'helper'}]);
      const result=await run.agent('task','local',undefined,new AbortController().signal);
      const root=f.workspace.get(result.name);
      await f.workspace.create(result.name,'inside','task','helper'); await until(()=>!f.workspace.get('inside').busy);
      assert.equal(root.identity.parentName,null); assert.equal(root.identity.role,'worker');
      assert.equal(f.workspace.get('inside').identity.groupId,root.identity.groupId);
      assert.equal(f.workspace.get('ordinary').identity.groupId,f.workspace.rootGroupId);
      assert.deepEqual(f.workspace.list('main',true).map(r=>r.name),['main','ordinary']);
      assert.deepEqual(f.workspace.list(result.name,true).map(r=>r.name),[result.name,'inside']);
      for (const [from,to] of [['main',result.name],[result.name,'ordinary'],['inside','main']]) await assert.rejects(f.workspace.send(from,to,'probe'),/not available in your group/);
      await assert.rejects(f.workspace.send(result.name,'unknown','probe'),/not available in your group/);
      await f.workspace.send(result.name,'inside','local message');
      await run.close();
    } finally {await f.cleanup();}
  });
  test('leaf roots fail closed at exposure, loadout and direct coordinator operations',async()=>{
    const f=await fixture({leaf:true}); const {loadout,promptIdentity}=await load('loadout.ts'),{registerTools}=await load('tools.ts');
    try {
      const root=f.workspace.get('main');root.template.tools.extra.push('create_agent','list_agents','send_message','wait_message','workflow');
      assert.deepEqual(loadout(root.template,[],root.identity),['workflow']);
      const tools=[];registerTools({registerTool:t=>tools.push(t)},()=>f.workspace,'main',false,root.identity);
      assert.ok(tools.every(t=>t.exposure==='hidden'));
      assert.throws(()=>f.workspace.list('main',true),/unavailable/);
      await assert.rejects(f.workspace.wait('main',1),/unavailable/);
      await assert.rejects(f.workspace.send('main','unknown','probe'),/unavailable/);
      const identity={...root.identity,name:'headless',role:'worker'};
      assert.match(promptIdentity(identity,root.template).agent_workspace,/no messaging parent/);
      assert.deepEqual(loadout(root.template,[],identity),['workflow']);
    } finally {await f.cleanup();}
  });
  test('unrelated running groups cannot mask local message deadlock; corrupt replay rejected',async()=>{
    const f=await fixture();
    try {
      const main=f.workspace.get('main'),other={...main,identity:{...main.identity,name:'external',instanceId:'external',role:'worker',parentName:null,groupId:'external-group'},status:'running',inbox:[],pending:[]};
      const container=f.workspace.addGroup({version:1,id:'container',parentGroupId:f.workspace.rootGroupId,kind:'workflow',label:'Workflow',rootAgentInstanceId:null});
      f.workspace.addGroup({version:1,id:'external-group',parentGroupId:container.id,kind:'agents',label:'External',rootAgentInstanceId:'external'});
      f.workspace.records.set('external',other);
      await assert.rejects(f.workspace.wait('main',1),/Everyone else/);
      main.inbox.push({id:'corrupt',from:'external',to:'main',message:'cross-group'});
      await assert.rejects(f.workspace.wait('main',1),/Corrupt/);
      main.inbox=[];
      f.manager.appendCustomEntry('subagents.delivery.v1',{envelope:{id:'replay',from:'external',to:'main',message:'cross-group'}});
      const {Workspace}=await load('workspace.ts');
      const restored=new Workspace({...f.options,ephemeralSessions:f.workspace.ephemeralSessions});
      // Missing root metadata is also corrupt; restore must never inject the delivery.
      await assert.rejects(restored.restore(),/Missing.*group root member|cross-group/);await restored.close();
      f.workspace.records.delete('external');
    } finally {await f.cleanup();}
  });
  test('restore marks unfinished groups cancelled in memory without rewriting branch snapshots',async()=>{
    const f=await fixture();
    try {
      f.workspace.addGroup({version:1,id:'running-container',parentGroupId:f.workspace.rootGroupId,kind:'workflow',label:'Running',rootAgentInstanceId:null,status:'running'});
      f.workspace.addGroup({version:1,id:'queued-child',parentGroupId:'running-container',kind:'agents',label:'Queued',agentName:'queued-1',rootAgentInstanceId:null,status:'queued'});
      f.workspace.addGroup({version:1,id:'failed-child',parentGroupId:'running-container',kind:'agents',label:'Failed',rootAgentInstanceId:null,status:'failed',error:'Original failure'});
      f.workspace.addGroup({version:1,id:'finished-container',parentGroupId:f.workspace.rootGroupId,kind:'workflow',label:'Finished',rootAgentInstanceId:null,status:'completed'});
      const snapshots=f.manager.getBranch().filter(e=>e.type==='custom'&&e.customType==='subagents.group.v1');
      const before=JSON.stringify(snapshots);const {Workspace}=await load('workspace.ts');
      const restored=new Workspace({...f.options,ephemeralSessions:f.workspace.ephemeralSessions});await restored.restore();
      assert.equal(restored.group('running-container').status,'cancelled');assert.equal(restored.group('queued-child').status,'cancelled');
      assert.match(restored.group('queued-child').error,/not resumed/);assert.deepEqual(restored.members('queued-child'),[]);
      assert.equal(restored.group('failed-child').status,'failed');assert.equal(restored.group('failed-child').error,'Original failure');
      assert.equal(restored.group('finished-container').status,'completed');
      assert.equal(JSON.stringify(f.manager.getBranch().filter(e=>e.type==='custom'&&e.customType==='subagents.group.v1')),before);
      await restored.close();
    } finally {await f.cleanup();}
  });
  test('group graph validation rejects missing parents, cycles and invalid root cardinality',async()=>{
    const {normalizeGroup,validateGroups}=await load('groups.ts');
    const root=normalizeGroup({version:1,id:'root',parentGroupId:null,kind:'root',label:'Root',rootAgentInstanceId:'main'});
    const child={version:1,id:'a',parentGroupId:'b',kind:'workflow',label:'A',rootAgentInstanceId:null};
    assert.throws(()=>validateGroups(new Map([['root',root],['a',child]]),'root'),/Missing/);
    assert.throws(()=>validateGroups(new Map([['root',root],['a',child],['b',{...child,id:'b',kind:'agents',parentGroupId:'a'}]]),'root'),/Cyclic/);
    assert.throws(()=>normalizeGroup({...root,kind:'workflow'}),/hierarchy/);
  });
}
