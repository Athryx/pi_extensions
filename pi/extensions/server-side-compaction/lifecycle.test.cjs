const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, mkdir, rm} = require('node:fs/promises');
const {join} = require('node:path');
const {tmpdir} = require('node:os');
const {host} = require('../subagents/test-helper.cjs');

const READABLE = 'Readable checkpoint: original secret fact and complete tool result preserved.';
const BUNDLE = [
  {type:'message', role:'assistant', content:[{type:'output_text', text:'Server retained prelude.'}]},
  {type:'compaction', encrypted_content:'opaque-lifecycle-ciphertext'},
  {type:'message', role:'assistant', content:[{type:'output_text', text:'Server retained epilogue.'}]},
];
const usage = {input:10, output:5, cacheRead:0, cacheWrite:0, totalTokens:15,
  cost:{input:0, output:0, cacheRead:0, cacheWrite:0, total:0}};
const assistant = (content, extra={}) => ({role:'assistant', content, api:'openai-responses', provider:'openai', model:'local', timestamp:1, stopReason:'stop', usage, ...extra});

// Only the compact endpoint is mocked. Generation uses a deterministic registered
// SDK provider, but still invokes the real request hook and consumes its result.
async function fixture() {
  const sdk = await host('dist/index.js');
  const ai = await host('node_modules/@earendil-works/pi-ai/dist/index.js');
  const {openAIResponsesApi} = await host('node_modules/@earendil-works/pi-ai/dist/api/openai-responses.lazy.js');
  async function capturePayload(model, messages) {
    let payload;
    await openAIResponsesApi().streamSimple(model, {messages:sdk.convertToLlm(messages)}, {
      apiKey:'serialization-only', transport:'sse',
      fetch:async ()=>{throw new Error('Serializer attempted network access');},
      onPayload(value) {payload=structuredClone(value); throw new Error('Captured before HTTP');},
    }).result();
    assert.ok(payload, 'installed Responses serializer invoked onPayload');
    return payload;
  }
  const dir = await mkdtemp(join(tmpdir(), 'pi-compaction-lifecycle-'));
  const agentDir = join(dir, 'agent');
  await mkdir(agentDir);
  const originalFetch = global.fetch, originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const endpoint = [], requests = [], errors = [];
  const controls = {endpointStatus:200, summaryError:false, beforeResponse:undefined, generationUsage:undefined, overflowOnce:false, payloadModel:undefined};
  global.fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.openai.com/v1/responses/compact', 'all other network access is forbidden');
    endpoint.push(JSON.parse(options.body));
    if (controls.endpointStatus!==200) return new Response('deterministic endpoint failure', {status:controls.endpointStatus});
    return new Response(JSON.stringify({object:'response.compaction', output:BUNDLE,
      usage:{input_tokens:10, output_tokens:5, total_tokens:15}}), {status:200, headers:{'content-type':'application/json'}});
  };
  const runtime = await sdk.ModelRuntime.create({authPath:join(agentDir,'auth.json'), modelsPath:null, refreshOnCreate:false});
  const provider = {api:'openai-responses', apiKey:'local-fake-key', baseUrl:'https://api.openai.com/v1',
    models:[{id:'local', name:'Local', reasoning:false, input:['text'], contextWindow:128000, maxTokens:1024,
      cost:{input:0, output:0, cacheRead:0, cacheWrite:0}}],
    streamSimple(model, context, options) {
      const stream = ai.createAssistantMessageEventStream();
      queueMicrotask(async () => {
        try {
          const raw = await capturePayload({...model, api:'openai-responses'}, context.messages);
          if (controls.payloadModel) raw.model=controls.payloadModel;
          const replacement = await options?.onPayload?.(raw, model);
          // Do not ignore the poison proxy on a blocked request (Pi hooks are fail-open).
          const payload = JSON.parse(JSON.stringify(replacement ?? raw));
          requests.push({context:structuredClone(context), payload});
          if (controls.beforeResponse) await controls.beforeResponse(options?.signal);
          if (options?.signal?.aborted) throw new Error('Deterministic request aborted');
          if (controls.summaryError) throw new Error('Deterministic readable summary failure');
          if (controls.overflowOnce) {controls.overflowOnce=false; throw new Error('maximum context length exceeded');}
          const output = assistant([{type:'text', text:READABLE}], {api:model.api, provider:model.provider, model:model.id, timestamp:Date.now(),
            ...(controls.generationUsage ? {usage:controls.generationUsage} : {})});
          stream.push({type:'start', partial:output});
          stream.push({type:'done', reason:'stop', message:output});
        } catch (error) {
          stream.push({type:'error', reason:'error', error:assistant([], {timestamp:Date.now(), api:model.api, provider:model.provider, model:model.id, stopReason:'error', errorMessage:error.message})});
        } finally { stream.end(); }
      });
      return stream;
    },
  };
  runtime.registerProvider('openai', provider);
  runtime.registerProvider('other-local', {...provider, baseUrl:'https://unused.invalid'});
  const model = runtime.getModelOfType('chat','openai','local');
  const target = runtime.getModelOfType('chat','other-local','local');
  let manager = sdk.SessionManager.create(dir, join(dir,'sessions'));
  const toolText = 'TOOL-BEGIN:' + 'unabridged result '.repeat(700) + ':TOOL-END';
  const source = [
    {role:'user', content:'Original secret fact: purple kestrel.', timestamp:1},
    assistant([{type:'toolCall', id:'call_lifecycle', name:'read', arguments:{path:'facts.txt'}}], {stopReason:'toolUse'}),
    {role:'toolResult', toolCallId:'call_lifecycle', toolName:'read', content:[{type:'text', text:toolText}], isError:false, timestamp:2},
    assistant([{type:'text',text:'Old answer.'}]),
    {role:'user', content:'TAIL-USER '+ 'recent '.repeat(100), timestamp:3},
    assistant([{type:'text',text:'TAIL-ASSISTANT '+ 'recent '.repeat(100)}]),
  ];
  for (const message of source) manager.appendMessage(message);
  const settings = sdk.SettingsManager.inMemory({compaction:{enabled:false, keepRecentTokens:100, reserveTokens:1024}, retry:{enabled:false}});
  let session;
  async function open(enabled=true) {
    const loader = new sdk.DefaultResourceLoader({cwd:dir, agentDir, settingsManager:settings,
      noExtensions:true, additionalExtensionPaths:enabled ? [join(__dirname,'index.ts')] : [], noSkills:true, noPromptTemplates:true, noThemes:true});
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({session} = await sdk.createAgentSession({cwd:dir, agentDir, settingsManager:settings, resourceLoader:loader,
      sessionManager:manager, modelRuntime:runtime, model, noTools:true}));
    await session.bindExtensions({mode:'print', onError:error=>errors.push(error)});
    return session;
  }
  await open();
  return {sdk, endpoint, requests, errors, controls, settings, model, target, toolText, capturePayload, source,
    get manager() {return manager;},
    get session() {return session;}, async reopen(enabled=true) {
      session.dispose();
      manager = sdk.SessionManager.open(manager.getSessionFile());
      return open(enabled);
    },
    async cleanup() {
      try {session?.dispose(); assert.deepEqual(errors, [], 'extension runner must not swallow lifecycle errors');}
      finally {global.fetch=originalFetch; originalAgentDir===undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR=originalAgentDir; await rm(dir,{recursive:true,force:true});}
    }};
}
const latest = f => f.manager.getBranch().filter(e=>e.type==='compaction').at(-1);
async function encrypted(f) {
  await f.session.prompt('/compaction server');
  await f.session.compact();
  assert.equal(f.endpoint.length,1);
  const entry = latest(f);
  assert.equal(entry.details?.kind,'server-side-compaction');
  return entry;
}
const asText = value => JSON.stringify(value);

test('installed SDK persists exact structured prefix and replays ordered output once with unchanged retained tail, including resume', async () => {
  const f = await fixture();
  try {
    const entry = await encrypted(f);
    assert.deepEqual(entry.details.output, BUNDLE);
    const entries = f.manager.getBranch();
    const boundary = entries.findIndex(e=>e.id===entry.firstKeptEntryId);
    const prefixMessages = entries.slice(0,boundary).filter(e=>e.type==='message').map(e=>e.message);
    const expected = await f.capturePayload(f.model, [{role:'system', content:f.session.systemPrompt, timestamp:0}, ...prefixMessages]);
    assert.deepEqual(f.endpoint[0].input,JSON.parse(JSON.stringify(expected.input)));
    assert.match(asText(f.endpoint[0].input), /TOOL-BEGIN:/);
    assert.ok(asText(f.endpoint[0].input).includes(f.toolText), 'tool output is never truncated');
    assert.doesNotMatch(asText(f.endpoint[0].input), /TAIL-ASSISTANT/);
    assert.ok(f.manager.getSessionFile(), 'checkpoint is file-backed');
    await f.reopen();
    await f.session.prompt('Next generation after resume.');
    const request = f.requests.at(-1);
    const raw = await f.capturePayload(f.model, request.context.messages);
    const markerIndex = raw.input.findIndex(item=>asText(item).includes(entry.summary));
    assert.ok(markerIndex>=0);
    assert.deepEqual(request.payload.input,JSON.parse(JSON.stringify([...raw.input.slice(0,markerIndex), ...BUNDLE, ...raw.input.slice(markerIndex+1)])));
    assert.equal(request.payload.input.filter(item=>item.type==='compaction').length,1);
    assert.doesNotMatch(asText(request.payload), /Server-side OpenAI checkpoint/);
  } finally {await f.cleanup();}
});

test('server to Pi policy is deferred; next native checkpoint reconstructs readable source instead of marker or ciphertext', async () => {
  const f = await fixture();
  try {
    const entry = await encrypted(f);
    await f.session.prompt('/compaction pi');
    assert.equal(latest(f).id,entry.id);
    assert.equal(f.requests.length,0, 'changing backend cannot implicitly convert');
    await f.session.prompt('Continue with retained tail.');
    assert.deepEqual(f.requests.at(-1).payload.input.filter(item=>item.type==='compaction'), [BUNDLE[1]]);
    const before = f.requests.length;
    await f.session.compact();
    const summaryCalls = f.requests.slice(before);
    assert.ok(summaryCalls.length>0);
    const text = asText(summaryCalls.map(r=>r.context));
    assert.match(text,/purple kestrel/);
    assert.match(text,/TOOL-BEGIN:/);
    assert.doesNotMatch(text,/Server-side OpenAI checkpoint|opaque-lifecycle-ciphertext/);
    assert.match(latest(f).summary,/Readable checkpoint/);
    assert.notEqual(latest(f).details?.kind,'server-side-compaction');
    assert.equal(f.endpoint.length,1);
  } finally {await f.cleanup();}
});

test('explicit portable conversion survives extension disable and remains readable', async () => {
  const f = await fixture();
  try {
    const entry = await encrypted(f);
    await f.session.prompt('/compaction portable');
    const portable = f.manager.getBranch().find(e=>e.type==='custom_message' && e.customType==='server-side-compaction.portable.v1');
    assert.ok(portable);
    assert.equal(portable.details.checkpointId,entry.id);
    assert.equal(portable.content,READABLE);
    assert.match(asText(f.requests[0].context), /purple kestrel/);
    assert.doesNotMatch(asText(f.requests[0].context), /Server-side OpenAI checkpoint|opaque-lifecycle-ciphertext/);
    await f.reopen(false);
    await f.session.prompt('Read the portable checkpoint with extension disabled.');
    const request = f.requests.at(-1);
    assert.ok(asText(request.context).includes(READABLE));
    assert.doesNotMatch(asText(request.payload), /opaque-lifecycle-ciphertext/);
    assert.equal(f.endpoint.length,1);
  } finally {await f.cleanup();}
});

for (const accepted of [false,true]) test(`interactive incompatible model switch confirmation ${accepted ? 'accepts and converts' : 'cancels without conversion'}`, async () => {
  const f = await fixture();
  try {
    await encrypted(f);
    const dialogs = [];
    const runner = f.session.extensionRunner;
    runner.setUIContext({...runner.getUIContext(), confirm:async (title, message)=>{dialogs.push({title,message});return accepted;}, notify(){}, setStatus(){}}, 'tui');
    assert.equal(runner.createContext().hasUI,true);
    await f.session.setModel(f.target);
    assert.equal(dialogs.length,1);
    assert.match(dialogs[0].title,/Compaction required/);
    assert.equal(f.session.model.provider,accepted ? 'other-local' : 'openai');
    assert.equal(f.requests.length,accepted ? 1 : 0);
    const portable = f.manager.getBranch().filter(e=>e.type==='custom_message' && e.customType==='server-side-compaction.portable.v1');
    assert.equal(portable.length,accepted ? 1 : 0);
    if (accepted) {
      await f.session.prompt('Continue on the incompatible provider after conversion.');
      const text = asText(f.requests.at(-1).payload);
      assert.ok(text.includes(READABLE));
      assert.doesNotMatch(text,/Server-side OpenAI checkpoint|opaque-lifecycle-ciphertext/);
    }
  } finally {await f.cleanup();}
});


test('endpoint failure over an encrypted checkpoint falls back to readable semantic reconstruction', async () => {
  const f = await fixture();
  try {
    const original = await encrypted(f);
    await f.session.prompt('Keep this newer fact in the next checkpoint.');
    const before = f.requests.length;
    f.controls.endpointStatus=503;
    await f.session.compact();
    assert.equal(f.endpoint.length,2);
    assert.notEqual(latest(f).id,original.id);
    assert.notEqual(latest(f).details?.kind,'server-side-compaction');
    assert.ok(latest(f).summary.startsWith(READABLE));
    assert.match(latest(f).summary, /facts\.txt/);
    const readableRequests = f.requests.slice(before);
    assert.ok(readableRequests.length>0);
    assert.match(asText(readableRequests.map(r=>r.context)), /purple kestrel/);
    assert.doesNotMatch(asText(readableRequests), /Server-side OpenAI checkpoint|opaque-lifecycle-ciphertext/);
    assert.ok(f.manager.getBranch().some(e=>e.type==='custom' && /Falling back/.test(e.data?.message ?? '')));
  } finally {await f.cleanup();}
});

for (const viaSwitch of [false,true]) test(`readable conversion failure preserves encrypted checkpoint and compatible model (${viaSwitch ? 'accepted model switch' : 'portable command'})`, async () => {
  const f = await fixture();
  try {
    const original = await encrypted(f);
    f.controls.summaryError=true;
    if (viaSwitch) {
      const runner = f.session.extensionRunner;
      runner.setUIContext({...runner.getUIContext(), confirm:async ()=>true, notify(){}, setStatus(){}}, 'tui');
      await f.session.setModel(f.target);
    } else await f.session.prompt('/compaction portable');
    assert.equal(f.session.model.provider,'openai');
    assert.equal(latest(f).id,original.id);
    assert.equal(f.manager.getBranch().some(e=>e.type==='custom_message' && e.customType==='server-side-compaction.portable.v1'),false);
    assert.equal(f.requests.length,1);
    assert.doesNotMatch(asText(f.requests[0]), /Server-side OpenAI checkpoint|opaque-lifecycle-ciphertext/);
    f.controls.summaryError=false;
    await f.session.prompt('Original checkpoint must still replay after failed conversion.');
    assert.deepEqual(f.requests.at(-1).payload.input.filter(item=>item.type==='compaction'),[BUNDLE[1]]);
  } finally {await f.cleanup();}
});

test('navigation cancels a pending portable conversion and cannot append a stale readable checkpoint', async () => {
  const f = await fixture();
  try {
    const original = await encrypted(f);
    let started;
    const pending = new Promise(resolve=>{started=resolve;});
    f.controls.beforeResponse = signal => new Promise((resolve,reject)=>{
      assert.ok(signal, 'conversion passes an operation-owned abort signal');
      signal.addEventListener('abort',()=>reject(new Error('Deterministic conversion cancelled')), {once:true});
      started();
    });
    const conversion = f.session.prompt('/compaction portable');
    await pending;
    // This is the actual SDK event runner used after tree navigation. Move the
    // authoritative branch first, as the host does, without starting another run.
    const forkPoint = f.manager.getBranch().find(e=>e.type==='message' && e.message.role==='user');
    f.manager.branch(forkPoint.id);
    f.manager.appendCustomEntry('lifecycle.navigation', {from:original.id});
    await f.session.extensionRunner.emit({type:'session_tree'});
    await conversion;
    assert.equal(f.manager.getBranch().some(e=>e.type==='custom_message' && e.customType==='server-side-compaction.portable.v1'),false);
    assert.equal(f.session.model.provider,'openai');
    assert.equal(latest(f),undefined);
    f.controls.beforeResponse=undefined;
    f.manager.branch(original.id);
    f.manager.appendCustomEntry('lifecycle.navigation', {restored:true});
    await f.reopen();
    assert.equal(latest(f).id,original.id);
    await f.session.prompt('Still use the original checkpoint after stale conversion.');
    assert.deepEqual(f.requests.at(-1).payload.input.filter(item=>item.type==='compaction'),[BUNDLE[1]]);
  } finally {await f.cleanup();}
});

for (const reason of ['threshold','overflow']) test(`native automatic ${reason} lifecycle selects server compaction without a manual compact call`, async () => {
  const f = await fixture();
  try {
    await f.session.prompt('/compaction server');
    const events = [];
    const unsubscribe = f.session.subscribe(event=>{if (event.type==='compaction_start' || event.type==='compaction_end') events.push(event);});
    f.settings.setCompactionEnabled(true);
    if (reason==='threshold') f.controls.generationUsage={...usage, input:127500, totalTokens:127505};
    else f.controls.overflowOnce=true;
    await f.session.prompt(`Trigger deterministic automatic ${reason} recovery.`);
    unsubscribe();
    assert.equal(f.endpoint.length,1);
    assert.equal(latest(f).details?.kind,'server-side-compaction');
    assert.equal(events.filter(e=>e.type==='compaction_start' && e.reason===reason).length,1);
    const ended = events.find(e=>e.type==='compaction_end');
    assert.ok(ended.result);
    assert.equal(ended.reason,reason);
    assert.equal(ended.aborted,false);
    assert.equal(ended.willRetry,reason==='overflow');
    assert.equal(f.requests.length,reason==='overflow' ? 2 : 1, 'overflow retries once; threshold does not repeat completed generation');
    if (reason==='overflow') assert.deepEqual(f.requests.at(-1).payload.input.filter(item=>item.type==='compaction'),[BUNDLE[1]]);
  } finally {await f.cleanup();}
});

test('generation during pending readable conversion consumes poison before deterministic transport', async () => {
  const f = await fixture();
  let release, conversion;
  try {
    await encrypted(f);
    let started;
    const pending = new Promise(resolve=>{started=resolve;});
    f.controls.beforeResponse = async ()=>{started(); await new Promise(resolve=>{release=resolve;});};
    conversion = f.session.prompt('/compaction portable');
    await pending;
    const before = f.requests.length;
    const blocked = await f.session.extensionRunner.emitBeforeProviderRequest({model:f.model.id, input:[{role:'user',content:'Concurrent request while conversion is active.'}]});
    assert.throws(()=>JSON.stringify(blocked), /original checkpoint was preserved/);
    assert.equal(f.requests.length,before, 'blocked payload never reaches the deterministic transport');
    release();
    await conversion;
    assert.equal(f.endpoint.length,1);
  } finally {release?.(); await conversion; await f.cleanup();}
});

test('a request-local routed model mismatch blocks encrypted replay before transport', async () => {
  const f = await fixture();
  try {
    await encrypted(f);
    f.controls.payloadModel='different-virtual-model';
    await f.session.prompt('Route this request through an incompatible physical model.');
    assert.equal(f.requests.length,0);
    assert.equal(f.session.messages.at(-1).stopReason,'error');
    assert.match(f.session.messages.at(-1).errorMessage,/original checkpoint was preserved/);
    assert.equal(f.endpoint.length,1);
  } finally {await f.cleanup();}
});

test('portable projection missing its marker anchor poisons the next provider request', async () => {
  const f = await fixture();
  try {
    await encrypted(f);
    await f.session.prompt('/compaction portable');
    const runner = f.session.extensionRunner;
    const before = f.requests.length;
    // Exercise the installed context runner with a malformed projection, followed
    // by the real request runner. Never swallow a returned poison proxy.
    await runner.emitContext([{role:'user', content:'Projection lost its checkpoint summary.', timestamp:Date.now()}]);
    const blocked = await runner.emitBeforeProviderRequest({model:f.model.id, input:[{role:'user',content:'lost anchor'}]});
    assert.throws(()=>JSON.stringify(blocked), /original checkpoint was preserved/);
    assert.equal(f.requests.length,before);
  } finally {await f.cleanup();}
});

for (const authAvailable of [true,false]) test(`navigation while model-switch authentication is pending cannot restore, prompt, or mutate the new branch (${authAvailable ? 'valid' : 'missing'} credentials)`, async () => {
  const f = await fixture();
  let release, registry, originalAuth;
  try {
    await encrypted(f);
    const runner = f.session.extensionRunner;
    let dialogs=0;
    runner.setUIContext({...runner.getUIContext(), confirm:async ()=>{dialogs++;return true;}, notify(){}, setStatus(){}}, 'tui');
    registry=runner.createContext().modelRegistry;
    originalAuth=registry.getApiKeyAndHeaders;
    let started;
    const pending = new Promise(resolve=>{started=resolve;});
    registry.getApiKeyAndHeaders=async function(model) {
      const auth=await originalAuth.call(this,model);
      if (model.provider==='openai') {
        started();
        await new Promise(resolve=>{release=resolve;});
      }
      return authAvailable ? auth : {ok:false};
    };
    const switching=f.session.setModel(f.target);
    await pending;
    const forkPoint=f.manager.getBranch().find(e=>e.type==='message' && e.message.role==='user');
    f.manager.branch(forkPoint.id);
    f.manager.appendCustomEntry('lifecycle.navigation', {pendingAuth:true});
    await runner.emit({type:'session_before_tree'});
    const leaf=f.manager.getLeafId();
    release();
    await switching;
    assert.equal(f.session.model.provider,'other-local', 'stale model-select handler must not restore the old model');
    assert.equal(f.manager.getLeafId(),leaf, 'stale authentication cannot append any new branch entries');
    assert.equal(dialogs,0);
    assert.equal(f.requests.length,0);
    assert.equal(latest(f),undefined);
  } finally {
    release?.();
    if (registry && originalAuth) registry.getApiKeyAndHeaders=originalAuth;
    await f.cleanup();
  }
});

test('resuming sibling branches activates only that branch checkpoint and mode', async () => {
  const f = await fixture();
  try {
    const entry = await encrypted(f);
    const originalUser = f.manager.getBranch().find(e=>e.type==='message' && e.message.role==='user');
    f.manager.branch(originalUser.id);
    f.manager.appendCustomEntry('server-side-compaction.mode.v1', {mode:'pi'});
    await f.reopen();
    assert.equal(latest(f),undefined);
    await f.session.prompt('Sibling branch without encrypted context.');
    assert.doesNotMatch(asText(f.requests.at(-1).payload), /opaque-lifecycle-ciphertext|Server-side OpenAI checkpoint/);
    assert.match(asText(f.requests.at(-1).payload), /purple kestrel/);
    f.manager.branch(entry.id);
    f.manager.appendCustomEntry('server-side-compaction.mode.v1', {mode:'server'});
    await f.reopen();
    assert.equal(latest(f).id,entry.id);
    await f.session.prompt('Resume the encrypted branch.');
    assert.deepEqual(f.requests.at(-1).payload.input.filter(item=>item.type==='compaction'),[BUNDLE[1]]);
    assert.equal(f.endpoint.length,1, 'branch resume does not recompact');
  } finally {await f.cleanup();}
});
