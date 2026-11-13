const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,writeFile,rm}=require('node:fs/promises');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {load,host}=require('./test-helper.cjs');

async function setup(initial){
  const {default:extension}=await load('index.ts');
  const tools=[],handlers={};let active=[...initial];
  extension({registerTool:t=>tools.push(t),on:(n,h)=>{handlers[n]=h;},getActiveTools:()=>[...active],setActiveTools:n=>{active=[...n];}});
  return {tools,handlers,get active(){return active;}};
}
const openai={provider:'openai',api:'openai-responses',id:'gpt'};
const codex={provider:'openai-codex',api:'openai-codex-responses',id:'gpt'};
const other={provider:'openrouter',api:'openai-completions',id:'x'};

test('tools are opt-in and reject extra fields',async()=>{
  const {tools}=await setup([]);const {validateToolArguments}=await host('node_modules/@earendil-works/pi-ai/dist/utils/validation.js');
  assert.deepEqual(tools.map(t=>t.name),['tavily_search','tavily_extract']);
  for(const t of tools)assert.equal(t.defaultActive,false);
  const call=(t,args)=>validateToolArguments(t,{name:t.name,arguments:args});
  call(tools[0],{query:'x'});call(tools[1],{urls:['https://example.com']});
  assert.throws(()=>call(tools[0],{query:'x',extra:1}),/Validation failed/);
  assert.throws(()=>call(tools[1],{urls:['https://example.com'],extra:1}),/Validation failed/);
  assert.throws(()=>call(tools[0],{query:'x',max_results:99}),/Validation failed/);
});

test('tools are removed on OpenAI models and restored only if they were removed',async()=>{
  const s=await setup(['read','tavily_search','tavily_extract']);
  s.handlers.session_start({},{model:openai});assert.deepEqual(s.active,['read']);
  s.handlers.model_select({model:other},{model:other});assert.deepEqual(s.active.sort(),['read','tavily_extract','tavily_search']);
  s.handlers.model_select({model:codex},{});assert.deepEqual(s.active,['read']);
  // user deselected one in the meantime? Only suppressed tools return; unselected ones stay off.
  const t=await setup(['read']);t.handlers.model_select({model:openai},{});t.handlers.model_select({model:other},{});assert.deepEqual(t.active,['read']);
  // proxies and non-OpenAI providers keep Tavily
  const u=await setup(['tavily_search']);u.handlers.session_start({},{model:{...openai,baseUrl:'https://proxy.test/v1'}});assert.deepEqual(u.active,['tavily_search']);
});

test('search and extract call Tavily with bearer auth and format untrusted results',async()=>{
  const {callTavily,formatResponse,loadApiKey}=await load('client.ts');
  const dir=await mkdtemp(join(tmpdir(),'tavily-'));const old=process.env.TAVILY_API_KEY;
  try{
    delete process.env.TAVILY_API_KEY;assert.equal(await loadApiKey({},dir),undefined);
    await writeFile(join(dir,'tavily-search.json'),'{"apiKey":"file-key"}');assert.equal(await loadApiKey({},dir),'file-key');
    assert.equal(await loadApiKey({TAVILY_API_KEY:' env-key '},dir),'env-key');
    process.env.TAVILY_API_KEY='k';let seen;
    const fetchImpl=async(url,init)=>{seen={url,init};return new Response(JSON.stringify({answer:'A',results:[{title:'T',url:'https://e.com',content:'c'}]}),{status:200});};
    const data=await callTavily('search',{query:'q'},undefined,fetchImpl);
    assert.equal(seen.url,'https://api.tavily.com/search');assert.equal(seen.init.headers.authorization,'Bearer k');assert.equal(JSON.parse(seen.init.body).query,'q');
    const text=formatResponse(data,'search');assert.match(text,/untrusted/);assert.match(text,/Answer: A/);assert.match(text,/\[1\] T\nhttps:\/\/e.com\nc/);
    assert.match(formatResponse({},'search'),/No results/);assert.ok(formatResponse({results:[{url:'u',content:'x'.repeat(99999)}]},'search').length<41000);
    await assert.rejects(callTavily('search',{},undefined,async()=>new Response('nope',{status:401})),/HTTP 401 nope/);
    delete process.env.TAVILY_API_KEY;process.env.PI_CODING_AGENT_DIR=dir;await rm(join(dir,'tavily-search.json'));
    await assert.rejects(callTavily('search',{},undefined,fetchImpl),/API key not found/);
  }finally{old===undefined?delete process.env.TAVILY_API_KEY:process.env.TAVILY_API_KEY=old;delete process.env.PI_CODING_AGENT_DIR;await rm(dir,{recursive:true,force:true});}
});
