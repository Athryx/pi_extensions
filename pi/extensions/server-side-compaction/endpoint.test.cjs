const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { realpathSync } = require('node:fs');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve, dirname } = require('node:path');
const { pathToFileURL } = require('node:url');
const root = resolve(dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim())), '../..');
const esbuild = require(require.resolve('esbuild', { paths: [root] }));
async function load(file) {
  const agent = await import(pathToFileURL(join(root, 'dist/index.js')).href);
  const result = await esbuild.build({ entryPoints: [join(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['@earendil-works/pi-coding-agent'] });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, name => name === '@earendil-works/pi-coding-agent' ? agent : require(name));
  return module.exports;
}
const endpoint = load('openai.ts');
const config = load('config.ts');
const model = { id: 'gpt-test', provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 0 } };
const ctx = { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'secret-key', headers: { 'OpenAI-Project': 'proj' } }) } };
const output = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'older fact' }] }, { type: 'compaction', encrypted_content: 'opaque', id: 'c1' }];
const envelope = { object: 'response.compaction', output };
const reply = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

test('official provider/API/host/path allowlist and suffix normalization', async () => {
  const { getAdapter } = await endpoint;
  for (const suffix of ['/v1', '/v1/', '/v1/responses']) assert.equal(getAdapter({ ...model, baseUrl: `https://api.openai.com${suffix}` }).endpoint, 'https://api.openai.com/v1/responses/compact');
  for (const baseUrl of ['https://api.openai.com.evil/v1', 'http://api.openai.com/v1', 'https://x@api.openai.com/v1', 'https://api.openai.com/v1?x=1', 'https://api.openai.com/custom', 'https://api.openai.com:8443/v1']) assert.equal(getAdapter({ ...model, baseUrl }), undefined);
  for (const provider of ['azure-openai', 'openrouter', 'custom']) assert.equal(getAdapter({ ...model, provider }), undefined);
  assert.equal(getAdapter({ ...model, api: 'openai-completions' }), undefined);
  for (const suffix of ['', '/codex', '/codex/responses']) assert.equal(getAdapter({ ...model, provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: `https://chatgpt.com/backend-api${suffix}` }).endpoint, 'https://chatgpt.com/backend-api/codex/responses/compact');
});

test('strict config, merged exact precedence, effective agent dir and trust', async () => {
  const { parseConfig, loadConfig, resolvePolicy } = await config;
  for (const value of [null, [], { typo: true }, { mode: 'SERVER' }, { timeoutMs: 0 }, { maxResponseBytes: Infinity }, { providers: { 'bad/name': 'auto' } }, { models: { 'openai/': 'pi' } }, JSON.parse('{"providers":{"__proto__":"server"}}')]) assert.throws(() => parseConfig(value));
  const dir = await mkdtemp(join(tmpdir(), 'pi-compaction-config-'));
  try {
    const agentDir = join(dir, 'agent'), cwd = join(dir, 'project');
    await mkdir(agentDir, { recursive: true }); await mkdir(join(cwd, '.pi'), { recursive: true });
    await writeFile(join(agentDir, 'server-side-compaction.json'), JSON.stringify({ mode: 'pi', providers: { openai: 'server' }, models: { 'openai/gpt-test': 'pi' } }));
    await writeFile(join(cwd, '.pi/server-side-compaction.json'), JSON.stringify({ mode: 'auto', models: { 'openai/gpt-test': 'server' } }));
    const untrusted = await loadConfig({ cwd, isProjectTrusted: () => false }, { agentDir });
    assert.equal(resolvePolicy(model, untrusted.config).backend, 'pi');
    const trusted = await loadConfig({ cwd, isProjectTrusted: () => true }, { agentDir });
    assert.equal(trusted.valid, true); assert.equal(trusted.config.providers.openai, 'server');
    assert.equal(resolvePolicy(model, trusted.config).backend, 'server');
    assert.equal(resolvePolicy(model, trusted.config, 'pi').backend, 'pi');
    assert.equal(resolvePolicy({ ...model, provider: 'custom' }, trusted.config, 'server').backend, 'pi');
    await writeFile(join(cwd, '.pi/server-side-compaction.json'), '{oops');
    const invalid = await loadConfig({ cwd, isProjectTrusted: () => true }, { agentDir });
    assert.equal(invalid.valid, false); assert.match(invalid.warnings[0], /Invalid JSON/);
    assert.equal(resolvePolicy(model, invalid.config, 'server').backend, 'pi');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('fresh resolver credentials, exact structured input, ordered bundle and usage', async () => {
  const { compactPrefix } = await endpoint;
  const input = [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] }, { type: 'function_call', call_id: 'call_x', name: 'read', arguments: '{ "x":  1 }' }, { type: 'function_call_output', call_id: 'call_x', output: 'z'.repeat(8000) }];
  let called = 0;
  const result = await compactPrefix({ ctx, model, input, instructions: 'canonical', prompt_cache_key: 'cache', fetch: async (url, request) => {
    called++; assert.equal(url, 'https://api.openai.com/v1/responses/compact'); assert.equal(request.redirect, 'error');
    assert.equal(request.headers.get('authorization'), 'Bearer secret-key'); assert.equal(request.headers.get('openai-project'), 'proj');
    assert.deepEqual(JSON.parse(request.body), { model: model.id, input, instructions: 'canonical', prompt_cache_key: 'cache' });
    return reply({ ...envelope, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 3 } } });
  } });
  assert.equal(called, 1); assert.deepEqual(result.output, output);
  assert.equal(result.usage.input, 80); assert.equal(result.usage.cacheRead, 20); assert.equal(result.usage.reasoning, 3); assert.equal(result.usage.cost.total, 0.00022);
  assert.match(result.compatibility.accountFingerprint, /^[a-f0-9]{64}$/); assert.ok(!JSON.stringify(result).includes('secret-key'));
});

test('Codex account identity is refresh-stable, account-scoped and safe', async () => {
  const { resolveCompactionAuth, compareCompatibility } = await endpoint;
  const codex = { ...model, provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api' };
  const auth = (account, signature) => ({ modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: `h.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.${signature}` }) } });
  const a = await resolveCompactionAuth(auth('acct-1', 'a'), codex), b = await resolveCompactionAuth(auth('acct-1', 'b'), codex), c = await resolveCompactionAuth(auth('acct-2', 'c'), codex);
  assert.equal(a.headers.get('chatgpt-account-id'), 'acct-1'); assert.equal(a.headers.get('originator'), 'pi');
  assert.equal(compareCompatibility(a.compatibility, b.compatibility), true); assert.equal(compareCompatibility(a.compatibility, c.compatibility), false);
  assert.ok(!JSON.stringify(a.compatibility).includes('acct-1'));
});

test('resolved routing and transport overrides fail closed before network', async () => {
  const { compactPrefix, resolveCompactionAuth } = await endpoint;
  for (const extra of [{ baseUrl: 'https://proxy.example/v1' }, { env: { HTTPS_PROXY: 'http://proxy.example' } }]) {
    let called = false;
    const configured = { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'secret', ...extra }) } };
    await assert.rejects(compactPrefix({ ctx: configured, model, input: output, fetch: async () => { called = true; return reply(envelope); } }), { code: 'unsupported' });
    assert.equal(called, false);
  }
  const removed = await resolveCompactionAuth({ modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'secret', headers: { 'X-Remove': null } }) } }, { ...model, headers: { 'X-Remove': 'remove', host: 'evil.example' } });
  assert.equal(removed.headers.has('x-remove'), false); assert.equal(removed.headers.has('host'), false);
});

test('strict bundle and accounting validation reject unknown or corrupt state', async () => {
  const { validateOutput, normalizeUsage } = await endpoint;
  assert.strictEqual(validateOutput(output), output);
  assert.deepEqual(validateOutput(output.map(item => ({ ...item, status: 'completed' }))), output.map(item => ({ ...item, status: 'completed' })));
  for (const status of ['incomplete', 'in_progress', 'failed', 'cancelled']) assert.throws(() => validateOutput(output.map(item => ({ ...item, status }))));
  for (const bad of [[], [{ type: 'compaction', encrypted_content: '' }], [...output, output[1]], [...output, { type: 'unknown' }], [...output, { role: 'user', content: [{ type: 'input_text', text: 2 }] }]]) assert.throws(() => validateOutput(bad));
  assert.equal(normalizeUsage(undefined, model), undefined);
  assert.throws(() => normalizeUsage({ input_tokens: 1, output_tokens: -1, total_tokens: 0 }, model));
  assert.throws(() => normalizeUsage({ input_tokens: 1, output_tokens: 0, total_tokens: 1, input_tokens_details: { cached_tokens: 2 } }, model));
});

test('safe status, network, malformed, byte limits and no retries', async () => {
  const { compactPrefix } = await endpoint;
  const cases = [
    [async () => new Response('secret-body', { status: 403 }), 'http'],
    [async () => { throw new Error('secret-token'); }, 'network'],
    [async () => new Response('not JSON secret-body'), 'response'],
    [async () => reply({ output }), 'response'],
    [async () => reply(envelope), 'limit'],
  ];
  for (const [fetch, code] of cases) {
    let attempts = 0;
    await assert.rejects(compactPrefix({ ctx, model, input: output, maxResponseBytes: code === 'limit' ? 5 : 1024, fetch: (...args) => { attempts++; return fetch(...args); } }), error => error.code === code && !/secret/.test(error.message));
    assert.equal(attempts, 1);
  }
  await assert.rejects(compactPrefix({ ctx, model, input: output, maxResponseBytes: 5, fetch: async () => new Response('x', { headers: { 'content-length': '99999' } }) }), { code: 'limit' });
});

test('abort is distinct from failure and timeout bounds auth/fetch/body', async () => {
  const { compactPrefix } = await endpoint;
  const controller = new AbortController(); controller.abort(); let called = false;
  await assert.rejects(compactPrefix({ ctx, model, input: output, signal: controller.signal, fetch: async () => { called = true; return reply(envelope); } }), { code: 'aborted', name: 'AbortError' });
  assert.equal(called, false);
  const pending = () => new Promise(() => {});
  await assert.rejects(compactPrefix({ ctx: { modelRegistry: { getApiKeyAndHeaders: pending } }, model, input: output, timeoutMs: 5 }), { code: 'timeout' });
  await assert.rejects(compactPrefix({ ctx, model, input: output, timeoutMs: 5, fetch: pending }), { code: 'timeout' });
  let cancelled = false;
  await assert.rejects(compactPrefix({ ctx, model, input: output, timeoutMs: 5, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) }), { code: 'timeout' });
  assert.equal(cancelled, true);
});
