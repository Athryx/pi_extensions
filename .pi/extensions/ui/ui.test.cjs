const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { realpathSync } = require('node:fs');
const { resolve, join, dirname } = require('node:path');
const { pathToFileURL } = require('node:url');

const root = resolve(dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim())), '../..');
const cwd = resolve(__dirname, '../../..');
const host = path => import(pathToFileURL(join(root, path)).href);
const ready = (async () => {
  const { createJiti } = await host('node_modules/jiti/lib/jiti.mjs');
  const jiti = createJiti(__filename, { moduleCache: false, alias: {
    '@earendil-works/pi-coding-agent': join(root, 'dist/index.js'),
    '@earendil-works/pi-tui': join(root, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
  } });
  const compact = await jiti.import(join(__dirname, 'compact.ts'));
  const bashHighlight = await jiti.import(join(__dirname, 'bash-highlight.ts'));
  const syntaxHighlight = await jiti.import(join(__dirname, 'syntax-highlight.ts'));
  const emphasis = await jiti.import(join(__dirname, 'emphasis.ts'));
  const commandSpans = await jiti.import(join(__dirname, 'shell-command-spans.ts'));
  const extension = await jiti.import(join(__dirname, 'index.ts'));
  const tui = await host('node_modules/@earendil-works/pi-tui/dist/index.js');
  const themes = await host('dist/modes/interactive/theme/theme.js');
  themes.initTheme('dark');
  const { ToolExecutionComponent } = await host('dist/modes/interactive/components/tool-execution.js');
  const { CustomEditor } = await host('dist/modes/interactive/components/custom-editor.js');
  const { KeybindingsManager } = await host('dist/core/keybindings.js');
  return { ...compact, ...bashHighlight, ...syntaxHighlight, ...emphasis, ...commandSpans, ...extension, ...tui, ...themes, ToolExecutionComponent, CustomEditor, KeybindingsManager };
})();
const plain = lines => lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''));
function fakeTui(Container) {
  const tui = new Container();
  tui.requestRender = () => {};
  tui.terminal = { rows: 40, columns: 100 };
  return tui;
}
function makeRow(api, tui, name, id, args) {
  const definition = {
    renderCall: () => new api.Text(`native ${name}`, 0, 0),
    renderResult: () => new api.Text('original result', 0, 0),
  };
  const row = new api.ToolExecutionComponent(name, id, args, { showImages: false }, definition, tui, cwd);
  row.setArgsComplete();
  row.markExecutionStarted();
  row.updateResult({ content: [{ type: 'text', text: 'full result' }], details: undefined, isError: false });
  return row;
}

test('loads with installed pi API and registers no tools or renderer replacements', async () => {
  const { loadExtensions } = await host('dist/core/extensions/loader.js');
  const { extensions, errors } = await loadExtensions([join(__dirname, 'index.ts')], cwd);
  assert.deepEqual(errors, []);
  assert.equal(extensions.length, 1);
  assert.equal(extensions[0].tools.size, 0);
  assert.equal(extensions[0].toolRenderers, undefined);
  assert.ok(extensions[0].commands.has('ui'));
  assert.ok(extensions[0].shortcuts.has('ctrl+alt+o'));
});

test('compact native tool instances: groups, spacing, dynamic rows and normal restoration', async () => {
  const api = await ready;
  const tui = fakeTui(api.Container);
  const chat = new api.Container();
  tui.addChild(chat);
  const read1 = makeRow(api, tui, 'read', 'r1', { path: `${cwd}/a.ts` });
  const read2 = makeRow(api, tui, 'read', 'r2', { path: 'b.ts' });
  const bash = makeRow(api, tui, 'bash', 'b1', { command: 'printf hello\nprintf world' });
  chat.addChild(read1);
  chat.addChild({ render: () => [], invalidate() {} }); // Invisible tool-only assistant message.
  chat.addChild(read2);
  chat.addChild(bash);
  const native = chat.render(100);
  const view = new api.CompactView(tui, () => api.theme);
  assert.deepEqual(plain(chat.render(100)), ['', ' read', '   a.ts:1', '   b.ts:1', '', ' $ printf hello ↵ printf world']);
  assert.ok(chat.render(100).join('\n').includes(api.emphasize('a.ts', api.theme)));
  assert.ok(chat.render(100).join('\n').includes(api.theme.fg('muted', ':1')));
  assert.ok(chat.render(100).join('\n').includes(api.highlightBashCommand('printf hello\nprintf world', api.theme)));
  assert.ok(!chat.render(100).join('').includes('original result'));
  assert.ok(!chat.render(100).join('').includes('\x1b[48;'));
  // New tool rows added after adapter installation are picked up at render time.
  const edit = makeRow(api, tui, 'edit', 'e1', { path: 'c.ts', edits: [{ oldText: 'secret payload' }] });
  chat.addChild(edit);
  assert.deepEqual(plain(chat.render(100)).slice(-2), ['', ' edit c.ts']);
  edit.updateResult({ content: [{ type: 'text', text: 'failure details' }], details: undefined, isError: true });
  assert.equal(plain(chat.render(100)).at(-1), ' edit c.ts ✗');
  edit.isPartial = true;
  edit.result = undefined;
  assert.equal(plain(chat.render(100)).at(-1), ' edit c.ts ⋯');
  view.enabled = false;
  assert.deepEqual(chat.render(100).slice(0, native.length), native);
  view.dispose();
  view.dispose();
  assert.equal(Object.hasOwn(read1, 'render'), false);
  assert.equal(Object.hasOwn(chat, 'render'), false);
  assert.deepEqual(chat.render(100).slice(0, native.length), native);
});

test('visible messages break groups; widths, images and unknown tool summaries stay compact', async () => {
  const api = await ready;
  const tui = fakeTui(api.Container);
  const chat = new api.Container();
  tui.addChild(chat);
  chat.addChild(makeRow(api, tui, 'functions.read', 'r1', { path: '界'.repeat(100) }));
  chat.addChild(new api.Text('explanation', 0, 0));
  const row = makeRow(api, tui, 'functions.read', 'r2', { path: 'image.png' });
  // The adapter bypasses native image rendering as well as result rendering.
  row.imageComponents = [{ render: () => ['IMAGE'], invalidate() {} }];
  chat.addChild(row);
  chat.addChild(makeRow(api, tui, 'ask_question', 'q1', { question: 'Pick a choice\nplease' }));
  const view = new api.CompactView(tui, () => api.theme);
  const lines = plain(chat.render(100));
  assert.equal(lines.filter(line => line === ' read').length, 0);
  assert.ok(lines.includes(' read image.png:1'));
  assert.ok(lines.includes(' ask_question Pick a choice ↵ please'));
  assert.ok(!lines.includes('IMAGE'));
  for (const width of [0, 1, 2, 5, 12, 40]) {
    chat.render(width);
    // Only tool layout belongs to this extension; native prose has its own
    // minimum-width behavior (Text renders a character even at width zero).
    for (const child of chat.children.filter(child => 'toolCallId' in child)) {
      for (const line of child.render(width)) assert.ok(api.visibleWidth(line) <= width, `width ${width}: ${line}`);
    }
  }
  assert.equal(api.toolSummary('unknown', { content: 'secret', password: 'hidden', approved: true }), 'approved=true');
  assert.equal(api.toolSummary('close_bash', { session_name: 'job-1' }), 'job-1');
  assert.equal(api.oneLine('foo\x1b\r\nbar'), 'foo ↵ bar');
  view.dispose();
});

test('Bash uses subdued shell highlighting, stays one line, and refreshes on commands/themes', async () => {
  const api = await ready;
  const command = '# comment\nif true; then printf "%s\\n" "$HOME"; fi';
  const highlighted = api.highlightBashCommand(command, api.theme);
  assert.deepEqual(plain([highlighted]), [api.oneLine(command)]);
  const blended = token => api.foregroundAnsi(api.mixColors(api.theme.colors.muted, api.theme.colors[token], 0.45), api.theme.getColorMode());
  assert.ok(highlighted.includes(blended('syntaxString')));
  // Preserve newlines while parsing, so the comment doesn't swallow `if`.
  assert.ok(highlighted.includes(blended('syntaxKeyword')));
  assert.ok(highlighted.startsWith(api.theme.getFgAnsi('muted')));
  assert.ok(highlighted.includes('\x1b[39m' + api.theme.getFgAnsi('muted')));
  assert.ok(!api.highlightBashCommand('echo \x1b[2Jbad', api.theme).includes('\x1b[2J'));
  assert.deepEqual(plain([api.highlightBashCommand('echo\t"value"', api.theme)]), ['echo "value"']);
  const huge = 'echo '.repeat(4000);
  assert.equal(api.highlightBashCommand(huge, api.theme), api.theme.fg('muted', huge.trim()));

  const tui = fakeTui(api.Container);
  const chat = new api.Container();
  tui.addChild(chat);
  const row = makeRow(api, tui, 'functions.bash', 'b1', { command });
  chat.addChild(row);
  const view = new api.CompactView(tui, () => api.theme);
  try {
    const dark = chat.render(100);
    assert.deepEqual(chat.render(100), dark);
    api.initTheme('light');
    const light = chat.render(100);
    assert.notDeepEqual(light, dark);
    assert.ok(light.join('').includes(blended('syntaxString')));
    row.updateArgs({ command: 'printf "界" "$USER' }); // Incomplete streamed quote.
    assert.deepEqual(plain(chat.render(100)), ['', ' $ printf "界" "$USER']);
    for (const width of [0, 1, 2, 5, 12, 40]) {
      for (const line of chat.render(width)) assert.ok(api.visibleWidth(line) <= width);
    }
    view.enabled = false;
    assert.ok(chat.render(100).join('').includes('native functions.bash'));
  } finally {
    view.dispose();
    api.initTheme('dark');
  }
});

test('codemode renders muted JavaScript, including streamed/raw scripts and theme changes', async () => {
  const api = await ready;
  const code = '// @options: {"max_output_tokens": 1000}\nconst result = await tools.read({ path: "a.ts" });\ntext(result);';
  assert.equal(api.toolSummary('functions.codemode', { code }), api.oneLine(code));
  for (const input of [{ code }, code]) {
    const tui = fakeTui(api.Container);
    const chat = new api.Container();
    tui.addChild(chat);
    const row = makeRow(api, tui, 'functions.codemode', 'c1', input);
    chat.addChild(row);
    const view = new api.CompactView(tui, () => api.theme);
    view.showCode = true;
    try {
      const highlighted = api.highlightCompactCode(code, 'javascript', api.theme);
      assert.deepEqual(plain([highlighted]), [code]);
      const blended = token => api.foregroundAnsi(api.mixColors(api.theme.colors.muted, api.theme.colors[token], 0.45), api.theme.getColorMode());
      assert.ok(highlighted.includes(blended('syntaxKeyword')));
      assert.ok(highlighted.includes(blended('syntaxString')));
      assert.deepEqual(plain(chat.render(240)), ['', ' codemode', ...code.split('\n').map(line => '   ' + line)]);
      const dark = chat.render(240);
      api.initTheme('light');
      assert.notDeepEqual(chat.render(240), dark);
      row.updateArgs({ code: 'await tools.read({ path: "界' });
      assert.deepEqual(plain(chat.render(100)), ['', ' codemode await tools.read({ path: "界']);
      for (const width of [0, 1, 2, 5, 12, 40]) {
        for (const line of chat.render(width)) assert.ok(api.visibleWidth(line) <= width);
      }
      row.updateArgs({});
      assert.deepEqual(plain(chat.render(100)), ['', ' codemode …']);
      view.enabled = false;
      assert.ok(chat.render(100).join('').includes('native functions.codemode'));
    } finally {
      view.dispose();
      api.initTheme('dark');
    }
  }
  assert.ok(!api.highlightCompactCode('text("\x1b[2J")', 'javascript', api.theme).includes('\x1b[2J'));
  const huge = 'text(1); '.repeat(2000);
  assert.equal(api.highlightCompactCode(huge, 'javascript', api.theme), api.theme.fg('muted', huge.trimEnd()));
  const tui = fakeTui(api.Container);
  const chat = new api.Container();
  tui.addChild(chat);
  const row = makeRow(api, tui, 'codemode', 'layout', { code: 'text(1);' });
  chat.addChild(row);
  const view = new api.CompactView(tui, () => api.theme);
  view.showCode = true;
  try {
    assert.deepEqual(plain(chat.render(80)), ['', ' codemode text(1);']);
    row.updateArgs({ code: 'if (true) {\n  text("hello");\n\n}' });
    assert.deepEqual(plain(chat.render(80)), ['', ' codemode', '   if (true) {', '     text("hello");', '   ', '   }']);
    row.updateResult({ content: [], details: undefined, isError: true });
    assert.equal(plain(chat.render(80))[1], ' codemode ✗');
    row.updateArgs({ code: 'text("a very long script line that needs wrapping");' });
    const wrapped = plain(chat.render(25));
    assert.equal(wrapped[1], ' codemode ✗');
    assert.ok(wrapped.length > 3);
    assert.ok(wrapped.slice(2).every(line => line.startsWith('   ')));
    for (const width of [0, 1, 2, 3, 5, 12, 25]) {
      for (const line of chat.render(width)) assert.ok(api.visibleWidth(line) <= width);
    }
  } finally {
    view.dispose();
  }
});

test('compact codemode nests compact tools and groups filenames at a second indent', async () => {
  const api = await ready;
  const tui = fakeTui(api.Container);
  const chat = new api.Container();
  tui.addChild(chat);
  const row = makeRow(api, tui, 'codemode', 'cm', { code: 'await tools.read({path:"a.ts"});' });
  const calls = [
    { id: 'cm/1', name: 'functions.read', args: '{"path":"src/a.ts","offset":2,"limit":3}', status: 'ok' },
    { id: 'cm/2', name: 'functions.read', args: '{"path":"src/b.ts"}', status: 'running' },
    { id: 'cm/3', name: 'bash', args: '{"command":"echo hello"}', status: 'error' },
    { id: 'cm/4', name: 'read', args: '{"path":"c.ts"}', status: 'ok' },
  ];
  row.updateResult({ content: [], details: { calls }, isError: false });
  chat.addChild(row);
  const view = new api.CompactView(tui, () => api.theme);
  try {
    assert.deepEqual(plain(chat.render(100)), ['', ' codemode', '   read', '     src/a.ts:2-4', '     src/b.ts ⋯', '   $ echo hello ✗', '   read c.ts']);
    assert.ok(chat.render(100).join('').includes(api.emphasize('a.ts', api.theme)));
    view.nestedCalls.set('cm/2', { name: 'functions.read', args: { path: 'src/full.ts' }, running: false, result: { content: [{ type: 'text', text: 'one\ntwo' }] } });
    assert.ok(plain(chat.render(100)).includes('     src/full.ts:1-2'));
    view.showCode = true;
    assert.ok(plain(chat.render(100))[1].startsWith(' codemode await tools.read'));
    assert.ok(plain(chat.render(100)).includes('     src/a.ts:2-4'));
    for (const width of [0, 1, 2, 3, 5, 20]) {
      for (const line of chat.render(width)) assert.ok(api.visibleWidth(line) <= width);
    }
    view.nestedCalls.clear();
    calls[0].args = '{"path":"truncated';
    assert.doesNotThrow(() => chat.render(80));
    view.enabled = false;
    assert.ok(chat.render(100).join('').includes('native codemode'));
  } finally { view.dispose(); }
});

test('file basenames and argv0 share teal emphasis, not white, while directories and ranges stay grey', async () => {
  const api = await ready;
  for (const theme of ['dark', 'light']) {
    api.initTheme(theme);
    const color = api.emphasisAnsi(api.theme);
    assert.notEqual(color, api.theme.getFgAnsi('text'));
    assert.notEqual(color, api.theme.getFgAnsi('muted'));
    for (const name of ['read', 'write', 'edit']) {
      const styled = api.styleFileSummary(name, { path: 'src/my file.ts', offset: 5, limit: 2, content: 'a\nb\n' }, cwd, { details: { firstChangedLine: 7 } }, api.theme);
      assert.ok(styled.includes(api.theme.fg('muted', 'src/')));
      assert.ok(styled.includes(api.emphasize('my file.ts', api.theme)));
      assert.deepEqual(plain([styled]), [api.toolSummary(name, { path: 'src/my file.ts', offset: 5, limit: 2, content: 'a\nb\n' }, cwd, { details: { firstChangedLine: 7 } })]);
    }
    const command = 'FOO=bar /usr/bin/custom-tool --flag filename.txt | other-tool && ./local-tool';
    const highlighted = api.highlightBashCommand(command, api.theme);
    assert.deepEqual(plain([highlighted]), [command]);
    for (const word of ['/usr/bin/custom-tool', 'other-tool', './local-tool']) assert.ok(highlighted.includes(color + word));
    assert.ok(!highlighted.includes(color + 'filename.txt'));
  }
  api.initTheme('dark');
});

test('argv0 lexer skips assignments, redirection targets, quoted arguments, expansions and comments', async () => {
  const api = await ready;
  const names = text => api.shellCommandSpans(text).map(span => text.slice(span.start, span.end));
  for (const [command, expected] of [
    ['FOO="two words" /usr/bin/rg -n "x | fake" file | sort && ./run; printf hi', ['/usr/bin/rg', 'sort', './run', 'printf']],
    ['2>err FOO=bar ./tool arg > output; next', ['./tool', 'next']],
    ['printf "$(echo "a|b")" tail; final', ['printf', 'final']],
    ["printf 'not; a command' foo\\|bar; final", ['printf', 'final']],
    ['# fake | cmd\nif test -f file; then ./run; else fallback; fi', ['test', './run', 'fallback']],
    ['for f in a b; do printf "$f"; done', ['printf']],
    ["'./my tool' arg", ["'./my tool'"]],
    ['name() { real-tool; }', ['real-tool']],
    ['(( x++ )); [[ x == y ]] && real-tool', ['real-tool']],
    ['cat <<EOF\nnot-a-command\nEOF\nnext', ['cat']],
  ]) assert.deepEqual(names(command), expected, command);
  // Syntax spans may split an argv0; resetting them must not remove its accent.
  const styled = api.highlightBashCommand('"./my tool" arg; custom-tool "string" tail', api.theme);
  assert.deepEqual(plain([styled]), ['"./my tool" arg; custom-tool "string" tail']);
  assert.ok(styled.includes(api.emphasisAnsi(api.theme) + 'custom-tool'));
  assert.ok(!styled.includes(api.emphasisAnsi(api.theme) + 'tail'));
});

test('read/write/edit line ranges use arguments and results without reading files', async () => {
  const api = await ready;
  assert.equal(api.toolSummary('read', { path: 'a.ts', offset: 10, limit: 25 }), 'a.ts:10-34');
  assert.equal(api.toolSummary('read', { path: 'a.ts', offset: 10, limit: null }), 'a.ts:10');
  assert.equal(api.fileLineRange('read', { offset: null, limit: null }), '');
  assert.equal(api.fileLineRange('read', {}, { content: [{ type: 'text', text: 'a\nb\nc\n' }] }), ':1-3');
  assert.equal(api.fileLineRange('read', {}, { content: [{ type: 'image' }] }), '');
  assert.equal(api.fileLineRange('read', {}, { details: { truncation: { outputLines: 2000 } } }), ':1-2000');
  assert.equal(api.fileLineRange('read', {}, { details: { truncation: { firstLineExceedsLimit: true, outputLines: 1 } } }), '');
  assert.equal(api.toolSummary('write', { path: 'a.ts', content: 'a\nb\nc\n' }), 'a.ts:1-3');
  assert.equal(api.fileLineRange('write', { content: '' }), '');
  assert.equal(api.fileLineRange('edit', {}, { details: { diff: '- 10 old\n- 11 old\n+ 10 new\n+ 11 new\n+ 12 new' } }), ':old 10-11 → new 10-12');
  assert.equal(api.fileLineRange('functions.edit', {}, { details: { diff: '- 5 old\n+ 5 new\n  6 context\n- 20 old\n+ 20 new' } }), ':5,20');
  assert.equal(api.fileLineRange('edit', {}, { details: { firstChangedLine: 42 } }), ':42');
  assert.equal(api.fileLineRange('edit', {}, { isError: true, details: { firstChangedLine: 42 } }), '');
  // Rendering reads updated result metadata, including grouped edit rows.
  const tui = fakeTui(api.Container);
  const chat = new api.Container();
  tui.addChild(chat);
  const edit = makeRow(api, tui, 'edit', 'e1', { path: 'a.ts' });
  chat.addChild(edit);
  chat.addChild(makeRow(api, tui, 'edit', 'e2', { path: 'b.ts' }));
  const view = new api.CompactView(tui, () => api.theme);
  edit.updateResult({ content: [], details: { diff: '- 10 old\n+ 10 new\n+ 11 new' } });
  assert.deepEqual(plain(chat.render(100)), ['', ' edit', '   a.ts:old 10 → new 10-11', '   b.ts']);
  view.dispose();
});

test('tool-cycle matching respects remapping, history precedence and dialog focus', async () => {
  const api = await ready;
  const tui = fakeTui(api.Container);
  const kb = new api.KeybindingsManager({ 'app.tools.expand': 'ctrl+e' });
  const editor = new api.CustomEditor(tui, api.getEditorTheme(), kb);
  editor.onAction('app.tools.expand', () => {});
  tui.getFocusedComponent = () => editor;
  assert.equal(api.matchesToolCycle(tui, '\x05'), true);
  assert.equal(api.matchesToolCycle(tui, '\x1b[101;5:1u'), true);
  assert.equal(api.matchesToolCycle(tui, '\x1b[101;5:3u'), false);
  assert.equal(api.matchesToolCycle(tui, '\x0f'), false);
  const historyKb = new api.KeybindingsManager({ 'tui.editor.historyPrevious': 'ctrl+o' });
  const historyEditor = new api.CustomEditor(tui, api.getEditorTheme(), historyKb);
  historyEditor.onAction('app.tools.expand', () => {});
  tui.getFocusedComponent = () => historyEditor;
  assert.equal(api.matchesToolCycle(tui, '\x0f'), false);
  tui.getFocusedComponent = () => new api.Input();
  assert.equal(api.matchesToolCycle(tui, '\x0f'), false);
});

test('Ctrl+C saves drafts for Up, expands paste markers, and preserves native clear/exit handlers', async () => {
  const api = await ready;
  const tui = fakeTui(api.Container);
  const kb = new api.KeybindingsManager();
  api.setKeybindings(kb);
  const editor = new api.CustomEditor(tui, api.getEditorTheme(), kb);
  tui.getFocusedComponent = () => editor;
  let clears = 0;
  editor.onAction('app.clear', () => { clears++; editor.setText(''); });
  editor.addToHistory('previous prompt');
  editor.setText('unfinished\nmessage');
  api.rememberClearedDraft(tui, '\x03', editor.getText());
  editor.handleInput('\x03');
  assert.equal(clears, 1);
  assert.equal(editor.getText(), '');
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), 'unfinished\nmessage');
  editor.setText('');
  editor.handleInput(`\x1b[200~${'long paste\n'.repeat(50)}\x1b[201~`);
  const expanded = editor.getExpandedText();
  api.rememberClearedDraft(tui, '\x03', editor.getText());
  editor.handleInput('\x03');
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), expanded.trim());
  const historyCount = editor.history.length;
  editor.setText('must not save on key-up or repeat');
  api.rememberClearedDraft(tui, '\x1b[99;5:3u', editor.getText());
  api.rememberClearedDraft(tui, '\x1b[99;5:2u', editor.getText());
  assert.equal(editor.history.length, historyCount);
  api.rememberClearedDraft(tui, 'a', editor.getText());
  assert.equal(editor.history.length, historyCount);
  // Cancel in a dialog or overlay must not save the main editor's text.
  tui.getFocusedComponent = () => new api.Input();
  api.rememberClearedDraft(tui, '\x03', editor.getText());
  assert.equal(editor.history.length, historyCount);
});

test('clear binding remapping is respected', async () => {
  const api = await ready;
  const tui = fakeTui(api.Container);
  const kb = new api.KeybindingsManager({ 'app.clear': 'ctrl+k' });
  const editor = new api.CustomEditor(tui, api.getEditorTheme(), kb);
  editor.onAction('app.clear', () => editor.setText(''));
  tui.getFocusedComponent = () => editor;
  editor.setText('remapped draft');
  api.rememberClearedDraft(tui, '\x03', editor.getText());
  assert.equal(editor.history.length, 0);
  api.rememberClearedDraft(tui, '\x0b', editor.getText());
  assert.deepEqual(editor.history, ['remapped draft']);
});

test('real TUI dispatch cycles once per Kitty press, never on release/repeat or via the native handler', async () => {
  const api = await ready;
  const { loadExtensions } = await host('dist/core/extensions/loader.js');
  for (const Renderer of [api.TuiMainScreen, api.TuiAltScreen]) {
    const tui = new Renderer({ rows: 40, columns: 100, write() {} }, false);
    tui.stopped = true; // Exercise dispatch without starting terminal I/O/render timers.
    const kb = new api.KeybindingsManager();
    api.setKeybindings(kb);
    const editor = new api.CustomEditor(tui, api.getEditorTheme(), kb);
    let nativeToggles = 0;
    editor.onAction('app.tools.expand', () => { nativeToggles++; });
    tui.addChild(editor);
    tui.setFocus(editor);
    const { extensions, errors, runtime } = await loadExtensions([join(__dirname, 'index.ts')], cwd);
    assert.deepEqual(errors, []);
    const extension = extensions[0];
    const entries = [];
    runtime.appendEntry = (customType, data) => entries.push({ type: 'custom', customType, data });
    let widget, expanded = false;
    const ctx = {
      mode: 'tui', hasUI: true, sessionManager: { getBranch: () => entries },
      ui: {
        theme: api.theme, getEditorText: () => editor.getText(),
        getToolsExpanded: () => expanded,
        setToolsExpanded: value => { expanded = value; },
        setWidget: (_key, factory) => { widget?.dispose(); widget = factory(tui); },
        onTerminalInput: handler => tui.addInputListener(handler),
        setStatus() {}, notify() {},
      },
    };
    const start = async () => {
      for (const handler of extension.handlers.get('session_start') ?? []) await handler({}, ctx);
    };
    const press = '\x1b[111;5:1u';
    const release = '\x1b[111;5:3u';
    const repeat = '\x1b[111;5:2u';
    await start();
    try {
      for (const expected of ['compact-code', 'collapsed', 'expanded', 'compact']) {
        const count = entries.length;
        tui.handleTerminalInput(press);
        assert.equal(entries.length, count + 1, `${Renderer.name}: press`);
        assert.equal(entries.at(-1).data.mode, expected);
        tui.handleTerminalInput(release);
        assert.equal(entries.length, count + 1, `${Renderer.name}: key-up must not advance view`);
        tui.handleTerminalInput(repeat);
        assert.equal(entries.length, count + 1, `${Renderer.name}: held-key repeat must not advance view`);
        assert.equal(nativeToggles, 0);
      }
      // Reinitializing a session must replace, not duplicate, the listener.
      await start();
      const count = entries.length;
      tui.handleTerminalInput('\x0f'); // Legacy terminals have no key-up event.
      assert.equal(entries.length, count + 1);
      assert.equal(entries.at(-1).data.mode, 'compact-code');
      assert.equal(nativeToggles, 0);
    } finally {
      widget.dispose();
    }
    tui.handleTerminalInput(press);
    assert.equal(nativeToggles, 1, 'cleanup restores native dispatch');
    tui.handleTerminalInput(release);
    assert.equal(nativeToggles, 1, 'native TUI already filters release events');
  }
});

test('session lifecycle, preference persistence, cleanup, and non-TUI guards', async () => {
  const api = await ready;
  const { loadExtensions } = await host('dist/core/extensions/loader.js');
  const { extensions, errors, runtime } = await loadExtensions([join(__dirname, 'index.ts')], cwd);
  assert.deepEqual(errors, []);
  const extension = extensions[0];
  const entries = [];
  runtime.appendEntry = (customType, data) => entries.push({ type: 'custom', customType, data });
  const tui = fakeTui(api.Container);
  const chat = new api.Container();
  tui.addChild(chat);
  chat.addChild(makeRow(api, tui, 'write', 'w1', { path: 'file.ts' }));
  const native = chat.render(80);
  let listener, widget, expanded = false;
  const kb = new api.KeybindingsManager();
  const editor = new api.CustomEditor(tui, api.getEditorTheme(), kb);
  let nativeToggles = 0;
  editor.onAction('app.tools.expand', () => { nativeToggles++; });
  tui.getFocusedComponent = () => editor;
  const statuses = new Map([["ui", "old footer label"]]);
  const notices = [];
  const ctx = {
    mode: 'tui', hasUI: true,
    sessionManager: { getBranch: () => entries },
    ui: {
      theme: api.theme, getEditorText: () => '',
      getToolsExpanded: () => expanded,
      setToolsExpanded: value => {
        expanded = value;
        for (const child of chat.children) child.setExpanded?.(value);
      },
      setWidget: (_key, factory) => { widget?.dispose(); widget = factory(tui); },
      onTerminalInput: handler => { listener = handler; return () => { listener = undefined; }; },
      setStatus: (key, value) => statuses.set(key, value),
      notify: (message, type) => notices.push({ message, type }),
    },
  };
  const emit = async (name, event = {}) => { for (const handler of extension.handlers.get(name) ?? []) await handler(event, ctx); };
  await emit('session_start');
  assert.equal(widget.render(80).length, 0);
  assert.equal(statuses.get('ui'), undefined, 'old footer label is cleared');
  assert.equal(typeof listener, 'function');
  assert.deepEqual(plain(chat.render(80)), ['', ' write file.ts']);
  const nestedRow = makeRow(api, tui, 'codemode', 'event-parent', { code: 'await tools.read({path:"full.ts"})' });
  nestedRow.updateResult({ content: [], details: { calls: [{ id: 'event-parent/1', name: 'read', args: '{"path":"truncated', status: 'running' }] } });
  chat.addChild(nestedRow);
  await emit('tool_execution_start', { parentToolCallId: 'event-parent', toolCallId: 'event-parent/1', toolName: 'read', args: { path: 'full.ts' } });
  assert.ok(plain(chat.render(80)).includes('   read full.ts ⋯'));
  await emit('tool_execution_end', { parentToolCallId: 'event-parent', toolCallId: 'event-parent/1', toolName: 'read', isError: false, result: { content: [{ type: 'text', text: 'a\nb' }] } });
  assert.ok(plain(chat.render(80)).includes('   read full.ts:1-2'));
  chat.removeChild(nestedRow);
  const pressCtrlO = () => {
    const result = listener('\x0f');
    assert.deepEqual(result, { consume: true });
    if (!result?.consume) editor.handleInput('\x0f');
  };
  pressCtrlO(); // compact -> compact-code
  assert.deepEqual(entries.at(-1).data, { mode: 'compact-code' });
  assert.deepEqual(notices.at(-1), { message: 'Tool output: compact-code', type: 'info' });
  assert.deepEqual(plain(chat.render(80)), ['', ' write file.ts']);
  pressCtrlO(); // compact-code -> collapsed
  assert.equal(expanded, false);
  assert.deepEqual(chat.render(80), native);
  assert.deepEqual(entries.at(-1).data, { mode: 'collapsed' });
  pressCtrlO(); // collapsed -> expanded
  assert.equal(expanded, true);
  assert.equal(chat.children[0].expanded, true);
  assert.deepEqual(entries.at(-1).data, { mode: 'expanded' });
  assert.deepEqual(notices.at(-1), { message: 'Tool output: expanded', type: 'info' });
  pressCtrlO(); // expanded -> compact, native toggle must not also run
  assert.deepEqual(plain(chat.render(80)), ['', ' write file.ts']);
  assert.deepEqual(entries.at(-1).data, { mode: 'compact' });
  assert.equal(nativeToggles, 0);
  assert.deepEqual(notices.at(-1), { message: 'Tool output: compact', type: 'info' });
  assert.equal(statuses.get('ui'), undefined, 'cycling never sets a footer label');
  await extension.commands.get('ui').handler('collapsed', ctx);
  assert.deepEqual(chat.render(80), native);
  assert.deepEqual(entries.at(-1).data, { mode: 'collapsed' });
  assert.deepEqual(notices.at(-1), { message: 'Tool output: collapsed', type: 'info' });
  await emit('session_shutdown');
  assert.equal(listener, undefined);
  assert.equal(Object.hasOwn(chat, 'render'), false);
  await emit('session_start');
  assert.deepEqual(chat.render(80), native); // Saved normal preference restored.
  await extension.shortcuts.get('ctrl+alt+o').handler(ctx);
  assert.deepEqual(plain(chat.render(80)), ['', ' write file.ts']);
  widget.dispose(); // Pi's reload/session-reset boundary.
  assert.equal(listener, undefined);
  assert.deepEqual(chat.render(80), native);
  for (const mode of ['rpc', 'json', 'print']) {
    ctx.mode = mode;
    ctx.ui = new Proxy({}, { get: () => { throw new Error('non-TUI UI access'); } });
    await emit('session_start');
    await extension.commands.get('ui').handler('compact', ctx);
  }
});
