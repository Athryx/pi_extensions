const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { realpathSync } = require('node:fs');
const { join, resolve, dirname } = require('node:path');
const { pathToFileURL } = require('node:url');

const root = resolve(dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim())), '../..');
const host = path => import(pathToFileURL(join(root, path)).href);
const esbuild = require(require.resolve('esbuild', { paths: [root] }));
const packages = Promise.all([
  host('dist/index.js'),
  host('node_modules/@earendil-works/pi-ai/dist/index.js'),
  host('node_modules/@earendil-works/pi-tui/dist/index.js'),
]).then(([agent, ai, tui]) => ({
  '@earendil-works/pi-coding-agent': agent,
  '@earendil-works/pi-ai': ai,
  '@earendil-works/pi-tui': tui,
}));
const identityTheme = { fg: (_, text) => text, bg: (_, text) => text };
const user = content => ({ role: 'user', content, timestamp: 1 });
const tool = name => ({ name, description: `Use ${name}`, parameters: { type: 'object', properties: {}, additionalProperties: false } });
const prompt = { role: 'system', content: '', sections: { preamble: 'You are helpful.', rules: '<rules>\nBe concise.\n</rules>' }, toolsAdded: [tool('read')], timestamp: 0 };

async function moduleExports(file) {
  const dependencies = await packages;
  const result = await esbuild.build({
    entryPoints: [join(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs',
    external: Object.keys(dependencies),
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, name => dependencies[name]);
  return module.exports;
}
const model = moduleExports('model.ts');
const view = moduleExports('view.ts');

async function snapshot(messages = [prompt, user('Hello')], current = true) {
  const { buildSnapshot } = await model;
  const { getCurrentSystemMessage, getSystemMessageText } = (await packages)['@earendil-works/pi-ai'];
  return buildSnapshot({
    messages, source: current ? 'Current effective context' : 'Last captured request', model: 'test/model',
    current: current ? { prompt: getSystemMessageText(getCurrentSystemMessage(messages)), tools: [tool('read')] } : undefined,
    usage: { tokens: 500, contextWindow: 1000, percent: 50 },
  });
}

async function ui(snapshots) {
  const { ContextView } = await view;
  const { KeybindingsManager, TUI_KEYBINDINGS } = (await packages)['@earendil-works/pi-tui'];
  let closed = false;
  const tui = { terminal: { rows: 28 }, requestRender() {} };
  return { tui, component: new ContextView(snapshots, tui, identityTheme, new KeybindingsManager(TUI_KEYBINDINGS), () => { closed = true; }), closed: () => closed };
}
const screen = component => component.render(110).join('\n');
const mouse = (x, y, extra = {}) => ({ type: 'click', button: 'left', x, y, width: 110, height: 26, screenX: x, screenY: y, shift: false, alt: false, ctrl: false, ...extra });

async function extensionHarness() {
  const { loadExtensions } = await host('dist/core/extensions/loader.js');
  const { extensions, errors, runtime } = await loadExtensions([join(__dirname, 'index.ts')], resolve(__dirname, '../../..'));
  assert.deepEqual(errors, []);
  const extension = extensions[0];
  runtime.getActiveTools = () => ['read', 'hidden'];
  runtime.getAllTools = () => [tool('read'), tool('hidden'), tool('inactive')];
  let component, overlayOptions;
  const notifications = [];
  const ctx = {
    mode: 'tui', model: { id: 'model', provider: 'test' },
    getSystemPrompt: () => 'CURRENT PROMPT', getSystemPromptOptions: () => ({ hiddenTools: ['hidden'] }),
    getContextUsage: () => ({ tokens: null, contextWindow: 1000, percent: null }),
    sessionManager: { buildSessionProjection: () => ({ messages: [prompt, user('Final response')] }) },
    ui: {
      notify: (...args) => notifications.push(args),
      custom: async (factory, options) => {
        overlayOptions = options;
        const { KeybindingsManager, TUI_KEYBINDINGS } = (await packages)['@earendil-works/pi-tui'];
        component = factory({ terminal: { rows: 28 }, requestRender() {} }, identityTheme, new KeybindingsManager(TUI_KEYBINDINGS), () => {});
      },
    },
  };
  return {
    extension, ctx, notifications,
    open: async () => { await extension.commands.get('context').handler('', ctx); return component; },
    options: () => overlayOptions,
    emit: async (event, data = {}) => { for (const handler of extension.handlers.get(event) ?? []) await handler(data, ctx); },
  };
}

test('current context categories replay prompt, exclude UI-only roles, and estimate content rather than response usage', async () => {
  const assistant = { role: 'assistant', content: [
    { type: 'thinking', thinking: 'Consider this.' },
    { type: 'text', text: 'Answer' },
    { type: 'toolCall', id: 'call1', name: 'read', arguments: { path: '/tmp/example' } },
  ], usage: { totalTokens: 999999 }, timestamp: 1 };
  const messages = [prompt, user('Hello'), assistant,
    { role: 'toolResult', toolName: 'read', toolCallId: 'call1', content: [{ type: 'text', text: 'File contents' }], details: { secret: 'UI ONLY' }, timestamp: 1 },
    { role: 'bashExecution', command: 'secret', output: 'secret', excludeFromContext: true, timestamp: 1 },
    { role: 'custom', customType: 'goal', content: 'Injected instructions', timestamp: 1 },
    { role: 'system', content: '', sections: { rules: null, goal_mode: '<goal_mode>\nBe careful.\n</goal_mode>' }, timestamp: 1 },
  ];
  const before = structuredClone(messages);
  const result = await snapshot(messages);
  assert.deepEqual(result.roots.map(root => root.label), ['System prompt', 'Tool definitions', 'Conversation']);
  assert.match(result.roots[0].text, /Be careful/);
  assert.doesNotMatch(result.roots[0].text, /Be concise/);
  const entries = result.roots[2].children;
  assert.equal(entries.length, 4);
  assert.equal(entries[1].children.length, 3);
  assert.match(entries[1].children[2].text, /\/tmp\/example/);
  assert.doesNotMatch(entries[2].text, /UI ONLY/);
  assert.ok(result.tokens < 1000);
  assert.equal(result.tokens, result.roots.reduce((total, node) => total + node.tokens, 0));
  assert.deepEqual(messages, before);
});

test('projection honors compaction, context edits, and active branch rather than raw history', async () => {
  const { SessionManager } = (await packages)['@earendil-works/pi-coding-agent'];
  const manager = SessionManager.inMemory();
  manager.appendMessage(prompt);
  manager.appendMessage(user('OLD TEXT TO DROP'));
  const retained = manager.appendMessage(user('ORIGINAL RETAINED TEXT'));
  manager.appendCompaction('Summarized earlier discussion', retained, 1000);
  manager.appendContextEdit(retained, { content: 'REPLACED CONTEXT' });
  manager.appendCustomEntry('ui-only', { secret: 'NOT CONTEXT' });
  manager.appendMessage(user('ABANDONED BRANCH'));
  manager.branch(manager.getEntry(retained).id);
  const otherBranch = await snapshot(manager.buildSessionProjection().messages);
  assert.doesNotMatch(JSON.stringify(otherBranch), /ABANDONED BRANCH|NOT CONTEXT/);
  // Restore the compacted branch to check edits applied after compaction.
  const compactedLeaf = manager.getEntries().find(entry => entry.type === 'custom').id;
  manager.branch(compactedLeaf);
  const result = await snapshot(manager.buildSessionProjection().messages);
  assert.match(JSON.stringify(result), /REPLACED CONTEXT|Summarized earlier discussion/);
  assert.doesNotMatch(JSON.stringify(result), /OLD TEXT TO DROP|ORIGINAL RETAINED TEXT|NOT CONTEXT|ABANDONED BRANCH/);
});

test('captured transcript retains later system and tool deltas; images have bounded text and a fixed estimate', async () => {
  const result = await snapshot([prompt,
    { role: 'system', content: '', sections: { rules: 'New rules' }, toolsAdded: [tool('bash')], toolsRemoved: [{ name: 'read' }], timestamp: 1 },
    user([{ type: 'image', data: 'A'.repeat(20000), mimeType: 'image/png' }]),
  ], false);
  assert.match(result.roots[0].text, /Be concise/);
  assert.equal(result.roots[1].children[0].label, 'read');
  const entries = result.roots[2].children;
  assert.match(entries[0].label, /System update/);
  assert.ok(entries[0].children.some(child => child.label === 'bash'));
  assert.match(entries[1].text, /20,000 characters/);
  assert.ok(entries[1].text.length < 500);
  assert.equal(entries[1].tokens, 1200);
});

test('wide and narrow layouts fit terminal columns and height, including Unicode and control sequences', async () => {
  const { safeText } = await view;
  const { visibleWidth } = (await packages)['@earendil-works/pi-tui'];
  const result = await snapshot([prompt, user('中文🙂'.repeat(100) + '\u001b[2J\u001b]52;c;unsafe\u0007\ttext\r\nend')]);
  const { component, tui } = await ui([result]);
  for (const height of [8, 12, 28, 50]) for (const width of [1, 12, 20, 50, 71, 72, 110, 180]) {
    tui.terminal.rows = height;
    component.invalidate();
    const lines = component.render(width);
    assert.ok(lines.length <= height, `${width}x${height} rows`);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}x${height}: ${visibleWidth(line)}`);
  }
  assert.equal(safeText('\u001b[2J\u001b]52;c;unsafe\u0007\u0000text\tend'), 'text    end');
});

test('empty sessions and opaque prompt replacements preserve the full effective prompt', async () => {
  const { buildSnapshot } = await model;
  const effective = 'Custom prefix\n\n<rules>\nA rule\n</rules>\n\nCustom tail';
  const result = buildSnapshot({ messages: [], source: 'Current', model: 'test/model', current: { prompt: effective, tools: [] } });
  assert.equal(result.roots[0].text, effective);
  assert.equal(result.roots[0].children[0].label, 'preamble');
  assert.equal(result.roots[1].tokens, 0);
  assert.equal(result.roots[2].children.length, 0);
  const { component } = await ui([result]);
  assert.match(screen(component), /Custom prefix/);
});

test('real Pi themes render within column bounds and are rebuilt on invalidation', async () => {
  const { ContextView } = await view;
  const { getThemeByName } = await host('dist/modes/interactive/theme/theme.js');
  const { visibleWidth, KeybindingsManager, TUI_KEYBINDINGS } = (await packages)['@earendil-works/pi-tui'];
  const theme = getThemeByName('dark');
  assert.ok(theme);
  const component = new ContextView([await snapshot()], { terminal: { rows: 28 }, requestRender() {} }, theme, new KeybindingsManager(TUI_KEYBINDINGS), () => {});
  const before = component.render(110);
  assert.ok(before.some(line => line.includes('\u001b[')));
  component.invalidate();
  assert.deepEqual(component.render(110), before);
  for (const width of [20, 71, 72, 110]) for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
});

test('keyboard expands tree, scrolls full content independently, switches snapshots and closes', async () => {
  const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const current = await snapshot();
  current.roots[0].text = long;
  const last = await snapshot([prompt, user('Last request content')], false);
  const { component, closed } = await ui([current, last]);
  assert.match(screen(component), /line 0/);
  component.handleInput('\t');
  component.handleInput('\u001b[6~'); // PageDown
  assert.match(screen(component), /line 16/);
  component.handleInput('\u001b[F'); // End
  assert.match(screen(component), /line 99/);
  component.handleInput('\u001b[H'); // Home
  assert.match(screen(component), /line 0/);
  component.handleInput('\t');
  component.handleInput('\r'); // Collapse system prompt
  assert.equal(component.rows.some(row => row.depth === 1 && row.parent === 'system'), false);
  component.handleInput('\r');
  assert.equal(component.rows.some(row => row.depth === 1 && row.parent === 'system'), true);
  component.handleInput('r');
  assert.match(screen(component), /Last captured request/);
  component.handleInput('q');
  assert.equal(closed(), true);
});

test('fullscreen mouse clicks expand categories and wheel events scroll the hovered pane', async () => {
  const result = await snapshot([prompt, ...Array.from({ length: 70 }, (_, i) => user(`message ${i}`))]);
  const { component } = await ui([result]);
  screen(component);
  const expanded = component.rows.length;
  component.handleMouse(mouse(4, 5)); // System prompt category
  assert.ok(component.rows.length < expanded);
  screen(component);
  component.handleMouse(mouse(4, 5));
  screen(component);
  component.handleMouse(mouse(4, 6)); // Prompt preamble
  assert.equal(component.selectedId, 'system:preamble');
  component.handleMouse(mouse(4, 8, { type: 'wheel', wheelDelta: 20 }));
  assert.ok(component.tree.scroll.scrollTop > 0);
  assert.ok(component.selectedIndex >= component.tree.scroll.scrollTop);
  screen(component);
  component.handleMouse(mouse(80, 10, { type: 'wheel', wheelDelta: 3 }));
  assert.equal(component.focus, 'detail');
});

test('/context registers only one command, excludes inactive/hidden tools, and guards non-TUI modes', async () => {
  const harness = await extensionHarness();
  assert.deepEqual([...harness.extension.commands.keys()], ['context']);
  assert.equal(harness.extension.tools.size, 0);
  const component = await harness.open();
  assert.equal(harness.options().overlay, true);
  assert.match(screen(component), /CURRENT PROMPT|Pi usage: unknown/);
  assert.deepEqual(component.snapshots[0].roots[1].children.map(child => child.label), ['read']);
  for (const mode of ['rpc', 'json', 'print']) {
    harness.ctx.mode = mode;
    await harness.open();
  }
  assert.equal(harness.notifications.length, 3);
});

test('request capture is read-only, isolated from mutation, and cleared on session changes', async () => {
  const harness = await extensionHarness();
  const messages = [prompt, user('Captured content'), {
    role: 'toolResult', toolName: 'read', toolCallId: '1', content: [{ type: 'text', text: 'Output' }],
    details: { uncloneable() {} }, timestamp: 1,
  }];
  await harness.emit('context_with_system', { messages });
  messages[1].content = 'Later mutation';
  assert.ok(messages[2].details.uncloneable);
  const component = await harness.open();
  assert.equal(component.snapshots.length, 2);
  assert.match(component.snapshots[1].roots[2].children[0].text, /Captured content/);
  for (const event of ['session_start', 'session_switch', 'session_fork', 'session_tree', 'session_compact', 'session_shutdown']) {
    await harness.emit('context_with_system', { messages });
    await harness.emit(event);
    assert.equal((await harness.open()).snapshots.length, 1, event);
  }
});
