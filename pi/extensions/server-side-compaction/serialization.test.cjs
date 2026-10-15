const {test} = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {realpathSync} = require('node:fs');
const {dirname,resolve,join} = require('node:path');
const {pathToFileURL} = require('node:url');
const root=resolve(dirname(realpathSync(execFileSync('which',['pi'],{encoding:'utf8'}).trim())),'../..');
const host=p=>import(pathToFileURL(join(root,p)).href);
const modules=Promise.all([host('dist/index.js'),host('node_modules/@earendil-works/pi-ai/dist/compat.js')]);
const esbuild=require(require.resolve('esbuild',{paths:[root]}));
async function load(file) {
  const [sdk,ai]=await modules;
  const output=await esbuild.build({entryPoints:[join(__dirname,file)],bundle:true,write:false,platform:'node',format:'cjs',external:['@earendil-works/pi-coding-agent','@earendil-works/pi-ai']});
  const m={exports:{}}; new Function('module','exports','require',output.outputFiles[0].text)(m,m.exports,name=>name==='@earendil-works/pi-coding-agent'?sdk:name==='@earendil-works/pi-ai'?ai:require(name)); return m.exports;
}
const model={provider:'openai',api:'openai-responses',id:'test',name:'test',baseUrl:'https://api.openai.com/v1',input:['text','image'],reasoning:true,contextWindow:32000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const assistant=content=>({role:'assistant',provider:model.provider,api:model.api,model:model.id,content,usage,stopReason:'toolUse',timestamp:2});

test('standard payload builder preserves prefix structures, full tool output, images and fresh system state',async()=>{
  const {serializePrefix,capturePayload}=await load('serialize.ts'); const [sdk]=await modules;
  const manager=sdk.SessionManager.inMemory('/tmp');
  manager.appendMessage({role:'system',content:'canonical system',toolsAdded:[{name:'read',description:'Read file',parameters:{type:'object',properties:{path:{type:'string'}}}}],timestamp:0});
  manager.appendMessage({role:'user',content:[{type:'text',text:'older user'},{type:'image',mimeType:'image/png',data:'AAAA'}],timestamp:1});
  manager.appendMessage(assistant([{type:'thinking',thinking:'reason',thinkingSignature:JSON.stringify({type:'reasoning',id:'rs_1',summary:[],encrypted_content:'reason-cipher'})},{type:'toolCall',id:'call_1|fc_1',name:'read',arguments:{path:'a'}}]));
  manager.appendMessage({role:'toolResult',toolCallId:'call_1|fc_1',toolName:'read',content:[{type:'text',text:'x'.repeat(9000)}],isError:false,timestamp:3});
  const kept=manager.appendMessage({role:'user',content:'recent user must stay outside request',timestamp:4});
  manager.appendMessage({role:'system',content:'fresh rules',timestamp:5});
  const branch=manager.getBranch(); const full=await capturePayload(model,manager.buildSessionProjection().messages);
  const ctx={getSystemPrompt:()=> 'canonical system\n\nfresh rules',sessionManager:manager};
  const prefix=await serializePrefix(ctx,model,branch,kept);
  assert.ok(!JSON.stringify(prefix.input).includes('recent user'));
  const out=prefix.input.find(i=>i.type==='function_call_output'); assert.equal(out.output.length,9000);
  assert.ok(prefix.input.some(i=>i.type==='reasoning'&&i.encrypted_content==='reason-cipher'));
  assert.ok(JSON.stringify(prefix.input).includes('data:image/png;base64,AAAA'));
  // Compare conversation prefix exactly; a forced prompt can legitimately replace the leading system text.
  assert.deepEqual(prefix.input.filter(i=>!['system','developer'].includes(i.role)),full.input.filter(i=>!['system','developer'].includes(i.role)).slice(0,-1));
  assert.ok(JSON.stringify(prefix.input).includes('fresh rules'));
});

test('Codex uses its public original payload builder without any network access',async()=>{
  const {capturePayload}=await load('serialize.ts');
  const payload=await capturePayload({...model,provider:'openai-codex',api:'openai-codex-responses',baseUrl:'https://chatgpt.com/backend-api'},[
    {role:'system',content:'instructions',timestamp:0},{role:'user',content:'original content',timestamp:1},
  ],{sessionId:'thread-id'});
  assert.equal(payload.instructions,'instructions'); assert.equal(payload.prompt_cache_key,'thread-id');
  assert.equal(payload.input[0].content[0].text,'original content');
});

test('checkpoint replay is exact-once, independent of next policy, and never reuses old response chain',async()=>{
  const {replay}=await load('serialize.ts');
  const marker='Server-side OpenAI checkpoint [uuid]'; const output=[{role:'user',content:'older preserved user'},{type:'compaction',encrypted_content:'opaque'}];
  const payload={model:'test',input:[{role:'developer',content:'system'},{role:'user',content:[{type:'input_text',text:'wrapper '+marker}]},{role:'user',content:'fresh tail'}],tools:[{name:'fresh tool'}],previous_response_id:'old'};
  const result=replay(payload,marker,output);
  assert.deepEqual(result.input,[payload.input[0],...output,payload.input[2]]); assert.equal(result.previous_response_id,undefined);
  assert.deepEqual(result.tools,payload.tools); assert.equal(payload.input.length,3);
  assert.throws(()=>replay({...payload,input:[payload.input[0]]},marker,output),/exactly once/);
  assert.throws(()=>replay({...payload,input:[payload.input[1],payload.input[1]]},marker,output),/exactly once/);
});

test('fail-closed payload stops real OpenAI and Codex provider implementations before transport',async()=>{
  const {blockedPayload}=await load('serialize.ts'); const [,ai]=await modules;
  let attempts=0;
  for(const kind of ['openai','codex']) {
    const codex=kind==='codex';
    const provider=codex?ai.openAICodexResponsesApi():ai.openAIResponsesApi();
    const token=`h.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fake'}})).toString('base64url')}.s`;
    const result=await provider.streamSimple(codex?{...model,provider:'openai-codex',api:'openai-codex-responses',baseUrl:'https://chatgpt.com/backend-api'}:model,{messages:[{role:'system',content:'safe',timestamp:0},{role:'user',content:'must not be sent',timestamp:1}]},{apiKey:codex?token:'sk-fake',transport:'sse',fetch:async()=>{attempts++;throw Error('Unexpected network');},onPayload:()=>blockedPayload('Encrypted checkpoint is incompatible; conversion required.')}).result();
    assert.equal(result.stopReason,'error'); assert.match(result.errorMessage,/conversion required/);
  }
  assert.equal(attempts,0);
});

test('readable conversion chunks preserve tool groups and carry usage without fabricating counts',async()=>{
  const {summaryChunks,addUsage}=await load('summarize.ts');
  const tool=assistant([{type:'toolCall',id:'c1',name:'read',arguments:{}}]);
  const result={role:'toolResult',toolCallId:'c1',toolName:'read',content:[{type:'text',text:'x'.repeat(12000)}],isError:false,timestamp:3};
  const chunks=summaryChunks([{role:'user',content:'first',timestamp:1},tool,result,{role:'user',content:'z'.repeat(10000),timestamp:4}],1000);
  assert.ok(chunks.some(chunk=>chunk.includes(tool)&&chunk.includes(result)));
  assert.ok(chunks.length>2);
  assert.equal(addUsage(undefined,undefined),undefined);
  const u={...usage,input:2,output:1,totalTokens:3}; assert.equal(addUsage(u,u).totalTokens,6);
});
