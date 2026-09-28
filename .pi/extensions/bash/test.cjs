const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const piRoot = path.resolve(path.dirname(fs.realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim())), '../..');
const esbuild = require(require.resolve('esbuild', { paths: [piRoot] }));

// This standalone test replaces only Pi's agent-dir helper; the tools and shell
// implementation are compiled from the actual extension sources.
async function loadExtension(entry = 'tool.ts') {
const bundle = (await esbuild.build({
  entryPoints: [path.join(__dirname, entry)], bundle: true, platform: 'node', format: 'cjs',
  write: false, packages: 'bundle', nodePaths: [path.join(piRoot, 'node_modules')],
  plugins: [{ name: 'pi-stub', setup(build) {
    build.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: 'pi-stub', namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const getAgentDir = () => "/tmp"; export const SettingsManager = { create: () => ({ getShellPath: () => undefined, getShellCommandPrefix: () => undefined }) };', loader: 'js' }));
  }}],
})).outputFiles[0].text;
const m = { exports: {} };
new Function('module', 'exports', 'require', bundle)(m, m.exports, require);
return m.exports;
}
async function loadTools() { return (await loadExtension()).createBashTools; }
const run = async (tool, args) => tool.execute('id', args);
const statusLine = (result) => result.content[0].text.split('\n\n').at(-1);

test('bash tools reject unknown argument names', async () => {
  const { Check } = await import(require.resolve('typebox/value', { paths: [piRoot] }));
  const { validateToolArguments } = await import(pathToFileURL(path.join(piRoot, 'node_modules/@earendil-works/pi-ai/dist/utils/validation.js')).href);
  const { tools, shutdown } = (await loadTools())(process.cwd());
  const [bash, interact, close] = tools;
  try {
    assert.equal(Check(bash.parameters, { command: 'true', yield_timeout_ms: 60000 }), true);
    assert.equal(Check(bash.parameters, { command: 'true', yield_time_ms: 60000 }), false);
    assert.equal(Check(interact.parameters, { session_name: 'bash1', yield_time_ms: 60000 }), false);
    assert.equal(Check(close.parameters, { session_name: 'bash1', yield_time_ms: 60000 }), false);
    for (const [tool, args] of [
      [bash, { command: 'true', yield_time_ms: 60000 }],
      [interact, { session_name: 'bash1', yield_time_ms: 60000 }],
      [close, { session_name: 'bash1', yield_time_ms: 60000 }],
    ]) {
      assert.throws(() => validateToolArguments(tool, { name: tool.name, arguments: args }), /Validation failed.*must not have additional properties/s);
    }
  } finally { assert.deepEqual(await shutdown(), []); }
});

// Start with stdout on each side of a yield; test that polling consumes only
// new output, stdin is written verbatim, and the log retains everything.
test('foreground and background bash', async () => {
  const createBashTools = await loadTools();
  const { tools, shutdown } = createBashTools(process.cwd());
  const [bash, interact, close] = tools;
  try {
    const fg = await run(bash, { command: 'sleep 0.05; printf foreground', yield_timeout_ms: 1000 });
    assert.match(fg.content[0].text, /^foreground\n\n\[Command ran for [\d.]+s\.\]$/);
    assert.equal(fg.details.fullOutputPath, undefined);
    assert.ok(fg.details.elapsedSeconds >= 0.04);
    assert.equal(fg.details.waitedSeconds, undefined);

    const bg = await run(bash, { command: 'printf first; read x; printf "second:%s" "$x"', session_name: 'test', yield_timeout_ms: 50 });
    assert.equal(bg.details.sessionName, 'test');
    assert.match(bg.content[0].text, /first/);
    assert.match(bg.content[0].text, /Command elapsed: [\d.]+s\. Full output:/);
    assert.doesNotMatch(bg.content[0].text, /waited:/);
    assert.equal(bg.details.waitedSeconds, undefined);
    assert.match(bg.content[0].text, /Use interact_bash to send stdin or read new output/);
    assert.equal(fs.readFileSync(bg.details.fullOutputPath, 'utf8'), 'first');
    const polled = await run(interact, { session_name: 'test', yield_timeout_ms: 10 });
    assert.equal(polled.details.sessionName, 'test');
    assert.match(polled.content[0].text, /Running bash session: test/);
    assert.match(polled.content[0].text, /Command elapsed: [\d.]+s; waited: [\d.]+s this call\. Full output:/);
    assert.ok(polled.details.waitedSeconds >= 0);
    assert.doesNotMatch(polled.content[0].text, /Use interact_bash|close_bash to stop it/);
    const ended = await run(interact, { session_name: 'test', stdin: 'hello\n', yield_timeout_ms: 1000 });
    assert.match(ended.content[0].text, /second:hello/);
    assert.doesNotMatch(ended.content[0].text, /first/);
    assert.equal(fs.readFileSync(bg.details.fullOutputPath, 'utf8'), 'firstsecond:hello');
    assert.equal(ended.details.sessionName, undefined);
    assert.match(ended.content[0].text, /\[Command ran for [\d.]+s; waited: [\d.]+s this call\.\]$/);
    assert.ok(ended.details.waitedSeconds >= 0);
    assert.ok(ended.details.elapsedSeconds >= bg.details.elapsedSeconds);
    assert.rejects(run(interact, { session_name: 'test', yield_timeout_ms: 0 }), /Unknown bash session/);
    fs.unlinkSync(bg.details.fullOutputPath);

    const truncated = await run(bash, { command: 'head -c 80000 /dev/zero | tr "\\0" x', yield_timeout_ms: 1000 });
    assert.equal(truncated.details.truncation.truncated, true);
    assert.match(statusLine(truncated), /^\[Command ran for [\d.]+s\. Showing first [\d.]+KB and last [\d.]+KB of 78\.1KB \(last line is 78\.1KB\)\. Full output: .+\]$/);
    assert.match(truncated.content[0].text, /\.\.\. \[middle output omitted\] \.\.\./);
    assert.equal(truncated.details.waitedSeconds, undefined);
    assert.equal(truncated.details.truncation.outputBytes <= 50 * 1024, true);
    assert.equal(truncated.content[0].text.length < 52000, true);
    assert.equal(fs.statSync(truncated.details.fullOutputPath).size, 80000);
    fs.unlinkSync(truncated.details.fullOutputPath);

    const newlineTruncated = await run(bash, { command: 'printf "short\\n"; head -c 70000 /dev/zero | tr "\\0" x; printf "\\n"', yield_timeout_ms: 1000 });
    assert.equal(newlineTruncated.details.truncation.lastLinePartial, true);
    assert.match(statusLine(newlineTruncated), /last line is 68\.4KB/);
    fs.unlinkSync(newlineTruncated.details.fullOutputPath);

    const auto = await run(bash, { command: 'sleep 30', yield_timeout_ms: 0 });
    assert.match(auto.details.sessionName, /^bash\d+$/);
    await run(close, { session_name: auto.details.sessionName });
    fs.unlinkSync(auto.details.fullOutputPath);

    const unread = await run(bash, { command: 'sleep 0.05; printf close-output; sleep 30', session_name: 'unread', yield_timeout_ms: 0 });
    await new Promise(resolve => setTimeout(resolve, 120));
    const unreadClosed = await run(close, { session_name: 'unread' });
    assert.match(unreadClosed.content[0].text, /close-output/);
    assert.match(unreadClosed.content[0].text, /\[Closed bash session unread\. Command ran for [\d.]+s\. Full output: .+\]$/);
    assert.doesNotMatch(unreadClosed.content[0].text, /waited:/);
    assert.equal(unreadClosed.details.waitedSeconds, undefined);
    assert.equal(unreadClosed.details.fullOutputPath, unread.details.fullOutputPath);
    assert.equal(fs.readFileSync(unread.details.fullOutputPath, 'utf8'), 'close-output');
    fs.unlinkSync(unread.details.fullOutputPath);

    const dup = await run(bash, { command: 'sleep 30', session_name: 'duplicate', yield_timeout_ms: 0 });
    await assert.rejects(run(bash, { command: 'true', session_name: 'duplicate' }), /already exists/);
    const closed = await run(close, { session_name: 'duplicate' });
    assert.match(closed.content[0].text, /Closed bash session/);
    assert.doesNotMatch(closed.content[0].text, /waited:/);
    assert.doesNotMatch(closed.content[0].text, /Use interact_bash|close_bash to stop it/);
    fs.unlinkSync(dup.details.fullOutputPath);
    await assert.rejects(run(bash, { command: 'true', yield_timeout_ms: 300001 }), /yield_timeout_ms/);
    const failed = await run(bash, { command: 'exit 7', yield_timeout_ms: 1000 }).catch(e => e);
    assert.match(failed.message, /Command exited with code 7/);
    assert.match(failed.message, /Command ran for [\d.]+s/);
    const ac = new AbortController();
    const pending = bash.execute('id', { command: 'sleep 30', yield_timeout_ms: 300000 }, ac.signal);
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(pending, /aborted/);
  } finally { assert.deepEqual(await shutdown(), []); }
});

test('truncation keeps both ends and reports the full log in one status line', async () => {
  const { tools, shutdown } = (await loadTools())(process.cwd());
  const [bash, interact, close] = tools;
  try {
    const finished = await run(bash, { command: 'seq 1 2500', yield_timeout_ms: 1000 });
    assert.equal(finished.details.truncation.truncatedBy, 'lines');
    assert.equal(finished.details.truncation.outputLines, 2000); // 999 + marker + 1000
    assert.match(finished.content[0].text, /^1\n2\n/);
    assert.match(finished.content[0].text, /999\n\.\.\. \[middle output omitted\] \.\.\.\n1501\n/);
    assert.match(statusLine(finished), /^\[Command ran for [\d.]+s\. Showing lines 1-999 and 1501-2500 of 2500\. Full output: .+\]$/);
    assert.equal(fs.readFileSync(finished.details.fullOutputPath, 'utf8').trim().split('\n').length, 2500);
    fs.unlinkSync(finished.details.fullOutputPath);

    const staged = await run(bash, { command: 'seq 1 2500; read x; seq 2501 5000; read x; seq 5001 7500', session_name: 'staged', yield_timeout_ms: 500 });
    assert.equal(staged.details.sessionName, 'staged');
    assert.match(statusLine(staged), /^\[Running bash session: staged\. Command elapsed: [\d.]+s\. Showing lines 1-999 and 1501-2500 of 2500\. Full output: .+Use interact_bash/);
    assert.equal(statusLine(staged).match(/Full output:/g)?.length, 1);
    const running = await run(interact, { session_name: 'staged', stdin: 'go\n', yield_timeout_ms: 500 });
    assert.equal(running.details.sessionName, 'staged');
    assert.match(statusLine(running), /^\[Running bash session: staged\. Command elapsed: [\d.]+s; waited: [\d.]+s this call\. Showing lines 1-999 and 1501-2500 of 2500\. Full output: .+\]$/);
    const ended = await run(interact, { session_name: 'staged', stdin: 'go\n', yield_timeout_ms: 1000 });
    assert.equal(ended.details.sessionName, undefined);
    assert.match(statusLine(ended), /^\[Command ran for [\d.]+s; waited: [\d.]+s this call\. Showing lines 1-999 and 1501-2500 of 2500\. Full output: .+\]$/);
    assert.equal(fs.readFileSync(staged.details.fullOutputPath, 'utf8').trim().split('\n').length, 7500);
    fs.unlinkSync(staged.details.fullOutputPath);

    const toClose = await run(bash, { command: 'sleep 0.05; seq 1 2500; sleep 30', session_name: 'to-close', yield_timeout_ms: 0 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const closed = await run(close, { session_name: 'to-close' });
    assert.match(statusLine(closed), /^\[Closed bash session to-close\. Command ran for [\d.]+s\. Showing lines 1-999 and 1501-2500 of 2500\. Full output: .+\]$/);
    assert.equal(fs.readFileSync(toClose.details.fullOutputPath, 'utf8').trim().split('\n').length, 2500);
    fs.unlinkSync(toClose.details.fullOutputPath);

    const huge = await run(bash, { command: 'printf START; head -c 300000 /dev/zero | tr "\\0" x; printf END', yield_timeout_ms: 1000 });
    assert.equal(huge.details.truncation.truncatedBy, 'bytes');
    assert.equal(huge.details.truncation.outputBytes <= 50 * 1024, true);
    assert.match(huge.content[0].text, /^STARTx+/);
    assert.match(huge.content[0].text, /\.\.\. \[middle output omitted\] \.\.\./);
    assert.match(huge.content[0].text, /x+END\n\n\[Command ran for/);
    assert.match(statusLine(huge), /Showing first [\d.]+KB and last [\d.]+KB of 293\.0KB/);
    assert.equal(fs.statSync(huge.details.fullOutputPath).size, 300008);
    fs.unlinkSync(huge.details.fullOutputPath);
  } finally { assert.deepEqual(await shutdown(), []); }
});

test('session shutdown persists a model-visible notice only for stopped background commands', async () => {
  const extension = (await loadExtension('index.ts')).default;
  const handlers = new Map();
  const tools = new Map();
  extension({ on: (name, handler) => handlers.set(name, handler), registerTool: tool => tools.set(tool.name, tool) });
  const notices = [];
  const ctx = {
    cwd: process.cwd(), isProjectTrusted: () => true,
    sessionManager: { appendCustomMessageEntry: (...args) => notices.push(args) },
  };
  await handlers.get('session_start')({}, ctx);
  await handlers.get('session_shutdown')({}, ctx);
  assert.deepEqual(notices, []);

  await handlers.get('session_start')({}, ctx);
  const bash = tools.get('bash');
  const active = await run(bash, { command: 'sleep 30', session_name: 'active', yield_timeout_ms: 0 });
  const done = await run(bash, { command: 'true', session_name: 'already-done', yield_timeout_ms: 0 });
  await new Promise(resolve => setTimeout(resolve, 100));
  try {
    await handlers.get('session_shutdown')({}, ctx);
    assert.equal(notices.length, 1);
    assert.equal(notices[0][0], 'bash-session-shutdown');
    assert.equal(notices[0][2], true);
    assert.match(notices[0][1], /active/);
    assert.match(notices[0][1], /cannot be resumed/i);
    assert.ok(notices[0][1].includes(active.details.fullOutputPath));
    assert.doesNotMatch(notices[0][1], /already-done/);
    await handlers.get('session_shutdown')({}, ctx);
    assert.equal(notices.length, 1);
  } finally {
    fs.unlinkSync(active.details.fullOutputPath);
    if (done.details.fullOutputPath) fs.unlinkSync(done.details.fullOutputPath);
  }
});
