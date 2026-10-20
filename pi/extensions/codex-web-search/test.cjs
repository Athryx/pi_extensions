const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,mkdir,writeFile,rm}=require('node:fs/promises');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {load,host}=require('./test-helper.cjs');

test('tool is selectable, inactive by default, hidden from function declarations and never locally callable',async()=>{
  const {default:extension}=await load('index.ts');const tools=[];
  extension({registerTool:tool=>tools.push(tool),registerCommand(){},registerMessageRenderer(){},on(){}});
  const tool=tools[0];assert.equal(tool.name,'web_search');assert.equal(tool.defaultActive,false);assert.equal(tool.exposure,'model-only');
  assert.deepEqual(tool.prepareLoadout(),{hiddenDeclarations:['web_search']});
  const {validateToolArguments}=await host('node_modules/@earendil-works/pi-ai/dist/utils/validation.js');
  assert.throws(()=>validateToolArguments(tool,{name:'web_search',arguments:{query:'extra argument'}}),/Validation failed/);
  await assert.rejects(tool.execute(),/OpenAI-hosted/);
});

test('native requests preserve tools, include fields, instructions and immutable source payload',async()=>{
  const {searchRequest}=await load('request.ts');
  const payload={model:'test',input:[{role:'user',content:'hi'}],instructions:'Keep this',tools:[{type:'function',name:'read'},{type:'tool_search'}],include:['reasoning.encrypted_content'],store:false,metadata:{trace:'x'}};
  const before=structuredClone(payload);const next=searchRequest(payload,'cached');assert.deepEqual(payload,before);
  assert.equal(next.tools.at(-1).external_web_access,false);assert.equal(next.tools.filter(t=>t.type==='web_search').length,1);
  assert.deepEqual(next.tools.slice(0,-1),payload.tools);assert.deepEqual(next.metadata,payload.metadata);assert.equal(next.store,false);
  assert.match(next.instructions,/^Keep this/);assert.match(next.instructions,/cite source URLs/);
  assert.deepEqual(next.include,['reasoning.encrypted_content','web_search_call.action.sources']);
  const twice=searchRequest(next,'live');assert.equal(twice.tools.filter(t=>t.type==='web_search').length,1);assert.equal(twice.tools.at(-1).external_web_access,true);
  const existing=searchRequest({...payload,tools:[...payload.tools,{type:'web_search',filters:{allowed_domains:['example.com']}},{type:'web_search_preview'}]},'live');
  assert.deepEqual(existing.tools.at(-1).filters,{allowed_domains:['example.com']});assert.ok(!existing.tools.some(t=>t.type==='web_search_preview'));
  for(const input of [null,{}, {input:[],tools:{}},{messages:[]}])assert.equal(searchRequest(input,'live'),undefined);
});

test('only built-in OpenAI Responses routes qualify; non-OpenAI and proxies are quiet no-ops',async()=>{
  const {supportsSearch}=await load('request.ts');
  assert.equal(supportsSearch({provider:'openai',api:'openai-responses',id:'x'}),true);
  assert.equal(supportsSearch({provider:'openai-codex',api:'openai-codex-responses',id:'x'}),true);
  for(const model of [undefined,{provider:'anthropic',api:'anthropic-messages',id:'x'},{provider:'openrouter',api:'openai-responses',id:'x'},
    {provider:'openai',api:'openai-completions',id:'x'},...['http://api.openai.com/v1','https://proxy.test/v1','https://api.openai.com.evil/v1','https://api.openai.com/v1?x=1','https://user@api.openai.com/v1','https://api.openai.com/other'].map(baseUrl=>({provider:'openai',api:'openai-responses',id:'x',baseUrl}))]) assert.equal(supportsSearch(model),false);
});

test('config defaults, trusted project precedence, empty overrides and invalid config',async()=>{
  const {parseConfig,loadConfig}=await load('config.ts');const dir=await mkdtemp(join(tmpdir(),'search-config-'));
  try {
    const cwd=join(dir,'project'),agent=join(dir,'agent');await mkdir(join(cwd,'.pi'),{recursive:true});await mkdir(agent);
    const ctx={cwd,isProjectTrusted:()=>false};assert.equal((await loadConfig(ctx,agent)).mode,'live');
    await writeFile(join(agent,'codex-web-search.json'),' {"mode":"cached"}');
    await writeFile(join(cwd,'.pi','codex-web-search.json'),'{"mode":"live"}');
    assert.equal((await loadConfig(ctx,agent)).mode,'cached');ctx.isProjectTrusted=()=>true;
    assert.equal((await loadConfig(ctx,agent)).mode,'live');assert.equal((await loadConfig(ctx,agent)).source,'project config');
    await writeFile(join(cwd,'.pi','codex-web-search.json'),'{}');assert.equal((await loadConfig(ctx,agent)).mode,'cached');
    for(const invalid of ['{"mode":"bad"}','{"unknown":1}','null','[1]','not json',' '.repeat(65537)]){
      await writeFile(join(cwd,'.pi','codex-web-search.json'),invalid);assert.equal((await loadConfig(ctx,agent)).warnings.length,1);
    }
    for(const invalid of [null,[],{mode:'disabled'},{other:true}])assert.throws(()=>parseConfig(invalid));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('conversation overrides reset and follow the selected branch',async()=>{
  const {conversationMode,MODE_ENTRY}=await load('config.ts');
  const entry=mode=>({type:'custom',customType:MODE_ENTRY,data:{version:1,mode}});
  const branch=[entry('cached'),entry('live')];assert.equal(conversationMode(branch),'live');assert.equal(conversationMode(branch.slice(0,1)),'cached');
  assert.equal(conversationMode([...branch,entry(null)]),undefined);assert.equal(conversationMode([...branch,entry('invalid')]),'live');
});

async function fixture(){
  const {default:extension}=await load('index.ts');const handlers=new Map(),entries=[],notices=[],statuses=[],commands=new Map();let active=['web_search'];
  const ctx={model:{provider:'openai',api:'openai-responses',id:'test'},hasUI:true,cwd:'/unused',isProjectTrusted:()=>false,
    sessionManager:{getBranch:()=>entries},ui:{notify:(...a)=>notices.push(a),setStatus:(...a)=>statuses.push(a)}};
  extension({registerTool(){},registerCommand:(name,value)=>commands.set(name,value),registerMessageRenderer(){},getActiveTools:()=>active,
    appendEntry:(customType,data)=>entries.push({type:'custom',customType,data}),on:(event,handler)=>handlers.set(event,handler)});
  const emit=(name,event={})=>handlers.get(name)?.(event,ctx);
  return{ctx,emit,entries,notices,statuses,command:args=>commands.get('web-search').handler(args,ctx),select:names=>active=names};
}
test('commands toggle the conversation only; selection survives model changes and next request uses new mode',async()=>{
  const f=await fixture();const request={payload:{model:'test',input:[]}};
  assert.equal(f.emit('before_provider_request',request).tools.at(-1).external_web_access,true);
  await f.command('');assert.equal(f.emit('before_provider_request',request).tools.at(-1).external_web_access,false);
  await f.command('status');assert.match(f.notices.at(-1)[0],/cached \(conversation override\)/);assert.equal(f.entries.length,1);
  f.ctx.model={provider:'anthropic',api:'anthropic-messages',id:'other'};f.emit('model_select');
  const foreign={messages:[]};assert.equal(f.emit('before_provider_request',{payload:foreign}),undefined);assert.deepEqual(foreign,{messages:[]});
  await f.command('status');assert.match(f.notices.at(-1)[0],/unavailable/);
  f.ctx.model={provider:'openai',api:'openai-responses',id:'test'};f.emit('model_select');assert.equal(f.emit('before_provider_request',request).tools.at(-1).external_web_access,false);
  f.select([]);assert.equal(f.emit('before_provider_request',request),undefined);await f.command('live');assert.equal(f.emit('before_provider_request',request),undefined);
  await f.command('reset');assert.equal(f.entries.at(-1).data.mode,null);const count=f.entries.length;await f.command('off');assert.equal(f.entries.length,count);assert.match(f.notices.at(-1)[0],/Usage:/);
  f.select(['web_search']);assert.equal(f.emit('before_provider_request',{payload:{model:'routed-elsewhere',input:[]}}),undefined);
});

test('in-flight mode, canceled capture and repeated native events remain isolated',async()=>{
  const f=await fixture();f.emit('before_provider_request',{payload:{model:'test',input:[]}});
  const event={provider:'openai',api:'openai-responses',model:'test',data:{type:'response.output_item.done',item:{id:'search1',type:'web_search_call',status:'completed',action:{type:'search',query:'hello',sources:[{title:'Source',url:'https://example.com'}]}}}};
  f.emit('provider_stream_event',event);f.emit('provider_stream_event',event);await f.command('cached');
  const result=f.emit('turn_end',{outcome:'completed'});assert.equal(result.entries[0].details.mode,'live');assert.deepEqual(result.entries[0].details.actions,['hello']);
  assert.equal(f.emit('turn_end',{outcome:'completed'}),undefined);
  f.emit('before_provider_request',{payload:{model:'test',input:[]}});f.emit('provider_stream_event',event);f.emit('session_before_tree');assert.equal(f.emit('turn_end',{outcome:'aborted'}),undefined);
  assert.deepEqual(f.statuses.at(-1),['codex-web-search',undefined]);
});

test('native sources, citation ranges and provider terminal fallback produce bounded portable summaries',async()=>{
  const {SearchCapture,summary,source}=await load('output.ts');const capture=new SearchCapture();const text='Answer citeturn0search0.';
  const message={id:'msg',type:'message',content:[{type:'output_text',text,annotations:[{type:'url_citation',start_index:7,end_index:text.length-1,url:'https://example.com/x',title:'Example [source]'}]}]};
  const search={id:'search',type:'web_search_call',status:'completed',action:{type:'search',queries:['first','second'],sources:[{url:'https://example.com/x',title:'Example'}]}};
  capture.ingest({type:'response.completed',response:{output:[search,message]}});capture.ingest({type:'response.completed',response:{output:[search,message]}});
  const linked=capture.linkText(text,JSON.stringify({v:1,id:'msg'}));assert.match(linked,/\[Example \\\[source\\\]\]\(<https:\/\/example.com\/x>\)/);assert.doesNotMatch(linked,/cite/);
  assert.equal(capture.linkText('edited by another extension','msg'),'edited by another extension');assert.equal(capture.linkText(text,'unknown'),text);
  assert.match(summary(capture.details('cached','aborted')),/cached, aborted/);assert.equal(capture.sources.size,1);assert.equal(capture.actions.size,2);
  for(let n=0;n<300;n++)capture.ingest({type:'response.output_item.done',item:{id:'s'+n,type:'web_search_call',action:{type:'search',query:'query'+n,sources:[{url:'https://example.com/'+n}]}}});
  assert.equal(capture.sources.size,50);assert.equal(capture.actions.size,20);assert.equal(capture.calls.size,50);
  for(const url of ['javascript:alert(1)','file:///tmp/x','https://secret@example.com','https://example.com/\u001b[31m'])assert.equal(source({url}),undefined);
});

test('structured operations distinguish actual opens from search sources and preserve call order across stream snapshots',async()=>{
  const {SearchCapture}=await load('output.ts');const capture=new SearchCapture();
  const search={id:'search',type:'web_search_call',status:'completed',action:{type:'search',queries:['first','second'],sources:[{url:'https://unopened.example/',title:'Only a result'}]}};
  const open={id:'open',type:'web_search_call',status:'completed',action:{type:'open_page',url:'https://opened.example/'}};
  const find={id:'find',type:'web_search_call',status:'completed',action:{type:'find_in_page',url:'https://opened.example/',pattern:'needle'}};
  for(const item of [search,open,find])capture.ingest({type:'response.output_item.added',item:{id:item.id,type:'web_search_call',status:'in_progress'}});
  for(const item of [open,search,find])capture.ingest({type:'response.output_item.done',item});
  capture.ingest({type:'response.completed',response:{output:[search,open,find]}});
  assert.deepEqual(capture.details('live','completed').operations,[
    {type:'search',query:'first',status:'completed'},{type:'search',query:'second',status:'completed'},
    {type:'open_page',url:'https://opened.example/',status:'completed'},{type:'find_in_page',url:'https://opened.example/',pattern:'needle',status:'completed'},
  ]);
  assert.ok(!capture.details('live','completed').operations.some(op=>op.url==='https://unopened.example/'));
  capture.ingest({type:'response.output_item.done',item:{...open,status:'failed'}});assert.equal(capture.details('live','error').operations[2].status,'failed');
  for(let index=0;index<60;index++)capture.ingest({type:'response.output_item.done',item:{...search,id:'extra'+index}});
  assert.equal(capture.details('live','completed').operations.length,50);
});

test('render caches unchanged rows and invalidates width, theme, expansion, content and explicit invalidation',async()=>{
  const {SearchSummary}=await load('render.ts');let content='header\none\ntwo\nthree\nfour',expanded=false,color='ansi';let colors=0;
  const theme={colors:{},getColorMode:()=>color,appearance:'dark',fg:(_,text)=>{colors++;return text;}};
  const row=new SearchSummary(()=>content,()=>expanded,theme,1);let lines=row.render(60);assert.match(lines.join('\n'),/more lines/);assert.strictEqual(row.render(60),lines);assert.equal(colors,1);
  for(const change of [()=>content+='\nfive',()=>expanded=true,()=>theme.colors={},()=>color='truecolor',()=>theme.appearance='light',()=>row.invalidate()]){change();const next=row.render(60);assert.notStrictEqual(next,lines);lines=next;}
  assert.notStrictEqual(row.render(30),lines);assert.deepEqual(row.render(0),[]);assert.doesNotMatch(row.render(60).join('\n'),/more lines/);
});
