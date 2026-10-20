const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,mkdir,writeFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const {load,host}=require('../subagents/test-helper.cjs');
const plain=lines=>lines.join('\n').replace(/\x1b\[[0-9;]*m/g,'');
const deferred=()=>{let release;const promise=new Promise(resolve=>{release=resolve});return{promise,release};};
async function until(predicate){for(let n=0;n<500;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Timed out waiting for provider tool UI');}
function terminal(){return{columns:120,rows:40,kittyProtocolActive:false,start(){},stop(){},write(){},drainInput:async()=>{},
  moveBy(){},hideCursor(){},showCursor(){},clearLine(){},clearFromCursor(){},clearScreen(){},setTitle(){},setProgress(){},setProgramStatus(){}};}

test('real TUI renders generic provider activity before text, including worker viewing, abort and saved history', {timeout:20000}, async()=>{
  const sdk=await host('dist/index.js'),ai=await host('node_modules/@earendil-works/pi-ai/dist/index.js');
  const {createEventBus}=await host('dist/core/event-bus.js');
  const shared=await load('../shared/viewed-session.ts');
  const dir=await mkdtemp(join(tmpdir(),'pi-provider-ui-host-')),cwd=join(dir,'project'),agentDir=join(dir,'agent');
  await mkdir(cwd);await mkdir(join(agentDir,'agents'),{recursive:true});
  const addon=join(dir,'provider-demo.ts');
  // This second provider has no web-search-specific data or renderer code.
  await writeFile(addon,`
import {createProviderToolReporter} from ${JSON.stringify(resolve(__dirname,'../shared/provider-tools.ts'))};
export default function(pi) {
 const reporter=createProviderToolReporter(pi,'provider-demo');let stream;
 pi.on('before_provider_request',()=>{stream=reporter.begin()});
 pi.on('provider_stream_event',event=>{if(event.data?.type==='demo.tool')stream?.update(event.data.call)});
}
`);
  await writeFile(join(agentDir,'settings.json'),JSON.stringify({extensions:[addon],compaction:{enabled:false},retry:{enabled:false}}));
  await writeFile(join(agentDir,'agents/main.yaml'),'name: main\nsubagents: {extra: [subagent], default: subagent}');
  await writeFile(join(agentDir,'agents/subagent.yaml'),'name: subagent');
  await writeFile(join(agentDir,'subagents.json'),JSON.stringify({default_agent:'main'}));
  const oldAgentDir=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
  const events=createEventBus(),workerGate=deferred();let mainGate=deferred(),runtime,mode;
  const requests=[];
  try{
    const models=await sdk.ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
    models.registerProvider('provider-tools-test',{api:'provider-tools-test',apiKey:'fake-local-key',baseUrl:'http://unused.invalid',
      models:[{id:'fake',name:'Fake',reasoning:false,input:['text'],contextWindow:32000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
      streamSimple(model,context,options){
        const stream=ai.createAssistantMessageEventStream();
        const worker=ai.getCurrentSystemPrompt(context.messages).includes('Name: staged-worker');
        const gate=worker?workerGate:mainGate;
        requests.push({worker,context});
        void(async()=>{
          await options.onPayload?.({model:model.id,input:[]},model);
          const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],stopReason:'pending',timestamp:Date.now(),
            usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
          stream.push({type:'start',partial:message});
          await new Promise(resolve=>setTimeout(resolve,0));
          const call={id:'remote',label:'rendered diagram',summary:worker?'WORKER OP':'MAIN OP',status:'running'};
          await options.onProviderStreamEvent?.({type:'demo.tool',call},model);
          // No text, thinking, or normalized tool delta is sent while gated.
          await gate.promise;
          if(options.signal?.aborted){message.stopReason='aborted';message.errorMessage='Request was aborted';stream.push({type:'error',reason:'aborted',error:message});}
          else{
            await options.onProviderStreamEvent?.({type:'demo.tool',call:{...call,status:'completed'}},model);
            const text=worker?'WORKER FINAL':'MAIN FINAL';message.content.push({type:'text',text});
            stream.push({type:'text_start',contentIndex:0,partial:message});stream.push({type:'text_delta',contentIndex:0,delta:text,partial:message});
            message.stopReason='stop';stream.push({type:'done',reason:'stop',message});
          }
          stream.end();
        })().catch(error=>{stream.end();throw error});
        return stream;
      }});
    const model=models.getModel('provider-tools-test','fake'),manager=sdk.SessionManager.create(cwd,join(dir,'sessions'));
    manager.appendMessage({role:'user',content:'Prior history',timestamp:1});
    const createRuntime=async({cwd,agentDir,sessionManager,sessionStartEvent})=>{
      const services=await sdk.createAgentSessionServices({cwd,agentDir,modelRuntime:models,
        settingsManager:sdk.SettingsManager.inMemory({theme:'dark',quietStartup:true,showTerminalProgress:false,compaction:{enabled:false},retry:{enabled:false}}),
        resourceLoaderOptions:{eventBus:events,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
          additionalExtensionPaths:[addon,join(__dirname,'index.ts'),join(__dirname,'../subagents/index.ts')]}});
      return{...await sdk.createAgentSessionFromServices({services,sessionManager,sessionStartEvent,model}),services,diagnostics:services.diagnostics};
    };
    runtime=await sdk.createAgentSessionRuntime(createRuntime,{cwd,agentDir,sessionManager:manager});
    mode=new sdk.InteractiveMode(runtime,{terminal:terminal(),tuiMode:'regular'});mode.registerSignalHandlers=()=>{};mode.unregisterSignalHandlers=()=>{};await mode.init();
    const root=runtime.session.prompt('Create a diagram.');
    await until(()=>plain(mode.chatContainer.render(120)).includes('rendered diagram MAIN OP ⋯'));
    assert.doesNotMatch(plain(mode.chatContainer.render(120)),/MAIN FINAL/,'activity is visible before any answer text');
    assert.ok(!runtime.session.getAllTools().some(tool=>tool.name==='rendered diagram'));
    mainGate.release();await root;
    const completed=plain(mode.chatContainer.render(120));assert.ok(completed.indexOf('rendered diagram MAIN OP')<completed.indexOf('MAIN FINAL'));
    assert.equal((completed.match(/rendered diagram MAIN OP/g)??[]).length,1);
    const saved=manager.getBranch().filter(entry=>entry.type==='message'&&entry.message.role==='assistant').at(-1).message;
    assert.equal(saved.providerToolCalls.calls[0].status,'completed');
    const reopened=sdk.SessionManager.open(manager.getSessionFile()).getBranch().find(entry=>entry.type==='message'&&entry.message.providerToolCalls);
    assert.deepEqual(reopened.message.providerToolCalls,saved.providerToolCalls);
    const create=runtime.session.getToolDefinition('create_agent');await create.execute('create-staged',{name:'staged-worker',task:'Create a diagram.'},new AbortController().signal);
    await until(()=>requests.some(request=>request.worker));
    await runtime.session.prompt('/subagents staged-worker');
    const service=shared.requestViewedSessionAPI({events});assert.ok(service.getViewedSession());
    await until(()=>plain(mode.documentContainer.children[2].render(120)).includes('rendered diagram WORKER OP ⋯'));
    assert.doesNotMatch(plain(mode.documentContainer.children[2].render(120)),/WORKER FINAL|MAIN OP/);
    workerGate.release();await until(()=>plain(mode.documentContainer.children[2].render(120)).includes('WORKER FINAL'));
    const worker=plain(mode.documentContainer.children[2].render(120));assert.ok(worker.indexOf('WORKER OP')<worker.indexOf('WORKER FINAL'));
    await runtime.session.prompt('/subagents main');assert.doesNotMatch(JSON.stringify(runtime.session.messages),/WORKER OP/,'worker metadata never leaks into main');
    await until(()=>runtime.session.isIdle);
    const baseline=mode.chatContainer.render(120).filter(line=>plain([line]).includes('rendered diagram MAIN OP')).length;
    mainGate=deferred();const aborted=runtime.session.prompt('Cancel this diagram.');
    await until(()=>mode.chatContainer.render(120).filter(line=>plain([line]).includes('rendered diagram MAIN OP')).length===baseline+1);
    const abort=runtime.session.abort();mainGate.release();await abort;await aborted;
    const last=runtime.session.messages.filter(message=>message.role==='assistant').at(-1);
    assert.equal(last.stopReason,'aborted');assert.equal(last.providerToolCalls.calls[0].status,'cancelled');
    assert.match(plain(mode.chatContainer.render(120)),/rendered diagram MAIN OP \(cancelled\)/);
  }finally{
    mainGate.release();workerGate.release();mode?.stop();await runtime?.dispose();mode?.themeController.dispose();
    oldAgentDir===undefined?delete process.env.PI_CODING_AGENT_DIR:process.env.PI_CODING_AGENT_DIR=oldAgentDir;await rm(dir,{recursive:true,force:true});
  }
});
