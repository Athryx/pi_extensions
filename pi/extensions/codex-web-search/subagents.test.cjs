const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,mkdir,writeFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {host}=require('./test-helper.cjs');
const {load}=require('../subagents/test-helper.cjs');

test('real worker preflight, template selection and isolated command overrides',async()=>{
  const sdk=await host('dist/index.js'),ai=await host('node_modules/@earendil-works/pi-ai/dist/index.js');
  const {Workspace}=await load('workspace.ts'),{parseTemplate}=await load('templates.ts');
  const dir=await mkdtemp(join(tmpdir(),'pi-search-workers-')),agentDir=join(dir,'agent');await mkdir(agentDir);
  await writeFile(join(agentDir,'settings.json'),JSON.stringify({extensions:[join(__dirname,'index.ts')],defaultTools:['+web_search'],compaction:{enabled:false}}));
  await writeFile(join(agentDir,'codex-web-search.json'),JSON.stringify({mode:'cached'}));
  const requests=[];
  const runtime=await sdk.ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:null,refreshOnCreate:false});
  runtime.registerProvider('local',{api:'worker-search-test',apiKey:'fake-local-key',baseUrl:'http://unused.invalid',
    models:[{id:'test',name:'Test',reasoning:false,input:['text'],contextWindow:32000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
    streamSimple(model,context,options){
      const stream=ai.createAssistantMessageEventStream();
      queueMicrotask(async()=>{
        const payload={messages:context.messages};const replacement=await options.onPayload?.(payload,model);assert.equal(replacement,payload,'unsupported worker payload is unchanged');
        requests.push(context);
        const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content:[{type:'text',text:'Worker complete.'}],stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
        stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});stream.end();
      });return stream;
    }});
  const registry=new sdk.ModelRegistry(runtime),model=registry.find('local','test'),manager=sdk.SessionManager.inMemory(dir);
  manager.appendMessage({role:'user',content:'Parent conversation',timestamp:Date.now()});
  manager.appendCustomEntry('codex-web-search.mode.v1',{version:1,mode:'live'});
  const identity={version:1,workspaceId:'search-test',instanceId:'root',name:'main',template:'main',role:'interactive',parentName:null,rootSessionFile:manager.getSessionFile()};
  manager.appendCustomEntry('subagents.identity.v1',identity);
  const templates=new Map([
    ['main',parseTemplate('name: main\nsubagents: {extra: [worker, excluded, explicit], default: worker}',join(dir,'main.yaml'))],
    ['worker',parseTemplate('name: worker',join(dir,'worker.yaml'))],
    ['excluded',parseTemplate('name: excluded\ntools: {extra: [-web_search]}',join(dir,'excluded.yaml'))],
    ['explicit',parseTemplate('name: explicit\ntools: {include_defaults: false, extra: [web_search]}',join(dir,'explicit.yaml'))],
  ]);
  const context={cwd:dir,sessionManager:manager,modelRegistry:registry,model,thinkingLevel:'off',isIdle:()=>false,isProjectTrusted:()=>true};
  const oldAgentDir=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
  const workspace=new Workspace({cwd:dir,agentDir,trusted:true,config:{agent_paths:[],max_running:8,max_depth:4,max_group_depth:4,worker_exclude_extensions:[]},templates,identity,context,global:{model,thinking:'off'},append:(type,data)=>manager.appendCustomEntry(type,data),rootSend:()=>{}});
  try{
    const workers=[];
    for(const [name,template]of [['alice','worker'],['bob','worker'],['excluded','excluded'],['explicit','explicit']]){
      await workspace.create('main',name,'Complete the deterministic local task.',template);
      const worker=workspace.get(name);for(let n=0;n<500&&worker.busy;n++)await new Promise(resolve=>setTimeout(resolve,10));
      assert.equal(worker.status,'idle',worker.error);assert.equal(worker.session.getActiveToolNames().includes('web_search'),template!=='excluded');workers.push(worker);
    }
    const [alice,bob,excluded,explicit]=workers;
    assert.equal(alice.session.extensionRunner.createContext().hasUI,false);
    assert.equal(alice.manager.getBranch().filter(e=>e.customType==='codex-web-search.mode.v1').length,0,'parent override is not inherited');
    const before=requests.length;await alice.session.prompt('/web-search');await bob.session.prompt('/web-search cached');await excluded.session.prompt('/web-search live');await explicit.session.prompt('/web-search status');
    assert.equal(requests.length,before,'commands never request a model');
    const modes=worker=>worker.manager.getBranch().filter(e=>e.customType==='codex-web-search.mode.v1').map(e=>e.data.mode);
    assert.deepEqual(modes(alice),['live'],'worker toggle starts from config cached, not parent live');assert.deepEqual(modes(bob),['cached']);assert.deepEqual(modes(explicit),[]);
    assert.ok(!excluded.session.getActiveToolNames().includes('web_search'),'command cannot re-enable a forbidden tool');
    assert.ok(!excluded.session.getAllTools().some(t=>t.name==='web_search'),'forbidden registration is not discoverable');
    assert.ok(!explicit.session.getCallableToolNames().includes('web_search'));
  }finally{
    await workspace.close();oldAgentDir===undefined?delete process.env.PI_CODING_AGENT_DIR:process.env.PI_CODING_AGENT_DIR=oldAgentDir;await rm(dir,{recursive:true,force:true});
  }
});
