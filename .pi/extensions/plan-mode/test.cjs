const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const root = path.resolve(path.dirname(fs.realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim())), '../..');
const esbuild = require(require.resolve('esbuild', { paths: [root] }));

async function load() {
  const code = (await esbuild.build({
    entryPoints: [join(__dirname, 'index.ts')], bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'stub', setup(build) {
      build.onResolve({ filter: /^(typebox|@earendil-works\/pi-coding-agent)$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
      build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ loader: 'js', contents: args.path === 'typebox'
        ? 'export const Type = { Object: (o, options) => ({ ...o, ...options }), Boolean: () => ({}) };' : 'export {};' }));
    }}],
  })).outputFiles[0].text;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', code)(module, module.exports, require);
  return module.exports;
}

function harness(init, cwd, mode = 'tui', saved = []) {
  const events = {};
  const commands = {};
  const tools = {};
  const messages = [];
  const conversation = [];
  const notices = [];
  let activeTools = ['read', 'bash', 'write', 'edit', 'ask_question'];
  let toolSetChanges = 0;
  const entries = [...saved];
  const ctx = {
    mode, cwd, sessionManager: { getBranch: () => entries },
    ui: { theme: { fg: (_, s) => s }, setStatus: () => {}, notify: (s) => notices.push(s) },
  };
  const pi = {
    on: (name, fn) => { events[name] = fn; },
    registerTool: (tool) => { tools[tool.name] = tool; activeTools.push(tool.name); },
    registerCommand: (name, cmd) => { commands[name] = cmd; },
    getActiveTools: () => [...activeTools], setActiveTools: (names) => { toolSetChanges++; activeTools = [...names]; },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    sendMessage: (message, options) => conversation.push({ role: 'custom', ...message, options }),
    sendUserMessage: (s) => messages.push(s),
  };
  init(pi);
  events.session_start({}, ctx);
  return { events, commands, tools, messages, conversation, notices, ctx, active: () => activeTools, toolSetChanges: () => toolSetChanges };
}

test('filename normalization and resolvePlanTarget', async () => {
  const { planFilename, resolvePlanTarget } = await load();
  assert.equal(planFilename('  improve search results  '), 'IMPROVE_SEARCH_RESULTS.md');
  assert.equal(planFilename('../../oops'), 'OOPS.md');
  assert.throws(() => planFilename(' ... '), /description/);

  // resolvePlanTarget
  const cwd = '/workspace';
  assert.deepEqual(resolvePlanTarget('', cwd), { file: '', description: '' });
  assert.deepEqual(resolvePlanTarget('custom/path/plan.md', cwd), {
    file: '/workspace/custom/path/plan.md',
    description: 'plan',
  });
  assert.deepEqual(resolvePlanTarget('custom/path/plan', cwd), {
    file: '/workspace/custom/path/plan.md',
    description: 'plan',
  });
  assert.deepEqual(resolvePlanTarget('auth_feature.md', cwd), {
    file: '/workspace/plans/auth_feature.md',
    description: 'auth_feature',
  });
  assert.deepEqual(resolvePlanTarget('auth_feature', cwd), {
    file: '/workspace/plans/auth_feature.md',
    description: 'auth_feature',
  });
  assert.deepEqual(resolvePlanTarget('improve search results', cwd), {
    file: '/workspace/plans/IMPROVE_SEARCH_RESULTS.md',
    description: 'improve search results',
  });
});

test('interactive plan lifecycle, Antigravity prompt format, approval and exit notice', async () => {
  const { default: init } = await load();
  const cwd = await mkdtemp(join(tmpdir(), 'pi-plan-test-'));
  try {
    const h = harness(init, cwd);
    assert.ok(h.commands.plan);
    assert.equal(h.commands.implement, undefined, 'Standalone /implement must be removed');
    assert.equal(h.commands['exit-plan'], undefined, 'Standalone /exit-plan must be removed');
    assert.ok(h.active().includes('finish_plan'));
    assert.equal(h.tools.finish_plan.parameters.additionalProperties, false);
    assert.match(h.tools.finish_plan.promptGuidelines[0], /unless plan mode is active/);

    const inactive = await h.tools.finish_plan.execute('id', { approved: true }, undefined, undefined, h.ctx);
    assert.match(inactive.content[0].text, /not active/);

    await h.commands.plan.handler('new feature', h.ctx);
    const file = join(cwd, 'plans', 'NEW_FEATURE.md');
    assert.equal((await fs.promises.stat(join(cwd, 'plans'))).isDirectory(), true);
    assert.deepEqual(h.active(), ['read', 'bash', 'write', 'edit', 'ask_question', 'finish_plan']);
    assert.equal(h.events.before_agent_start, undefined);

    h.events.input({ source: 'interactive', text: 'please plan it' }, h.ctx);
    h.conversation.push({ role: 'user', content: 'please plan it' });
    assert.deepEqual(h.conversation.map((m) => m.role), ['custom', 'user']);
    const prompt = h.conversation[0].content;
    assert.match(prompt, /ask_question/);
    assert.match(prompt, /Goal Description/);
    assert.match(prompt, /User Review Required/);
    assert.match(prompt, /Open Questions/);
    assert.match(prompt, /Proposed Changes/);
    assert.match(prompt, /Verification Plan/);
    assert.match(prompt, /Walkthrough/);
    assert.ok(prompt.includes(file));

    h.events.input({ source: 'extension', text: 'follow-up' }, h.ctx);
    assert.equal(h.conversation.length, 2);
    assert.equal(h.events.tool_call, undefined); // Instructions, not a hard tool gate.

    await h.commands.plan.handler('implement', h.ctx);
    assert.equal(h.messages.length, 0); // Draft must exist before approval.

    await writeFile(file, '# Plan\n');
    await h.commands.plan.handler('implement', h.ctx);
    assert.deepEqual(h.active(), ['read', 'bash', 'write', 'edit', 'ask_question', 'finish_plan']);
    assert.match(h.messages[0], /explicitly approve/);

    await h.commands.plan.handler('another', h.ctx);
    await h.commands.plan.handler('exit', h.ctx);
    h.events.input({ source: 'interactive', text: 'next request' }, h.ctx);
    assert.match(h.conversation.at(-1).content, /WITHOUT APPROVAL/);
    const length = h.conversation.length;
    h.events.input({ source: 'interactive', text: 'later request' }, h.ctx);
    assert.equal(h.conversation.length, length);

    await h.commands.plan.handler('another', h.ctx);
    const blocked = await h.tools.finish_plan.execute('id', { approved: true }, undefined, undefined, h.ctx);
    assert.match(blocked.content[0].text, /still active/);

    const result = await h.tools.finish_plan.execute('id', { approved: false }, undefined, undefined, h.ctx);
    assert.match(result.content[0].text, /without approving/);
    h.events.input({ source: 'interactive', text: 'continue' }, h.ctx);
    assert.match(h.conversation.at(-1).content, /WITHOUT APPROVAL/);

    await h.commands.plan.handler('implement me', h.ctx);
    await writeFile(join(cwd, 'plans', 'IMPLEMENT_ME.md'), '# Ready\n');
    const approved = await h.tools.finish_plan.execute('id', { approved: true }, undefined, undefined, h.ctx);
    assert.match(approved.content[0].text, /implement it now/);
    const count = h.conversation.length;
    h.events.input({ source: 'interactive', text: 'next' }, h.ctx);
    assert.equal(h.conversation.length, count); // Approval must not send a no-approval notice.
    assert.equal(h.toolSetChanges(), 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('dynamic no-arg planning and auto-discovery of written plan', async () => {
  const { default: init } = await load();
  const cwd = await mkdtemp(join(tmpdir(), 'pi-plan-dynamic-'));
  try {
    const h = harness(init, cwd);
    // Enter plan mode with no argument
    await h.commands.plan.handler('', h.ctx);
    assert.ok(h.notices.some((n) => n.includes('Plan mode enabled')));
    assert.equal((await stat(join(cwd, 'plans'))).isDirectory(), true);

    // Verify injected prompt instructs dynamic filename under plans/
    h.events.input({ source: 'interactive', text: 'plan something cool' }, h.ctx);
    const prompt = h.conversation[0].content;
    assert.match(prompt, /No plan path was specified/);
    assert.match(prompt, /plans\/<plan_name>\.md/);
    assert.match(prompt, /Goal Description/);
    assert.match(prompt, /Walkthrough/);

    // /plan implement before writing plan fails
    await h.commands.plan.handler('implement', h.ctx);
    assert.equal(h.messages.length, 0);
    assert.ok(h.notices.some((n) => n.includes('Write a plan in plans/ before approving it')));

    // Write a plan file dynamically chosen by the model
    const chosenPlan = join(cwd, 'plans', 'cool_feature.md');
    await writeFile(chosenPlan, '# Cool Feature Plan\n');

    // /plan implement now discovers the plan
    await h.commands.plan.handler('implement', h.ctx);
    assert.equal(h.messages.length, 1);
    assert.match(h.messages[0], /explicitly approve the plan in .*cool_feature\.md/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('custom relative path creates directories and sets explicit target', async () => {
  const { default: init } = await load();
  const cwd = await mkdtemp(join(tmpdir(), 'pi-plan-custom-'));
  try {
    const h = harness(init, cwd);
    await h.commands.plan.handler('docs/architecture/new_system.md', h.ctx);
    assert.equal((await stat(join(cwd, 'docs', 'architecture'))).isDirectory(), true);

    h.events.input({ source: 'interactive', text: 'plan it' }, h.ctx);
    const prompt = h.conversation[0].content;
    assert.ok(prompt.includes(join(cwd, 'docs', 'architecture', 'new_system.md')));
    assert.ok(prompt.includes(join(cwd, 'docs', 'architecture', 'walkthrough.md')));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('resuming a planning session restores its indicator and exit tool', async () => {
  const { default: init } = await load();
  const cwd = await mkdtemp(join(tmpdir(), 'pi-plan-resume-'));
  try {
    const file = join(cwd, 'plans', 'RESUME.md');
    const h = harness(init, cwd, 'tui', [{ type: 'custom', customType: 'project-plan-mode',
      data: { active: true, description: 'resume', file, exitNotice: false } }]);
    assert.ok(h.active().includes('finish_plan'));
    assert.ok(h.active().includes('bash'));
    h.events.input({ source: 'interactive', text: 'continue' }, h.ctx);
    assert.match(h.conversation[0].content, /PLAN MODE ACTIVE/);
    assert.equal(h.events.tool_call, undefined);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('no commands or tool registered headlessly', async () => {
  const { default: init } = await load();
  const h = harness(init, '/tmp', 'print');
  assert.deepEqual(Object.keys(h.commands), []);
  assert.deepEqual(Object.keys(h.tools), []);
  assert.equal(h.events.before_agent_start, undefined);
  h.events.input({ source: 'interactive', text: 'hello' }, h.ctx);
  assert.equal(h.conversation.length, 0);
});
