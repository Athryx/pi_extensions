const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, mkdir, writeFile, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const {host} = require('../pi/extensions/subagents/test-helper.cjs');
const cwd = resolve(__dirname, '..');

/** A real SDK main/worker workspace, real QuickJS and a strictly local fake provider. */
async function fixture(source, {codemodeOnly = false, pause} = {}) {
  const sdk = await host('dist/index.js');
  const ai = await host('node_modules/@earendil-works/pi-ai/dist/index.js');
  const dir = await mkdtemp(join(tmpdir(), 'pi-workflow-integration-'));
  const agentDir = join(dir, 'agent'), project = join(dir, 'project');
  await mkdir(join(agentDir, 'agents'), {recursive: true});
  await mkdir(project);
  const extensions = ['subagents', 'workflow'].map(name => join(cwd, 'pi/extensions', name, 'index.ts'));
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({extensions, defaultTools: ['read', 'codemode', 'workflow', ...(pause ? ['workflow_pause'] : [])], codemode: {mode: codemodeOnly ? 'only' : 'on'}, retry: {enabled: false}}));
  await writeFile(join(agentDir, 'agents/main.yaml'), 'name: main\nsubagents: {include_defaults: false}\n');
  await writeFile(join(agentDir, 'subagents.json'), JSON.stringify({default_agent: 'main', max_running: 2, max_depth: 3}));
  await writeFile(join(project, 'flow.js'), source);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session;
  const requests = [];
  try {
    const runtime = await sdk.ModelRuntime.create({authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false});
    runtime.registerProvider('workflow-test', {
      api: 'workflow-test', apiKey: 'fake-only', baseUrl: 'http://unused.invalid',
      models: [{id: 'local', name: 'Local fake', reasoning: false, input: ['text'], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 64000, maxTokens: 2000}],
      streamSimple(model, context, options) {
        const stream = ai.createAssistantMessageEventStream();
        requests.push({...context, effectivePrompt: ai.getCurrentSystemPrompt(context.messages)});
        void (async () => {
          const prompt = ai.getCurrentSystemPrompt(context.messages);
          const main = prompt.includes('Name: main.');
          const last = context.messages.at(-1);
          const isLaunch = main && last.role === 'user';
          const content = isLaunch
            ? [{type: 'toolCall', id: 'run-workflow', name: 'workflow', arguments: {path: 'flow.js'}}]
            : [{type: 'text', text: main ? 'Main finished.' : 'Isolated worker answer.'}];
          const output = {role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content, stopReason: 'pending', usage: {input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
          stream.push({type: 'start', partial: output});
          for (const [index, block] of content.entries()) {
            if (block.type === 'toolCall') {
              stream.push({type: 'toolcall_start', contentIndex: index, partial: output});
              stream.push({type: 'toolcall_end', contentIndex: index, toolCall: block, partial: output});
            } else {
              stream.push({type: 'text_start', contentIndex: index, partial: output});
              stream.push({type: 'text_delta', contentIndex: index, delta: block.text, partial: output});
              stream.push({type: 'text_end', contentIndex: index, content: block.text, partial: output});
            }
          }
          output.stopReason = options?.signal?.aborted ? 'aborted' : isLaunch ? 'toolUse' : 'stop';
          if (output.stopReason === 'aborted') { output.errorMessage = 'Cancelled'; stream.push({type: 'error', reason: 'aborted', error: output}); }
          else stream.push({type: 'done', reason: output.stopReason, message: output});
          stream.end();
        })().catch(error => { stream.push({type: 'error', reason: 'error', error}); stream.end(); });
        return stream;
      },
    });
    const settings = sdk.SettingsManager.create(project, agentDir);
    await settings.reload();
    const loader = new sdk.DefaultResourceLoader({cwd: project, agentDir, settingsManager: settings, noExtensions: true, additionalExtensionPaths: extensions, extensionFactories: [sdk.createCodemodeExtension(), ...(pause ? [pi => pi.registerTool({name: 'workflow_pause', label: 'Pause fixture', description: 'Local abort fixture', parameters: {type: 'object', properties: {}, additionalProperties: false}, execute: pause})] : [])]});
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const registry = new sdk.ModelRegistry(runtime);
    const manager = sdk.SessionManager.inMemory(project);
    ({session} = await sdk.createAgentSession({cwd: project, agentDir, settingsManager: settings, resourceLoader: loader, sessionManager: manager, modelRuntime: runtime, model: registry.find('workflow-test', 'local'), thinkingLevel: 'off'}));
    await session.bindExtensions({mode: 'print'});
    return {session, manager, requests, async cleanup() {
      await session.abort();
      await session.extensionRunner.emit({type: 'session_shutdown', reason: 'quit'});
      session.dispose();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(dir, {recursive: true, force: true});
    }};
  } catch (error) {
    if (session) { await session.extensionRunner.emit({type: 'session_shutdown', reason: 'quit'}); session.dispose(); }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, {recursive: true, force: true});
    throw error;
  }
}

for (const codemodeOnly of [false, true]) test(`direct workflow integration from a leaf main (${codemodeOnly ? 'codemode only' : 'normal'})`, async () => {
  const f = await fixture(`
    await workflow.register_agents([{name:'reader', tools:{include_defaults:false, extra:['read']}, subagents:{include_defaults:false}}]);
    const value = await workflow.sequence([
      async (prior, w) => {
        if(prior !== undefined) throw new Error('wrong first input');
        await w.set_status('Read in parallel');
        return await w.parallel([0,1,2].map(i => async branch => {
          await branch.set_status('Read item '+i);
          return await branch.agent('Return a concise answer for item '+i, 'reader');
        }), 'Three readers');
      },
      async (prior, w) => { await w.set_status('Collect answers'); return prior.join('|'); },
    ], 'Integration');
    return value;
  `, {codemodeOnly});
  try {
    assert.equal(f.session.getActiveToolNames().includes('workflow'), true);
    for (const name of ['create_agent','list_agents','send_message','wait_message']) assert.equal(f.session.getActiveToolNames().includes(name), false);
    await f.session.prompt('Run the directed workflow.');
    const result = f.session.messages.find(message => message.role === 'toolResult' && message.toolName === 'workflow');
    assert.ok(result, 'workflow must be model callable even under codemode.only');
    assert.equal(result.isError, false, result.content.map(block => block.text ?? '').join('\n'));
    assert.match(result.content.map(block => block.text ?? '').join('\n'), /Isolated worker answer\.\|Isolated worker answer\.\|Isolated worker answer\./);
    assert.equal(result.usage.totalTokens, 15, 'three worker responses counted once');
    const members = f.manager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === 'subagents.member.v1').map(entry => entry.data);
    assert.equal(members.length, 3);
    assert.equal(new Set(members.map(member => member.identity.groupId)).size, 3);
    for(const member of members) {
      assert.equal(member.identity.role, 'worker');
      assert.equal(member.identity.parentName, null);
      assert.match(member.identity.name, /^reader-\d+$/);
    }
    const groups = f.manager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === 'subagents.group.v1').map(entry => entry.data);
    assert.ok(groups.some(group => group.kind === 'root'));
    assert.ok(groups.some(group => group.kind === 'workflow'));
    assert.equal(f.session.messages.some(message => message.role === 'custom' && message.customType === 'subagents.message.v1'), false, 'no cross-group completion messages');
    const workers = f.requests.filter(request => !request.messages.some(message => message.role === 'toolResult' && message.toolName === 'workflow') && aiPrompt(request).includes('Role: worker'));
    assert.ok(workers.length >= 3);
    for (const request of workers) {
      const declared = request.tools?.map(tool => tool.name) ?? [];
      for (const name of ['create_agent','list_agents','send_message','wait_message','ask_question','finish_plan']) assert.equal(declared.includes(name), false, `${name} leaked to a leaf headless root`);
    }
  } finally {await f.cleanup();}
});
function aiPrompt(request) {return request.effectivePrompt;}

test('real workflow host cancellation preserves partial output and awaits tool cleanup', async () => {
  let started, finished = false;
  const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture('text("partial output"); await workflow.tools.workflow_pause({});', {
    pause: async (_id, _args, signal) => {
      started();
      await new Promise(resolve => { signal.addEventListener('abort', resolve, {once: true}); if (signal.aborted) resolve(); });
      finished = true;
      return {content: [{type: 'text', text: 'Stopped'}], isError: true};
    },
  });
  try {
    const prompt = f.session.prompt('Run the directed workflow.');
    await Promise.race([ready, prompt.then(() => { throw new Error('Workflow ended before pause started: ' + JSON.stringify(f.session.messages)); })]);
    await f.session.abort();
    await prompt;
    const result = f.session.messages.find(message => message.role === 'toolResult' && message.toolName === 'workflow');
    assert.ok(result, 'aborted workflow still emits its final tool result');
    assert.equal(result.isError, true);
    assert.equal(result.details.status, 'cancelled');
    assert.match(result.content.map(block => block.text ?? '').join('\n'), /partial output/);
    assert.equal(finished, true, 'cleanup must finish before workflow returns');
    assert.equal(f.requests.length, 1, 'only the local fake main launch response is generated');
  } finally { await f.cleanup(); }
});
