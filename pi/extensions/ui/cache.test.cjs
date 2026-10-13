const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { realpathSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const root = resolve(dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim())), '../..');
const host = path => import(pathToFileURL(join(root, path)).href);
const ready = (async () => {
  const { createJiti } = await host('node_modules/jiti/lib/jiti.mjs');
  const jiti = createJiti(__filename, { fsCache: false, moduleCache: false, alias: {
    '@earendil-works/pi-coding-agent': join(root, 'dist/index.js'),
    '@earendil-works/pi-tui': join(root, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
  } });
  const compact = await jiti.import(join(__dirname, 'compact.ts'));
  const emphasis = await jiti.import(join(__dirname, 'emphasis.ts'));
  const syntax = await jiti.import(join(__dirname, 'syntax-highlight.ts'));
  const tui = await host('node_modules/@earendil-works/pi-tui/dist/index.js');
  const themes = await host('dist/modes/interactive/theme/theme.js');
  const { ToolExecutionComponent } = await host('dist/modes/interactive/components/tool-execution.js');
  const { CustomMessageComponent } = await host('dist/modes/interactive/components/custom-message.js');
  themes.initTheme('dark');
  return { ...compact, ...emphasis, ...syntax, ...tui, themes, ToolExecutionComponent, CustomMessageComponent };
})();
const plain = lines => lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
function scene(api, theme = () => api.themes.theme) {
  const tui = new api.Container(); tui.requestRender = () => {};
  const chat = new api.Container(); tui.addChild(chat);
  const view = new api.CompactView(tui, theme);
  return { tui, chat, view };
}
function tool(api, tui, name, id, args, details) {
  const row = new api.ToolExecutionComponent(name, id, args, { showImages: false }, undefined, tui, '/project');
  row.setArgsComplete(); row.markExecutionStarted();
  row.updateResult({ content: [{ type: 'text', text: 'one\ntwo' }], details, isError: false });
  return row;
}
function countedTheme(theme) {
  let calls = 0;
  return {
    theme: new Proxy(theme, { get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? (...args) => {
        if (['fg', 'bold', 'getFgAnsi'].includes(property)) calls++;
        return value.apply(target, args);
      } : value;
    } }),
    calls: () => calls,
  };
}

test('spinner frames reuse complete rows, custom bodies, messages, grouping and parsed nested arguments', async () => {
  const api = await ready;
  const counter = countedTheme(api.themes.theme);
  const { tui, chat, view } = scene(api, () => counter.theme);
  const parent = tool(api, tui, 'codemode', 'parent', { code: 'text("hidden");' }, { calls: [
    { id: 'parent/1', name: 'read', args: '{"path":"first.ts"}', status: 'ok' },
    { id: 'parent/2', name: 'read', args: '{"path":"second.ts"}', status: 'ok' },
    { id: 'parent/3', name: 'bash', args: '{"command":"printf hello"}', status: 'error' },
  ] });
  const questions = tool(api, tui, 'ask_question', 'questions', { questions: [{ question: 'A long question? '.repeat(20) }] },
    { questions: [{ question: 'A long question? '.repeat(20), answer: { answer: 'A long answer. '.repeat(20), notes: 'Notes' } }] });
  const incoming = new api.CustomMessageComponent({ role: 'custom', customType: 'subagents.message.v1', display: true,
    content: '', details: { from: 'worker', message: 'A long message. '.repeat(40) }, timestamp: 1 }, undefined, api.themes.getMarkdownTheme());
  chat.addChild(parent); chat.addChild(questions); chat.addChild(incoming);
  const parse = JSON.parse; let parses = 0;
  JSON.parse = (...args) => { parses++; return parse(...args); };
  try {
    const first = chat.render(120);
    const rows = [parent, questions, incoming].map(row => row.render(120));
    const calls = counter.calls(), parsed = parses;
    assert.ok(parsed >= 3);
    for (let frame = 0; frame < 30; frame++) {
      assert.deepEqual(chat.render(120), first);
      [parent, questions, incoming].forEach((row, index) => assert.equal(row.render(120), rows[index]));
    }
    assert.equal(parses, parsed, 'saved nested arguments are not parsed again');
    assert.equal(counter.calls(), calls, 'no styling/color/wrapping work for unchanged rows');
  } finally { JSON.parse = parse; view.dispose(); }
});

test('keys detect in-place argument, result, status and custom body changes without serializing payloads', async () => {
  const api = await ready;
  const { tui, chat, view } = scene(api);
  const read = tool(api, tui, 'read', 'read', { path: 'before.ts' });
  const edit = tool(api, tui, 'edit', 'edit', { path: 'edit.ts' }, { firstChangedLine: 4 });
  const question = tool(api, tui, 'ask_question', 'question', { questions: [{ question: 'Question?' }] },
    { questions: [{ question: 'Question?', answer: { answer: 'Before', notes: 'Old note' } }] });
  const write = tool(api, tui, 'write', 'write', { path: 'write.ts', content: 'a\nb' });
  write.args.toJSON = () => { throw new Error('never serialize complete arguments on spinner frames'); };
  [read, edit, question, write].forEach(row => chat.addChild(row));
  try {
    chat.render(120);
    read.args.path = 'after.ts'; read.result.content[0].text += '\nthree';
    edit.result.details.firstChangedLine = 8;
    question.result.details.questions[0].answer.answer = 'After';
    question.result.details.questions[0].answer.notes = 'New note';
    write.args.content += '\nc';
    const changed = plain(chat.render(120));
    assert.match(changed, /after\.ts:1-3/); assert.match(changed, /edit\.ts:8/);
    assert.match(changed, /answer: After/); assert.match(changed, /notes: New note/);
    assert.match(changed, /write\.ts:1-3/);
    read.result.isError = true; assert.match(plain(chat.render(120)), /after\.ts.*✗/);
    question.isPartial = true; assert.match(plain(chat.render(120)), /answer: Pending/);
    // Explicit invalidation also invokes Pi's native fallback renderer, which
    // is allowed to serialize arguments; spinner rendering above must not.
    delete write.args.toJSON;
    const cached = write.render(120); write.invalidate(); assert.notEqual(write.render(120), cached);
  } finally { view.dispose(); }
});

test('nested rows retain caches but reflect changed previews, live in-place updates and removed calls', async () => {
  const api = await ready;
  const { tui, chat, view } = scene(api);
  const calls = [{ id: 'cm/1', name: 'read', args: '{"path":"saved.ts"}', status: 'ok' }];
  const parent = tool(api, tui, 'codemode', 'cm', { code: 'text(1);' }, { calls }); chat.addChild(parent);
  try {
    chat.render(100); const initial = parent.render(100); assert.equal(parent.render(100), initial);
    calls[0].args = '{"path":"changed.ts","offset":7}'; assert.match(plain(chat.render(100)), /changed\.ts:7/);
    view.nestedCalls.set('cm/1', { name: 'read', args: { path: 'live.ts' }, running: true });
    assert.match(plain(chat.render(100)), /live\.ts ⋯/);
    const live = view.nestedCalls.get('cm/1'); live.args.path = 'final.ts'; live.running = false;
    live.result = { content: [{ type: 'text', text: 'a\nb' }] };
    assert.match(plain(chat.render(100)), /final\.ts:1-2/);
    live.result.content[0].text += '\nc'; assert.match(plain(chat.render(100)), /final\.ts:1-3/);
    view.nestedCalls.clear(); assert.match(plain(chat.render(100)), /changed\.ts:7/);
    calls.length = 0; assert.doesNotMatch(plain(chat.render(100)), /changed\.ts/);
  } finally { view.dispose(); }
});

test('width, theme, grouping visibility, padding and view mode invalidate cached output', async () => {
  const api = await ready;
  const { tui, chat, view } = scene(api);
  const first = tool(api, tui, 'read', 'first', { path: 'first.ts' });
  const prose = new api.Text('', 0, 0);
  const second = tool(api, tui, 'read', 'second', { path: 'second.ts' });
  const parent = tool(api, tui, 'codemode', 'cm', { code: 'text(1);' });
  [first, prose, second, parent].forEach(row => chat.addChild(row));
  try {
    const dark = chat.render(100);
    assert.match(plain(dark), /read\n   first\.ts/);
    prose.setText('Visible prose'); assert.match(plain(chat.render(100)), /read first\.ts/);
    prose.setText(''); assert.match(plain(chat.render(100)), /read\n   first\.ts/);
    const cached = second.render(100); second.outputPad = 3; assert.notEqual(second.render(100), cached);
    view.showCode = true; assert.match(plain(chat.render(100)), /codemode text\(1\)/);
    view.showCode = false; assert.doesNotMatch(plain(chat.render(100)), /text\(1\)/);
    api.themes.initTheme('light'); assert.notDeepEqual(chat.render(100), dark);
    for (const width of [1, 2, 5, 40]) {
      chat.render(width);
      for (const row of [first, second, parent]) for (const line of row.render(width)) assert.ok(api.visibleWidth(line) <= width);
    }
    view.enabled = false; const native = second.render(100);
    view.enabled = true; chat.render(100); assert.notDeepEqual(second.render(100), native);
    view.dispose(); assert.equal(Object.hasOwn(second, 'invalidate'), false);
  } finally { view.dispose(); api.themes.initTheme('dark'); }
});

test('received messages cache full bodies and invalidate mutable metadata and legacy text', async () => {
  const api = await ready;
  const { chat, view } = scene(api);
  const message = { role: 'custom', customType: 'subagents.message.v1', display: true, timestamp: 1,
    content: [{ type: 'text', text: 'Message from worker:\nBefore' }], details: {} };
  const row = new api.CustomMessageComponent(message, undefined, api.themes.getMarkdownTheme()); chat.addChild(row);
  try {
    chat.render(100); const first = row.render(100); assert.equal(row.render(100), first);
    message.content[0].text = 'Message from worker:\nAfter'; assert.match(plain(chat.render(100)), /After/);
    message.details.from = 'new-worker'; message.details.message = 'Metadata body';
    assert.match(plain(chat.render(100)), /new-worker/); assert.match(plain(chat.render(100)), /Metadata body/);
    row.outputPad = 0; assert.match(plain(chat.render(100)), /\nreceive message from/);
  } finally { view.dispose(); }
});

test('restoring a previous child array restores its cached group positions', async () => {
  const api = await ready;
  const { tui, chat, view } = scene(api);
  const first = tool(api, tui, 'read', 'first', { path: 'first.ts' });
  const second = tool(api, tui, 'read', 'second', { path: 'second.ts' });
  const grouped = [first, second];
  try {
    chat.children = grouped; const initial = chat.render(100);
    chat.children = [first]; assert.match(plain(chat.render(100)), /read first\.ts/);
    chat.children = grouped; assert.deepEqual(chat.render(100), initial);
  } finally { view.dispose(); }
});

test('theme-level emphasis and syntax palettes are reused across different commands', async () => {
  const api = await ready;
  const counter = countedTheme(api.themes.theme);
  const ansi = api.emphasisAnsi(counter.theme); const afterEmphasis = counter.calls();
  assert.equal(api.emphasisAnsi(counter.theme), ansi); assert.equal(counter.calls(), afterEmphasis);
  api.highlightCompactCode('const x = 1;', 'javascript', counter.theme); const afterPalette = counter.calls();
  api.highlightCompactCode('const y = 2;', 'javascript', counter.theme);
  assert.equal(counter.calls(), afterPalette, 'subdued syntax palette is computed once per theme');
});
