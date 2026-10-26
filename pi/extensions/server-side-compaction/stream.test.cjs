const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { realpathSync } = require('node:fs');
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
const model = { id: 'gpt-test', provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api', cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 0 } };
const account = 'acct-stream-private';
const token = `h.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.private-signature`;
const ctx = { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }) } };
const checkpoint = { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque-🔒', status: 'completed' };
const input = [
  { type: 'message', role: 'system', content: 'system' },
  { role: 'user', content: 'first user' },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'old reply' }] },
  { type: 'function_call', call_id: 'call_x', name: 'read', arguments: '{ "path":  "x" }' },
  { type: 'function_call_output', call_id: 'call_x', output: 'original tool result' },
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second user' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
];
const users = input.filter(item => item.role === 'user');
const usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 3 } };
const event = (type, fields = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const done = item => event('response.output_item.done', { output_index: 0, item });
const completed = (fields = {}) => event('response.completed', { response: { status: 'completed', usage, ...fields } });
const success = () => done(checkpoint) + completed();
function reply(text, { fragmented = false, hang = false, onCancel = () => {} } = {}) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset < bytes.length) {
        const end = fragmented ? offset + 1 : bytes.length;
        controller.enqueue(bytes.slice(offset, end)); offset = end;
      } else if (!hang) controller.close();
    },
    cancel: onCancel,
  }), { headers: { 'content-type': 'text/event-stream' } });
}
async function compact(options = {}) {
  const { compactPrefix } = await endpoint;
  return compactPrefix({ ctx, model, input, instructions: 'canonical instructions', timeoutMs: 1000, fetch: async () => reply(success()), ...options });
}
const safeError = code => error => {
  assert.equal(error.code, code);
  assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /private-signature|acct-stream-private|secret-body|secret-detail|secret-input/);
  return true;
};

test('Codex streams one compaction request with copied input, instructions and serialized tool settings', async () => {
  const { getAdapter } = await endpoint;
  for (const suffix of ['', '/codex', '/codex/', '/codex/responses']) {
    assert.equal(getAdapter({ ...model, baseUrl: `https://chatgpt.com/backend-api${suffix}` }).endpoint, 'https://chatgpt.com/backend-api/codex/responses');
  }
  const original = structuredClone(input);
  const settings = {
    tools: [{ type: 'function', name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, strict: true }],
    tool_choice: 'auto', parallel_tool_calls: false, text: { format: { type: 'text' } },
    reasoning: { effort: 'low', summary: 'auto' }, include: ['reasoning.encrypted_content'], prompt_cache_key: 'settings-cache',
    previous_response_id: 'forbidden', model: 'wrong', input: ['wrong'], store: true, stream: false,
    instructions: 'wrong', temperature: 0.7, unknown: 'drop',
  };
  let calls = 0;
  const result = await compact({ requestSettings: settings, fetch: async (url, request) => {
    calls++;
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error');
    assert.equal(request.headers.get('authorization'), `Bearer ${token}`);
    assert.equal(request.headers.get('chatgpt-account-id'), account);
    const allowed = Object.fromEntries(['tools', 'tool_choice', 'parallel_tool_calls', 'text', 'reasoning', 'include', 'prompt_cache_key'].map(key => [key, settings[key]]));
    assert.deepEqual(JSON.parse(request.body), { ...allowed, model: model.id, input: [...original, { type: 'compaction_trigger' }], store: false, stream: true, instructions: 'canonical instructions' });
    return reply(success());
  } });
  assert.equal(calls, 1); assert.deepEqual(input, original);
  assert.deepEqual(result.output, [...users, checkpoint]);
  assert.equal(result.usage.input, 80); assert.equal(result.usage.cacheRead, 20); assert.equal(result.usage.reasoning, 3);
  assert.equal(result.usage.cost.total, 0.00022);
  assert.match(result.compatibility.accountFingerprint, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /private-signature|acct-stream-private/);
});

test('Codex completion usage accepts nullable optional token details', async () => {
  const nullable = { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: null, output_tokens_details: null };
  const result = await compact({ fetch: async () => reply(done(checkpoint) + completed({ usage: nullable })) });
  assert.equal(result.usage.input, 10); assert.equal(result.usage.output, 2);
  assert.equal(result.usage.cacheRead, 0); assert.equal(result.usage.totalTokens, 12);
  for (const key of ['input_tokens_details', 'output_tokens_details']) {
    await assert.rejects(compact({ fetch: async () => reply(done(checkpoint) + completed({ usage: { ...nullable, [key]: 'invalid' } })) }), safeError('response'));
  }
});

test('Codex cache routing and beta features preserve existing auth feature flags', async () => {
  const configured = { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token, headers: { 'x-codex-beta-features': 'existing_feature' } }) } };
  await compact({ ctx: configured, prompt_cache_key: 'explicit-cache', fetch: async (_url, request) => {
    assert.equal(JSON.parse(request.body).prompt_cache_key, 'explicit-cache');
    assert.equal(request.headers.get('session_id'), 'explicit-cache');
    assert.equal(request.headers.get('openai-beta'), 'responses=experimental');
    assert.deepEqual(request.headers.get('x-codex-beta-features').split(',').map(value => value.trim()), ['existing_feature', 'remote_compaction_v2']);
    return reply(success());
  } });
});

test('fragmented UTF-8, CRLF, comments and multiline SSE data preserve checkpoint bytes', async () => {
  const item = JSON.stringify(checkpoint);
  const wire = ': keepalive\r\n\r\nevent: response.output_item.done\r\ndata: {"type":"response.output_item.done",\r\ndata: "output_index":0,"item":' + item + '}\r\n\r\n' + completed().replace(/\n/g, '\r\n');
  const result = await compact({ fetch: async () => reply(wire, { fragmented: true }) });
  assert.deepEqual(result.output, [...users, checkpoint]);
});

test('done items are authoritative without terminal output; generated items are not replayed', async () => {
  const generated = [
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'generated-reasoning' },
    { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'do not retain' }], status: 'completed' },
    { type: 'function_call', id: 'fc_1', call_id: 'call_new', name: 'read', arguments: '{}' },
  ];
  for (const terminal of [{}, { output: [...generated, checkpoint] }]) {
    const wire = generated.concat(checkpoint).map((item, output_index) => event('response.output_item.done', { item, output_index })).join('') + completed(terminal);
    const result = await compact({ fetch: async () => reply(wire) });
    assert.deepEqual(result.output, [...users, checkpoint]);
  }
});

test('terminal-only completed output is accepted and retains every original user', async () => {
  const result = await compact({ fetch: async () => reply(completed({ output: [checkpoint] })) });
  assert.deepEqual(result.output, [...users, checkpoint]);
});

test('completed output must agree with previously emitted items', async () => {
  for (const output of [[], [{ ...checkpoint, encrypted_content: 'different' }], [checkpoint, { type: 'message', role: 'assistant', content: 'extra' }]]) {
    await assert.rejects(compact({ fetch: async () => reply(done(checkpoint) + completed({ output })) }), safeError('response'));
  }
});

test('missing completion, missing/duplicate checkpoint and unsuccessful events fail without retries', async () => {
  const cases = [
    '', done(checkpoint), done(checkpoint) + 'data: [DONE]\n\n', completed(),
    done(checkpoint) + done({ ...checkpoint, id: 'cmp_2' }) + completed(),
    completed({ output: [checkpoint, { ...checkpoint, id: 'cmp_2' }] }),
    done({ ...checkpoint, encrypted_content: '' }) + completed(),
    done(checkpoint) + completed({ status: 'incomplete' }),
    done(checkpoint) + completed({ status: 'failed' }),
    event('error', { message: 'secret-detail', code: 'server_error' }),
    done(checkpoint) + event('response.failed', { response: { status: 'failed', error: { message: 'secret-detail' } } }),
    done(checkpoint) + event('response.incomplete', { response: { status: 'incomplete', incomplete_details: { reason: 'secret-detail' } } }),
  ];
  for (const wire of cases) {
    let calls = 0;
    await assert.rejects(compact({ fetch: async () => { calls++; return reply(wire); } }), safeError('response'));
    assert.equal(calls, 1);
  }
});

test('malformed SSE JSON and malformed event payloads expose no response details', async () => {
  for (const wire of [
    'event: response.output_item.done\ndata: {secret-detail\n\n',
    done(checkpoint) + 'event: response.completed\ndata: {secret-detail\n\n',
    event('response.output_item.done', { item: null }) + completed(),
    event('response.completed', { response: null }),
    done(checkpoint) + completed({ usage: { input_tokens: -1 } }),
  ]) await assert.rejects(compact({ fetch: async () => reply(wire) }), safeError('response'));
});

test('SSE byte limits count UTF-8 bytes and cancel a hanging reader', async () => {
  const wire = success();
  let cancelled = false;
  await assert.rejects(compact({ maxResponseBytes: new TextEncoder().encode(wire).length - 1, fetch: async () => reply(wire, { fragmented: true, hang: true, onCancel() { cancelled = true; } }) }), safeError('limit'));
  assert.equal(cancelled, true);
  let declaredCancelled = false;
  await assert.rejects(compact({ maxResponseBytes: 8, fetch: async () => {
    const response = reply('', { hang: true, onCancel() { declaredCancelled = true; } });
    response.headers.set('content-length', '99999'); return response;
  } }), safeError('limit'));
  assert.equal(declaredCancelled, true);
});

test('abort and timeout cancel stalled SSE readers distinctly', async () => {
  for (const mode of ['aborted', 'timeout']) {
    const controller = new AbortController();
    let cancelled = false, timer;
    try {
      await assert.rejects(compact({ signal: controller.signal, timeoutMs: mode === 'timeout' ? 30 : 1000, fetch: async () => {
        if (mode === 'aborted') timer = setTimeout(() => controller.abort(), 10);
        return reply(done(checkpoint), { hang: true, onCancel() { cancelled = true; } });
      } }), error => {
        safeError(mode)(error);
        if (mode === 'aborted') assert.equal(error.name, 'AbortError');
        return true;
      });
      assert.equal(cancelled, true);
    } finally { clearTimeout(timer); }
  }
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(compact({ signal: controller.signal, fetch: async () => { calls++; return reply(success()); } }), safeError('aborted'));
  assert.equal(calls, 0);
});

test('completed terminates and cancels a stream which never closes', async () => {
  let cancelled = false;
  const result = await compact({ timeoutMs: 100, fetch: async () => reply(success(), { hang: true, onCancel() { cancelled = true; } }) });
  assert.deepEqual(result.output, [...users, checkpoint]);
  assert.equal(cancelled, true);
});

test('HTTP, network and reader errors are redacted and never trigger generation or legacy probes', async () => {
  const cases = [
    [async () => new Response('secret-body', { status: 403 }), 'http'],
    [async () => { throw new Error(`secret-detail ${token}`); }, 'network'],
    [async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('secret-detail')); } }), { headers: { 'content-type': 'text/event-stream' } }), 'response'],
  ];
  for (const [fetch, code] of cases) {
    let calls = 0;
    await assert.rejects(compact({ input: [{ role: 'user', content: 'secret-input' }], fetch: (...args) => { calls++; return fetch(...args); } }), safeError(code));
    assert.equal(calls, 1);
  }
});
