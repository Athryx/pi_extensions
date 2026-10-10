const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { realpathSync } = require('node:fs');
const { resolve, join, dirname } = require('node:path');
const { pathToFileURL } = require('node:url');

// Resolve the installed host, not bundled copies or API stubs.
const root = resolve(dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim())), '../..');
const cwd = resolve(__dirname, '..');
const host = path => import(pathToFileURL(join(root, path)).href);

test('all extensions load and execute against the installed pi API', async () => {
  const { loadExtensions } = await host('dist/core/extensions/loader.js');
  const { validateToolArguments } = await host('node_modules/@earendil-works/pi-ai/dist/utils/validation.js');
  const { extensions, errors, runtime } = await loadExtensions(
    ['ask-question', 'bash', 'goal-mode', 'plan-mode'].map(name => join(cwd, '.pi/extensions', name, 'index.ts')), cwd,
  );
  assert.deepEqual(errors, []);
  assert.equal(extensions.length, 4);
  const { SessionManager } = await host('dist/core/session-manager.js');
  const sessionManager = SessionManager.inMemory(cwd);
  runtime.appendEntry = (customType, data) => sessionManager.appendCustomEntry(customType, data);
  runtime.sendMessage = () => {};
  const ctx = {
    cwd, mode: 'tui', hasUI: true, isProjectTrusted: () => true,
    isIdle: () => true, hasPendingMessages: () => false,
    sessionManager,
    ui: { theme: { fg: (_, text) => text }, setStatus() {}, setWidget() {} },
  };
  const emit = async (name, event = {}) => {
    for (const extension of extensions) for (const handler of extension.handlers.get(name) ?? []) await handler(event, ctx);
  };
  try {
    await emit('session_start');
    const tools = new Map(extensions.flatMap(extension => [...extension.tools].map(([name, tool]) => [name, tool.definition])));
    assert.deepEqual([...tools.keys()].sort(), ['ask_question', 'bash', 'close_bash', 'finish_plan', 'interact_bash', 'set_goal', 'set_goal_status']);
    assert.equal(tools.get('ask_question').executionMode, 'parallel');
    assert.equal(tools.get('ask_question').exposure, 'model-only');
    for (const name of ['set_goal', 'set_goal_status', 'finish_plan']) assert.equal(tools.get(name).executionMode, 'sequential');
    for (const [name, arguments_] of [
      ['set_goal', { goal: 'Compatibility check' }],
      ['set_goal_status', { status: 'completed', reason: 'API check' }],
      ['finish_plan', { approved: false }],
      ['bash', { command: 'printf compatibility', yield_time_ms: 1000 }],
    ]) {
      const tool = tools.get(name);
      const args = validateToolArguments(tool, { name, arguments: arguments_ });
      assert.throws(() => validateToolArguments(tool, { name, arguments: { ...args, extra: true } }), /Validation failed/);
      const result = await tool.execute('compatibility', args, undefined, undefined, ctx);
      assert.ok(Object.hasOwn(result, 'details'), `${name} requires details`);
      assert.equal(result.content[0].type, 'text');
    }
    const event = { systemPromptOptions: { sections: { existing: 'preserved' } } };
    await emit('before_agent_start', event);
    assert.equal(event.systemPromptOptions.sections.existing, 'preserved');
    assert.match(event.systemPromptOptions.sections.goal_mode, /Only call set_goal/);
  } finally {
    await emit('session_shutdown');
  }
});
