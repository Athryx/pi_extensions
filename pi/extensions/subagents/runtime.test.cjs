const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, mkdir, writeFile, rm, readFile} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {load,host} = require('./test-helper.cjs');
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function until(predicate) { for(let n=0;n<300;n++){if(predicate())return; await sleep(10);} throw new Error('Condition timed out'); }
async function fixture({factory, disk=false, respond}={}) {
  const {Workspace} = await load('workspace.ts'), {parseTemplate} = await load('templates.ts');
  const sdk = await host('dist/index.js'), ai = await host('node_modules/@earendil-works/pi-ai/dist/index.js');
  const dir = await mkdtemp(join(tmpdir(),'pi-workers-'));
  await mkdir(join(dir,'agent'),{recursive:true}); await mkdir(join(dir,'project'),{recursive:true});
  const requests=[];
  const runtime=await sdk.ModelRuntime.create({authPath:join(dir,'agent/auth.json'),modelsPath:null,refreshOnCreate:false});
  let gate;
  const config={api:'test-workspace',apiKey:'not-a-real-key',baseUrl:'http://unused.invalid',models:[{id:'test',name:'Test',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000}],streamSimple(model,context,options){
    const stream=ai.createAssistantMessageEventStream();
    requests.push(context);
    void (async()=>{
      if(gate) await gate;
      const output={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content:respond ? respond(context,requests.length) : [{type:'text',text:'worker answer'}],stopReason:'pending',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      stream.push({type:'start',partial:output});
      output.content.forEach((block,index)=>{if(block.type==='text'){stream.push({type:'text_start',contentIndex:index,partial:output});stream.push({type:'text_delta',contentIndex:index,delta:block.text,partial:output});stream.push({type:'text_end',contentIndex:index,content:block.text,partial:output});}else{stream.push({type:'toolcall_start',contentIndex:index,partial:output});stream.push({type:'toolcall_end',contentIndex:index,toolCall:block,partial:output});}});
      output.stopReason=options?.signal?.aborted?'aborted':output.content.some(b=>b.type==='toolCall')?'toolUse':'stop';
      if(output.stopReason==='aborted'){output.errorMessage='Cancelled';stream.push({type:'error',reason:'aborted',error:output});}
      else stream.push({type:'done',reason:output.stopReason,message:output});
      stream.end();
    })();
    return stream;
  }};
  runtime.registerProvider('workspace-test',config);
  const registry=new sdk.ModelRegistry(runtime), model=registry.find('workspace-test','test');
  assert.ok(model);
  const manager=disk?sdk.SessionManager.create(join(dir,'project'),join(dir,'sessions')):sdk.SessionManager.inMemory(join(dir,'project'));
  manager.appendMessage({role:'user',content:'main task',timestamp:Date.now()});
  const identity={version:1,workspaceId:'test-workspace',instanceId:'root',name:'main',template:'main',role:'interactive',parentName:null,rootSessionFile:manager.getSessionFile()};
  manager.appendCustomEntry('subagents.identity.v1',identity);
  const templates=new Map(['main','subagent','leader'].map(n=>[n,parseTemplate('name: '+n+'\n'+(n==='subagent'?'':'subagents: {extra: [subagent, leader], default: subagent}'),join(dir,n+'.yaml'))]));
  const ctx={cwd:join(dir,'project'),sessionManager:manager,modelRegistry:registry,model,thinkingLevel:'high',isIdle:()=>false,isProjectTrusted:()=>true};
  const received=[];
  const options={cwd:ctx.cwd,agentDir:join(dir,'agent'),trusted:true,config:{agent_paths:[],max_running:8,max_depth:4,max_group_depth:4,worker_exclude_extensions:[]},templates,identity,context:ctx,global:{model,thinking:'high'},append:(k,d)=>manager.appendCustomEntry(k,d),rootSend:(e)=>{received.push(e);manager.appendCustomMessageEntry('subagents.message.v1','Message from '+e.from+':\n'+e.message,true,e);manager.appendCustomEntry('subagents.delivery.v1',{envelope:e,delivered:true});},workerFactory:factory};
  const previousAgentDir=process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR=options.agentDir;
  const workspace=new Workspace(options);
  return {workspace,options,templates,dir,ctx,manager,received,requests,sdk,ai,runtime,setGate:g=>gate=g,cleanup:async()=>{await workspace.close(); previousAgentDir===undefined?delete process.env.PI_CODING_AGENT_DIR:process.env.PI_CODING_AGENT_DIR=previousAgentDir; await rm(dir,{recursive:true,force:true});}};
}
test('worker tool removals apply before registration and model declarations', async()=>{
  const f=await fixture();
  try {
    f.templates.get('subagent').tools.extra=['-read','-edit','-write','-unknown'];
    await f.workspace.create('main','restricted','check tools');
    await until(()=>f.requests.length && !f.workspace.get('restricted').busy);
    const tools=f.workspace.get('restricted').session.getActiveToolNames();
    assert.ok(tools.includes('bash'));
    for (const name of ['read','edit','write']) assert.ok(!tools.includes(name));
    const declared=(f.ai.getCurrentSystemMessage(f.requests[0].messages).toolsAdded ?? []).map(tool=>tool.name);
    for (const name of ['read','edit','write']) assert.ok(!declared.includes(name));
  } finally {await f.cleanup();}
});

test('spawning workers receive allowed child descriptions in the actual request', async()=>{
  const f=await fixture();
  try {
    f.templates.get('subagent').description='Handles delegated tasks';
    f.templates.get('leader').description='Coordinates helpers';
    await f.workspace.create('main','coordinator','inspect catalog','leader');
    await until(()=>f.requests.length && !f.workspace.get('coordinator').busy);
    const prompt=f.ai.getCurrentSystemPrompt(f.requests[0].messages);
    assert.match(prompt,/Allowed child templates:\n- subagent — Handles delegated tasks\n- leader — Coordinates helpers/);
  } finally {await f.cleanup();}
});

test('real SDK worker lifecycle, separate files, filtered extensions, resume and restore', async()=>{
  const f=await fixture({disk:true});
  let release; f.setGate(new Promise(r=>release=r));
  try {
    await mkdir(join(f.dir,'agent/extensions/context'),{recursive:true});
    await writeFile(join(f.dir,'agent/extensions/context/index.ts'),'throw new Error("main-only factory executed"); export default function () {}');
    await f.workspace.create('main','alice','inspect local files');
    assert.equal(f.workspace.get('alice').status,'running');
    const record=f.workspace.get('alice');
    assert.ok(record.sessionFile); assert.notEqual(record.sessionFile,f.manager.getSessionFile());
    const persisted=await readFile(record.sessionFile,'utf8'); assert.match(persisted,/subagents.identity.v1/);
    assert.equal(record.session.getActiveToolNames().includes('create_agent'),false);
    assert.equal(record.session.getActiveToolNames().includes('set_goal'),false);
    await assert.rejects(f.workspace.create('alice','bad','task'),/No default/);
    await assert.rejects(f.workspace.create('main','alice','task'),/already used/);
    release(); f.setGate(undefined);
    await until(()=>f.received.length===1 && !record.busy);
    assert.equal(record.status,'idle'); assert.equal(f.received[0].from,'alice'); assert.equal(f.received[0].message,'worker answer');
    assert.match(f.ai.getCurrentSystemPrompt(f.requests[0].messages),/Name: alice.*Parent: main/);
    const file=record.sessionFile;
    await f.workspace.send('main','alice','follow-up');
    await until(()=>f.received.length===2 && !record.busy);
    assert.equal(record.sessionFile,file);
    assert.equal(record.session.messages.filter(m=>m.role==='custom' && m.customType==='subagents.message.v1').length,1);
    record.session.settingsManager.applyOverrides({compaction:{keepRecentTokens:0,reserveTokens:1024}});
    await record.session.compact('Preserve workspace identity and communication history');
    assert.ok(record.manager.getBranch().some(e=>e.type==='compaction'));
    assert.ok(record.manager.getBranch().some(e=>e.type==='custom'&&e.customType==='subagents.identity.v1'));
    assert.equal(f.received.length,2); // summarization is not a worker completion
    const {Workspace}=await load('workspace.ts'); await f.workspace.close();
    const restored=new Workspace(f.options); await restored.restore();
    assert.equal(restored.get('alice').status,'idle'); assert.equal(restored.get('alice').messages.some(m=>m.role==='assistant'),true);
    await restored.close();
  } finally {release();await f.cleanup();}
});
test('wait delivery, unread inbox, cancellation, timeout and all-waiting refusal', async()=>{
  const f=await fixture();
  try {
    // Main plus a synthetic active peer uses actual coordinator logic without provider scheduling.
    const main=f.workspace.get('main');
    const peer={...main,identity:{...main.identity,name:'peer',instanceId:'peer',role:'worker',parentName:'main'},status:'running',inbox:[],pending:[],session:{sendCustomMessage:async()=>{}}};
    f.workspace.records.set('peer',peer);
    const wait=f.workspace.wait('main',2);
    await f.workspace.send('peer','main','hello');
    assert.equal((await wait).status,'received'); assert.equal(main.inbox.length,0);
    await f.workspace.send('peer','main','early'); assert.equal((await f.workspace.wait('main')).messages.length,1);
    assert.equal((await f.workspace.wait('main',0.01)).status,'timeout');
    const controller=new AbortController(), cancelled=f.workspace.wait('main',2,controller.signal); controller.abort(); await assert.rejects(cancelled,/cancelled/);
    peer.status='idle'; f.workspace.setMainStatus('running'); await assert.rejects(f.workspace.wait('main',2),/Everyone else/);
    peer.status='running'; const waiting=f.workspace.wait('main',2); peer.status='idle'; f.workspace.deadlock(); await assert.rejects(waiting,/Everyone else/);
    f.workspace.records.delete('peer');
    await assert.rejects(f.workspace.send('main','main','self'),/Self/);
    await assert.rejects(f.workspace.wait('main',601),/timeout/);
  } finally {await f.cleanup();}
});
test('failure rollback, nesting/capacity, unknown tool preflight and strict actual validation',async()=>{
  const f=await fixture();
  try {
    const {parseTemplate}=await load('templates.ts');
    f.templates.set('subagent',parseTemplate('name: subagent\ntools: {extra: [missing]}',join(f.dir,'subagent.yaml')));
    await assert.rejects(f.workspace.create('main','broken','task'),/Unknown\/unavailable tool/);
    assert.equal(f.workspace.records.has('broken'),false);
    const {registerTools}=await load('tools.ts'), tools=[];registerTools({registerTool:t=>tools.push(t)},()=>f.workspace,'main',true);
    const {validateToolArguments}=await host('node_modules/@earendil-works/pi-ai/dist/utils/validation.js');
    for(const tool of tools) assert.throws(()=>validateToolArguments(tool,{name:tool.name,arguments:{extra:true}}),/Validation failed/);
  } finally {await f.cleanup();}
});
test('real parallel wait/send batch wakes through steering and injects content once',async()=>{
  const f=await fixture({respond:(_context,n)=>n===1?[{type:'toolCall',id:'wait',name:'wait_message',arguments:{timeout:2}},{type:'toolCall',id:'send',name:'send_message',arguments:{agent_name:'main',message:'Need reply'}}]:[{type:'text',text:'received reply'}]});
  try{
    await f.workspace.create('main','mailbox','coordinate');
    await until(()=>f.received.some(e=>e.message==='Need reply'));
    await f.workspace.send('main','mailbox','Here is your reply');
    const record=f.workspace.get('mailbox');await until(()=>record.status==='idle'&&!record.busy);
    const messages=record.session.messages.filter(m=>m.role==='custom'&&m.customType==='subagents.message.v1');
    assert.equal(messages.length,1);assert.match(messages[0].content,/Message from main.*Here is your reply/s);
    assert.equal(record.session.messages.filter(m=>m.role==='toolResult'&&m.isError).length,0);
    assert.equal(f.received.filter(e=>e.message==='received reply').length,1);
  }finally{await f.cleanup();}
});
test('worker loadout prevents nested deferred calls; defaults-disabled skills only expose extras',async()=>{
  const f=await fixture({respond:(_context,n)=>n===1?[{type:'toolCall',id:'probe',name:'probe',arguments:{}}]:[{type:'text',text:'checked tools'}]});
  try{
    await mkdir(join(f.dir,'agent/extensions'),{recursive:true});
    await writeFile(join(f.dir,'agent/extensions/probe.ts'),`export default function(pi) {
      pi.registerTool({name:'secret',label:'secret',exposure:'codemode',parameters:{type:'object',properties:{},additionalProperties:false},async execute(){throw new Error('Forbidden tool ran');}});
      pi.registerTool({name:'probe',label:'probe',parameters:{type:'object',properties:{},additionalProperties:false},async execute(id,args,signal,update,ctx){const result=await ctx.executeTool('secret',{});return {content:[{type:'text',text:result.isError?'blocked':'unexpected'}],details:undefined};}});
    }`);
    await mkdir(join(f.dir,'agent/skills/default'),{recursive:true});
    await writeFile(join(f.dir,'agent/skills/default/SKILL.md'),'---\nname: default\ndescription: Default skill\n---\nInstructions');
    await mkdir(join(f.dir,'extra/extra-skill'),{recursive:true});
    await writeFile(join(f.dir,'extra/extra-skill/SKILL.md'),'---\nname: extra-skill\ndescription: Extra skill\n---\nInstructions');
    const {parseTemplate}=await load('templates.ts');
    f.templates.set('subagent',parseTemplate('name: subagent\ntools: {include_defaults: false, extra: [probe]}\nskills: {include_defaults: false, extra_paths: [./extra]}',join(f.dir,'subagent.yaml')));
    await f.workspace.create('main','restricted','check');
    const record=f.workspace.get('restricted');await until(()=>record.status==='idle'&&!record.busy);
    assert.equal(record.session.messages.find(m=>m.role==='toolResult'&&m.toolName==='probe').content[0].text,'blocked');
    assert.equal(record.session.extensionRunner.getToolDefinition('secret').exposure,'hidden');
    assert.deepEqual(record.session.resourceLoader.getSkills().skills.map(s=>s.name),['extra-skill']);
    assert.equal(record.session.getActiveToolNames().includes('write'),false);
  }finally{await f.cleanup();}
});
test('nested permissions, capacity and inherited selection resolve again on idle resume',async()=>{
  const f=await fixture();
  let release;f.setGate(new Promise(r=>release=r));
  try {
    f.workspace.config.max_depth=1;
    await f.workspace.create('main','leader','parent task','leader');
    await assert.rejects(f.workspace.create('leader','grandchild','task'),/nesting/);
    f.workspace.config.max_running=1;
    await assert.rejects(f.workspace.create('main','over-capacity','task'),/capacity/);
    release();f.setGate(undefined);const record=f.workspace.get('leader');
    await until(()=>record.status==='idle'&&!record.busy);
    f.workspace.get('main').selection={...f.workspace.global,thinking:'low'};
    await f.workspace.send('main','leader','resume under new thinking');
    await until(()=>record.status==='idle'&&!record.busy);
    assert.equal(record.selection.thinking,'low');
  } finally {release();await f.cleanup();}
});
test('worker shutdown cleans enhanced bash background processes and waits',async()=>{
  const f=await fixture();
  let outputPath;
  try {
    await writeFile(join(f.dir,'agent/settings.json'),JSON.stringify({extensions:[join(__dirname,'../bash/index.ts')]}));
    await f.workspace.create('main','shell','task');
    const record=f.workspace.get('shell');await until(()=>record.status==='idle'&&!record.busy);
    assert.ok(record.session.getActiveToolNames().includes('interact_bash'), JSON.stringify({tools:record.session.getAllTools(),paths:record.session.extensionRunner.getExtensionPaths()}));
    const ctx=record.session.extensionRunner.createToolContext('background',undefined);
    const bash=record.session.extensionRunner.getToolDefinition('bash');
    const result=await bash.execute('background',{command:'sleep 30',yield_time_ms:0,session_name:'shutdown-check'},undefined,undefined,ctx);
    outputPath=result.details.fullOutputPath;assert.equal(result.details.sessionName,'shutdown-check');
    await f.workspace.wait('main',2); // consume the worker completion already in the inbox
    const wait=assert.rejects(f.workspace.wait('main',2),/Workspace closed/);
    await f.workspace.close(); await wait;
    assert.ok(record.manager.getBranch().some(e=>e.type==='custom_message'&&String(e.content).includes('shutdown-check')));
  } finally {await f.cleanup();if(outputPath)await rm(outputPath,{force:true});}
});
test('ephemeral tree reconstruction retains child histories without session files',async()=>{
  const f=await fixture();
  try {
    await f.workspace.create('main','ephemeral','task');
    const record=f.workspace.get('ephemeral');await until(()=>record.status==='idle'&&!record.busy);
    assert.equal(record.sessionFile,undefined);
    const {Workspace}=await load('workspace.ts');
    const cache=f.workspace.ephemeralSessions;
    await f.workspace.close();
    const restored=new Workspace({...f.options,ephemeralSessions:cache});
    await restored.restore();assert.equal(restored.get('ephemeral').status,'idle');
    assert.ok(restored.get('ephemeral').messages.some(m=>m.role==='assistant'));
    await restored.close();
  }finally{await f.cleanup();}
});
test('explicit asynchronous MCP-style tool names get a bounded startup preflight',async()=>{
  const f=await fixture({respond:(_context,n)=>n===1?[{type:'toolCall',id:'late',name:'mcp__test__probe',arguments:{}}]:[{type:'text',text:'late tool completed'}]});
  try {
    await mkdir(join(f.dir,'agent/extensions'),{recursive:true});
    await writeFile(join(f.dir,'agent/extensions/late.ts'),`export default function(pi){let timer;pi.on('session_start',()=>{timer=setTimeout(()=>pi.registerTool({name:'mcp__test__probe',label:'late',parameters:{type:'object',properties:{},additionalProperties:false},async execute(){return {content:[{type:'text',text:'late registration worked'}],details:undefined};}}),100);});pi.on('session_shutdown',()=>clearTimeout(timer));}`);
    const {parseTemplate}=await load('templates.ts');
    f.templates.set('subagent',parseTemplate('name: subagent\ntools: {extra: [mcp__test__probe]}',join(f.dir,'subagent.yaml')));
    await f.workspace.create('main','late-tools','task');
    const record=f.workspace.get('late-tools');await until(()=>record.status==='idle'&&!record.busy);
    assert.equal(record.session.messages.find(m=>m.role==='toolResult'&&m.toolName==='mcp__test__probe').content[0].text,'late registration worked');
  }finally{await f.cleanup();}
});
test('worker defaults resolve global/project Pi settings, modifiers, trust and opt-out', async()=>{
  for (const config of [
    {global:['read','grep'], project:['+find','-read'], trusted:true, expected:['grep','find']},
    {global:['read','grep'], project:['write'], trusted:true, expected:['write']},
    {global:['read','grep'], project:['write'], trusted:false, expected:['read','grep']},
    {global:[], project:undefined, trusted:true, expected:[]},
    {global:['+grep','-bash'], project:undefined, trusted:true, expected:['read','edit','write','grep']},
    {global:['write'], project:undefined, trusted:true, disabled:true, expected:['grep']},
  ]) {
    const f=await fixture();
    try {
      await writeFile(join(f.dir,'agent/settings.json'),JSON.stringify({defaultTools:config.global,extensions:[join(__dirname,'../bash/index.ts')]}));
      await mkdir(join(f.dir,'project/.pi'),{recursive:true});
      if(config.project) await writeFile(join(f.dir,'project/.pi/settings.json'),JSON.stringify({defaultTools:config.project}));
      f.workspace.trusted=config.trusted;
      if(config.disabled){const {parseTemplate}=await load('templates.ts'); f.templates.set('subagent',parseTemplate('name: subagent\ntools: {include_defaults: false, extra: [grep]}',join(f.dir,'subagent.yaml')));}
      await f.workspace.create('main','settings','task');
      const record=f.workspace.get('settings');await until(()=>record.status==='idle'&&!record.busy);
      assert.deepEqual(record.session.getActiveToolNames().filter(n=>!['send_message','wait_message','list_agents'].includes(n)).sort(),config.expected.sort());
      assert.equal(record.session.getActiveToolNames().includes('interact_bash'),false);
    } finally {await f.cleanup();}
  }
});
test('interactive-marked tools and snippets are filtered independently of extension filename',async()=>{
  const f=await fixture();
  try {
    const helper=join(__dirname,'../shared/interactive.ts');
    await mkdir(join(f.dir,'agent/extensions'),{recursive:true});
    await writeFile(join(f.dir,'agent/extensions/arbitrary.ts'),`import {interactiveTool, registerInteractiveTool, interactiveSection} from ${JSON.stringify(helper)};
      export default function(pi){
        const tool=name=>({name,label:name,description:'INTERACTIVE_DESCRIPTION',promptSnippet:'INTERACTIVE_SNIPPET',promptGuidelines:['INTERACTIVE_GUIDELINE'],parameters:{type:'object',properties:{},additionalProperties:false},async execute(){throw new Error('Interactive tool ran');}});
        pi.registerTool(interactiveTool(tool('custom_interactive')));
        pi.on('session_start',(event,ctx)=>registerInteractiveTool(pi,tool('late_interactive'),ctx));
        pi.on('before_agent_start',(event,ctx)=>interactiveSection(event.systemPromptOptions.sections,'interactive_custom','INTERACTIVE_SECTION',ctx));
      }`);
    await writeFile(join(f.dir,'agent/settings.json'),JSON.stringify({defaultTools:['read','custom_interactive','late_interactive','ask_question','finish_plan','set_goal','set_goal_status'],extensions:['ask-question','plan-mode','goal-mode'].map(n=>join(__dirname,'..',n,'index.ts'))}));
    await f.workspace.create('main','noninteractive','task');
    const record=f.workspace.get('noninteractive');await until(()=>record.status==='idle'&&!record.busy);
    assert.deepEqual(record.session.getActiveToolNames().sort(),['read','send_message','wait_message','list_agents'].sort());
    const prompt=f.ai.getCurrentSystemPrompt(f.requests[0].messages);
    assert.doesNotMatch(prompt,/INTERACTIVE_|Goal mode:|Use ask_question|Do not call finish_plan/);
    for(const name of ['custom_interactive','late_interactive','ask_question','finish_plan','set_goal','set_goal_status']){
      const definition=record.session.extensionRunner.getToolDefinition(name);
      assert.equal(definition.exposure,'hidden',name);
      assert.equal(definition.promptSnippet,undefined,name);
      assert.equal(definition.promptGuidelines,undefined,name);
      await assert.rejects(definition.execute('test',{},undefined,undefined,record.session.extensionRunner.createToolContext('test')),/interactive agent/);
    }
  }finally{await f.cleanup();}
});
module.exports={fixture,until};
