const {test} = require('node:test');
const assert = require('node:assert/strict');
const {load, host} = require('./test-helper.cjs');

test('agent bar wraps, shows templates/status/selection and disposes both subscriptions', async () => {
  const {AgentBar} = await load('agent-bar.ts');
  const {visibleWidth} = await host('node_modules/@earendil-works/pi-tui/dist/index.js');
  const listeners = new Set(), changes = new Set();
  let selected, renders = 0;
  const api = {
    version: 1, available: true, setViewedSession() {},
    getViewedSession: () => selected,
    onChange: fn => {changes.add(fn); return () => changes.delete(fn);},
  };
  const pi = {events: {emit: (_event, request) => request.reply(api)}};
  const record = (name, template, status) => ({identity: {name, instanceId: name}, template: {name: template}, status});
  const workspace = {
    records: new Map([
      ['main', record('main', 'main', 'idle')],
      ['worker', record('worker', 'subagent', 'running')],
      ['waiting', record('waiting', 'leader', 'waiting')],
    ]),
    get(name) {return this.records.get(name);},
    subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);},
  };
  const colors = [];
  const theme = {fg: (color, text) => {colors.push([color, text]); return text;}, bold: text => `<${text}>`};
  const bar = new AgentBar(pi, workspace, {requestRender: () => renders++}, theme);
  assert.match(bar.render(100).join('\n'), /● <main \(main\)>.*● worker \(subagent\)/);
  assert.equal(colors.filter(([c, t]) => c === 'success' && t === '●').length, 2);
  assert.ok(colors.some(([c, t]) => c === 'muted' && t === '●'));
  selected = {id: 'worker'};
  for (const fn of changes) fn();
  assert.match(bar.render(100).join('\n'), /<worker \(subagent\)>/);
  workspace.get('worker').status = 'idle';
  for (const fn of listeners) fn();
  assert.equal(renders, 2);
  colors.length = 0;
  const lines = bar.render(12);
  assert.ok(lines.length > 1);
  assert.ok(lines.every(line => visibleWidth(line) <= 12));
  assert.equal(colors.filter(([c, t]) => c === 'success' && t === '●').length, 1);
  workspace.get('worker').identity.name = 'bad\x1b\nname';
  assert.doesNotMatch(bar.render(100).join('\n'), /\x1b/);
  assert.deepEqual(bar.render(0), []);
  bar.dispose(); bar.dispose();
  assert.equal(listeners.size, 0);
  assert.equal(changes.size, 0);
  assert.deepEqual(bar.render(80), []);
});
