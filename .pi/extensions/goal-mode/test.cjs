const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { realpathSync } = require('node:fs');
const root = join(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()), '../..');
const esbuild = require(require.resolve('esbuild', { paths: [root] }));

async function load() {
  const result = await esbuild.build({ entryPoints: [join(__dirname, 'index.ts')], bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'stubs', setup(build) {
      build.onResolve({ filter: /^(typebox|@earendil-works\/pi-ai)$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
      build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ loader: 'js', contents: args.path === 'typebox'
        ? 'export const Type = { Object: (x, options) => ({ ...x, ...options }), String: () => ({}), Optional: x => x };'
        : 'export const StringEnum = x => x;' }));
    } }],
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
  return module.exports.default;
}

function harness(init, { saved = [], ui = true } = {}) {
  const entries = [...saved], events = {}, tools = {}, commands = {}, sends = [], notices = [], statuses = [], widgets = [];
  let pending = false, idle = true;
  const ctx = { hasUI: ui, mode: ui ? 'tui' : 'print', isIdle: () => idle, hasPendingMessages: () => pending,
    sessionManager: { getBranch: () => entries },
    ui: { theme: { fg: (_, s) => s }, notify: (...args) => notices.push(args),
      setStatus: (...args) => statuses.push(args), setWidget: (...args) => widgets.push(args) } };
  const pi = { on: (name, handler) => events[name] = handler, registerTool: tool => tools[tool.name] = tool,
    registerCommand: (name, command) => commands[name] = command,
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    sendMessage: (message, options) => sends.push({ kind: 'custom', message, options }),
    sendUserMessage: (message, options) => sends.push({ kind: 'user', message, options }) };
  init(pi);
  events.session_start({}, ctx);
  return { entries, events, tools, commands, sends, notices, statuses, widgets, ctx,
    pending: value => pending = value, idle: value => idle = value };
}
const final = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] };
const turn = (h, message = final) => h.events.agent_end({ messages: [message] }, h.ctx);
const call = (h, name, args) => h.tools[name].execute('id', args, undefined, undefined, h.ctx);

test('tools validate goal, reason, resume and clearing', async () => {
  const h = harness(await load());
  assert.equal(h.tools.set_goal.parameters.additionalProperties, false);
  assert.equal(h.tools.set_goal_status.parameters.additionalProperties, false);
  assert.match((await call(h, 'set_goal_status', { status: 'blocked', reason: 'failed' })).content[0].text, /No current goal/);
  assert.match((await call(h, 'set_goal', { goal: '  ' })).content[0].text, /nonempty/);
  assert.equal(h.entries.length, 0);
  await call(h, 'set_goal', { goal: ' test it ' });
  assert.match((await call(h, 'set_goal_status', { status: 'completed' })).content[0].text, /reason/);
  assert.equal(h.entries.length, 1);
  await call(h, 'set_goal_status', { status: 'blocked', reason: 'Build failed: exit 1' });
  turn(h); assert.equal(h.sends.length, 0);
  await call(h, 'set_goal_status', { status: 'running' });
  await call(h, 'set_goal_status', { status: 'completed', reason: 'Tests passed' });
  assert.equal(h.entries.at(-1).data.goal, null);
  turn(h); assert.equal(h.sends.length, 0);
  assert.equal(h.statuses.at(-1)[1], undefined);
});

test('commands override reason requirement, replace, kickoff and restore branch state', async () => {
  const init = await load();
  const h = harness(init);
  await h.commands.goal.handler('make a thing', h.ctx);
  assert.equal(h.sends[0].kind, 'user');
  await h.commands.goal.handler('pause', h.ctx);
  assert.equal(h.entries.at(-1).data.status, 'blocked');
  await h.commands.goal.handler('resume', h.ctx);
  assert.equal(h.sends.length, 2);
  await h.commands.goal.handler('another goal', h.ctx);
  assert.equal(h.entries.at(-1).data.goal, 'another goal');
  const branch = h.entries.slice(0, 2);
  h.ctx.sessionManager.getBranch = () => branch;
  h.events.session_tree({}, h.ctx);
  assert.match(h.widgets.at(-1)[1][0], /make a thing/);
  const resumed = harness(init, { saved: branch, ui: false });
  turn(resumed);
  assert.equal(resumed.sends.length, 0); // restored blocked state
  await h.commands.goal.handler('stop', h.ctx);
  assert.equal(h.entries.at(-1).data.goal, null);
  assert.equal(resumed.statuses.length, 0);
});

test('repeated reminders only after normal no-tool final and no queued input', async () => {
  const h = harness(await load());
  await call(h, 'set_goal', { goal: 'fix tests' });
  turn(h, { ...final, stopReason: 'aborted' });
  turn(h, { ...final, stopReason: 'error' });
  turn(h, { ...final, content: [{ type: 'toolCall' }] });
  h.pending(true); turn(h); h.pending(false);
  assert.equal(h.sends.length, 0);
  turn(h); turn(h);
  assert.equal(h.sends.length, 2);
  assert.deepEqual(h.sends[0].options, { deliverAs: 'followUp', triggerTurn: true });
  assert.match(h.sends[0].message.content, /fix tests/);
  await call(h, 'set_goal_status', { status: 'blocked', reason: 'Cannot access server' });
  const filtered = h.events.context({ messages: [{ role: 'custom', ...h.sends[0].message }, { role: 'user', content: 'hello' }] });
  assert.equal(filtered.messages.length, 1);
  turn(h); assert.equal(h.sends.length, 2);
});

test('busy command queues kickoff and headless tools remain available', async () => {
  const h = harness(await load(), { ui: false });
  h.idle(false);
  await h.commands.goal.handler('investigate', h.ctx);
  assert.deepEqual(h.sends[0].options, { deliverAs: 'followUp' });
  assert.ok(h.tools.set_goal_status && h.tools.set_goal);
  assert.match(h.events.before_agent_start({ systemPrompt: 'Base' }).systemPrompt, /Base/);
});
