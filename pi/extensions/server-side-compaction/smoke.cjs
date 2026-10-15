// Disposable real-Pi TUI fixture. Only deterministic local providers/fetch mocks.
// Run `node smoke.cjs`, then start pi in the printed project directory with
// PI_CODING_AGENT_DIR=<printed>/agent pi --offline --provider openai --model smoke
// Chat twice, /compact, then /smoke-target. Escape cancels; repeat and accept.
const {mkdtempSync, mkdirSync, writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const dir = mkdtempSync(join(tmpdir(), 'pi-compaction-smoke-'));
const agent = join(dir, 'agent'), project = join(dir, 'project');
mkdirSync(join(agent, 'extensions'), {recursive:true});
mkdirSync(project);
writeFileSync(join(agent, 'settings.json'), JSON.stringify({quietStartup:true, tuiMode:'fullscreen',
  extensions:[join(agent, 'extensions/fake.ts'), join(__dirname, 'index.ts')],
  compaction:{enabled:false, keepRecentTokens:0, reserveTokens:1024}, retry:{enabled:false}}));
writeFileSync(join(agent, 'extensions/fake.ts'), `
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
export default function(pi) {
 globalThis.fetch=async (url,options)=>{
  if(String(url)!=='https://api.openai.com/v1/responses/compact')throw new Error('Smoke fixture blocks all real network');
  return new Response(JSON.stringify({object:'response.compaction',output:[{type:'compaction',encrypted_content:'FAKE-SMOKE-CHECKPOINT'}],usage:{input_tokens:10,output_tokens:5,total_tokens:15}}),{status:200,headers:{'content-type':'application/json'}});
 };
 const config={api:'openai-responses',apiKey:'fake-smoke-key',baseUrl:'https://api.openai.com/v1',models:[{id:'smoke',name:'Deterministic compaction smoke',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000}],streamSimple(model,context){
  const stream=createAssistantMessageEventStream();
  const output={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:'stop',content:[{type:'text',text:'Readable synthetic summary: the secret fact is BLUEBIRD. No paid calls.'}],usage:{input:10,output:5,cacheRead:0,cacheWrite:0,totalTokens:15,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  queueMicrotask(()=>{stream.push({type:'start',partial:output});stream.push({type:'text_start',contentIndex:0,partial:output});stream.push({type:'text_delta',contentIndex:0,delta:output.content[0].text,partial:output});stream.push({type:'text_end',contentIndex:0,content:output.content[0].text,partial:output});stream.push({type:'done',reason:'stop',message:output});stream.end();});return stream;
 }};
 pi.registerProvider('openai',config);
 pi.registerProvider('smoke-target',{...config,api:'smoke-local',baseUrl:'http://unused.invalid'});
 pi.registerCommand('smoke-target',{description:'Try incompatible deterministic model',handler:async(_,ctx)=>{await pi.setModel(ctx.modelRegistry.find('smoke-target','smoke'));ctx.ui.notify('Effective model: '+ctx.model.provider+'/'+ctx.model.id,'info');}});
 pi.registerCommand('smoke-state',{description:'Show actual active smoke state',handler:async(_,ctx)=>{const branch=ctx.sessionManager.getBranch();ctx.ui.notify('Effective model: '+ctx.model.provider+'/'+ctx.model.id+'; encrypted checkpoints: '+branch.filter(e=>e.type==='compaction'&&e.details?.kind==='server-side-compaction').length+'; portable records: '+branch.filter(e=>e.type==='custom_message'&&e.customType==='server-side-compaction.portable.v1').length,'info');}});
}
`);
console.log(dir);
