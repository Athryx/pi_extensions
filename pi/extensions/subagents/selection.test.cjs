const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, mkdir, writeFile, rm} = require('node:fs/promises');
const {join} = require('node:path');
const {tmpdir} = require('node:os');
const {load, host} = require('./test-helper.cjs');

async function fixture() {
  const {AgentViewSelection} = await load('selection.ts');
  const {VIEWED_SESSION_REQUEST} = await load('../shared/viewed-session.ts');
  const listeners = new Set(), changes = new Set(), calls = [], menus = [];
  let source, unsubscribe;
  const api = {
    version: 1, available: true,
    setViewedSession(next) {
      calls.push(next); unsubscribe?.(); source = next;
      unsubscribe = next?.subscribe(() => {});
      for (const listener of changes) listener(api.getViewedSession());
      return true;
    },
    getViewedSession: () => source && ({id: source.id, title: source.title}),
    onChange: listener => { changes.add(listener); return () => changes.delete(listener); },
  };
  const pi = {events: {on: () => () => {}, emit: (event, request) => {
    assert.equal(event, VIEWED_SESSION_REQUEST);
    if (f.service) request.reply(f.service);
  }}};
  const record = name => ({identity: {instanceId: 'id-' + name, name}, status: 'idle', messages: []});
  const workspace = {
    closed: false,
    records: new Map(['main', 'active', 'idle'].map(name => [name, record(name)])),
    get(name) { const record = this.records.get(name); if (!record) throw new Error('Unknown agent: ' + name); return record; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  workspace.get('active').status = 'running';
  const ctx = {mode: 'tui', ui: {select: async (title, options) => {menus.push({title, options}); return f.choice; }}};
  const f = {selection: new AgentViewSelection(pi), pi, api, service: api, workspace, ctx, calls, menus, listeners, choice: 'idle', get source() { return source; }};
  return f;
}

test('native selection includes idle agents, direct names skip picker, and main restores', async () => {
  const f = await fixture();
  assert.equal(await f.selection.select(f.workspace, '', f.ctx), true);
  assert.deepEqual(f.menus[0].options, ['main', 'active', 'idle']);
  assert.deepEqual(f.api.getViewedSession(), {id: 'id-idle', title: 'idle'});
  assert.equal(f.listeners.size, 1);
  assert.equal(await f.selection.select(f.workspace, ' active ', f.ctx), true);
  assert.equal(f.menus.length, 1);
  assert.equal(f.source.title, 'active');
  assert.equal(f.listeners.size, 1);
  assert.equal(await f.selection.select(f.workspace, 'main', f.ctx), true);
  assert.equal(f.api.getViewedSession(), undefined);
  assert.equal(f.listeners.size, 0);
  f.selection.clear();
  assert.equal(f.calls.length, 3);
});

test('cycling wraps both ways through main and idle workers, following external restoration', async () => {
  const f = await fixture();
  assert.equal(await f.selection.cycle(f.workspace, -1, f.ctx), true);
  assert.equal(f.source.title, 'idle');
  await f.selection.cycle(f.workspace, 1, f.ctx);
  assert.equal(f.source, undefined);
  await f.selection.cycle(f.workspace, 1, f.ctx);
  assert.equal(f.source.title, 'active');
  await f.selection.cycle(f.workspace, 1, f.ctx);
  assert.equal(f.source.title, 'idle');
  f.api.setViewedSession(undefined); // Escape restores main through the UI.
  await f.selection.cycle(f.workspace, 1, f.ctx);
  assert.equal(f.source.title, 'active');
  assert.equal(f.menus.length, 0);
  f.service = undefined;
  assert.equal(await f.selection.cycle(f.workspace, 1, f.ctx), false);
  assert.equal(await f.selection.cycle(f.workspace, 1, {...f.ctx, mode: 'rpc'}), false);
  f.selection.clear();
});

test('sources read current messages/session/settings/tool snapshots after idle resume', async () => {
  const f = await fixture(), record = f.workspace.get('idle');
  await f.selection.select(f.workspace, 'idle', f.ctx);
  const source = f.source;
  assert.equal(source.getSnapshot().session, undefined);
  const messages = [{role: 'user', content: 'new output', timestamp: 1}];
  const session = {}, manager = {}, settings = {}, toolUpdates = new Map();
  Object.assign(record, {messages, session, manager, settings, toolUpdates});
  assert.deepEqual(source.getSnapshot(), {messages, session, manager, settings, toolUpdates});
  let changed = 0;
  const unsubscribe = source.subscribe(() => changed++);
  for (const listener of f.listeners) listener();
  assert.equal(changed, 1);
  unsubscribe();
  record.session = {};
  assert.equal(source.getSnapshot().session, record.session);
  f.selection.clear();
  assert.equal(f.listeners.size, 0);
});

test('cancel leaves selection intact; closed picker results cannot view stale workspaces', async () => {
  const f = await fixture();
  await f.selection.select(f.workspace, 'active', f.ctx);
  f.choice = undefined;
  assert.equal(await f.selection.select(f.workspace, '', f.ctx), true);
  assert.equal(f.calls.length, 1);
  f.ctx.ui.select = async () => { f.workspace.closed = true; return 'idle'; };
  assert.equal(await f.selection.select(f.workspace, '', f.ctx), true);
  assert.equal(f.calls.length, 1);
  f.selection.clear();
});

test('missing, incompatible, unavailable and rejected services request overlay fallback', async () => {
  const f = await fixture();
  for (const service of [undefined, {...f.api, version: 2}, {...f.api, available: false}]) {
    f.service = service;
    assert.equal(await f.selection.select(f.workspace, '', f.ctx), false);
  }
  f.service = {...f.api, setViewedSession: () => false};
  assert.equal(await f.selection.select(f.workspace, 'idle', f.ctx), false);
  assert.equal(await f.selection.select(f.workspace, 'main', f.ctx), false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.menus.length, 0);
  f.service = f.api;
  assert.equal(await f.selection.select(f.workspace, 'idle', {...f.ctx, mode: 'rpc'}), false);
  await assert.rejects(f.selection.select(f.workspace, 'unknown', f.ctx), /Unknown agent/);
});

test('cleanup is idempotent and does not clear a different provider-owned view', async () => {
  const f = await fixture();
  await f.selection.select(f.workspace, 'idle', f.ctx);
  f.api.setViewedSession({id: 'other', title: 'other', subscribe: () => () => {}});
  f.selection.clear(); f.selection.clear();
  assert.equal(f.api.getViewedSession().id, 'other');
  assert.equal(f.calls.length, 2);
});

test('root command wiring keeps non-TUI output, overlay fallback and lifecycle cleanup', async () => {
  const sdk = await host('dist/index.js');
  const {default: install} = await load('index.ts');
  const f = await fixture();
  const dir = await mkdtemp(join(tmpdir(), 'pi-agent-selection-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(dir, 'agent');
  // Templates are external resources, so supply explicit test definitions.
  await mkdir(join(dir, 'agent/agents'), {recursive: true});
  await writeFile(join(dir, 'agent/agents/main.yaml'), 'name: main\nsubagents: {allowed: [subagent], default: subagent}\n');
  await writeFile(join(dir, 'agent/agents/subagent.yaml'), 'name: subagent\n');
  const manager = sdk.SessionManager.inMemory(dir);
  const identity = {version: 1, workspaceId: 'workspace', instanceId: 'root', name: 'main', template: 'main', role: 'interactive', parentName: null};
  manager.appendCustomEntry('subagents.identity.v1', identity);
  manager.appendCustomEntry('subagents.member.v1', {
    identity: {...identity, instanceId: 'worker', name: 'worker', template: 'subagent', role: 'worker', parentName: 'main'},
    template: {name: 'subagent', model: {name: 'parent', thinking: 'parent'}, tools: {include_defaults: true, extra: []}, skills: {include_defaults: true, extra_paths: []}, prompt: '', subagents: {allowed: []}, source: 'test'},
  });
  const handlers = new Map(), commands = new Map(), shortcuts = new Map(), tools = new Map(), sent = [], notices = [], eventHandlers = new Map();
  let overlays = 0;
  const pi = {
    ...f.pi,
    events: {
      on: (event, handler) => {eventHandlers.set(event, handler); return () => eventHandlers.delete(event);},
      emit: (event, request) => eventHandlers.has(event) ? eventHandlers.get(event)(request) : f.pi.events.emit(event, request),
    },
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerShortcut: (key, shortcut) => shortcuts.set(key, shortcut),
    registerTool: tool => tools.set(tool.name, tool),
    getAllTools: () => ['read', 'bash', 'edit', 'write'].map(name => ({name})).concat([...tools.values()]),
    getActiveTools: () => ['read', 'bash', 'edit', 'write'], setActiveTools() {},
    appendEntry: (type, data) => manager.appendCustomEntry(type, data),
    sendMessage: (...args) => sent.push(args),
  };
  const ctx = {cwd: dir, mode: 'tui', hasUI: true, sessionManager: manager, isProjectTrusted: () => false, isIdle: () => true,
    ui: {...f.ctx.ui, setWidget() {}, custom: async () => {overlays++;}, notify: (...args) => notices.push(args)},
  };
  install(pi);
  try {
    await handlers.get('session_start')({reason: 'new'}, ctx);
    assert.deepEqual([...shortcuts.keys()], ['alt+]', 'alt+[']);
    await shortcuts.get('alt+]').handler(ctx);
    assert.equal(f.source.title, 'worker');
    await shortcuts.get('alt+[').handler(ctx);
    assert.equal(f.source, undefined);
    const command = commands.get('subagents');
    assert.ok(command.getArgumentCompletions('wo').some(item => item.value === 'worker'));
    await command.handler('worker', ctx);
    assert.equal(f.source.title, 'worker');
    assert.equal(overlays, 0);
    const {requestWorkflowAgentsAPI} = await load('../shared/workflow-agents.ts');
    const capability = requestWorkflowAgentsAPI(pi);
    assert.equal(capability.version, 1);
    const run = capability.openRun({sourcePath: join(dir, 'demo.js'), signal: new AbortController().signal});
    const groupCommand = commands.get('groups');
    const groupItems = groupCommand.getArgumentCompletions('');
    assert.ok(groupItems.some(item => item.value === 'root'));
    const workflowGroup = groupItems.find(item => /Workflow: demo/.test(item.label));
    assert.ok(workflowGroup);
    await groupCommand.handler(workflowGroup.value, ctx);
    assert.match(f.source.getSnapshot().messages[0].content, /No agents/);
    assert.deepEqual(command.getArgumentCompletions(''), []);
    await assert.rejects(command.handler('worker', ctx), /\/groups/);
    await groupCommand.handler('root', ctx);
    assert.equal(f.source.title, 'worker'); // Root group remembers its last member.
    await command.handler('main', ctx);
    assert.equal(f.source, undefined);
    assert.ok(command.getArgumentCompletions('wo').some(item => item.value === 'worker'));
    await groupCommand.handler('', {...ctx, mode: 'json', hasUI: false});
    assert.equal(sent.at(-1)[0].customType, 'subagents.groups.v1');
    assert.match(sent.at(-1)[0].content, /Workflow: demo/);
    await run.close();
    await handlers.get('session_start')({reason: 'reload'}, ctx);
    assert.equal(f.source, undefined);
    await command.handler('worker', ctx);
    await handlers.get('session_tree')({}, ctx);
    assert.equal(f.source, undefined);
    await command.handler('worker', ctx);
    await command.handler('ignored', {...ctx, mode: 'rpc'});
    assert.match(notices.at(-1)[0], /worker/);
    await command.handler('ignored', {...ctx, mode: 'json', hasUI: false});
    assert.equal(sent.at(-1)[0].customType, 'subagents.list.v1');
    assert.deepEqual(sent.at(-1)[1], {triggerTurn: false});
    const write = process.stdout.write;
    let printed = '';
    try {
      process.stdout.write = chunk => { printed += chunk; return true; };
      await command.handler('ignored', {...ctx, mode: 'print', hasUI: false});
    } finally { process.stdout.write = write; }
    assert.ok(JSON.parse(printed).some(agent => agent.name === 'worker'));
    assert.equal(f.source.title, 'worker');
    f.service = undefined;
    await command.handler('', ctx);
    assert.equal(overlays, 1);
    f.service = {...f.api, version: 2};
    await command.handler('', ctx);
    assert.equal(overlays, 2);
    await handlers.get('session_shutdown')({}, ctx);
    assert.equal(f.source, undefined);
    assert.equal(f.listeners.size, 0);
    f.service = f.api;
    await handlers.get('session_start')({reason: 'reload'}, ctx);
    await command.handler('worker', ctx);
    await handlers.get('session_start')({reason: 'fork'}, ctx);
    assert.equal(f.source, undefined);
  } finally {
    await handlers.get('session_shutdown')({}, ctx);
    previous === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, {recursive: true, force: true});
  }
});
