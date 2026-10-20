const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,mkdir,writeFile,readFile,rm}=require('node:fs/promises');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {host,load}=require('./test-helper.cjs');

// Exercise installed serializers, real SSE normalization, extension hooks and persistence.
// Each transport is replaced with a deterministic local fetch: no network/model calls.
async function fixture({tools,config,compaction=false}={}){
  const sdk=await host('dist/index.js');
  const ai=await host('node_modules/@earendil-works/pi-ai/dist/index.js');
  const {openAIResponsesApi}=await host('node_modules/@earendil-works/pi-ai/dist/api/openai-responses.lazy.js');
  const {openAICodexResponsesApi}=await host('node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.lazy.js');
  const dir=await mkdtemp(join(tmpdir(),'pi-search-lifecycle-')),agentDir=join(dir,'agent');await mkdir(agentDir);
  if(config!==undefined)await writeFile(join(agentDir,'codex-web-search.json'),JSON.stringify(config));
  const originalAgentDir=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
  const requests=[],errors=[],controls={failed:false,incomplete:false,viewPage:false};
  const marker='citeturn0search0';
  const fetch=async(url,options)=>{
    const bytes=new Headers(options.headers).get('content-encoding')==='zstd'?require('node:zlib').zstdDecompressSync(options.body).toString():options.body;
    const payload=JSON.parse(bytes);requests.push({url:String(url),payload});
    assert.ok(['https://api.openai.com/v1/responses','https://chatgpt.com/backend-api/codex/responses'].includes(String(url)),'no unexpected endpoint');
    const enabled=payload.tools?.some(tool=>tool.type==='web_search');
    const text=enabled?'Verified fact. '+marker:'Ordinary model answer.';
    const message={id:'msg_'+requests.length,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:enabled?[{type:'url_citation',start_index:15,end_index:15+marker.length,title:'Example source',url:'https://example.com/fact'}]:[]}]};
    const search={id:'ws_'+requests.length,type:'web_search_call',status:'completed',action:{type:'search',queries:['latest fact'],sources:[{type:'url',title:'Example source',url:'https://example.com/fact'}]}};
    const page={id:'page_'+requests.length,type:'web_search_call',status:'completed',action:{type:'open_page',url:'https://example.com/opened'}};
    const nativeItems=enabled?[search,...(controls.viewPage?[page]:[])]:[];
    const events=[{type:'response.created',response:{id:'resp_'+requests.length}}];
    nativeItems.forEach((item,index)=>events.push({type:'response.output_item.added',output_index:index,item:{id:item.id,type:'web_search_call',status:'in_progress'}},{type:'response.output_item.done',output_index:index,item}));
    events.push({type:'response.output_item.added',output_index:nativeItems.length,item:{...message,content:[]}},{type:'response.output_text.delta',output_index:nativeItems.length,content_index:0,delta:text},{type:'response.output_item.done',output_index:nativeItems.length,item:message});
    events.push({type:controls.failed?'response.failed':controls.incomplete?'response.incomplete':'response.completed',response:{id:'resp_'+requests.length,status:controls.failed?'failed':controls.incomplete?'incomplete':'completed',
      ...(controls.failed?{error:{message:'Deterministic search response failure'}}:{}),...(controls.incomplete?{incomplete_details:{reason:'max_output_tokens'}}:{}),output:[...nativeItems,message],usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_tokens_details:{cached_tokens:0}}}});
    return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
  };
  const runtime=await sdk.ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:null,refreshOnCreate:false});
  const modelInfo={id:'local',name:'Local',reasoning:false,input:['text'],contextWindow:128000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const provider={api:'openai-responses',apiKey:'fake-local-key',baseUrl:'https://api.openai.com/v1',models:[modelInfo],
    streamSimple(model,context,options){return openAIResponsesApi().streamSimple(model,context,{...options,fetch,transport:'sse'});}};
  runtime.registerProvider('openai',provider);
  runtime.registerProvider('other-local',provider);
  const token='h.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fake-account'}})).toString('base64url')+'.s';
  runtime.registerProvider('openai-codex',{...provider,api:'openai-codex-responses',apiKey:token,baseUrl:'https://chatgpt.com/backend-api',
    streamSimple(model,context,options){return openAICodexResponsesApi().streamSimple(model,context,{...options,fetch,transport:'sse'});}});
  const model=runtime.getModelOfType('chat','openai','local');
  const codex=runtime.getModelOfType('chat','openai-codex','local');
  const other=runtime.getModelOfType('chat','other-local','local');
  let manager=sdk.SessionManager.create(dir,join(dir,'sessions')),session;
  const settings=sdk.SettingsManager.inMemory({defaultTools:['+web_search'],compaction:{enabled:false},retry:{enabled:false},cacheWarming:'off'});
  async function open(){
    const loader=new sdk.DefaultResourceLoader({cwd:dir,agentDir,settingsManager:settings,noExtensions:true,
      additionalExtensionPaths:[join(__dirname,'index.ts'),...(compaction?[join(__dirname,'../server-side-compaction/index.ts')]:[])],
      extensionFactories:[sdk.createCodemodeExtension(),sdk.createToolSearchExtension()],noSkills:true,noPromptTemplates:true,noThemes:true});
    await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
    ({session}=await sdk.createAgentSession({cwd:dir,agentDir,settingsManager:settings,resourceLoader:loader,sessionManager:manager,modelRuntime:runtime,model,...(tools?{tools}:{})}));
    await session.bindExtensions({mode:'print',onError:error=>errors.push(error)});
  }
  await open();
  return {sdk,ai,runtime,model,codex,other,requests,errors,dir,agentDir,controls,get session(){return session;},get manager(){return manager;},
    async reopen(){session.dispose();manager=sdk.SessionManager.open(manager.getSessionFile());await open();},
    async cleanup(){try{session?.dispose();assert.deepEqual(errors,[],'extension hooks must not fail silently');}finally{originalAgentDir===undefined?delete process.env.PI_CODING_AGENT_DIR:process.env.PI_CODING_AGENT_DIR=originalAgentDir;await rm(dir,{recursive:true,force:true});}}};
}
const native=payload=>payload.tools?.filter(tool=>tool.type==='web_search')??[];
const results=f=>f.manager.getBranch().filter(entry=>entry.type==='custom_message'&&entry.customType==='codex-web-search.results.v1');

test('installed Pi runs native search, saves links and summaries, then switches away and back without losing selection',async()=>{
  const f=await fixture();
  try{
    assert.ok(f.session.getActiveToolNames().includes('web_search'));
    await f.session.prompt('Search for the latest fact.');const first=f.requests.at(-1).payload;
    assert.equal(native(first).length,1);assert.equal(native(first)[0].external_web_access,true);
    assert.ok(!first.tools.some(tool=>tool.type==='function'&&tool.name==='web_search'));
    const answer=f.session.messages.filter(message=>message.role==='assistant').at(-1);
    assert.match(answer.content[0].text,/\[Example source\]\(<https:\/\/example.com\/fact>\)/);assert.doesNotMatch(answer.content[0].text,/cite/);
    assert.equal(results(f).length,1);assert.equal(results(f)[0].details.mode,'live');
    await f.session.setModel(f.other);await f.session.prompt('Continue on another provider.');
    const foreign=f.requests.at(-1).payload;assert.equal(native(foreign).length,0);assert.doesNotMatch(JSON.stringify(foreign.tools),/web_search/);
    assert.match(JSON.stringify(foreign.input),/https:\/\/example.com\/fact/);assert.ok(f.session.getActiveToolNames().includes('web_search'));
    await f.session.setModel(f.codex);await f.session.prompt('Search with Codex.');
    const codexAnswer=f.session.messages.filter(m=>m.role==='assistant').at(-1);assert.notEqual(codexAnswer.stopReason,'error',codexAnswer.errorMessage);
    assert.equal(native(f.requests.at(-1).payload).length,1);assert.match(f.requests.at(-1).url,/codex\/responses$/);
    await f.session.setModel(f.model);await f.session.prompt('Back to OpenAI.');assert.equal(native(f.requests.at(-1).payload).length,1);
  }finally{await f.cleanup();}
});

test('conversation commands persist across reopening and do not change config or make requests',async()=>{
  const f=await fixture({config:{mode:'cached'}});
  try{
    await f.session.prompt('Initial config mode');assert.equal(native(f.requests.at(-1).payload)[0].external_web_access,false);
    const count=f.requests.length;await f.session.prompt('/web-search live');await f.session.prompt('/web-search status');assert.equal(f.requests.length,count);
    assert.deepEqual(JSON.parse(await readFile(join(f.agentDir,'codex-web-search.json'),'utf8')),{mode:'cached'});
    await f.reopen();await f.session.prompt('After resume');assert.equal(native(f.requests.at(-1).payload)[0].external_web_access,true);
    await f.session.prompt('/web-search');await f.session.prompt('After toggle');assert.equal(native(f.requests.at(-1).payload)[0].external_web_access,false);
    await f.session.prompt('/web-search live');await f.session.prompt('/web-search reset');await f.session.prompt('After reset');assert.equal(native(f.requests.at(-1).payload)[0].external_web_access,false);
  }finally{await f.cleanup();}
});

test('native SSE actions survive resume and render through the custom UI as search and page-view rows',async()=>{
  const f=await fixture();
  const {CompactView}=await load('../ui/compact.ts');
  const {Container}=await host('node_modules/@earendil-works/pi-tui/dist/index.js');
  const {CustomMessageComponent}=await host('dist/modes/interactive/components/custom-message.js');
  const themes=await host('dist/modes/interactive/theme/theme.js');themes.initTheme('dark');
  let view;
  try{
    f.controls.viewPage=true;await f.session.prompt('Search and open a specific page.');
    assert.deepEqual(results(f)[0].details.operations,[{type:'search',query:'latest fact',status:'completed'},
      {type:'open_page',url:'https://example.com/opened',status:'completed'}]);
    await f.reopen();const saved=results(f)[0];
    const tui=new Container(),chat=new Container();tui.requestRender=()=>{};tui.addChild(chat);
    const row=new CustomMessageComponent({role:'custom',customType:saved.customType,content:saved.content,details:saved.details,display:true,timestamp:1},
      f.session.extensionRunner.getMessageRenderer(saved.customType),themes.getMarkdownTheme(),1);
    const normal=row.render(120);chat.addChild(row);view=new CompactView(tui,()=>themes.theme);
    const rendered=chat.render(120),plain=rendered.join('\n').replace(/\x1b\[[0-9;]*m/g,'');
    assert.match(plain,/searched latest fact/);assert.match(plain,/viewed web page https:\/\/example.com\/opened/);
    assert.doesNotMatch(plain,/viewed web page https:\/\/example.com\/fact/,'a source hit is not a view');
    assert.ok(rendered.join('\n').includes(themes.theme.fg('mdLink',themes.theme.bold('searched'))));
    view.enabled=false;assert.deepEqual(row.render(120),normal);
  }finally{view?.dispose();await f.cleanup();}
});

test('CLI-style exclusions remain authoritative even when command mode changes',async()=>{
  const f=await fixture({tools:['read']});
  try{
    assert.ok(!f.session.getActiveToolNames().includes('web_search'));await f.session.prompt('/web-search cached');await f.session.prompt('No search');
    assert.equal(native(f.requests.at(-1).payload).length,0);assert.equal(results(f).length,0);
  }finally{await f.cleanup();}
});

test('codemode and tool search coexist without a callable placeholder',async()=>{
  const f=await fixture({tools:['codemode','tool_search','web_search']});
  try{
    await f.session.prompt('Use native search');assert.equal(native(f.requests.at(-1).payload).length,1);
    assert.equal(f.session.getAllTools().find(tool=>tool.name==='web_search').exposure,'model-only');assert.ok(!f.session.getCallableToolNames().includes('web_search'));
    const nested=await f.session.extensionRunner.createToolContext('probe',undefined).executeTool('web_search',{});
    assert.equal(nested.isError,true);assert.match(JSON.stringify(nested),/not callable|Unknown|not available|not found/i);
    assert.ok(!f.requests.at(-1).payload.tools.some(tool=>tool.type==='function'&&tool.name==='web_search'));
  }finally{await f.cleanup();}
});

test('invalid config disables only search, while compaction extension and ordinary responses keep working',async()=>{
  const f=await fixture({config:{mode:'invalid'},compaction:true});
  try{await f.session.prompt('Normal generation');assert.equal(native(f.requests.at(-1).payload).length,0);assert.equal(f.session.messages.filter(m=>m.role==='assistant').at(-1).stopReason,'stop');}
  finally{await f.cleanup();}
});

test('incomplete and failed native responses retain source summaries without manufacturing local tool calls',async()=>{
  for(const outcome of ['incomplete','failed']){
    const f=await fixture();
    try{
      f.controls[outcome]=true;await f.session.prompt('Search then stop early');assert.equal(results(f).length,1);
      assert.equal(results(f)[0].details.sources[0].url,'https://example.com/fact');
      assert.ok(!f.session.messages.some(m=>m.role==='assistant'&&m.content.some(c=>c.type==='toolCall'&&c.name==='web_search')));
    }finally{await f.cleanup();}
  }
});
