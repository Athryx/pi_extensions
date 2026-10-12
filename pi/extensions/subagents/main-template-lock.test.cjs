// Installed SDK integration: no network requests or paid model calls.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, mkdir, writeFile, readFile, rm} = require('node:fs/promises');
const {join} = require('node:path');
const {tmpdir} = require('node:os');
const {host} = require('./test-helper.cjs');
const LOCK = 'subagents.main-template-lock.v1';
const TEMPLATE = 'subagents.template.v1';
const IDENTITY = 'subagents.identity.v1';
const user = () => ({role: 'user', content: 'first actual user message', timestamp: Date.now()});
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve}; };

async function fixture({disk = false, ui = false, seed, defaultAgent = 'main', noSelectable = false} = {}) {
  const sdk = await host('dist/index.js');
  const ai = await host('node_modules/@earendil-works/pi-ai/dist/index.js');
  const dir = await mkdtemp(join(tmpdir(), 'pi-main-template-lock-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = join(dir, 'agent');
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session;
  const errors = [], notifications = [], menus = [], requests = [], viewed = [];
  const f = {dir, agentDir, sdk, errors, notifications, menus, requests, viewed, choice: 'leaf'};
  async function closeSession() {
    if (session) {
      await session.extensionRunner.emit({type: 'session_shutdown', reason: 'quit'});
      session.dispose(); session = undefined;
    }
  }
  f.cleanup = async () => {
    await closeSession();
    previous === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, {recursive: true, force: true});
  };
  try {
    await mkdir(join(agentDir, 'agents'), {recursive: true});
    await writeFile(join(agentDir, 'agents/main.yaml'), 'name: main\nsubagents: {extra: [subagent], default: subagent}');
    await writeFile(join(agentDir, 'agents/subagent.yaml'), 'name: subagent');
    if (defaultAgent !== null) await writeFile(join(agentDir, 'subagents.json'), JSON.stringify({default_agent: defaultAgent}));
    await writeFile(join(agentDir, 'agents/leaf.yaml'), 'name: leaf\ntools: {include_defaults: false, extra: [read]}\nmodel: {name: parent}');
    await writeFile(join(agentDir, 'agents/hidden.yaml'), 'name: hidden\nselectable: false');
    if (noSelectable) for (const name of ['main', 'subagent', 'leaf']) {
      await writeFile(join(agentDir, 'agents', name + '.yaml'), 'name: ' + name + '\nselectable: false');
    }
    const settings = sdk.SettingsManager.inMemory();
    const runtime = await sdk.ModelRuntime.create({authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false});
    runtime.registerProvider('main-lock-test', {
      api: 'main-lock-test', apiKey: 'fake', baseUrl: 'http://unused.invalid',
      models: [{id: 'model', name: 'Model', reasoning: true, input: ['text'], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 32000, maxTokens: 1000}],
      streamSimple(model, context) {
        requests.push({context, locks: f.locks()});
        const stream = ai.createAssistantMessageEventStream();
        const output = {role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{type: 'text', text: 'answer'}], stopReason: 'pending', usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
        stream.push({type: 'start', partial: output});
        stream.push({type: 'text_start', contentIndex: 0, partial: output});
        stream.push({type: 'text_delta', contentIndex: 0, delta: 'answer', partial: output});
        stream.push({type: 'text_end', contentIndex: 0, content: 'answer', partial: output});
        output.stopReason = 'stop';
        stream.push({type: 'done', reason: 'stop', message: output}); stream.end();
        return stream;
      },
    });
    const model = runtime.getModelOfType('chat', 'main-lock-test', 'model');
    const loader = new sdk.DefaultResourceLoader({cwd: dir, agentDir, settingsManager: settings, noExtensions: true, additionalExtensionPaths: [join(__dirname, 'index.ts')], extensionFactories: [pi => {
      pi.events.on('ui:viewed-session:request:v1', request => request.reply({version: 1, available: true, setViewedSession(source) { viewed.push(source); return true; }, getViewedSession: () => undefined, onChange: () => () => {}}));
    }]});
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    f.manager = disk ? sdk.SessionManager.create(dir, join(dir, 'sessions')) : sdk.SessionManager.inMemory(dir);
    if (seed) await seed(f.manager);
    f.open = async manager => {
      await closeSession(); f.manager = manager;
      await loader.reload(); // A disposed SDK invalidates its extension factories/context.
      assert.deepEqual(loader.getExtensions().errors, []);
      ({session} = await sdk.createAgentSession({cwd: dir, agentDir, settingsManager: settings, resourceLoader: loader, sessionManager: manager, modelRuntime: runtime, model}));
      await session.bindExtensions({mode: ui ? 'tui' : 'print', ...(ui ? {uiContext: {setWidget() {}, notify: (message, type) => notifications.push({message, type}), select: async (title, options) => { menus.push({title, options}); return f.pick ? f.pick() : f.choice; }}} : {}), onError: error => errors.push(error)});
      assert.deepEqual(errors, []);
    };
    f.locks = () => f.manager.getEntries().filter(e => e.type === 'custom' && e.customType === LOCK).map(e => e.data);
    f.command = (args = '', ctx) => session.extensionRunner.getCommand('agent').handler(args, ctx ?? session.extensionRunner.createCommandContext());
    f.context = () => session.extensionRunner.createCommandContext();
    f.completions = prefix => session.extensionRunner.getCommand('agent').getArgumentCompletions(prefix);
    f.hasCommand = name => !!session.extensionRunner.getCommand(name);
    f.emit = event => session.extensionRunner.emit(event);
    f.prompt = text => session.prompt(text);
    f.reload = () => session.reload();
    f.tools = () => session.getActiveToolNames();
    f.template = async () => {
      const runner = session.extensionRunner;
      const result = await runner.getToolDefinition('list_agents').execute('lock-test', {all: true}, undefined, undefined, runner.createToolContext('lock-test'));
      return result.details.find(r => r.name === 'main').template;
    };
    f.emitUser = async () => {
      const message = user();
      await f.emit({type: 'message_start', message});
      f.manager.appendMessage(message);
      await f.emit({type: 'message_end', message});
    };
    await f.open(f.manager);
    return f;
  } catch (error) { await f.cleanup(); throw error; }
}

test('configured default selects a fresh session, but saved selection and locks win on reload', async () => {
  const f = await fixture({defaultAgent: 'hidden'});
  try {
    assert.equal(await f.template(), 'hidden'); // Explicit defaults need not be selectable.
    await f.command('leaf');
    await writeFile(join(f.agentDir, 'subagents.json'), JSON.stringify({default_agent: 'main'}));
    await f.reload(); assert.equal(await f.template(), 'leaf');
    await f.emitUser(); assertLocked(f);
    await writeFile(join(f.agentDir, 'subagents.json'), JSON.stringify({default_agent: 'hidden'}));
    await f.reload(); assert.equal(await f.template(), 'leaf'); assertLocked(f);
    f.manager.newSession(); await f.emit({type: 'session_start', reason: 'new'});
    assert.equal(await f.template(), 'hidden'); assert.deepEqual(f.locks(), []);
  } finally { await f.cleanup(); }
});

test('absent default selects the first selectable discovered template rather than main', async () => {
  const f = await fixture({defaultAgent: null});
  try {
    assert.equal(await f.template(), 'leaf');
    assert.deepEqual(f.errors, []);
  } finally { await f.cleanup(); }
});

test('unavailable configured default fails startup rather than silently falling back', async () => {
  await assert.rejects(fixture({defaultAgent: 'missing'}), /missing|unavailable/i);
});

test('without configured default, no selectable templates fails startup', async () => {
  await assert.rejects(fixture({defaultAgent: null, noSelectable: true}), /selectable/i);
});

test('saved identity selection wins over configured fresh-session default', async () => {
  const f = await fixture({defaultAgent: 'main', seed(manager) {
    manager.appendCustomEntry(IDENTITY, {version: 1, workspaceId: 'saved-workspace', instanceId: 'saved-main', name: 'main', template: 'hidden', role: 'interactive', parentName: null, rootSessionFile: manager.getSessionFile()});
  }});
  try { assert.equal(await f.template(), 'hidden'); assert.deepEqual(f.locks(), []); }
  finally { await f.cleanup(); }
});

function assertLocked(f, template = 'leaf') { assert.deepEqual(f.locks(), [{version: 1, template}]); }
const lockedError = error => error instanceof Error && /first user message/i.test(error.message) && /\/new/.test(error.message);

test('slash commands, custom state/context and system messages leave an empty session selectable', async () => {
  const f = await fixture({ui: true});
  try {
    await f.prompt('/agent leaf');
    f.manager.appendCustomEntry('test.state', {role: 'user'});
    f.manager.appendCustomMessageEntry('test.context', 'extension context', false);
    for (const message of [{role: 'system', content: 'system guidance', timestamp: 1}, {role: 'custom', customType: 'test.context', content: 'context', display: false, timestamp: 2}]) {
      await f.emit({type: 'message_start', message});
      f.manager.appendMessage(message);
      await f.emit({type: 'message_end', message});
    }
    await f.reload();
    await f.prompt('/agent main');
    f.choice = undefined; await f.command(); // Cancel does not lock or change selection.
    assert.equal(await f.template(), 'main');
    f.choice = 'leaf'; await f.command();
    assert.equal(await f.template(), 'leaf');
    assert.deepEqual(f.locks(), []); assert.equal(f.requests.length, 0);
    assert.equal(f.menus.length, 2); assert.deepEqual(f.errors, []);
  } finally { await f.cleanup(); }
});

test('selectable only filters the template picker/completions; viewer command is renamed', async () => {
  const f = await fixture({ui: true});
  try {
    assert.equal(f.hasCommand('agents'), false);
    assert.equal(f.hasCommand('subagents'), true);
    assert.equal(f.completions('').some(item => item.value === 'hidden'), false);
    assert.ok(f.completions('le').some(item => item.value === 'leaf'));
    f.choice = undefined;
    await f.command();
    assert.equal(f.menus.at(-1).options.includes('hidden'), false);
    assert.ok(f.menus.at(-1).options.includes('leaf'));
    await f.command('hidden');
    assert.equal(await f.template(), 'hidden');
    await f.reload();
    assert.equal(await f.template(), 'hidden');
    await f.prompt('/subagents main');
    assert.equal(f.viewed.at(-1), undefined);
    assert.deepEqual(f.errors, []);
  } finally { await f.cleanup(); }
});

test('first real prompt durably locks selected template before the provider runs; no UI rejects', async () => {
  const f = await fixture({disk: true});
  try {
    await f.prompt('/agent leaf');
    await f.prompt('first actual prompt');
    assertLocked(f); assert.deepEqual(f.requests[0].locks, [{version: 1, template: 'leaf'}]);
    assert.equal(f.requests.length, 1);
    const file = f.manager.getSessionFile();
    assert.match(await readFile(file, 'utf8'), /subagents\.main-template-lock\.v1/);
    const before = f.manager.getEntries();
    await assert.rejects(f.command('main'), lockedError);
    assert.deepEqual(f.manager.getEntries(), before); assert.equal(await f.template(), 'leaf');
    await f.prompt('/agent main'); // SDK reports command errors rather than rejecting prompt().
    assert.equal(f.errors.length, 1); assert.match(f.errors.pop().error, /first user message.*\/new/i);
    await f.prompt('second prompt'); assertLocked(f);
    await f.open(f.sdk.SessionManager.open(file));
    assertLocked(f); assert.equal(await f.template(), 'leaf');
    await f.reload(); assertLocked(f); assert.equal(await f.template(), 'leaf');
    assert.equal(f.requests.length, 2);
  } finally { await f.cleanup(); }
});

test('locked UI commands warn without picker or mutation; native /subagents viewer still works', async () => {
  const f = await fixture({ui: true});
  try {
    await f.command('leaf'); await f.emitUser(); assertLocked(f);
    const before = f.manager.getEntries(), tools = f.tools();
    for (const args of ['', 'main', 'unknown']) await f.command(args);
    assert.equal(f.menus.length, 0); assert.equal(f.notifications.length, 3);
    for (const notice of f.notifications) { assert.equal(notice.type, 'warning'); assert.match(notice.message, /first user message.*\/new/i); }
    assert.deepEqual(f.manager.getEntries(), before); assert.deepEqual(f.tools(), tools);
    assert.equal(await f.template(), 'leaf'); assert.deepEqual(f.errors, []);
    f.choice = 'main'; await f.prompt('/subagents');
    assert.equal(f.menus.length, 1); assert.deepEqual(f.menus[0].options, ['main']);
    assert.equal(f.viewed.length, 1); assert.equal(f.viewed[0], undefined);
    assert.deepEqual(f.manager.getEntries(), before);
  } finally { await f.cleanup(); }
});

test('tree backtracking and reload use all-entry lock, overriding an earlier branch selection', async () => {
  const f = await fixture();
  try {
    await f.command('main'); const earlier = f.manager.getLeafId();
    await f.command('leaf'); await f.emitUser(); assertLocked(f);
    f.manager.branch(earlier);
    assert.equal(f.manager.getBranch().some(e => e.type === 'custom' && e.customType === LOCK), false);
    await f.emit({type: 'session_tree'});
    assert.equal(await f.template(), 'leaf'); assertLocked(f);
    await f.reload(); assert.equal(await f.template(), 'leaf'); assertLocked(f);
    await assert.rejects(f.command('main'), lockedError);
    f.manager.resetLeaf(); await f.emit({type: 'session_tree'});
    assert.equal(await f.template(), 'leaf'); assertLocked(f);
    await assert.rejects(f.command('main'), lockedError);
    assert.equal(f.requests.length, 0);
  } finally { await f.cleanup(); }
});

test('existing user history on an abandoned branch migrates the current chosen template once at startup', async () => {
  const f = await fixture({disk: true, seed(manager) {
    const selected = manager.appendCustomEntry(TEMPLATE, {template: 'leaf'});
    manager.appendMessage(user());
    manager.branch(selected);
    manager.appendCustomEntry('test.resume-position', {}); // Persist the older active branch.
  }});
  try {
    assert.equal(f.manager.getBranch().some(e => e.type === 'message' && e.message.role === 'user'), false);
    assertLocked(f); assert.equal(await f.template(), 'leaf');
    const file = f.manager.getSessionFile();
    assert.match(await readFile(file, 'utf8'), /subagents\.main-template-lock\.v1/);
    await f.open(f.sdk.SessionManager.open(file));
    assertLocked(f); await assert.rejects(f.command('main'), lockedError);
  } finally { await f.cleanup(); }
});

test('compacted old user history is migrated even when projection has no user messages', async () => {
  const f = await fixture({seed(manager) {
    manager.appendCustomEntry(TEMPLATE, {template: 'leaf'}); manager.appendMessage(user());
    manager.appendCompaction('summary only', null, 1000);
    assert.equal(manager.buildSessionProjection().messages.some(m => m.role === 'user'), false);
  }});
  try { assertLocked(f); await f.reload(); assertLocked(f); await assert.rejects(f.command('main'), lockedError); }
  finally { await f.cleanup(); }
});

test('history-bearing and marker-only forks inherit locks; genuinely new empty sessions unlock', async () => {
  const f = await fixture();
  try {
    await f.command('leaf');
    const message = user(); await f.emit({type: 'message_start', message});
    assertLocked(f); // Lock must exist before user persistence, so a picker cannot race it.
    const marker = f.manager.getEntries().find(e => e.type === 'custom' && e.customType === LOCK);
    f.manager.appendMessage(message); await f.emit({type: 'message_end', message});
    const oldWorkspace = f.manager.getBranch().filter(e => e.type === 'custom' && e.customType === IDENTITY).at(-1).data.workspaceId;
    f.manager.createBranchedSession(f.manager.getLeafId()); await f.emit({type: 'session_start', reason: 'fork'});
    assertLocked(f); assert.equal(await f.template(), 'leaf');
    const forkWorkspace = f.manager.getBranch().filter(e => e.type === 'custom' && e.customType === IDENTITY).at(-1).data.workspaceId;
    assert.notEqual(forkWorkspace, oldWorkspace);
    f.manager.createBranchedSession(marker.id); await f.emit({type: 'session_start', reason: 'fork'});
    assert.equal(f.manager.getEntries().some(e => e.type === 'message' && e.message.role === 'user'), false);
    assertLocked(f); await assert.rejects(f.command('main'), lockedError);
    f.manager.newSession(); await f.emit({type: 'session_start', reason: 'new'});
    assert.deepEqual(f.locks(), []); assert.equal(await f.template(), 'main');
    await f.command('leaf'); assert.equal(await f.template(), 'leaf'); assert.deepEqual(f.locks(), []);
  } finally { await f.cleanup(); }
});

test('picker resolved after user message warns and cannot change the newly locked template', async () => {
  const f = await fixture({ui: true});
  const picked = deferred(), opened = deferred();
  try {
    f.pick = () => { opened.resolve(); return picked.promise; };
    const pending = f.command(); await opened.promise;
    await f.emitUser(); assertLocked(f, 'main');
    const before = f.manager.getEntries(); picked.resolve('leaf'); await pending;
    assert.equal(await f.template(), 'main'); assert.deepEqual(f.manager.getEntries(), before);
    assert.equal(f.notifications.at(-1).type, 'warning'); assert.deepEqual(f.errors, []);
  } finally { picked.resolve(); await f.cleanup(); }
});

test('picker rechecks idle state and workspace after awaiting native selection', async () => {
  const f = await fixture({ui: true});
  try {
    let idle = true;
    const context = f.context(); context.isIdle = () => idle;
    let picked = deferred(), opened = deferred();
    f.pick = () => { opened.resolve(); return picked.promise; };
    let pending = f.command('', context); await opened.promise;
    idle = false; const before = f.manager.getEntries(); picked.resolve('leaf'); await pending;
    assert.equal(await f.template(), 'main'); assert.deepEqual(f.manager.getEntries(), before);
    assert.equal(f.notifications.at(-1).type, 'warning');
    picked = deferred(); opened = deferred();
    f.pick = () => { opened.resolve(); return picked.promise; };
    pending = f.command(); await opened.promise;
    await f.emit({type: 'session_start', reason: 'reload'}); // Same SDK, replaced workspace.
    const restarted = f.manager.getEntries(); picked.resolve('leaf'); await pending;
    assert.equal(await f.template(), 'main'); assert.deepEqual(f.manager.getEntries(), restarted);
    assert.deepEqual(f.locks(), []); assert.equal(f.requests.length, 0); assert.deepEqual(f.errors, []);
  } finally { await f.cleanup(); }
});
