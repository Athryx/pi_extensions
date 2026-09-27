const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const root = path.resolve(path.dirname(fs.realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim())), '../..');
const esbuild = require(require.resolve('esbuild', { paths: [root] }));

async function load() {
  const code = (await esbuild.build({
    entryPoints: [path.join(__dirname, 'index.ts')], bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'stub', setup(build) {
      build.onResolve({ filter: /^(typebox|@earendil-works\/pi-(tui|coding-agent))$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
      build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ loader: 'js', contents: {
        typebox: 'export const Type = { Object: (o) => o, String: () => ({}), Optional: (o) => o, Array: (o) => o };',
        '@earendil-works/pi-coding-agent': 'export const truncateHead = (s) => ({ content: s });',
        '@earendil-works/pi-tui': `export const Key = { escape: 'escape', tab: 'tab', right: 'right', left: 'left', enter: 'enter', up: 'up', down: 'down', shift: (s) => 'shift+' + s };
          export const matchesKey = (a,b) => a === b;
          export const visibleWidth = (s) => s.length;
          export const wrapTextWithAnsi = (s) => [s];
          export class Text { constructor(text) { this.text = text; } }
          export class Editor { constructor() { this.value = ''; } setText(s) { this.value = s; } getText() { return this.value; } handleInput(s) { if (s === 'enter') this.onSubmit(this.value); else this.value += s; } render() { return [this.value]; } invalidate() {} }`,
      }[args.path] }));
    }}],
  })).outputFiles[0].text;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', code)(module, module.exports, require);
  return module.exports.default;
}

test('headless mode does not register a tool', async () => {
  const init = await load();
  const tools = [];
  const pi = { on: (_, callback) => { pi.start = callback; }, registerTool: (tool) => tools.push(tool) };
  init(pi);
  pi.start({}, { mode: 'print' });
  assert.equal(tools.length, 0);
});

test('parallel questions share one form; notes and answer are returned independently', async () => {
  const init = await load();
  let tool;
  let ui;
  const pi = { on: (_, callback) => { pi.start = callback; }, registerTool: (value) => { tool = value; } };
  init(pi);
  pi.start({}, { mode: 'tui' });
  assert.equal(tool.name, 'ask_question');
  assert.match(tool.promptSnippet, /Ask the user/);
  assert.match(tool.promptGuidelines.join(' '), /same assistant turn/);
  assert.match(tool.promptGuidelines.join(' '), /\(Recommended\)/);
  assert.match(tool.promptGuidelines.join(' '), /empty list/);
  let shown = 0;
  const ctx = { ui: { custom: (factory) => {
    shown++;
    return new Promise((resolve) => {
      ui = factory({ requestRender() {} }, { fg: (_, s) => s, bg: (_, s) => s }, {}, resolve);
    });
  } } };
  const a = tool.execute('a', { question: 'First?', choices: ['one', 'two', 'three'] }, undefined, undefined, ctx);
  const b = tool.execute('b', { question: 'Second?' }, undefined, undefined, ctx);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(shown, 1);
  ui.render(80);
  ui.handleInput('down');
  ui.handleInput('enter'); // second choice
  ui.handleInput('tab'); // open first question's notes inline
  assert.match(ui.render(80).join('\n'), /Notes:/);
  ui.handleInput('extra');
  ui.handleInput('tab'); // save and close notes
  ui.handleInput('right'); // second question
  ui.handleInput('enter'); // free-form editor
  ui.handleInput('free text');
  ui.handleInput('enter'); // save answer
  ui.handleInput('left'); // revisit first question
  assert.match(ui.render(80).join('\n'), /> 2\. two ✓/);
  ui.handleInput('right'); // revisit second
  assert.match(ui.render(80).join('\n'), /free text/);
  ui.handleInput('right'); // submit
  ui.handleInput('enter');
  const [r1, r2] = await Promise.all([a, b]);
  assert.deepEqual(r1.details.answer, { answer: 'two', choiceIndex: 2, notes: 'extra' });
  assert.deepEqual(r2.details.answer, { answer: 'free text', notes: '' });
});

test('Other accepts custom text, cancellation resolves every sibling', async () => {
  const init = await load();
  let tool;
  const pi = { on: (_, cb) => { pi.start = cb; }, registerTool: (value) => { tool = value; } };
  init(pi);
  pi.start({}, { mode: 'tui' });
  let ui;
  const ctx = { ui: { custom: (factory) => new Promise((done) => {
    ui = factory({ requestRender() {} }, { fg: (_, s) => s, bg: (_, s) => s }, {}, done);
  }) } };
  const custom = tool.execute('a', { question: 'Choose', choices: ['a', 'b', 'c'] }, undefined, undefined, ctx);
  await new Promise((resolve) => setTimeout(resolve, 10));
  ui.handleInput('down'); ui.handleInput('down'); ui.handleInput('down');
  ui.handleInput('enter'); ui.handleInput('something else'); ui.handleInput('enter');
  assert.match(ui.render(80).join('\n'), /Other \(write your own answer\): something else ✓/);
  ui.handleInput('enter'); // reopen Other with the existing answer
  assert.match(ui.render(80).join('\n'), /Your answer:\n something else/);
  ui.handleInput(' revised'); ui.handleInput('enter');
  assert.match(ui.render(80).join('\n'), /Other \(write your own answer\): something else revised ✓/);
  ui.handleInput('tab'); ui.handleInput('a note'); ui.handleInput('enter');
  ui.handleInput('right');
  assert.match(ui.render(80).join('\n'), /something else revised \(notes: a note\)/);
  ui.handleInput('enter');
  assert.deepEqual((await custom).details.answer, { answer: 'something else revised', notes: 'a note' });

  const first = tool.execute('b', { question: 'One' }, undefined, undefined, ctx);
  const second = tool.execute('c', { question: 'Two' }, undefined, undefined, ctx);
  await new Promise((resolve) => setTimeout(resolve, 10));
  ui.handleInput('escape');
  assert.equal((await first).details.answer, null);
  assert.equal((await second).details.answer, null);
});
