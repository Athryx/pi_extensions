const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, mkdir, writeFile, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const {load, host} = require('../subagents/test-helper.cjs');

// Exercise the actual worker package resolver, resource loader and print-mode binding.
// The custom provider is local and deterministic; no HTTP/model service is contacted.
async function fixture({supported=false} = {}) {
  const {Workspace} = await load('workspace.ts');
  const {parseTemplate} = await load('templates.ts');
  const sdk = await host('dist/index.js');
  const ai = await host('node_modules/@earendil-works/pi-ai/dist/index.js');
  const dir = await mkdtemp(join(tmpdir(), 'pi-compaction-workers-'));
  const agentDir = join(dir, 'agent'), cwd = join(dir, 'project');
  await mkdir(agentDir, {recursive:true});
  await mkdir(cwd, {recursive:true});
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    extensions:[join(__dirname, 'index.ts')],
    compaction:{enabled:false, keepRecentTokens:0, reserveTokens:1024},
  }));
  const requests = [];
  const runtime = await sdk.ModelRuntime.create({authPath:join(agentDir, 'auth.json'), modelsPath:null, refreshOnCreate:false});
  const provider = {
    api:'compaction-worker-test', apiKey:'fake-local-key', baseUrl:'http://unused.invalid',
    models:[{id:'local', name:'Local', reasoning:false, input:['text'], contextWindow:32000, maxTokens:1000,
      cost:{input:0, output:0, cacheRead:0, cacheWrite:0}}],
    streamSimple(model, context) {
      requests.push(context);
      const stream = ai.createAssistantMessageEventStream();
      const output = {role:'assistant', api:model.api, provider:model.provider, model:model.id,
        timestamp:Date.now(), content:[{type:'text', text:'Deterministic readable worker summary.'}], stopReason:'stop',
        usage:{input:10, output:5, cacheRead:0, cacheWrite:0, totalTokens:15,
          cost:{input:0, output:0, cacheRead:0, cacheWrite:0, total:0}}};
      queueMicrotask(() => {
        stream.push({type:'start', partial:output});
        stream.push({type:'text_start', contentIndex:0, partial:output});
        stream.push({type:'text_delta', contentIndex:0, delta:output.content[0].text, partial:output});
        stream.push({type:'text_end', contentIndex:0, content:output.content[0].text, partial:output});
        stream.push({type:'done', reason:'stop', message:output});
        stream.end();
      });
      return stream;
    },
  };
  runtime.registerProvider('compaction-worker-test', provider);
  if (supported) runtime.registerProvider('openai', {...provider, api:'openai-responses', baseUrl:'https://api.openai.com/v1'});
  const registry = new sdk.ModelRegistry(runtime);
  const model = registry.find(supported ? 'openai' : 'compaction-worker-test', 'local');
  assert.ok(model);
  const manager = sdk.SessionManager.inMemory(cwd);
  manager.appendMessage({role:'user', content:'Root task must not inherit child policy.', timestamp:Date.now()});
  const identity = {version:1, workspaceId:'compaction-test', instanceId:'root', name:'main', template:'main',
    role:'interactive', parentName:null, rootSessionFile:manager.getSessionFile()};
  manager.appendCustomEntry('subagents.identity.v1', identity);
  const templates = new Map(['main', 'subagent'].map(name => [name, parseTemplate(
    'name: '+name+'\n'+(name==='main' ? 'subagents: {extra: [subagent], default: subagent}' : ''), join(dir, name+'.yaml'))]));
  const context = {cwd, sessionManager:manager, modelRegistry:registry, model, thinkingLevel:'off',
    isIdle:()=>false, isProjectTrusted:()=>true};
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const workspace = new Workspace({cwd, agentDir, trusted:true,
    config:{agent_paths:[], max_running:8, max_depth:4, max_group_depth:4, worker_exclude_extensions:[]},
    templates, identity, context, global:{model, thinking:'off'},
    append:(type, data)=>manager.appendCustomEntry(type, data), rootSend:()=>{},
  });
  const cleanups = [];
  return {workspace, manager, requests, cleanups, async cleanup() {
    await workspace.close();
    for (const cleanup of cleanups.reverse()) cleanup();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, {recursive:true, force:true});
  }};
}
async function createWorker(f, name) {
  await f.workspace.create('main', name, 'Remember the local worker fact: '+name);
  const worker = f.workspace.get(name);
  for (let n=0; n<500 && worker.busy; n++) await new Promise(resolve=>setTimeout(resolve, 10));
  assert.ok(!worker.busy, 'worker completed its deterministic initial run');
  assert.equal(worker.status, 'idle', worker.error);
  assert.ok(worker.session.extensionRunner.getExtensionPaths().some(path => resolve(path)===join(__dirname, 'index.ts')));
  const ctx = worker.session.extensionRunner.createContext();
  assert.equal(ctx.mode, 'print');
  assert.equal(ctx.hasUI, false);
  return worker;
}
function modes(manager) {
  return manager.getBranch().filter(entry => entry.type==='custom' && entry.customType==='server-side-compaction.mode.v1').map(entry=>entry.data.mode);
}
function forbidDialogs(f, worker) {
  const attempts = [];
  // SDK print runners share a no-op UI singleton. Preserve identity (hasUI must
  // remain false), and restore the methods even if an assertion fails.
  const ui = worker.session.extensionRunner.getUIContext();
  for (const name of ['confirm', 'select', 'input', 'custom', 'editor']) {
    const original = ui[name];
    f.cleanups.push(() => { ui[name] = original; });
    ui[name] = async () => { attempts.push(name); throw new Error('Headless worker attempted dialog '+name); };
  }
  return attempts;
}

test('real subagents load compaction headlessly and keep branch mode overrides worker-local', async () => {
  const f = await fixture();
  try {
    const alice = await createWorker(f, 'alice');
    const bob = await createWorker(f, 'bob');
    const dialogs = forbidDialogs(f, alice);
    await alice.session.prompt('/compaction pi');
    await bob.session.prompt('/compaction server');
    assert.deepEqual(modes(alice.manager), ['pi']);
    assert.deepEqual(modes(bob.manager), ['server']);
    assert.deepEqual(modes(f.manager), []);
    const before = f.requests.length;
    await alice.session.prompt('/compaction status');
    await bob.session.prompt('/compaction status');
    assert.equal(f.requests.length, before, 'policy/status commands do not make model calls');
    // Re-read policy from each branch after the other worker changes its override.
    await alice.session.prompt('/compaction reset');
    assert.deepEqual(modes(bob.manager), ['server']);
    assert.deepEqual(modes(f.manager), []);
    assert.deepEqual(dialogs, []);
  } finally { await f.cleanup(); }
});

test('unsupported server selection in a real worker falls back to native readable compaction without dialogs', async () => {
  const f = await fixture();
  try {
    const worker = await createWorker(f, 'fallback');
    const dialogs = forbidDialogs(f, worker);
    await worker.session.prompt('/compaction server');
    const before = f.requests.length;
    await worker.session.compact('Keep the worker fact readable.');
    const checkpoint = worker.manager.getBranch().find(entry=>entry.type==='compaction');
    assert.ok(checkpoint, 'native host compaction persisted a checkpoint');
    assert.match(checkpoint.summary, /Deterministic readable worker summary/);
    assert.notEqual(checkpoint.details?.kind, 'server-side-compaction');
    assert.equal(f.requests.length, before+2, 'native split-turn compaction summarizes both history and turn prefix');
    assert.deepEqual(dialogs, []);
    assert.deepEqual(modes(f.manager), []);
  } finally { await f.cleanup(); }
});

test('server checkpoints stay worker-local and headless incompatible model changes never open dialogs', async () => {
  const originalFetch = global.fetch;
  const endpointRequests = [];
  global.fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.openai.com/v1/responses/compact', 'no real network request is allowed');
    endpointRequests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({object:'response.compaction', output:[
      {type:'compaction', encrypted_content:'deterministic-worker-ciphertext'},
    ], usage:{input_tokens:10, output_tokens:5, total_tokens:15}}), {status:200, headers:{'content-type':'application/json'}});
  };
  let f;
  try {
    f = await fixture({supported:true});
    const alice = await createWorker(f, 'encrypted');
    const bob = await createWorker(f, 'readable');
    const dialogs = forbidDialogs(f, alice);
    await alice.session.prompt('/compaction server');
    const before = f.requests.length;
    await alice.session.compact();
    assert.equal(endpointRequests.length, 1);
    assert.equal(f.requests.length, before, 'server compaction does not call the readable summarizer');
    assert.ok(alice.manager.getBranch().some(entry=>entry.type==='compaction' && entry.details?.kind==='server-side-compaction'));
    assert.equal(bob.manager.getBranch().some(entry=>entry.type==='compaction'), false);
    assert.equal(f.manager.getBranch().some(entry=>entry.type==='compaction'), false);
    const previous = alice.session.model;
    const target = alice.session.extensionRunner.createContext().modelRegistry.find('compaction-worker-test', 'local');
    assert.ok(target);
    await alice.session.setModel(target);
    assert.equal(alice.session.model.provider, previous.provider, 'headless switch restores the compatible model');
    assert.equal(alice.session.model.id, previous.id);
    assert.equal(endpointRequests.length, 1, 'switch refusal does not start another server compaction');
    assert.equal(f.requests.length, before, 'headless switch does not implicitly accept conversion cost');
    await bob.session.prompt('/compaction pi');
    await bob.session.compact();
    const readable = bob.manager.getBranch().find(entry=>entry.type==='compaction');
    assert.ok(readable);
    assert.match(readable.summary, /Deterministic readable worker summary/);
    assert.notEqual(readable.details?.kind, 'server-side-compaction');
    assert.equal(endpointRequests.length, 1, 'other worker uses its own Pi policy despite the first worker server mode');
    assert.equal(f.requests.length, before+2, 'native split-turn compaction retains its two summary calls');
    assert.deepEqual(dialogs, []);
  } finally {
    try { if (f) await f.cleanup(); } finally { global.fetch = originalFetch; }
  }
});
