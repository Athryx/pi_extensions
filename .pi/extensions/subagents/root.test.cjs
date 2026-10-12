// Root wiring is tested separately from the coordinator using the installed SDK.
const {test} = require('node:test');
const assert=require('node:assert/strict');
const {join,resolve}=require('node:path');
const {mkdtemp,mkdir,writeFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {host}=require('./test-helper.cjs');
test('root extension binds, preserves tools, selects leaf templates, and survives reload/fork',async()=>{
  const sdk=await host('dist/index.js');
  const dir=await mkdtemp(join(tmpdir(),'pi-root-agents-'));
  const previous=process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR=join(dir,'agent');
  let session;
  const errors = [];
  try {
    await mkdir(join(dir,'agent/agents'),{recursive:true});
    await writeFile(join(dir,'agent/agents/leaf.yaml'),'name: leaf\ntools: {include_defaults: false, extra: [read]}\nmodel: {name: parent}');
    await writeFile(join(dir,'agent/agents/settings-based.yaml'),'name: settings-based\ntools: {include_defaults: true, extra: [find]}');
    await writeFile(join(dir,'agent/settings.json'),JSON.stringify({defaultTools:['read','grep']}));
    const settings=sdk.SettingsManager.inMemory();
    const runtime=await sdk.ModelRuntime.create({authPath:join(dir,'agent/auth.json'),modelsPath:null,refreshOnCreate:false});
    runtime.registerProvider('root-test',{api:'root-test',apiKey:'fake',baseUrl:'http://unused.invalid',models:[{id:'model',name:'Model',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000}],streamSimple(){throw new Error('No model calls expected');}});
    const model=runtime.getModelOfType('chat','root-test','model');
    const loader=new sdk.DefaultResourceLoader({cwd:dir,agentDir:join(dir,'agent'),settingsManager:settings,noExtensions:true,additionalExtensionPaths:[join(__dirname,'index.ts')]});
    await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
    const manager=sdk.SessionManager.inMemory(dir);
    ({session}=await sdk.createAgentSession({cwd:dir,agentDir:join(dir,'agent'),settingsManager:settings,resourceLoader:loader,sessionManager:manager,modelRuntime:runtime,model}));
    await session.bindExtensions({mode:'print', onError: error => errors.push(error)});
    assert.ok(session.getActiveToolNames().includes('write'));
    assert.ok(session.getActiveToolNames().includes('create_agent'));
    const list=session.extensionRunner.getToolDefinition('list_agents');
    let result=await list.execute('test',{all:true},undefined,undefined,session.extensionRunner.createToolContext('test'));
    assert.equal(result.details[0].name,'main');
    await session.prompt('/agent leaf');
    assert.equal(session.getActiveToolNames().includes('write'),false);
    assert.equal(session.getActiveToolNames().includes('create_agent'),false);
    const creation=session.getAllTools().find(t=>t.name==='create_agent');assert.equal(creation.exposure,'hidden');
    assert.equal(manager.getBranch().filter(e=>e.type==='custom'&&e.customType==='subagents.identity.v1').at(-1).data.role,'interactive');
    await session.reload();
    assert.equal(session.getActiveToolNames().includes('write'),false);
    await session.prompt('/agent settings-based');
    assert.deepEqual(session.getActiveToolNames().sort(),['read','grep','find','send_message','wait_message','list_agents'].sort());
    await session.prompt('/agent main');
    assert.ok(session.getActiveToolNames().includes('create_agent'));
    await session.extensionRunner.emit({type:'session_start',reason:'fork'});
    const ids=manager.getBranch().filter(e=>e.type==='custom'&&e.customType==='subagents.identity.v1').map(e=>e.data.workspaceId);
    assert.notEqual(ids.at(-1),ids[0]);
    assert.deepEqual(errors, []);
  } finally {
    if(session){await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();}
    previous===undefined?delete process.env.PI_CODING_AGENT_DIR:process.env.PI_CODING_AGENT_DIR=previous;
    await rm(dir,{recursive:true,force:true});
  }
});
