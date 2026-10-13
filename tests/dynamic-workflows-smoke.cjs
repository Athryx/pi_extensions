// Disposable real-Pi TUI fixture; fake provider only. Prints its directory.
const {mkdtempSync, mkdirSync, writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const dir = mkdtempSync(join(tmpdir(), 'pi-workflow-smoke-'));
const root = resolve(__dirname, '..');
const agent = join(dir, 'agent'), project = join(dir, 'project');
mkdirSync(join(agent, 'agents'), {recursive: true});
mkdirSync(join(agent, 'extensions'), {recursive: true});
mkdirSync(project);
writeFileSync(join(agent, 'settings.json'), JSON.stringify({quietStartup: true, tuiMode: 'fullscreen', defaultTools: ['read','codemode','workflow'], extensions: [join(root,'pi/extensions/subagents/index.ts'),...(process.argv.includes('--fallback') ? [] : [join(root,'pi/extensions/ui/index.ts')]),join(root,'pi/extensions/workflow/index.ts'),join(agent,'extensions/fake.ts')], retry: {enabled: false}}));
writeFileSync(join(agent, 'subagents.json'), JSON.stringify({default_agent: 'main', max_running: 2}));
writeFileSync(join(agent, 'agents/main.yaml'), 'name: main\nsubagents: {include_defaults: false}\n');
writeFileSync(join(project, 'flow.js'), `
await workflow.register_agents([
  {name:'reader', tools:{include_defaults:false,extra:[]}, prompt:'Perform the assigned synthetic task.', subagents:{include_defaults:false}},
  {name:'writer', tools:{include_defaults:false,extra:[]}, prompt:'Return a synthetic summary.', subagents:{include_defaults:false}},
]);
return await workflow.sequence([
 async (prior,w) => {
  await w.set_status('Research files');
  return await w.parallel([
   async branch => {await branch.set_status('Read architecture'); return await branch.agent('Produce synthetic architecture notes.', 'reader');},
   async branch => {await branch.set_status('Read conventions'); return await branch.agent('Produce synthetic convention notes.', 'reader', 'conventions');},
  ],'Research');
 },
 async (findings,w) => {await w.set_status('Summarize findings'); return await w.agent(JSON.stringify(findings),'writer');},
],'Repository overview');
`);
writeFileSync(join(agent, 'extensions/fake.ts'), `
import {createAssistantMessageEventStream,getCurrentSystemPrompt} from '@earendil-works/pi-ai';
export default function(pi) {
 pi.registerProvider('workflow-smoke', {api:'workflow-smoke', apiKey:'fake-only', baseUrl:'http://unused.invalid', models:[{id:'test',name:'Workflow smoke test',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:64000,maxTokens:2000}],streamSimple(model,context,options){
  const stream=createAssistantMessageEventStream();
  void (async()=>{
   const prompt=getCurrentSystemPrompt(context.messages), main=prompt.includes('Name: main.'), last=context.messages.at(-1);
   const output={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:'pending',content:[],usage:{input:2,output:3,cacheRead:0,cacheWrite:0,totalTokens:5,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
   stream.push({type:'start',partial:output});
   if(main && last.role==='user') {
    const call={type:'toolCall',id:'workflow-demo',name:'workflow',arguments:{path:'flow.js'}};output.content.push(call);
    stream.push({type:'toolcall_start',contentIndex:0,partial:output});stream.push({type:'toolcall_end',contentIndex:0,toolCall:call,partial:output});output.stopReason='toolUse';
   } else {
    const block={type:'text',text:''}; output.content.push(block);stream.push({type:'text_start',contentIndex:0,partial:output});
    const parts=main?['Workflow completed. All workers remained in separate agent groups.'] : ['# Isolated synthetic worker\\n','No messaging parent; read-only viewer.\\n', ...Array.from({length:6},(_,i)=>'Synthetic step '+(i+1)+'/6 completed.\\n'),'Final synthetic response.'];
    for(const delta of parts){
     if(!main) await new Promise(r=>{const timer=setTimeout(done,1000);function done(){clearTimeout(timer);options?.signal?.removeEventListener('abort',done);r();} options?.signal?.addEventListener('abort',done,{once:true});if(options?.signal?.aborted)done();});
     if(options?.signal?.aborted)break;block.text+=delta;stream.push({type:'text_delta',contentIndex:0,delta,partial:output});
    }
    stream.push({type:'text_end',contentIndex:0,content:block.text,partial:output});output.stopReason=options?.signal?.aborted?'aborted':'stop';
   }
   if(output.stopReason==='aborted'){output.errorMessage='Cancelled';stream.push({type:'error',reason:'aborted',error:output});} else stream.push({type:'done',reason:output.stopReason,message:output});stream.end();
  })();return stream;
 }});
}
`);
console.log(dir);
