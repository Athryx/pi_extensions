const {test} = require('node:test');
const assert = require('node:assert/strict');
const {load, host} = require('./test-helper.cjs');

async function fixture() {
  const {GroupViewSelection} = await load('group-selection.ts');
  const {AgentViewSelection} = await load('selection.ts');
  const groups = new GroupViewSelection(), listeners = new Set(), changes = new Set(), calls = [];
  const descriptor = (id, parentGroupId, kind, rootAgentInstanceId, label = id) => ({version: 1, id, parentGroupId, kind, rootAgentInstanceId, label});
  const groupMap = new Map([
    ['root-id', descriptor('root-id', null, 'root', 'id-main', 'Root group')],
    ['workflow-id', descriptor('workflow-id', 'root-id', 'workflow', null, 'Workflow: 同名')],
    ['agent-id', descriptor('agent-id', 'workflow-id', 'agents', 'id-research', 'Same label')],
    ['other-id', descriptor('other-id', 'workflow-id', 'agents', 'id-other', 'Same label')],
    ['queued-id', {...descriptor('queued-id', 'workflow-id', 'agents', null), status: 'queued'}],
  ]);
  const record = (name, groupId, parentName) => ({identity: {name, instanceId: 'id-' + name, groupId, parentName}, status: 'idle', template: {name: 'template'}, messages: [], inbox: [], pending: []});
  const records = new Map([
    ['main', record('main', 'root-id', null)], ['ordinary', record('ordinary', 'root-id', 'main')],
    ['research', record('research', 'agent-id', null)], ['helper', record('helper', 'agent-id', 'research')],
    ['other', record('other', 'other-id', null)],
  ]);
  const workspace = {rootGroupId: 'root-id', groups: groupMap, records, closed: false,
    get(name) {if (!records.has(name)) throw new Error('Unknown agent: ' + name); return records.get(name);},
    members(id) {return [...records.values()].filter(r => r.identity.groupId === id);},
    subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);},
  };
  let source, unsubscribe;
  const api = {version: 1, available: true,
    setViewedSession(next) {calls.push(next); unsubscribe?.(); source = next; unsubscribe = next?.subscribe(() => {}); for (const fn of changes) fn(api.getViewedSession()); return true;},
    getViewedSession: () => source && {id: source.id, title: source.title},
    onChange(fn) {changes.add(fn); return () => changes.delete(fn);},
  };
  let service = api;
  const pi = {events: {emit: (_event, request) => service && request.reply(service)}};
  const menus = [];
  const ctx = {mode: 'tui', ui: {select: async (title, options) => {menus.push(options); return options[0];}}};
  return {groups, workspace, records, listeners, changes, calls, api, pi, ctx, menus,
    selection: new AgentViewSelection(pi, groups), get source() {return source;}, set service(value) {service = value;}};
}

test('hierarchy uses stable ids/root alias, preserves empty containers and invalidates one menu cache', async () => {
  const f = await fixture(), {groups, workspace} = f;
  assert.equal(groups.id(workspace), 'root-id');
  const tree = groups.tree(workspace);
  assert.deepEqual(tree.map(r => r.id), ['root-id', 'workflow-id', 'agent-id', 'other-id', 'queued-id']);
  assert.match(tree[1].label, /^  Workflow.*0 agents/);
  assert.match(tree[2].label, /^    Same label.*agent-id/);
  assert.match(tree[3].label, /other-id/);
  assert.equal(groups.tree(workspace), tree);
  workspace.groups.get('queued-id').status = 'failed';
  assert.notEqual(groups.tree(workspace), tree);
  const updated = groups.tree(workspace);
  f.records.get('research').status = 'running';
  assert.notEqual(groups.tree(workspace), updated);
  assert.equal(await groups.choose(workspace, '', async (_title, options) => options[2]), true);
  assert.equal(groups.id(workspace), 'agent-id');
  groups.set(workspace, 'root'); assert.equal(groups.id(workspace), 'root-id');
  assert.throws(() => groups.set(workspace, 'Same label'), /Unknown agent group/);
  assert.equal(await groups.choose(workspace, '', async () => undefined), false);
  assert.equal(groups.id(workspace), 'root-id');
  assert.equal(await groups.choose(workspace, '', async (_title, options) => {groups.clear(); return options[2];}), false);
});

test('group selection remembers members, roots fall back safely, cycling/picker stay local and Escape resets root', async () => {
  const f = await fixture();
  f.groups.set(f.workspace, 'agent-id');
  assert.equal(await f.selection.selectGroup(f.workspace, f.ctx), true);
  assert.equal(f.source.title, 'research');
  await f.selection.cycle(f.workspace, 1, f.ctx); assert.equal(f.source.title, 'helper');
  await f.selection.cycle(f.workspace, 1, f.ctx); assert.equal(f.source.title, 'research');
  await f.selection.select(f.workspace, 'helper', f.ctx);
  f.groups.set(f.workspace, 'other-id'); await f.selection.selectGroup(f.workspace, f.ctx);
  assert.equal(f.source.title, 'other');
  f.groups.set(f.workspace, 'agent-id'); await f.selection.selectGroup(f.workspace, f.ctx);
  assert.equal(f.source.title, 'helper');
  await assert.rejects(f.selection.select(f.workspace, 'ordinary', f.ctx), /\/groups/);
  await f.selection.select(f.workspace, '', f.ctx);
  assert.deepEqual(f.menus.at(-1), ['research', 'helper']);
  f.records.delete('helper');
  assert.equal(f.groups.preferred(f.workspace).identity.name, 'research');
  f.api.setViewedSession(undefined); assert.equal(f.groups.id(f.workspace), 'root-id');
  f.groups.set(f.workspace, 'other-id'); await f.selection.selectGroup(f.workspace, f.ctx);
  await f.selection.select(f.workspace, 'main', f.ctx);
  assert.equal(f.groups.id(f.workspace), 'root-id'); assert.equal(f.source, undefined);
  f.selection.clear(); assert.equal(f.changes.size, 0); assert.equal(f.listeners.size, 0);
});

test('empty/queued group native overview clears workers, cycles no-op and stays read-only', async () => {
  const f = await fixture();
  f.groups.set(f.workspace, 'agent-id'); await f.selection.selectGroup(f.workspace, f.ctx);
  f.groups.set(f.workspace, 'workflow-id');
  await f.selection.selectGroup(f.workspace, f.ctx);
  assert.match(f.source.id, /group:workflow-id/);
  const snapshot = f.source.getSnapshot();
  assert.equal(snapshot.session, undefined);
  assert.match(snapshot.messages[0].content, /No agents.*\n.*agent-id/s);
  assert.equal(f.source.getSnapshot().messages, snapshot.messages);
  f.workspace.groups.get('agent-id').status = 'completed';
  assert.notEqual(f.source.getSnapshot().messages, snapshot.messages);
  const calls = f.calls.length;
  assert.equal(await f.selection.cycle(f.workspace, 1, f.ctx), true);
  assert.equal(f.calls.length, calls);
  f.api.setViewedSession(undefined); assert.equal(f.groups.id(f.workspace), 'root-id');
  f.groups.set(f.workspace, 'queued-id'); await f.selection.selectGroup(f.workspace, f.ctx);
  assert.match(f.source.getSnapshot().messages[0].content, /queued/);
  f.selection.clear();
});

test('missing native API uses safe fallback and stale group/agent picker results are ignored', async () => {
  const f = await fixture();
  f.groups.set(f.workspace, 'agent-id'); await f.selection.selectGroup(f.workspace, f.ctx);
  f.service = undefined;
  f.groups.set(f.workspace, 'workflow-id');
  assert.equal(await f.selection.selectGroup(f.workspace, f.ctx), false);
  assert.equal(f.source, undefined); assert.equal(f.groups.id(f.workspace), 'workflow-id');
  await assert.rejects(f.selection.select(f.workspace, 'other', f.ctx), /\/groups/);
  f.service = f.api;
  f.groups.set(f.workspace, 'agent-id');
  const count = f.calls.length;
  f.ctx.ui.select = async () => {f.groups.set(f.workspace, 'other-id'); return 'research';};
  await f.selection.select(f.workspace, '', f.ctx);
  assert.equal(f.calls.length, count);
  f.groups.set(f.workspace, 'agent-id');
  f.ctx.ui.select = async () => {f.records.delete('helper'); return 'helper';};
  await f.selection.select(f.workspace, '', f.ctx);
  assert.equal(f.calls.length, count);
  f.selection.clear();
});

test('group bar/overview reuse cached layout and invalidate status, width, theme and group changes', async () => {
  const f = await fixture(), {AgentBar} = await load('agent-bar.ts'), {GroupView} = await load('group-view.ts');
  const {visibleWidth} = await host('node_modules/@earendil-works/pi-tui/dist/index.js');
  const tui = {terminal: {rows: 20}, requestRender() {}}, theme = {fg: (_color, text) => text, bold: text => '<' + text + '>'};
  const bar = new AgentBar(f.pi, f.workspace, tui, theme, f.groups);
  const initial = bar.render(100); assert.equal(bar.render(100), initial);
  f.groups.set(f.workspace, 'agent-id'); await f.selection.selectGroup(f.workspace, f.ctx);
  let output = bar.render(100).join('\n');
  assert.match(output, /research.*helper/); assert.doesNotMatch(output, /main|ordinary|other/);
  const active = bar.render(100); f.records.get('research').status = 'running';
  assert.notEqual(bar.render(100), active);
  const status = bar.render(100); assert.notEqual(bar.render(20), status);
  theme.fg = (_color, text) => '\x1b[31m' + text + '\x1b[0m';
  assert.notEqual(bar.render(100), status);
  f.groups.set(f.workspace, 'workflow-id');
  output = bar.render(100).join('\n'); assert.match(output, /No agents/); assert.doesNotMatch(output, /research|helper|main/);
  const view = new GroupView(f.workspace, 'queued-id', tui, theme, () => {});
  const overview = view.render(80); assert.equal(view.render(80), overview);
  assert.equal(overview.length, 20); assert.equal(overview.at(-1), '');
  tui.terminal.rows = 10;
  const resized = view.render(80); assert.notEqual(resized, overview);
  assert.equal(resized.length, 10); assert.equal(view.render(80), resized);
  tui.terminal.rows = 20;
  f.workspace.groups.get('queued-id').status = 'failed';
  f.workspace.groups.get('queued-id').error = 'failure\x1b]52;c;secret\x07';
  assert.notEqual(view.render(80), overview);
  assert.doesNotMatch(view.render(80).join('\n'), /52;c;secret/);
  for (const width of [1, 20, 80, 120]) for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width);
  view.invalidate(); assert.notEqual(view.render(80), overview);
  view.dispose(); bar.dispose(); f.selection.clear(); assert.equal(f.listeners.size, 0);
});
