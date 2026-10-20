const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { realpathSync } = require('node:fs');
const { join, resolve, dirname } = require('node:path');
const { pathToFileURL } = require('node:url');
const root = resolve(dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim())), '../..');
const host = path => import(pathToFileURL(join(root, path)).href);
const esbuild = require(require.resolve('esbuild', { paths: [root] }));
const packages = Promise.all([host('dist/index.js'), host('node_modules/@earendil-works/pi-tui/dist/index.js')]).then(([agent, tui]) => ({
  '@earendil-works/pi-coding-agent': agent, '@earendil-works/pi-tui': tui,
}));
async function load(file) {
  const dependencies = await packages;
  const result = await esbuild.build({ entryPoints: [join(__dirname, file)], bundle: true, write: false, platform: 'node', format: 'cjs', external: Object.keys(dependencies) });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, name => dependencies[name] ?? require(name));
  return module.exports;
}
const usageModule = load('usage.ts');
const window = (seconds, used = 25) => ({ limit_window_seconds: seconds, used_percent: used, reset_at: 2000 });
const fixture = { plan_type: 'plus', rate_limit: { allowed: true, limit_reached: false, primary_window: window(18000), secondary_window: window(604800, 40) }, credits: { balance: '12.5', has_credits: true, unlimited: false } };
const token = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' } })).toString('base64url')}.sig`;
const model = { provider: 'openai-codex', id: 'test' };
function context(overrides = {}) {
  return { model, modelRegistry: { getAll: () => [model], isUsingOAuth: () => true, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }), ...overrides } };
}

test('remaining percentages, subscription metadata and reset times', async () => {
  const { parseUsage, footerText, usageDetails } = await usageModule;
  const data = parseUsage(fixture, 1000);
  assert.equal(footerText(data), 'Codex left: weekly 60% · 5h 75%');
  assert.equal(data.limits[0].windows[0].resetAt, 2000000);
  assert.match(usageDetails(data), /Plan: plus/);
  assert.match(usageDetails(data), /Credits: 12.5 \(available\)/);
  assert.match(footerText(data, true), /\(stale\)/);
});

test('weekly-only primary window never invents a 5h limit', async () => {
  const { parseUsage, footerText, usageDetails } = await usageModule;
  const data = parseUsage({ plan_type: 'pro', rate_limit: { primary_window: window(604800), secondary_window: null } });
  assert.equal(footerText(data), 'Codex left: weekly 75%');
  assert.doesNotMatch(usageDetails(data), /5h/);
});

test('unknown windows and missing percentages are not inferred as 5h or zero usage', async () => {
  const { parseUsage, footerText, usageDetails } = await usageModule;
  const data = parseUsage({ rate_limit: { primary_window: { reset_after_seconds: 60 }, secondary_window: { limit_window_seconds: 604800 } } }, 1000);
  assert.equal(footerText(data), 'Codex left: weekly ?');
  assert.equal(data.limits[0].windows[0].resetAt, 61000);
  assert.match(usageDetails(data), /primary: \? left/);
  assert.throws(() => parseUsage({ error: 'bad' }), /unrecognized/);
});

test('code review, additional limits, credits, clamp and sanitize', async () => {
  const { parseUsage, usageDetails } = await usageModule;
  const data = parseUsage({ ...fixture, plan_type: 'plus\x1b\n', code_review_rate_limit: { primary_window: window(604800, 110), limit_reached: true }, additional_rate_limits: [{ limit_name: 'Fast', rate_limit: { primary_window: window(18000, -5) } }] });
  assert.equal(data.plan, 'plus');
  assert.match(usageDetails(data), /Code review — limit reached/);
  assert.equal(data.limits[1].windows[0].remaining, 0);
  assert.equal(data.limits[2].windows[0].remaining, 100);
});

test('poll uses Pi auth and sends tokens only to fixed endpoint', async () => {
  const { fetchUsage, USAGE_URL } = await usageModule;
  const old = global.fetch;
  let calls = 0;
  global.fetch = async (url, init) => {
    calls++;
    assert.equal(url, USAGE_URL);
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(init.headers['ChatGPT-Account-Id'], 'acct-123');
    assert.equal(init.redirect, 'error');
    return { ok: true, json: async () => fixture };
  };
  try {
    assert.equal((await fetchUsage(context(), new AbortController().signal)).plan, 'plus');
    await assert.rejects(fetchUsage(context({ isUsingOAuth: () => false }), new AbortController().signal), /No compatible/);
    assert.equal(calls, 1);
  } finally { global.fetch = old; }
});

test('HTTP and network errors do not expose response bodies or credentials', async () => {
  const { fetchUsage, tokenAccount } = await usageModule;
  assert.equal(tokenAccount('sk-secret'), undefined);
  const old = global.fetch;
  try {
    global.fetch = async () => ({ ok: false, status: 401, text: async () => token });
    await assert.rejects(fetchUsage(context(), new AbortController().signal), error => /HTTP 401/.test(error.message) && !error.message.includes(token));
    global.fetch = async () => { throw new Error(token); };
    await assert.rejects(fetchUsage(context(), new AbortController().signal), /Could not reach/);
  } finally { global.fetch = old; }
});

test('footer preserves native layout, fits narrow widths and restores instance', async () => {
  const { UsageFooter } = await load('footer.ts');
  const { FooterComponent } = (await packages)['@earendil-works/pi-coding-agent'];
  const { visibleWidth } = (await packages)['@earendil-works/pi-tui'];
  const native = Object.create(FooterComponent.prototype);
  const original = width => ['path', `↑100 $0.000 (sub) 10%/200k${' '.repeat(Math.max(0, width - 35))}model`, 'other status'];
  native.render = original;
  let text = 'Codex left: weekly 60% · 5h 75%';
  const adapter = new UsageFooter({ children: [{ children: [native] }], requestRender() {} }, () => text);
  const lines = native.render(100);
  assert.equal(lines[1], original(100)[1]);
  assert.equal(lines[2], text);
  assert.equal(lines[0], 'path');
  assert.equal(lines[3], 'other status');
  for (const width of [1, 12, 30, 60, 100]) assert.ok(visibleWidth(native.render(width)[2]) <= width);
  text = '';
  assert.deepEqual(native.render(100), original(100));
  adapter.dispose(); adapter.dispose();
  assert.equal(native.render, original);
});

test('footer never mutates cached native rows and detached wrappers stay inert', async () => {
  const { UsageFooter } = await load('footer.ts');
  const { FooterComponent } = (await packages)['@earendil-works/pi-coding-agent'];
  const native = Object.create(FooterComponent.prototype);
  const cached = Object.freeze(['path', 'model/cost', 'other status']);
  native.render = () => cached;
  const tui = { children: [native], requestRender() {} };
  let text = 'Codex left: weekly 73%';
  const first = new UsageFooter(tui, () => text);
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(native.render(100), ['path', 'model/cost', text, 'other status']);
  }
  text = 'Codex left: weekly 72%';
  assert.equal(native.render(100)[2], text);
  // Simulate another extension wrapping ours before teardown.
  const retained = native.render;
  native.render = width => retained(width);
  first.dispose();
  assert.deepEqual(native.render(100), cached);
  const second = new UsageFooter(tui, () => text);
  assert.equal(native.render(100).filter(line => line.includes('Codex left:')).length, 1);
  second.dispose();
  assert.deepEqual(native.render(100), cached);
});

test('extension loads, /usage forces a poll and rejects arguments without polling', async () => {
  const { loadExtensions } = await host('dist/core/extensions/loader.js');
  const { extensions, errors } = await loadExtensions([join(__dirname, 'index.ts')], resolve(__dirname, '../../..'));
  assert.deepEqual(errors, []);
  const extension = extensions[0];
  const command = extension.commands.get('usage');
  const notices = [];
  const ctx = { ...context(), mode: 'rpc', ui: { notify: (text, level) => notices.push({ text, level }) } };
  const old = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: true, json: async () => fixture }; };
  try {
    await command.handler('bad', ctx);
    assert.equal(calls, 0);
    await command.handler('', ctx);
    await command.handler('', ctx);
    assert.equal(calls, 2);
    assert.match(notices.at(-1).text, /Codex subscription usage/);
    assert.equal(notices.at(-1).level, 'info');
    await Promise.all(extension.handlers.get('session_shutdown').map(fn => fn({}, ctx)));
  } finally { global.fetch = old; }
});
