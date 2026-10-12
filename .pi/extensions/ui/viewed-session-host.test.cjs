const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { load, host } = require('../subagents/test-helper.cjs');

const plain = lines => lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
const until = async predicate => {
  for (let n = 0; n < 300; n++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the in-process test worker');
};
function terminal() {
  let input;
  const writes = [];
  return {
    columns: 100, rows: 40, kittyProtocolActive: false, writes,
    start: listener => { input = listener; }, stop: () => { input = undefined; },
    press: data => { assert.ok(input, 'fake terminal is started'); input(data); },
    write: data => writes.push(data), drainInput: async () => {},
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
    clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
  };
}

test('real InteractiveMode startup discovers UI service and /subagents demo views a real in-process SDK worker', { timeout: 20000 }, async () => {
  const sdk = await host('dist/index.js');
  const ai = await host('node_modules/@earendil-works/pi-ai/dist/index.js');
  const { createEventBus } = await host('dist/core/event-bus.js');
  const shared = await load('../shared/viewed-session.ts');
  const dir = await mkdtemp(join(tmpdir(), 'pi-viewed-host-'));
  const cwd = join(dir, 'project'), agentDir = join(dir, 'agent');
  await mkdir(cwd); await mkdir(agentDir);
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const events = createEventBus();
  const term = terminal();
  let runtime, mode, releaseWorker;
  const workerGate = new Promise(resolve => { releaseWorker = resolve; });
  const requests = [];
  try {
    const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    modelRuntime.registerProvider('viewed-host-test', {
      api: 'viewed-host-test', apiKey: 'in-process-only', baseUrl: 'http://unused.invalid',
      models: [{ id: 'fake', name: 'Fake', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
      streamSimple(model, context) {
        const stream = ai.createAssistantMessageEventStream();
        const worker = ai.getCurrentSystemPrompt(context.messages).includes('Instance: demo');
        requests.push({ worker, context });
        assert.ok(requests.length <= 4, 'test provider cannot start an unbounded workflow');
        void (async () => {
          const answer = {
            role: 'assistant', api: model.api, provider: model.provider, model: model.id,
            timestamp: Date.now(), content: [{ type: 'text', text: worker ? 'WORKER LIVE HOST TEXT' : 'MAIN LOCAL REPLY' }], stopReason: 'pending',
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
          stream.push({ type: 'start', partial: answer });
          stream.push({ type: 'text_start', contentIndex: 0, partial: answer });
          stream.push({ type: 'text_delta', contentIndex: 0, delta: answer.content[0].text, partial: answer });
          if (worker) {
            await workerGate;
            answer.content[0].text += ' — WORKER FINAL HOST TEXT';
            stream.push({ type: 'text_delta', contentIndex: 0, delta: ' — WORKER FINAL HOST TEXT', partial: answer });
          }
          stream.push({ type: 'text_end', contentIndex: 0, content: answer.content[0].text, partial: answer });
          answer.stopReason = 'stop';
          stream.push({ type: 'done', reason: 'stop', message: answer });
          stream.end();
        })().catch(error => { stream.end(); throw error; });
        return stream;
      },
    });
    const model = modelRuntime.getModel('viewed-host-test', 'fake');
    assert.ok(model);
    const manager = sdk.SessionManager.inMemory(cwd);
    // Avoid first-install changelog/telemetry startup; this is an existing history.
    manager.appendMessage({ role: 'user', content: 'MAIN HOST HISTORY', timestamp: 1 });
    const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const services = await sdk.createAgentSessionServices({
        cwd, agentDir, modelRuntime,
        settingsManager: sdk.SettingsManager.inMemory({ theme: 'dark', quietStartup: true, showTerminalProgress: false, compaction: { enabled: false }, retry: { enabled: false } }),
        resourceLoaderOptions: {
          eventBus: events, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          additionalExtensionPaths: [join(__dirname, 'index.ts'), join(__dirname, '../subagents/index.ts')],
        },
      });
      return { ...(await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })), services, diagnostics: services.diagnostics };
    };
    runtime = await sdk.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: manager });
    mode = new sdk.InteractiveMode(runtime, { terminal: term, tuiMode: 'regular' });
    // Keep all production startup/layout/binding code, without installing process handlers.
    mode.registerSignalHandlers = () => {};
    mode.unregisterSignalHandlers = () => {};
    await mode.init(); // Unlike run(), does not check remote catalogs, packages or versions.
    const service = shared.requestViewedSessionAPI({ events });
    assert.ok(service);
    assert.equal(service.available, true, 'genuine host startup creates the recognized native tree');
    assert.equal(mode.renderer.children.length, 7);
    assert.equal(mode.documentContainer.children[2], mode.chatContainer);
    assert.equal(mode.renderer.getFocusedComponent(), mode.editor);
    assert.deepEqual(requests, [], 'startup does not invoke any model');
    assert.match(plain(mode.renderer.children[5].render(100)), /● main \(main\)/);
    const create = runtime.session.getToolDefinition('create_agent');
    assert.ok(create);
    // The actual subagents tool owns the real workspace; only the model provider is fake.
    await create.execute('host-create-demo', { name: 'demo', task: 'Give a deterministic test answer.' }, new AbortController().signal);
    await until(() => requests.some(request => request.worker));
    await runtime.session.prompt('/subagents demo');
    const viewedId = service.getViewedSession().id;
    assert.match(service.getViewedSession().title, /demo/);
    assert.notEqual(mode.documentContainer.children[2], mode.chatContainer);
    await until(() => plain(mode.documentContainer.children[2].render(100)).includes('WORKER LIVE HOST TEXT'));
    assert.doesNotMatch(plain(mode.documentContainer.children[2].render(100)), /MAIN HOST HISTORY/);
    assert.match(plain(mode.renderer.children[5].render(100)), /● demo \(subagent\)/);
    term.press('\x1b]'); // Alt+] cycles worker → main without switching sessions.
    await until(() => !service.getViewedSession());
    term.press('\x1b['); // Alt+[ cycles main → worker, even while it runs.
    await until(() => service.getViewedSession()?.id === viewedId);
    const history = [...mode.editor.history];
    const mainMessages = [...runtime.session.messages];
    const mainChatChildren = [...mode.chatContainer.children];
    mode.editor.setText('do not submit this worker-looking prompt');
    term.press('\r');
    assert.deepEqual(mode.editor.history, history);
    assert.deepEqual(runtime.session.messages, mainMessages);
    assert.deepEqual(mode.chatContainer.children, mainChatChildren, 'real native warnings must not append into offscreen main chat');
    assert.match(plain(mode.documentContainer.children[2].render(100)), /Agent view is read-only/);
    term.press('\x10'); // Block native model cycling without appending a main warning.
    assert.deepEqual(mode.chatContainer.children, mainChatChildren);
    assert.match(plain(mode.documentContainer.children[2].render(100)), /This control belongs to main/);
    assert.equal(mode.editor.getText(), 'do not submit this worker-looking prompt');
    term.press('\x0f');
    assert.equal(manager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === 'ui-view').at(-1).data.mode, 'compact-code');
    term.press('\x1b');
    assert.equal(service.getViewedSession(), undefined);
    assert.equal(mode.documentContainer.children[2], mode.chatContainer);
    // Use the host's production renderer-switch path, then rediscover on its real layout.
    assert.equal(mode.switchTuiMode('fullscreen', false, true), true);
    assert.equal(mode.renderer.children.length, 7);
    assert.equal(shared.requestViewedSessionAPI({ events }).available, true);
    await runtime.session.prompt('/subagents demo');
    assert.equal(shared.requestViewedSessionAPI({ events }).getViewedSession().id, viewedId);
    mode.renderer.renderNow();
    assert.match(plain(mode.documentContainer.children[2].render(100)), /WORKER LIVE HOST TEXT/);
    releaseWorker();
    await until(() => plain(mode.documentContainer.children[2].render(100)).includes('WORKER FINAL HOST TEXT'));
    await runtime.session.prompt('/subagents main');
    assert.equal(shared.requestViewedSessionAPI({ events }).getViewedSession(), undefined);
    assert.equal(mode.documentContainer.children[2], mode.chatContainer);
    term.press('\x1b]'); // Idle workers remain in the cycle in fullscreen.
    await until(() => shared.requestViewedSessionAPI({ events }).getViewedSession()?.id === viewedId);
    assert.match(plain(mode.renderer.children[5].render(100)), /● demo \(subagent\)/);
    term.press('\x1b');
    assert.ok(term.writes.length > 0, 'native renderers draw through the injected terminal');
    assert.ok(requests.every(request => request.context), 'all model work used the deterministic local provider');
  } finally {
    releaseWorker();
    mode?.stop(); // Do not call InteractiveMode.shutdown(), which exits the process.
    await runtime?.dispose();
    mode?.themeController.dispose();
    oldAgentDir === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(dir, { recursive: true, force: true });
  }
});
