const test=require('node:test');
const assert=require('node:assert/strict');
const {readFile,rm}=require('node:fs/promises');
const {load,fixture}=require('./test-helper.cjs');
let adapter;
async function execute(code,options={}){
 adapter ??= await load('codemode-adapter.ts');
 const f=fixture(options);
 const result=await adapter.executeWorkflow(code,'/source/workflow.js',options.signal ?? new AbortController().signal,f.ctx,f.pi,f.api,f.onUpdate);
 return {f,result,text:result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n')};
}
test('real VM async return console text exit and no Node globals',async()=>{
 const {result,text}=await execute('text("one");console.log("log",2);return {n:3}');
 assert.equal(result.isError,undefined);assert.match(text,/==> text 1\/2 <==\none/);assert.match(text,/==> text 2\/2 <==\n{"n":3}/);assert.match(text,/<console_output>\nlog 2/);
 const no=await execute('return [typeof process,typeof require,typeof fetch,typeof setTimeout,typeof WebAssembly]');
 assert.match(no.text,/\["undefined","undefined","undefined","undefined","undefined"\]/);
 const exited=await execute('text("before");exit();text("after")');
 assert.equal(exited.result.isError,undefined);assert.match(exited.text,/before/);assert.doesNotMatch(exited.text,/after/);
});
test('sequence preserves closure, undefined and prior objects without JSON round trips',async()=>{
 const {result,text,f}=await execute(`
 const object={x:2};const closed=5;
 return await workflow.sequence([
  async (prior,w)=>{if(prior!==undefined)throw Error("first");await w.set_status("First label");return {object,fn:()=>closed}},
  async (prior,w)=>{await w.set_status("Second label");return prior.object===object && prior.fn()===5}
 ],"Pipeline");`);
 assert.equal(result.isError,undefined);assert.match(text,/true/);
 const seq=result.details.nodes.find(n=>n.kind==='sequence');assert.equal(seq.activeStage,1);assert.equal(seq.previousStage,1);
 assert.ok(f.progress.some(d=>d.nodes.find(n=>n.kind==='sequence')?.previousStage===0 && d.nodes.some(n=>n.label==='Second label')));
 assert.equal(f.closeCount,1);
});
test('empty sequence undefined and parallel ordered results',async()=>{
 const {result,text}=await execute('return [await workflow.sequence([]),await workflow.parallel([]),await workflow.parallel([async w=>1,async w=>2])]');
 assert.equal(result.isError,undefined);assert.match(text,/\[null,\[\],\[1,2\]\]/);
});
test('validates every callback and label before starting any branch',async()=>{
 for(const code of ['await workflow.parallel([async w=>w.agent("bad","a"),3])','await workflow.sequence([()=>1],"x".repeat(81))']){
 const {result,f}=await execute(code);assert.equal(result.isError,true);assert.equal(f.agentCalls.length,0);assert.equal(result.details.nodes.length,1)}
});
test('scoped nested registration and agents update distinct progress',async()=>{
 const {result,text,f}=await execute(`
 await workflow.register_agents([{name:"local",prompt:"test"}]);
 return await workflow.parallel([
  async w=>{await w.set_status("Read architecture");return w.agent("first","local")},
  async w=>w.agent("second","local","custom")
 ]);`);
 assert.equal(result.isError,undefined);assert.match(text,/\["first","second"\]/);assert.equal(f.agents.length,1);
 const nodes=result.details.nodes.filter(n=>n.kind==='agent');assert.deepEqual(nodes.map(n=>n.agentName).sort(),['custom-1','local-2']);
 assert.ok(f.progress.some(d=>d.nodes.some(n=>n.kind==='agent'&&n.status==='running'&&n.groupId)));
});
test('parallel cancels sibling tools, observes rejection and parent fallback remains live',async()=>{
 let cancelled=false;
 const {result,text}=await execute(`
 try { await workflow.parallel([
  async w=>{await w.tools.hold({});return "bad"},
  async w=>{throw Error("first failure")}
 ],"Fanout"); } catch(error) { text(error.message); }
 return await workflow.sequence([async (_,w)=>{await w.set_status("Fallback");return 9}]);`,
 {tools:[{name:'hold',description:'Wait',parameters:{type:'object'}}],
 executeTool:async(name,args,signal)=>new Promise(resolve=>{
   const done=()=>{cancelled=true;resolve({toolCall:{id:'nested'},isError:true,result:{content:[{type:'text',text:'aborted'}]}})};
   signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();
 })});
 assert.equal(result.isError,undefined);assert.equal(cancelled,true);assert.match(text,/first failure \(parallel Fanout\)/);assert.match(text,/9/);
});
test('parallel does not await forever a pure unresolved sibling after failure',async()=>{
 const {result,text}=await execute('// @options: {"timeout_ms": 2000}\ntry {await workflow.parallel([async w=>new Promise(()=>{}),async w=>{throw Error("boom")}]);}catch(e){text(e.message)}return 10');
 assert.equal(result.isError,undefined);assert.match(text,/boom/);assert.match(text,/10/);
});
test('cancelled scoped facades reject subsequent operations, parent works',async()=>{
 const {result,text}=await execute(`
 let old;
 try {await workflow.parallel([async w=>{old=w;return new Promise(()=>{})},async w=>{throw Error("boom")}])}catch(e){}
 try{await old.agent("no","a")}catch(e){text(e.message)}
 return await workflow.agent("yes","a");`);
 assert.equal(result.isError,undefined);assert.match(text,/closed or cancelled/);assert.match(text,/yes/);
});
test('agent failures, cancellation and successful usage are counted once',async()=>{
 const usage={input:1,output:2,cacheRead:0,cacheWrite:0,totalTokens:3,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
 const {result}=await execute('try{await workflow.agent("bad","a")}catch(e){} return await workflow.agent("good","a")',{
 agent:async(prompt,template,name,signal)=>{if(prompt==='bad')throw Object.assign(Error('bad'),{usage});return {name,text:'good',usage}}
 });
 assert.equal(result.usage.totalTokens,6);
});
test('unawaited owned work is aborted and cleanup awaited before result',async()=>{
 let settled=false;
 const {result}=await execute('workflow.agent("long","a");return 2',{agent:async(prompt,template,name,signal)=>new Promise((resolve,reject)=>{
  const done=()=>{settled=true;reject(Error('cancelled'))};signal.addEventListener('abort',done,{once:true});if(signal.aborted)done()
 })});
 assert.equal(result.isError,undefined);assert.equal(settled,true);
 assert.equal(result.details.nodes.find(n=>n.kind==='agent').status,'cancelled');
});
test('tool structured/text/read image results and errors use host executeTool',async()=>{
 const image={type:'image',data:'aGVsbG8=',mimeType:'image/png'};
 const tools=[{name:'plain',description:'plain',parameters:{}},{name:'structured',description:'data',parameters:{},outputSchema:{}},{name:'read',description:'read',parameters:{}},{name:'codemode',parameters:{}},{name:'workflow',parameters:{}}];
 const {result,text,f}=await execute(`
 const a=await tools.plain({});
 const b=await workflow.tools.structured({});
 const c=await tools.read({});
 return {a,b,c,recursive:["codemode" in tools,"workflow" in tools]};
 `,{tools,executeTool:async(name)=>({toolCall:{id:'nested'},isError:name==='structured',result:{content:name==='read'?[{type:'text',text:'note'},image]:[{type:'text',text:'ok'}],structuredContent:name==='structured'?{n:4}:undefined}})});
 assert.equal(result.isError,undefined);assert.match(text,/"a":"ok","b":{"n":4}/);assert.match(text,/"note":"note"/);assert.match(text,/"recursive":\[false,false\]/);assert.equal(f.calls.length,3);
 const failed=await execute('await tools.plain({})',{tools,executeTool:async()=>({isError:true,result:{content:[{type:'text',text:'blocked'}]}})});
 assert.equal(failed.result.isError,true);assert.match(failed.text,/blocked/);
});
test('strict discovery includes guidelines, namespace, aliases and no recursive tools',async()=>{
 const tools=[{name:'mcp__ns__read-file',description:'Inspect source',parameters:{type:'object',properties:{path:{type:'string'}}}}];
 const metadata=[{...tools[0],promptGuidelines:['Use only local paths.'],namespace:{name:'mcp__ns',description:'Files',instructions:'Read safely'}}];
 const {result,text}=await execute('return [ALL_TOOLS,await describeTool("mcp__ns__read_file"),await describeNamespace("ns"),await searchTools("Inspect",{namespace:"ns"})]',{tools,metadata});
 assert.equal(result.isError,undefined);assert.match(text,/Use only local paths/);assert.match(text,/Read safely/);assert.match(text,/mcp__ns__read_file/);
 const invalid=await execute('await searchTools("a",{extra:1})',{tools});assert.equal(invalid.result.isError,true);
});
test('store is shared branch-local, success-only, including exit',async()=>{
 const f=fixture(),{executeWorkflow}=adapter ??= await load('codemode-adapter.ts');
 const run=code=>executeWorkflow(code,'/source/store.js',new AbortController().signal,f.ctx,f.pi,f.api);
 await run('store("x",{n:1});exit()');assert.equal(f.entries.length,1);
 const loaded=await run('return load("x")');assert.match(loaded.content.map(c=>c.text).join(''),/{"n":1}/);
 await run('store("x",{n:2});throw Error("failed")');assert.equal(f.entries.length,1);
 await run('store("x",undefined)');assert.equal(f.entries.length,2);assert.deepEqual(f.entries[1].data.delete,['x']);
});
test('partial output, source options, true source stack mapping and hard deadline',async()=>{
 const failed=await execute('// @options: {"max_output_tokens":1000}\ntext("partial");\nawait workflow.sequence([async()=>{throw Error("on source line 3")}]);');
 assert.equal(failed.result.isError,true);assert.match(failed.text,/partial/);assert.match(failed.text,/\/source\/workflow.js:3/);
 const infinite=await execute('// @options: {"timeout_ms":50}\nwhile(true){}');assert.equal(infinite.result.isError,true);
 const invalid=await assert.rejects(execute('// @options: {"unknown":1}\nreturn 1'));
});
test('output limits truncate head/tail spill full text and persist images',async()=>{
 const {result,text}=await execute('// @options: {"max_output_tokens":10}\ntext("start"+"x".repeat(200)+"end");image({type:"image",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+x2tUAAAAASUVORK5CYII=",mimeType:"image/png"})');
 assert.match(text,/truncated output/);assert.ok(result.details.fullOutputPath);
 assert.match(await readFile(result.details.fullOutputPath,'utf8'),/^start.*end$/);await rm(result.details.fullOutputPath);
 const saved=text.match(/Image saved to ([^\]]+)/)[1];assert.equal((await readFile(saved)).subarray(0,8).toString('hex'),'89504e470d0a1a0a');await rm(saved);
});
test('strict host operations reject unknown fields/cross-run scope IDs',async()=>{
 const failed=await execute('await __workflowHost({op:"status",scope:"other-run/0",label:"bad"})');assert.equal(failed.result.isError,true);assert.match(failed.text,/Unknown workflow scope/);
 const extra=await execute('await __workflowHost({op:"status",scope:"fixture-run/0",label:"bad",extra:true})');assert.equal(extra.result.isError,true);assert.match(extra.text,/Unknown field/);
 const excessive=await execute('await workflow.parallel(Array(10000).fill(async w=>1))');assert.equal(excessive.result.isError,true);
});
test('status and optional agent name reject malformed values rather than accepting defaults',async()=>{
 for(const source of ['await workflow.set_status()','await workflow.set_status(null)','await workflow.agent("task","a",null)']){
  const {result,f}=await execute(source);assert.equal(result.isError,true);assert.equal(f.agentCalls.length,0);
 }
});
test('abort cancels owned work and awaits cleanup',async()=>{
 const controller=new AbortController();
 let stopped=false;
 const {result}=await execute('await workflow.agent("waiting","a")',{signal:controller.signal,agent:async(prompt,template,name,signal)=>new Promise((resolve,reject)=>{
 const finish=()=>{stopped=true;reject(Error('stop'))};signal.addEventListener('abort',finish,{once:true});if(signal.aborted)finish();else setTimeout(()=>controller.abort(Error('stop')),10)
 })});
 assert.equal(result.isError,true);assert.equal(result.details.status,'cancelled');assert.equal(stopped,true);
});

test('settled agent retains exact scoped signal; fallback awaits descendants and final usage handles',async()=>{
 const {executeWorkflow}=adapter ??= await load('codemode-adapter.ts');
 let originalSignal,descendantsStopped=false,abortObserved=false,release;
 const ready=new Promise(resolve=>release=resolve);
 const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
 const f=fixture({
  tools:[{name:'hold',parameters:{}},{name:'fail',parameters:{}},{name:'inspect',parameters:{}}],
  agent:async(prompt,template,name,signal)=>{
   originalSignal=signal;signal.addEventListener('abort',()=>abortObserved=true,{once:true});release();
   return {name,text:'leader done',usage};
  },
  executeTool:async(name,args,signal)=>{
   if(name==='fail'){await ready;return {isError:true,result:{content:[{type:'text',text:'branch failed'}]}};}
   if(name==='inspect')return {isError:false,result:{content:[{type:'text',text:String(descendantsStopped)}]}};
   return new Promise(resolve=>{const done=()=>resolve({isError:true,result:{content:[{type:'text',text:'aborted'}]}});signal.addEventListener('abort',done,{once:true});if(signal.aborted)done()});
  },
 });
 const host=f.api.openRun();
 host.cancelAgents=async signal=>{
  assert.strictEqual(signal,originalSignal);assert.equal(signal.aborted,true);assert.equal(abortObserved,true);
  await new Promise(resolve=>setTimeout(resolve,10));descendantsStopped=true;usage.totalTokens=7;
 };
 const result=await executeWorkflow('try{await workflow.parallel([async w=>{await w.agent("leader","a");await w.tools.hold({})},async w=>w.tools.fail({})])}catch(e){}return await workflow.tools.inspect({})',
  '/scope.js',new AbortController().signal,f.ctx,f.pi,f.api);
 assert.equal(result.isError,undefined);assert.equal(descendantsStopped,true);assert.match(result.content.map(c=>c.text).join(''),/true/);assert.equal(result.usage.totalTokens,7);
});
test('abort during post-VM cleanup does not commit store to a replaced session',async()=>{
 const {executeWorkflow}=adapter ??= await load('codemode-adapter.ts');
 const controller=new AbortController(),f=fixture();
 const close=f.api.openRun().close;
 f.api.openRun().close=async()=>{controller.abort(Error("session changed"));await close()};
 const result=await executeWorkflow('store("bad",1);text("partial");return 2','/late.js',controller.signal,f.ctx,f.pi,f.api);
 assert.equal(result.isError,true);assert.equal(result.details.status,'cancelled');assert.equal(f.entries.length,0);
 assert.match(result.content.map(c=>c.text).join(''),/partial/);
});
test('source line one and caught parallel rethrow map to source rather than bootstrap',async()=>{
 const direct=await execute('throw Error("line one")');assert.match(direct.text,/\/source\/workflow.js:1/);
 const branch=await execute('try{await workflow.parallel([async()=>{throw Error("branch")}])}catch(error){throw error}');
 assert.equal(branch.result.isError,true);assert.match(branch.text,/\/source\/workflow.js:1/);assert.doesNotMatch(branch.text,/codemode\.js/);
});
test('sparse callback arrays reject before work and callbacks snapshot before host await',async()=>{
 for(const composition of ['sequence','parallel']){
  const {result,f}=await execute(`const callbacks=[async (...args)=>workflow.agent("no","a")];callbacks.length=2;await workflow.${composition}(callbacks)`);
  assert.equal(result.isError,true);assert.equal(f.agentCalls.length,0);assert.equal(f.calls.length,0);assert.equal(result.details.nodes.length,1);
 }
 const {result,text}=await execute('const callbacks=[async()=>7];const pending=workflow.sequence(callbacks);callbacks[0]=null;return await pending');
 assert.equal(result.isError,undefined);assert.match(text,/7/);
});
