const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { realpathSync } = require('node:fs');
const { join, resolve, dirname } = require('node:path');
const { pathToFileURL } = require('node:url');
const root = resolve(dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim())), '../..');
const host = path => import(pathToFileURL(join(root, path)).href);

for (const replacement of ['fork', 'resume', 'reload']) {
  test(`footer renders with an invalidated ctx during ${replacement}`, async () => {
    const { loadExtensions } = await host('dist/core/extensions/loader.js');
    const { FooterComponent } = await host('dist/index.js');
    const { extensions, errors } = await loadExtensions([join(__dirname, 'index.ts')], resolve(__dirname, '../../..'));
    assert.deepEqual(errors, []);
    const extension = extensions[0];
    const native = Object.create(FooterComponent.prototype);
    const original = () => ['path', 'native model/cost'];
    native.render = original;
    const tui = { children: [native], requestRender() {} };
    const model = { provider: 'openai-codex', id: 'test' };
    const token = `h.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-test' } })).toString('base64url')}.s`;
    let stale = false;
    let themePrefix = 'dim';
    const theme = { fg: (_, text) => `${themePrefix}:${text}` };
    let widgetFactory;
    let widget;
    const ui = {
      theme,
      setWidget: (_, factory) => {
        widgetFactory = factory;
        widget = factory(tui, theme);
      },
      notify() { assert.equal(stale, false, 'must not notify through an invalidated command ctx'); },
    };
    const ctx = {
      mode: 'tui', model,
      modelRegistry: { getAll: () => [model], isUsingOAuth: () => true, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }) },
      get ui() {
        assert.equal(stale, false, 'captured ctx.ui is stale');
        return ui;
      },
    };
    const dispatch = async name => { for (const fn of extension.handlers.get(name) ?? []) await fn({}, ctx); };
    const old = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ rate_limit: { primary_window: { limit_window_seconds: 604800, used_percent: 20 } } }) });
    try {
      await dispatch('session_start');
      await extension.commands.get('usage').handler('', ctx);
      assert.match(native.render(100)[2], /^dim:Codex left: weekly 80%/);
      for (let i = 0; i < 3; i++) {
        const previous = widget;
        widget = widgetFactory(tui, theme);
        // Even a late render/dispose from an old widget must not touch its successor.
        previous.render();
        previous.dispose();
        assert.equal(native.render(100).filter(line => line.includes('Codex left:')).length, 1);
        await extension.commands.get('usage').handler('', ctx);
      }
      // The host can redraw after invalidation but before widget disposal.
      stale = true;
      assert.match(native.render(100)[2], /^dim:Codex left: weekly 80%/);
      themePrefix = 'new-theme';
      assert.match(native.render(100)[2], /^new-theme:/);
      await dispatch('session_shutdown');
      assert.equal(native.render, original);
      stale = false;
      await dispatch('session_start');
      await extension.commands.get('usage').handler('', ctx);
      assert.match(native.render(100)[2], /weekly 80%/);
    } finally {
      await dispatch('session_shutdown');
      global.fetch = old;
    }
  });
}

test('startup/command polls coalesce; shutdown aborts and restores footer; late results are ignored', async () => {
  const { loadExtensions } = await host('dist/core/extensions/loader.js');
  const { FooterComponent } = await host('dist/index.js');
  const { extensions, errors } = await loadExtensions([join(__dirname, 'index.ts')], resolve(__dirname, '../../..'));
  assert.deepEqual(errors, []);
  const extension = extensions[0];
  const notices = [];
  const native = Object.create(FooterComponent.prototype);
  const original = () => ['path', '$0.000 (sub) 10%/200k model'];
  native.render = original;
  const tui = { children: [native], requestRender() {} };
  const model = { provider: 'openai-codex', id: 'test' };
  const token = `h.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' } })).toString('base64url')}.s`;
  const ctx = {
    mode: 'tui', model,
    modelRegistry: { getAll: () => [model], isUsingOAuth: () => true, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }) },
    ui: {
      theme: { fg: (color, text) => { assert.equal(color, 'dim'); return `\x1b[90m${text}\x1b[0m`; } },
      setWidget: (_, factory) => factory(tui, ctx.ui.theme), notify: (text, level) => notices.push({ text, level }),
    },
  };
  const dispatch = async name => { for (const fn of extension.handlers.get(name) ?? []) await fn({}, ctx); };
  const old = global.fetch;
  const requests = [];
  global.fetch = (_, init) => new Promise(resolve => requests.push({ init, resolve }));
  try {
    await dispatch('session_start');
    await new Promise(resolve => setImmediate(resolve));
    const command = extension.commands.get('usage');
    const first = command.handler('', ctx);
    const second = command.handler('', ctx);
    assert.equal(requests.length, 1);
    assert.notEqual(native.render, original);
    await dispatch('session_shutdown');
    assert.equal(requests[0].init.signal.aborted, true);
    assert.equal(native.render, original);
    requests[0].resolve({ ok: true, json: async () => ({ plan_type: 'plus', rate_limit: { primary_window: { limit_window_seconds: 604800, used_percent: 90 } } }) });
    await Promise.all([first, second]);
    assert.deepEqual(notices, []);
    await dispatch('session_start');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 2);
    const fresh = command.handler('', ctx);
    requests[1].resolve({ ok: true, json: async () => ({ plan_type: 'pro', rate_limit: { primary_window: { limit_window_seconds: 604800, used_percent: 20 } } }) });
    await fresh;
    assert.equal(native.render(100)[1], original()[1]);
    assert.match(native.render(100)[2], /weekly 80%/);
    assert.ok(native.render(100)[2].startsWith('\x1b[90m'));
    assert.doesNotMatch(native.render(100)[2], /5h/);
    assert.match(notices.at(-1).text, /Plan: pro/);
  } finally {
    await dispatch('session_shutdown');
    global.fetch = old;
  }
});
