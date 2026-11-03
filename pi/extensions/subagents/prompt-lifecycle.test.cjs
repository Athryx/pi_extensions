// Exercise the Pi 1.2 event union even when the installed host predates it.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, mkdir, writeFile, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {load, host} = require('./test-helper.cjs');

for (const includeDefaults of [true, false]) test(`main prompt modifiers cover user/custom setup; default skills=${includeDefaults}`, async () => {
  const sdk = await host('dist/index.js');
  const {default: install} = await load('index.ts');
  const dir = await mkdtemp(join(tmpdir(), 'pi-subagents-prompt-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = join(dir, 'agent');
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const handlers = new Map(), tools = new Map();
  const manager = sdk.SessionManager.inMemory(dir);
  const pi = {
    events: {on: () => () => {}},
    on: (name, handler) => handlers.set(name, handler),
    registerCommand() {}, registerShortcut() {},
    registerTool: tool => tools.set(tool.name, tool),
    getAllTools: () => ['read', 'bash', 'edit', 'write'].map(name => ({name})).concat([...tools.values()]),
    setActiveTools() {},
    appendEntry: (type, data) => manager.appendCustomEntry(type, data),
  };
  const ctx = {cwd: dir, mode: 'print', hasUI: false, sessionManager: manager,
    isProjectTrusted: () => false, isIdle: () => true};
  try {
    await mkdir(join(agentDir, 'agents'), {recursive: true});
    await mkdir(join(dir, 'extra'), {recursive: true});
    await writeFile(join(dir, 'extra/SKILL.md'), '---\nname: extra\ndescription: Extra template skill\n---\nSkill instructions');
    await writeFile(join(agentDir, 'subagents.json'), JSON.stringify({default_agent: 'main'}));
    await writeFile(join(agentDir, 'agents/main.yaml'), `name: main\nprompt: TEMPLATE_INSTRUCTIONS\nskills: {include_defaults: ${includeDefaults}, extra_paths: [${JSON.stringify(join(dir, 'extra'))}]}\nsubagents: {extra: [child], default: child}`);
    await writeFile(join(agentDir, 'agents/child.yaml'), 'name: child\ndescription: Handles delegated tasks');
    install(pi);
    await handlers.get('session_start')({reason: 'new'}, ctx);
    const status = async () => (await tools.get('list_agents').execute('list', {all: true})).details.find(agent => agent.name === 'main').status;
    assert.equal(await status(), 'idle');
    for (const trigger of [
      {prompt: 'legacy user input'},
      {messageType: 'user', prompt: 'user input', images: []},
      {messageType: 'custom', message: {role: 'custom', customType: 'test.resume', content: 'resume', display: false, timestamp: 1}},
    ]) {
      const originalSkills = [{name: 'base', filePath: '/base'}, {name: 'extra', filePath: '/old-extra'}];
      const event = {type: 'before_agent_start', ...trigger, systemPrompt: '', systemPromptOptions: {sections: {unrelated: 'retained'}, skills: [...originalSkills]}};
      if (trigger.messageType === 'custom') for (const name of ['prompt', 'images']) Object.defineProperty(event, name, {get() {throw new Error(`Custom runs have no ${name}`);}});
      // Pi >= 1.2 marks a run busy before dispatching its setup hooks.
      handlers.get('before_agent_start')(event, {...ctx, isIdle: () => false});
      assert.equal(event.systemPromptOptions.sections.unrelated, 'retained');
      assert.match(event.systemPromptOptions.sections.agent_identity, /Name: main\. Role: interactive\. Parent: none/);
      assert.equal(event.systemPromptOptions.sections.agent_instructions, 'TEMPLATE_INSTRUCTIONS');
      assert.match(event.systemPromptOptions.sections.agent_workspace, /child — Handles delegated tasks/);
      assert.deepEqual(event.systemPromptOptions.skills.map(skill => skill.name), includeDefaults ? ['base', 'extra'] : ['extra']);
      assert.equal(event.systemPromptOptions.skills.at(-1).filePath, join(dir, 'extra/SKILL.md'));
      assert.equal(originalSkills[1].filePath, '/old-extra');
      assert.equal(await status(), 'running');
      assert.equal(manager.getEntries().some(entry => entry.customType === 'subagents.main-template-lock.v1'), false);
      handlers.get('agent_settled')({}, ctx);
      assert.equal(await status(), 'idle');
    }
  } finally {
    await handlers.get('session_shutdown')?.({}, ctx);
    previous === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, {recursive: true, force: true});
  }
});
