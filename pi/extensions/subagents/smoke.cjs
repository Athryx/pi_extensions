// Disposable fake-provider TUI fixture. Prints its directory; no real API calls.
const {mkdtempSync,mkdirSync,writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const dir = mkdtempSync(join(tmpdir(),'pi-subagents-smoke-'));
mkdirSync(join(dir,'agent/extensions'),{recursive:true});mkdirSync(join(dir,'project'),{recursive:true});
writeFileSync(join(dir,'agent/settings.json'), JSON.stringify({quietStartup:true,tuiMode:'fullscreen'}));
mkdirSync(join(dir,'agent/agents'),{recursive:true});
writeFileSync(join(dir,'agent/agents/main.yaml'), 'name: main\nsubagents: {allowed: [subagent], default: subagent}\n');
writeFileSync(join(dir,'agent/agents/subagent.yaml'), 'name: subagent\n');
writeFileSync(join(dir,'agent/subagents.json'), JSON.stringify({default_agent:'main'}));
writeFileSync(join(dir,'agent/extensions/fake.ts'), `
import {createAssistantMessageEventStream,getCurrentSystemPrompt} from '@earendil-works/pi-ai';
export default function(pi) {
 pi.registerProvider('workspace-smoke',{api:'workspace-smoke',apiKey:'fake-only',baseUrl:'http://unused.invalid',models:[{id:'test',name:'Smoke test',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:2000}],streamSimple(model,context,options){
  const stream=createAssistantMessageEventStream();
  void (async()=>{
   const worker=getCurrentSystemPrompt(context.messages).includes('Name: demo.');
   const last=context.messages.at(-1);
   const lastText=typeof last.content==='string'?last.content:(last.content??[]).filter(b=>b.type==='text').map(b=>b.text).join(' ');
   const output={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:'pending',content:[],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
   stream.push({type:'start',partial:output});
   if(!worker && last.role==='user' && lastText.includes('Launch demo')){
    const call={type:'toolCall',id:'create-demo',name:'create_agent',arguments:{name:'demo',task:'Display progress for the read-only viewer'}};output.content.push(call);stream.push({type:'toolcall_start',contentIndex:0,partial:output});stream.push({type:'toolcall_end',contentIndex:0,toolCall:call,partial:output});output.stopReason='toolUse';
   } else if(!worker && last.role==='toolResult' && last.toolName==='create_agent'){
    const call={type:'toolCall',id:'wait-demo',name:'wait_message',arguments:{timeout:120}};output.content.push(call);stream.push({type:'toolcall_start',contentIndex:0,partial:output});stream.push({type:'toolcall_end',contentIndex:0,toolCall:call,partial:output});output.stopReason='toolUse';
   } else {
    const block={type:'text',text:''};output.content.push(block);stream.push({type:'text_start',contentIndex:0,partial:output});
    const parts=worker?['# Worker demo\\n','Parent: main · read-only viewer smoke test\\n\\n',...Array.from({length:12},(_,i)=>'Progress '+(i+1)+'/12: local synthetic work.\\n'),'\\nCompleted synthetic task.']:['Main received the worker result.'];
    for(const delta of parts){if(worker)await new Promise(r=>setTimeout(r,1000));if(options?.signal?.aborted)break;block.text+=delta;stream.push({type:'text_delta',contentIndex:0,delta,partial:output});}
    stream.push({type:'text_end',contentIndex:0,content:block.text,partial:output});output.stopReason=options?.signal?.aborted?'aborted':'stop';
   }
   if(output.stopReason==='aborted'){output.errorMessage='Cancelled';stream.push({type:'error',reason:'aborted',error:output});}else stream.push({type:'done',reason:output.stopReason,message:output});stream.end();
  })();return stream;
 }});
}
`);
console.log(dir);
