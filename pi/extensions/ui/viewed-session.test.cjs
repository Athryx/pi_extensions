const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { load, host } = require('../subagents/test-helper.cjs');

const cwd = resolve(__dirname, '../../..');
const ready = (async () => {
  const tui = await host('node_modules/@earendil-works/pi-tui/dist/index.js');
  const themes = await host('dist/modes/interactive/theme/theme.js');
  themes.initTheme('dark');
  const editor = await host('dist/modes/interactive/components/custom-editor.js');
  const bindings = await host('dist/core/keybindings.js');
  const tools = await host('dist/modes/interactive/components/tool-execution.js');
  const viewport = await host('dist/modes/interactive/chat-viewport.js');
  const loader = await host('dist/core/extensions/loader.js');
  const bus = await host('dist/core/event-bus.js');
  const shared = await load('../shared/viewed-session.ts');
  return { ...tui, ...themes, ...editor, ...bindings, ...tools, ...viewport, ...loader, ...bus, ...shared };
})();
const plain = lines => lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
const text = value => ({ type: 'text', text: value });
const user = value => ({ role: 'user', content: [text(value)], timestamp: 1 });
const assistant = (content, stopReason = 'stop') => ({
  role: 'assistant', content, api: 'openai-completions', provider: 'openai', model: 'test',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason, timestamp: 2,
});
const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
const result = (id, name, value, extra = {}) => ({
  role: 'toolResult', toolCallId: id, toolName: name, content: [text(value)], isError: false, timestamp: 3, ...extra,
});
function source(id, snapshot = { messages: [] }) {
  const listeners = new Set();
  let subscribes = 0, unsubscribes = 0;
  return {
    id, title: `Worker ${id}`,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      subscribes++;
      listeners.add(listener);
      let active = true;
      return () => { if (active) { active = false; unsubscribes++; listeners.delete(listener); } };
    },
    update(next) { snapshot = next; for (const listener of [...listeners]) listener(); },
    counts: () => ({ subscribes, unsubscribes, listeners: listeners.size }),
  };
}
function nativeTool(api, tui, id, name, args) {
  const row = new api.ToolExecutionComponent(name, id, args, { showImages: false }, undefined, tui, cwd);
  row.setArgsComplete();
  row.markExecutionStarted();
  row.updateResult({ content: [text('main-only result')], details: undefined, isError: false });
  return row;
}
async function fixture({ fullscreen = false, malformed = false, mode = 'tui' } = {}) {
  const api = await ready;
  const Renderer = fullscreen ? api.TuiAltScreen : api.TuiMainScreen;
  const writes = [];
  const tui = new Renderer({
    rows: 40, columns: 100, write: data => writes.push(data),
    hideCursor() {}, showCursor() {}, moveBy() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, stop() {},
  }, false);
  tui.stopped = true; // No terminal I/O, timers, signals, model or agent is started.
  const roots = Array.from({ length: 7 }, () => new api.Container());
  const [document, pendingMessages, status, widgetsAbove, editorContainer, widgetsBelow, footer] = roots;
  const header = new api.Container(), resources = new api.Container(), mainChat = new api.Container();
  header.addChild(new api.Text('MAIN HEADER', 0, 0));
  mainChat.addChild(new api.Text('MAIN TRANSCRIPT', 0, 0));
  const mainTool = nativeTool(api, tui, 'same-id', 'read', { path: 'main.ts' });
  mainChat.addChild(mainTool);
  let mainDisposals = 0;
  mainChat.dispose = () => { mainDisposals++; };
  mainTool.dispose = () => { mainDisposals++; };
  document.addChild(header); document.addChild(resources); document.addChild(mainChat);
  const kb = new api.KeybindingsManager({ 'app.session.new': 'ctrl+n', 'app.session.tree': 'ctrl+t' });
  api.setKeybindings(kb);
  const editor = new api.CustomEditor(tui, api.getEditorTheme(), kb);
  const actions = [];
  for (const action of ['app.tools.expand', 'app.clear', 'app.interrupt', 'app.model.cycleForward', 'app.session.new', 'app.session.tree']) {
    editor.onAction(action, () => actions.push(action));
  }
  const submitted = [];
  editor.onSubmit = value => submitted.push(value);
  editor.addToHistory('main prompt history');
  editor.setText('main draft');
  editorContainer.addChild(editor);
  footer.addChild(new api.Text('MAIN FOOTER', 0, 0));
  for (const root of roots) tui.addChild(root);
  const viewport = api.createChatViewport({ document, pendingMessages, status, widgetsAbove, editor: editorContainer, widgetsBelow, footer });
  if (fullscreen) tui.setLayoutRoot(viewport.root);
  tui.setFocus(editor);
  if (malformed) document.children.pop();
  const events = api.createEventBus();
  const { extensions, errors, runtime } = await api.loadExtensions([join(__dirname, 'index.ts')], cwd, events);
  assert.deepEqual(errors, []);
  const extension = extensions[0];
  const entries = [], notices = [];
  runtime.appendEntry = (customType, data) => entries.push({ type: 'custom', customType, data });
  let widget, expanded = false;
  const ctx = {
    mode, hasUI: mode === 'tui', cwd,
    sessionManager: { getBranch: () => entries, getCwd: () => cwd },
    ui: {
      theme: api.theme,
      getEditorText: () => editor.getText(),
      getToolsExpanded: () => expanded,
      setToolsExpanded: value => { expanded = value; mainTool.setExpanded(value); },
      setWidget: (_key, factory) => {
        widget?.dispose();
        widgetsBelow.clear();
        widget = factory(tui);
        widgetsBelow.addChild(widget);
      },
      onTerminalInput: handler => tui.addInputListener(handler),
      setStatus() {}, notify: (...args) => notices.push(args),
    },
  };
  const emit = async (name, event = {}) => {
    for (const handler of extension.handlers.get(name) ?? []) await handler(event, ctx);
  };
  await emit('session_start');
  const service = () => api.requestViewedSessionAPI({ events });
  return {
    api, tui, roots, document, mainChat, mainTool, editor, footer, viewport,
    events, ctx, entries, notices, actions, submitted, service, emit,
    render: () => plain(document.children[2].render(100)),
    command: args => extension.commands.get('ui').handler(args, ctx),
    press: data => tui.handleTerminalInput(data),
    dispose: () => widget?.dispose(),
    mainDisposals: () => mainDisposals,
  };
}

function toolRows(chat) {
  const rows = [];
  const visit = component => {
    if (typeof component.toolCallId === 'string') rows.push(component);
    else for (const child of component.children ?? []) visit(child);
  };
  visit(chat);
  return rows;
}

test('viewed banner caches complete lines and follows title, width, mode and warning changes', async () => {
  const f = await fixture();
  const live = source('banner', { messages: [user('Viewed text')] });
  try {
    f.service().setViewedSession(live);
    const banner = f.document.children[2].children[0];
    const first = banner.render(100);
    assert.equal(banner.render(100), first);
    assert.notEqual(banner.render(30), first);
    live.title = 'Renamed worker';
    assert.match(plain(banner.render(100)), /Renamed worker/);
    live.kind = 'group';
    assert.match(plain(banner.render(100)), /^\s*Group: Renamed worker/);
    assert.equal(banner.render(100), banner.render(100));
    live.kind = 'agent';
    assert.match(plain(banner.render(100)), /^\s*Agent: Renamed worker/);
    await f.command('compact-code');
    assert.match(plain(banner.render(100)), /tools: compact-code/);
    f.editor.setText('blocked submission'); f.press('\r');
    assert.match(plain(banner.render(100)), /Agent view is read-only/);
    const warning = banner.render(100); assert.equal(banner.render(100), warning);
  } finally { f.dispose(); }
});

test('discovery is synchronous, versioned, and optional', async () => {
  const api = await ready;
  const events = api.createEventBus();
  const pi = { events };
  assert.equal(api.requestViewedSessionAPI(pi), undefined);
  const service = { version: 1, available: false, setViewedSession: () => false, getViewedSession: () => undefined, onChange: () => () => {} };
  const off = events.on(api.VIEWED_SESSION_REQUEST, request => request.reply(service));
  assert.equal(api.requestViewedSessionAPI(pi), service);
  off();
  const offWrong = events.on(api.VIEWED_SESSION_REQUEST, request => request.reply({ version: 2 }));
  assert.equal(api.requestViewedSessionAPI(pi), undefined);
  offWrong();
  const offMalformed = events.on(api.VIEWED_SESSION_REQUEST, request => request.reply({ version: 1, available: true }));
  assert.equal(api.requestViewedSessionAPI(pi), undefined, 'version alone does not establish the callable API contract');
  offMalformed();
  events.on(api.VIEWED_SESSION_REQUEST, async request => { await Promise.resolve(); request.reply(service); });
  assert.equal(api.requestViewedSessionAPI(pi), undefined, 'late replies cannot satisfy synchronous discovery');
});

for (const fullscreen of [false, true]) {
  test(`native ${fullscreen ? 'fullscreen viewport' : 'regular'} layout swaps only chat and restores the live main tree`, async () => {
    const f = await fixture({ fullscreen });
    const mainChildren = [...f.mainChat.children];
    const history = [...f.editor.history];
    const roots = [...f.tui.children];
    const docChildren = [...f.document.children];
    const mainRender = f.render();
    const sourceA = source('idle', { messages: [user('STORED USER'), assistant([text('STORED ANSWER')])] });
    const api = f.service();
    assert.equal(api.version, 1);
    assert.equal(api.available, true);
    const changes = [];
    const off = api.onChange(info => changes.push(info));
    try {
      assert.equal(api.setViewedSession(sourceA), true);
      assert.deepEqual(api.getViewedSession(), { id: 'idle', title: 'Worker idle' });
      assert.notEqual(f.document.children[2], f.mainChat);
      assert.deepEqual(f.tui.children, roots);
      assert.deepEqual(f.document.children.slice(0, 2), docChildren.slice(0, 2));
      assert.equal(f.tui.getFocusedComponent(), f.editor);
      assert.match(f.render(), /STORED USER/);
      assert.match(f.render(), /STORED ANSWER/);
      assert.doesNotMatch(f.render(), /MAIN TRANSCRIPT|main-only result/);
      if (fullscreen) {
        // This is the installed host's actual ScrollView/VStack tree, not a mock layout.
        assert.equal(f.viewport.transcript.child, f.document);
        f.tui.renderNow();
      }
      f.mainChat.addChild(new f.api.Text('MAIN KEPT STREAMING', 0, 0));
      sourceA.update({ messages: [assistant([text('VIEW KEPT STREAMING')])] });
      assert.match(f.render(), /VIEW KEPT STREAMING/);
      assert.doesNotMatch(f.render(), /MAIN KEPT STREAMING/);
      assert.deepEqual(f.editor.history, history);
      assert.equal(f.editor.getText(), 'main draft');
      assert.equal(f.entries.length, 0, 'opening a view does not persist transcript or UI preferences');
      assert.equal(f.mainDisposals(), 0);
      assert.equal(api.setViewedSession(undefined), true);
      assert.equal(api.getViewedSession(), undefined);
      assert.equal(f.document.children[2], f.mainChat);
      assert.deepEqual(f.mainChat.children.slice(0, mainChildren.length), mainChildren);
      assert.ok(f.render().startsWith(mainRender));
      assert.match(f.render(), /MAIN KEPT STREAMING/);
      assert.deepEqual(sourceA.counts(), { subscribes: 1, unsubscribes: 1, listeners: 0 });
      assert.deepEqual(changes, [{ id: 'idle', title: 'Worker idle' }, undefined]);
      assert.equal(f.mainDisposals(), 0);
      off();
      api.setViewedSession(source('silent'));
      assert.equal(changes.length, 2, 'onChange unsubscribe is effective');
    } finally { off(); f.dispose(); }
  });
}

test('unsupported layouts and non-TUI modes decline without subscribing or mutating children', async () => {
  for (const options of [{ malformed: true }, { mode: 'rpc' }, { mode: 'json' }, { mode: 'print' }]) {
    const f = await fixture(options);
    try {
      const before = [...f.document.children];
      const stored = source('unsupported');
      const api = f.service();
      assert.ok(api, 'provider can be discovered even when native view is unavailable');
      assert.equal(api.available, false);
      assert.equal(api.setViewedSession(stored), false);
      assert.deepEqual(f.document.children, before);
      assert.equal(api.getViewedSession(), undefined);
      assert.deepEqual(stored.counts(), { subscribes: 0, unsubscribes: 0, listeners: 0 });
    } finally { f.dispose(); }
  }
});

test('an externally overwritten active tree is unavailable and cleanup never overwrites its replacement', async () => {
  const f = await fixture();
  const active = source('active'), rejected = source('rejected');
  try {
    const api = f.service();
    api.setViewedSession(active);
    const replacement = new f.api.Container();
    replacement.addChild(new f.api.Text('OTHER EXTENSION TREE', 0, 0));
    f.document.children[2] = replacement;
    assert.equal(api.available, false);
    assert.equal(api.setViewedSession(rejected), false);
    assert.equal(f.document.children[2], replacement);
    assert.deepEqual(rejected.counts(), { subscribes: 0, unsubscribes: 0, listeners: 0 });
    api.setViewedSession(undefined);
    assert.equal(f.document.children[2], replacement, 'restore only touches its own mounted view');
    assert.equal(active.counts().unsubscribes, 1);
    assert.equal(api.getViewedSession(), undefined);
  } finally { f.dispose(); }
});

test('source replacement, reload widget disposal, session restart, and shutdown unsubscribe exactly once', async () => {
  const f = await fixture();
  const a = source('a'), b = source('b'), c = source('c'), d = source('d');
  try {
    const api = f.service();
    const changes = [];
    api.onChange(info => changes.push(info));
    api.setViewedSession(a);
    api.setViewedSession(b);
    assert.equal(a.counts().unsubscribes, 1);
    assert.equal(b.counts().listeners, 1);
    a.update({ messages: [user('STALE A')] });
    assert.doesNotMatch(f.render(), /STALE A/);
    f.dispose(); // Pi's reload/resetExtensionUI boundary.
    f.dispose();
    assert.equal(b.counts().unsubscribes, 1);
    assert.equal(f.document.children[2], f.mainChat);
    assert.equal(api.getViewedSession(), undefined);
    assert.equal(changes.at(-1), undefined);
    assert.equal(api.setViewedSession(c), false, 'a disposed controller cannot attach a source');
    await f.emit('session_start');
    const restarted = f.service();
    assert.equal(restarted.available, true);
    assert.equal(restarted.setViewedSession(c), true);
    await f.emit('session_start');
    assert.equal(c.counts().unsubscribes, 1);
    assert.equal(f.service().setViewedSession(d), true);
    await f.emit('session_shutdown');
    await f.emit('session_shutdown');
    assert.equal(d.counts().unsubscribes, 1);
    assert.equal(f.document.children[2], f.mainChat);
    assert.equal(f.mainDisposals(), 0);
  } finally { f.dispose(); }
});

test('disposal rejects onChange reentry before broadcasting restoration on reload/shutdown', async () => {
  for (const shutdown of [false, true]) {
    const f = await fixture();
    const active = source('disposing'), replacement = source('reentrant');
    const attempts = [];
    let off;
    try {
      const api = f.service();
      api.setViewedSession(active);
      off = api.onChange(info => {
        if (info === undefined) attempts.push(api.setViewedSession(replacement));
      });
      if (shutdown) await f.emit('session_shutdown');
      else f.dispose(); // Reload's widget disposal boundary.
      assert.deepEqual(attempts, [false], 'observer cannot reinstall a view while its owner is disposing');
      assert.deepEqual(replacement.counts(), { subscribes: 0, unsubscribes: 0, listeners: 0 });
      assert.deepEqual(active.counts(), { subscribes: 1, unsubscribes: 1, listeners: 0 });
      assert.equal(api.getViewedSession(), undefined);
      assert.equal(api.available, false);
      assert.equal(f.document.children[2], f.mainChat);
      assert.equal(f.mainDisposals(), 0);
      f.dispose();
      assert.deepEqual(attempts, [false], 'repeat cleanup does not broadcast again');
    } finally { off?.(); f.dispose(); }
  }
});

test('throwing source unsubscribe is logged once but disposal still restores the native main tree', async t => {
  const f = await fixture();
  const active = source('bad-cleanup');
  const failure = new Error('unsubscribe failed');
  const bad = { ...active, subscribe(listener) {
    const stop = active.subscribe(listener);
    return () => { stop(); throw failure; };
  } };
  const errorLog = t.mock.method(console, 'error', () => {});
  try {
    const api = f.service();
    api.setViewedSession(bad);
    assert.doesNotThrow(() => f.dispose());
    assert.equal(f.document.children[2], f.mainChat);
    assert.equal(api.getViewedSession(), undefined);
    assert.equal(api.available, false);
    assert.deepEqual(active.counts(), { subscribes: 1, unsubscribes: 1, listeners: 0 });
    assert.equal(errorLog.mock.callCount(), 1);
    assert.equal(errorLog.mock.calls[0].arguments[1], failure);
    f.dispose();
    assert.equal(errorLog.mock.callCount(), 1, 'the failing unsubscribe is cleared before invocation');
    assert.equal(f.mainDisposals(), 0);
  } finally { f.dispose(); }
});

test('midstream hydration uses native assistant/tool rows, streamed arguments, partialResult, and final results', async () => {
  const f = await fixture();
  const updates = new Map([['same-id', { type: 'tool_execution_update', toolCallId: 'same-id', toolName: 'read', args: { path: 'partial' }, partialResult: { content: [text('HYDRATED PARTIAL TOOL OUTPUT')], details: undefined } }]]);
  let message = assistant([text('PARTIAL ASSISTANT'), call('same-id', 'read', { path: 'partial' })], 'pending');
  const messages = [user('WORKER QUESTION'), message];
  const live = source('live', { messages, toolUpdates: updates });
  try {
    assert.equal(f.service().setViewedSession(live), true);
    const row = toolRows(f.document.children[2])[0];
    assert.ok(row instanceof f.api.ToolExecutionComponent);
    assert.equal(row.isPartial, true);
    assert.equal(row.result.content[0].text, 'HYDRATED PARTIAL TOOL OUTPUT', 'opening midstream hydrates already-running output immediately');
    assert.match(f.render(), /PARTIAL ASSISTANT/);
    assert.match(f.render(), /read partial/);
    message = assistant([text('STREAMED ASSISTANT'), call('same-id', 'read', { path: 'worker.ts', offset: 10, limit: 2 })], 'pending');
    messages[1] = message; // Real providers can retain and mutate the message array.
    updates.set('same-id', { type: 'tool_execution_update', toolCallId: 'same-id', toolName: 'read', args: { path: 'worker.ts' }, partialResult: { content: [text('PARTIAL TOOL OUTPUT')], details: undefined } });
    live.update({ messages, toolUpdates: updates });
    assert.equal(toolRows(f.document.children[2])[0], row, 'streaming keeps the native row instance');
    assert.deepEqual(row.args, { path: 'worker.ts', offset: 10, limit: 2 });
    assert.equal(row.result.content[0].text, 'PARTIAL TOOL OUTPUT');
    assert.equal(row.isPartial, true);
    assert.match(f.render(), /STREAMED ASSISTANT/);
    assert.doesNotMatch(f.render(), /PARTIAL ASSISTANT/);
    await f.command('collapsed');
    assert.match(f.render(), /PARTIAL TOOL OUTPUT/, 'native normal view receives partialResult, not an absent result field');
    messages[1] = assistant([text('FINAL ASSISTANT'), call('same-id', 'read', { path: 'worker.ts', offset: 10, limit: 2 })]);
    const final = result('same-id', 'read', 'FINAL TOOL OUTPUT');
    messages.push(final);
    updates.set('same-id', { type: 'tool_execution_end', toolCallId: 'same-id', toolName: 'read', isError: false, result: final });
    live.update({ messages, toolUpdates: updates });
    assert.equal(toolRows(f.document.children[2])[0], row);
    assert.equal(row.isPartial, false);
    assert.match(f.render(), /FINAL ASSISTANT/);
    assert.match(f.render(), /FINAL TOOL OUTPUT/);
    assert.doesNotMatch(f.render(), /PARTIAL TOOL OUTPUT|MAIN TRANSCRIPT/);
    assert.deepEqual(f.mainTool.args, { path: 'main.ts' });
    assert.equal(f.mainTool.result.content[0].text, 'main-only result');
    const before = row;
    live.update({ messages, toolUpdates: updates });
    assert.equal(toolRows(f.document.children[2])[0], before, 'unchanged snapshot preserves rows');
  } finally { f.dispose(); }
});

test('an idle history acquires live worker renderers without running or mutating a session', async () => {
  const f = await fixture();
  const messages = [assistant([call('custom-id', 'custom_tool', { value: 'worker arg' })]), result('custom-id', 'custom_tool', 'worker result')];
  const idle = source('renderer', { messages });
  const rendered = [];
  const definition = {
    renderCall: args => { rendered.push(['call', args]); return new f.api.Text(`WORKER CALL ${args.value}`, 0, 0); },
    renderResult: value => { rendered.push(['result', value]); return new f.api.Text(`WORKER RESULT ${value.content[0].text}`, 0, 0); },
  };
  const session = {
    sessionManager: { getCwd: () => cwd },
    extensionRunner: {
      getMarkdownTransformers: () => [],
      getToolDefinition: name => name === 'custom_tool' ? definition : undefined,
      resolveToolRenderers: (_name, next) => next(),
    },
  };
  try {
    f.service().setViewedSession(idle);
    await f.command('collapsed');
    assert.match(f.render(), /worker result/);
    idle.update({ messages, session });
    assert.match(f.render(), /WORKER CALL worker arg/);
    assert.match(f.render(), /WORKER RESULT worker result/);
    assert.ok(rendered.some(([kind]) => kind === 'call'));
    assert.equal(messages.length, 2);
    assert.deepEqual(f.mainTool.args, { path: 'main.ts' });
    assert.equal(f.mainDisposals(), 0);
  } finally { f.dispose(); }
});

test('nested calls retain complete live arguments and results, with main and viewed caches isolated', async () => {
  const f = await fixture();
  const main = nativeTool(f.api, f.tui, 'parent', 'codemode', { code: 'text("main");' });
  main.updateResult({ content: [], details: { calls: [{ id: 'parent/1', name: 'read', args: '{"path":"truncated', status: 'running' }] }, isError: false });
  f.mainChat.addChild(main);
  await f.emit('tool_execution_start', { parentToolCallId: 'parent', toolCallId: 'parent/1', toolName: 'read', args: { path: 'main-full.ts' } });
  const updates = new Map();
  const parent = assistant([call('parent', 'codemode', { code: 'await tools.read({path:"worker-full.ts"});' })]);
  const messages = [parent];
  const live = source('nested', { messages, toolUpdates: updates });
  try {
    f.service().setViewedSession(live);
    updates.set('parent/1', { type: 'tool_execution_start', parentToolCallId: 'parent', toolCallId: 'parent/1', toolName: 'read', args: { path: 'worker-full.ts' } });
    updates.set('parent', { type: 'tool_execution_update', toolCallId: 'parent', toolName: 'codemode', args: {}, partialResult: { content: [], details: { calls: [{ id: 'parent/1', name: 'read', args: '{"path":"truncated', status: 'running' }] } } });
    live.update({ messages, toolUpdates: updates });
    assert.match(f.render(), /worker-full\.ts/);
    assert.doesNotMatch(f.render(), /main-full\.ts/);
    updates.set('parent/1', { type: 'tool_execution_end', parentToolCallId: 'parent', toolCallId: 'parent/1', toolName: 'read', isError: false, result: { content: [text('line one\nline two')], details: undefined } });
    live.update({ messages, toolUpdates: updates });
    assert.match(f.render(), /worker-full\.ts:1-2/, 'end events without args retain the cached full arguments');
    assert.doesNotMatch(f.render(), /main-full\.ts/);
    f.service().setViewedSession(undefined);
    assert.match(f.render(), /main-full\.ts/);
    assert.doesNotMatch(f.render(), /worker-full\.ts/);
  } finally { f.dispose(); }
});

test('Ctrl+O cycles viewed native rows, including expansion, and cleanup restores main preference and wrappers', async () => {
  const f = await fixture();
  const live = source('cycle', { messages: [assistant([call('worker-read', 'read', { path: 'worker.ts' })]), result('worker-read', 'read', 'VISIBLE WORKER OUTPUT')] });
  try {
    const mainInitial = plain(f.mainChat.render(100));
    f.service().setViewedSession(live);
    const row = toolRows(f.document.children[2])[0];
    assert.doesNotMatch(f.render(), /VISIBLE WORKER OUTPUT/);
    for (const expected of ['compact-code', 'collapsed', 'expanded', 'compact']) {
      const count = f.entries.length;
      f.press('\x1b[111;5:1u');
      assert.equal(f.entries.length, count + 1);
      assert.equal(f.entries.at(-1).data.mode, expected);
      assert.match(f.render(), new RegExp(`tools: ${expected}`), 'viewed banner reports the visible mode even when native status goes to main');
      if (expected === 'collapsed' || expected === 'expanded') {
        assert.match(f.render(), /VISIBLE WORKER OUTPUT/);
        assert.equal(row.expanded, expected === 'expanded');
      } else assert.doesNotMatch(f.render(), /VISIBLE WORKER OUTPUT/);
      f.press('\x1b[111;5:2u');
      f.press('\x1b[111;5:3u');
      assert.equal(f.entries.length, count + 1, 'repeat/release never cycle or invoke native action');
    }
    assert.deepEqual(f.actions, []);
    f.service().setViewedSession(undefined);
    assert.equal(plain(f.mainChat.render(100)), mainInitial);
    f.dispose();
    assert.equal(Object.hasOwn(f.mainTool, 'render'), false);
    assert.equal(Object.hasOwn(f.mainChat, 'render'), false);
    f.press('\x0f');
    assert.deepEqual(f.actions, ['app.tools.expand'], 'cleanup leaves native editor controls installed');
  } finally { f.dispose(); }
});

test('fullscreen restores independent manual positions after native layout and removes its one-frame hook on disposal', async () => {
  const f = await fixture({ fullscreen: true });
  const a = source('scroll-a', { messages: [user(Array.from({ length: 180 }, (_, n) => `Worker A line ${n}`).join('\n'))] });
  const b = source('scroll-b', { messages: [user(Array.from({ length: 160 }, (_, n) => `Worker B line ${n}`).join('\n'))] });
  try {
    f.mainChat.addChild(new f.api.Text(Array.from({ length: 200 }, (_, n) => `Main line ${n}`).join('\n'), 0, 0));
    // Activate real fullscreen layout/rendering without starting terminal I/O or timers.
    f.tui.requestRender = () => {};
    f.tui.beforeTerminalStart();
    f.tui.stopped = false;
    f.tui.renderNow();
    const scroll = f.tui.getPrimaryScrollView();
    assert.equal(scroll, f.viewport.transcript);
    const originalLayout = scroll.updateLayout;
    scroll.scrollTo(5, { disableFollow: true });
    assert.equal(scroll.scrollTop, 5);
    const api = f.service();
    api.setViewedSession(a);
    f.tui.renderNow();
    scroll.scrollTo(12, { disableFollow: true });
    api.setViewedSession(b);
    f.tui.renderNow();
    scroll.scrollTo(18, { disableFollow: true });
    api.setViewedSession(a);
    assert.equal(Object.hasOwn(scroll, 'updateLayout'), true, 'saved manual position waits for the next native frame');
    f.tui.renderNow();
    assert.equal(scroll.scrollTop, 12);
    assert.equal(scroll.isFollowingEnd, false);
    assert.equal(scroll.updateLayout, originalLayout);
    assert.equal(Object.hasOwn(scroll, 'updateLayout'), false, 'one-frame wrapper is removed after restoring');
    api.setViewedSession(b);
    f.tui.renderNow();
    assert.equal(scroll.scrollTop, 18);
    api.setViewedSession(undefined);
    f.tui.renderNow();
    assert.equal(scroll.scrollTop, 5, 'main position also survives source selection');
    api.setViewedSession(a);
    assert.equal(Object.hasOwn(scroll, 'updateLayout'), true);
    f.dispose(); // Exit before the pending restore frame.
    assert.equal(scroll.updateLayout, originalLayout);
    assert.equal(Object.hasOwn(scroll, 'updateLayout'), false, 'disposal removes the pending instance hook');
  } finally { f.dispose(); f.tui.stop(); }
});

test('session tree navigation restores main and branch preferences survive source cleanup', async () => {
  const f = await fixture();
  const viewed = source('tree', { messages: [assistant([call('tree-tool', 'read', { path: 'tree.ts' })]), result('tree-tool', 'read', 'TREE RESULT')] });
  try {
    await f.command('expanded');
    const savedEntries = [...f.entries];
    const mainRender = plain(f.mainChat.render(100));
    f.service().setViewedSession(viewed);
    assert.equal(toolRows(f.document.children[2])[0].expanded, true);
    assert.match(f.render(), /TREE RESULT/);
    await f.emit('session_tree');
    assert.equal(f.service().getViewedSession(), undefined);
    assert.equal(f.document.children[2], f.mainChat);
    assert.equal(plain(f.mainChat.render(100)), mainRender);
    assert.deepEqual(f.entries, savedEntries, 'viewing/exit does not append or overwrite the branch preference');
    assert.equal(viewed.counts().unsubscribes, 1);
    await f.emit('session_start');
    assert.equal(plain(f.mainChat.render(100)), mainRender, 'stored expanded preference is reconstructed after restart');
    f.service().setViewedSession(viewed);
    assert.equal(toolRows(f.document.children[2])[0].expanded, true);
  } finally { f.dispose(); }
});

test('source preflight failures preserve the existing view, and duplicate selection does not resubscribe', async () => {
  const f = await fixture();
  const stable = source('stable', { messages: [user('STABLE VIEW')] });
  let failedCleanup = 0;
  try {
    const api = f.service();
    api.setViewedSession(stable);
    const children = [...f.document.children];
    api.setViewedSession(stable);
    assert.equal(stable.counts().subscribes, 1);
    assert.throws(() => api.setViewedSession({ id: 'failed', title: 'Failed', getSnapshot() { throw new Error('snapshot unavailable'); }, subscribe(changed) { changed(); return () => failedCleanup++; } }), /snapshot unavailable/);
    assert.equal(failedCleanup, 1);
    assert.deepEqual(f.document.children, children);
    assert.equal(api.getViewedSession().id, 'stable');
    assert.match(f.render(), /STABLE VIEW/);
    assert.equal(stable.counts().unsubscribes, 0);
  } finally { f.dispose(); }
});

test('worker deltas preserve finished row and nested result caches instead of globally invalidating history', async () => {
  const f = await fixture();
  const updates = new Map([['parent/1', { type: 'tool_execution_end', parentToolCallId: 'parent',
    toolCallId: 'parent/1', toolName: 'read', args: { path: 'nested.ts' }, isError: false,
    result: { content: [text('one\ntwo')], details: undefined } }]]);
  const tail = assistant([text('STREAM BEFORE')], 'pending'); tail.timestamp = 4;
  const messages = [assistant([call('parent', 'codemode', { code: 'text(1);' })]),
    result('parent', 'codemode', '', { details: { calls: [{ id: 'parent/1', name: 'read', args: '{}', status: 'ok' }] } }), tail];
  const live = source('cached-history', { messages, toolUpdates: updates });
  try {
    f.service().setViewedSession(live); f.render();
    const row = toolRows(f.document.children[2])[0];
    const first = row.render(100);
    let completions = 0;
    const complete = row.setArgsComplete;
    row.setArgsComplete = function () { completions++; return complete.call(this); };
    tail.content[0].text = 'STREAM AFTER'; live.update({ messages, toolUpdates: updates });
    assert.match(f.render(), /STREAM AFTER/);
    assert.equal(row.render(100), first, 'finished parent and nested layouts survive unrelated streaming');
    assert.equal(completions, 0, 'completed native renderers are not rebuilt on unrelated deltas');
    updates.set('parent/1', { ...updates.get('parent/1'), result: { content: [text('one\ntwo\nthree')] } });
    live.update({ messages, toolUpdates: updates }); assert.match(f.render(), /nested\.ts:1-3/);
  } finally { f.dispose(); }
});

test('pending assistant content and tool arguments mutated in place invalidate the native rows', async () => {
  const f = await fixture();
  const args = { path: 'before.ts' };
  const message = assistant([text('BEFORE CONTENT'), call('mutable-tool', 'read', args)], 'pending');
  const messages = [message];
  const live = source('mutable', { messages });
  try {
    f.service().setViewedSession(live);
    const row = toolRows(f.document.children[2])[0];
    assert.match(f.render(), /BEFORE CONTENT/);
    assert.match(f.render(), /before\.ts/);
    message.content[0].text = 'AFTER CONTENT';
    args.path = 'after.ts';
    live.update({ messages });
    assert.equal(toolRows(f.document.children[2])[0], row);
    assert.match(f.render(), /AFTER CONTENT/);
    assert.match(f.render(), /after\.ts/);
    assert.doesNotMatch(f.render(), /BEFORE CONTENT|before\.ts/);
  } finally { f.dispose(); }
});

test('native extension dialogs replacing the editor dock retain input and never restore the viewed group', async () => {
  const f = await fixture();
  const live = source('native-dialog', {messages: [user('GROUP WORKER')]});
  const dock = f.roots[4];
  try {
    f.service().setViewedSession(live);
    const dialog = new f.api.Input(), received = [];
    dialog.handleInput = data => received.push(data);
    dock.clear(); dock.addChild(dialog); f.tui.setFocus(dialog);
    for (const key of ['\x1b[B', '\x1b', '\x03', '\r']) f.press(key);
    assert.deepEqual(received, ['\x1b[B', '\x1b', '\x03', '\r']);
    assert.equal(f.service().getViewedSession().id, 'native-dialog');
    assert.deepEqual(f.actions, []);
  } finally {
    dock.clear(); dock.addChild(f.editor); f.tui.setFocus(f.editor); f.dispose();
  }
});

test('held Kitty Ctrl+C/Escape exits once and cannot clear or interrupt main on repeat, while a new press stays native', async () => {
  const f = await fixture();
  const viewed = source('held-exit', { messages: [user('VIEWED')] });
  try {
    for (const [press, repeat, release, nativeAction] of [
      ['\x1b[99;5:1u', '\x1b[99;5:2u', '\x1b[99;5:3u', 'app.clear'],
      ['\x1b[27;1:1u', '\x1b[27;1:2u', '\x1b[27;1:3u', 'app.interrupt'],
    ]) {
      const count = f.actions.length;
      const history = [...f.editor.history];
      f.service().setViewedSession(viewed);
      f.press(press);
      assert.equal(f.service().getViewedSession(), undefined);
      assert.equal(f.document.children[2], f.mainChat);
      for (let n = 0; n < 3; n++) f.press(repeat);
      f.press(release);
      assert.equal(f.actions.length, count, `${nativeAction}: held reports never reach main`);
      assert.deepEqual(f.editor.history, history, 'held Ctrl+C does not remember/clear a main draft');
      assert.equal(f.editor.getText(), 'main draft');
      f.press(press); // A deliberately new nonrepeat press belongs to main again.
      assert.equal(f.actions.length, count + 1);
      assert.equal(f.actions.at(-1), nativeAction);
      f.press(release);
      assert.equal(f.actions.length, count + 1);
    }
  } finally { f.dispose(); }
});

test('view is read-only: ordinary submission and session/model actions are blocked, Escape/Ctrl+C restore, dialogs unaffected', async () => {
  const f = await fixture();
  const api = f.service();
  const live = source('readonly', { messages: [user('READ ONLY WORKER')] });
  try {
    const history = [...f.editor.history];
    const submit = f.editor.onSubmit;
    api.setViewedSession(live);
    const mainChildren = [...f.mainChat.children];
    const noticeCount = f.notices.length;
    f.editor.setText('must not submit to either agent');
    f.press('\r');
    assert.deepEqual(f.submitted, []);
    assert.equal(f.editor.getText(), 'must not submit to either agent');
    assert.deepEqual(f.editor.history, history);
    assert.match(f.render(), /Agent view is read-only.*before submitting/);
    assert.deepEqual(f.mainChat.children, mainChildren);
    assert.equal(f.notices.length, noticeCount, 'blocked submission warns inline, not via native offscreen notifications');
    f.press('\x10'); // Ctrl+P: native app.model.cycleForward.
    f.press('\x0e'); // Remapped app.session.new.
    f.press('\x14'); // Remapped app.session.tree.
    assert.deepEqual(f.actions, []);
    assert.match(f.render(), /This control belongs to main/);
    assert.deepEqual(f.mainChat.children, mainChildren);
    assert.equal(f.notices.length, noticeCount, 'blocked model/session controls never notify into main chat');
    assert.equal(api.getViewedSession().id, 'readonly');
    const dialog = new f.api.Input();
    let dialogKeys = [];
    dialog.handleInput = data => dialogKeys.push(data);
    f.tui.setFocus(dialog);
    f.press('\x1b');
    f.press('\x03');
    assert.deepEqual(dialogKeys, ['\x1b', '\x03']);
    assert.equal(api.getViewedSession().id, 'readonly');
    f.tui.setFocus(f.editor);
    f.press('\x1b');
    assert.equal(api.getViewedSession(), undefined);
    assert.equal(f.document.children[2], f.mainChat);
    assert.equal(f.editor.onSubmit, submit);
    api.setViewedSession(live);
    f.press('\x03');
    assert.equal(api.getViewedSession(), undefined);
    assert.deepEqual(f.actions, [], 'return-to-main does not abort, clear, or cycle the main session');
    assert.deepEqual(f.editor.history, history, 'view exit does not save a cleared main draft');
    api.setViewedSession(live);
    for (const allowed of ['/subagents', '/groups', '/groups root', '/ui compact']) {
      f.editor.setText(allowed);
      f.press('\r');
      assert.equal(f.submitted.at(-1), allowed);
    }
  } finally { f.dispose(); }
});
