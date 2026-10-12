const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { load, host } = require('../subagents/test-helper.cjs');

const cwd = resolve(__dirname, '../../..');
const ready = (async () => {
  const compact = await load('../ui/compact.ts');
  const tui = await host('node_modules/@earendil-works/pi-tui/dist/index.js');
  const themes = await host('dist/modes/interactive/theme/theme.js');
  themes.initTheme('dark');
  const { ToolExecutionComponent } = await host('dist/modes/interactive/components/tool-execution.js');
  const { CustomMessageComponent } = await host('dist/modes/interactive/components/custom-message.js');
  return { ...compact, ...tui, themes, ToolExecutionComponent, CustomMessageComponent };
})();
const plain = lines => lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''));
const flattened = lines => plain(lines).join('\n');
const noWhitespace = text => text.replace(/\s/g, '');
const result = details => ({ content: [{ type: 'text', text: 'native result body' }], details, isError: false });
const answer = (question, text, notes = '') => ({ question, choices: [], answer: { answer: text, notes } });
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function scene(api) {
  const tui = new api.Container();
  tui.requestRender = () => {};
  tui.terminal = { rows: 40, columns: 100 };
  const chat = new api.Container();
  tui.addChild(chat);
  const view = new api.CompactView(tui, () => api.themes.theme);
  return { tui, chat, view };
}
function tool(api, tui, name, args, details, id = name) {
  const definition = {
    renderCall: () => new api.Text(`native call ${name}`, 0, 0),
    renderResult: () => new api.Text('native result body', 0, 0),
  };
  const row = new api.ToolExecutionComponent(name, id, args, { showImages: false }, definition, tui, cwd);
  row.setArgsComplete();
  row.markExecutionStarted();
  row.updateResult(result(details));
  return row;
}
function message(api, details, content = 'native receive body', customType = 'subagents.message.v1') {
  return new api.CustomMessageComponent({
    role: 'custom', customType, content, display: true, timestamp: 123, details,
  }, () => new api.Text('native custom renderer', 0, 0));
}
function assertFits(api, component, widths = [0, 1, 2, 3, 4, 5, 8, 17, 40]) {
  for (const width of widths) {
    for (const line of component.render(width)) {
      assert.ok(api.visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
    }
  }
}

test('question answers match full question text, preserving reordered and duplicate occurrences and notes', async () => {
  const api = await ready;
  const { tui, chat, view } = scene(api);
  const questions = ['Choose a backend?', 'Which region?', 'Choose a backend?', 'Unanswered?'];
  const args = freeze({ questions: questions.map(question => ({ question, choices: [] })) });
  const details = freeze({ questions: [
    answer('Which region?', 'Region answer', 'Keep this note\nand this second line'),
    answer('Choose a backend?', 'First backend answer'),
    answer('Choose a backend?', 'Second backend answer'),
    answer('Not asked', 'Unmatched result answer'),
  ] });
  const row = tool(api, tui, 'functions.ask_question', args, details);
  chat.addChild(row);
  try {
    const lines = plain(chat.render(160));
    assert.equal(lines.filter(line => /ask_question/.test(line)).length, 1);
    const pairs = lines.filter(line => /^\s+(question|answer):/.test(line));
    assert.deepEqual(pairs.slice(0, 6), [
      '   question: Choose a backend?', '   answer: First backend answer',
      '   question: Which region?', '   answer: Region answer',
      '   question: Choose a backend?', '   answer: Second backend answer',
    ]);
    assert.ok(lines.includes('   question: Unanswered?'));
    assert.ok(lines.some(line => line.includes('notes: Keep this note')));
    assert.ok(lines.some(line => line.includes('and this second line')));
    assert.ok(lines.includes('   question: Not asked'));
    assert.ok(lines.includes('   answer: Unmatched result answer'));
    assert.equal(row.args, args);
    assert.equal(row.result.details, details);
    assert.deepEqual(plain(chat.render(160)), lines, 'rendering must not consume stored answers');
  } finally { view.dispose(); }
});

test('question aliases group across invisible rows, but visible messages break groups', async () => {
  const api = await ready;
  const { tui, chat, view } = scene(api);
  const first = tool(api, tui, 'ask_question', { questions: [{ question: 'First?' }] }, { questions: [answer('First?', 'One')] }, 'q1');
  const second = tool(api, tui, 'functions.ask_questions', { questions: [{ question: 'Second?' }] }, { questions: [answer('Second?', 'Two')] }, 'q2');
  chat.addChild(first);
  chat.addChild({ render: () => [], invalidate() {} });
  chat.addChild(second);
  try {
    const grouped = plain(chat.render(100));
    assert.equal(grouped.filter(line => /ask_questions?/.test(line)).length, 1);
    assert.deepEqual(grouped.filter(line => /^\s+(question|answer):/.test(line)), [
      '   question: First?', '   answer: One', '   question: Second?', '   answer: Two',
    ]);
    assert.equal(grouped.filter(line => line === '').length, 1);
    chat.children.splice(2, 0, new api.Text('Visible prose', 0, 0));
    const separated = plain(chat.render(100));
    assert.equal(separated.filter(line => /ask_questions?/.test(line)).length, 2);
    assert.equal(separated.filter(line => line === '').length, 2);
  } finally { view.dispose(); }
});

test('questions refresh pending, partial, cancelled and failed states without throwing on malformed records', async () => {
  const api = await ready;
  const { tui, chat, view } = scene(api);
  const row = tool(api, tui, 'ask_question', { questions: [{ question: 'Proceed?' }] }, undefined);
  row.updateResult(result({ questions: [] }), true);
  chat.addChild(row);
  try {
    let text = flattened(chat.render(100));
    assert.match(text, /question: Proceed\?/);
    assert.match(text, /answer:.*pending/i);
    row.updateResult(result({ questions: [answer('Proceed?', 'Streamed answer')] }), true);
    assert.match(flattened(chat.render(100)), /answer:.*pending/i, 'partial results are still pending');
    row.updateResult(result({ questions: [answer('Proceed?', 'Final answer', 'Final note')] }));
    text = flattened(chat.render(100));
    assert.match(text, /answer: Final answer/);
    assert.match(text, /notes: Final note/);
    assert.doesNotMatch(text, /pending/i);
    row.updateResult(result({ questions: [{ question: 'Proceed?', answer: null }] }));
    assert.match(flattened(chat.render(100)), /answer:.*cancelled/i);
    row.updateResult({ ...result({ questions: [answer('Proceed?', 'Stale answer')] }), isError: true });
    assert.match(flattened(chat.render(100)), /answer:.*failed/i);
    for (const details of [undefined, null, {}, { questions: 'bad' }, { questions: [null, {}, { question: 'Proceed?', answer: 12 }] }]) {
      row.updateResult(result(details));
      assert.doesNotThrow(() => chat.render(100));
      assert.match(flattened(chat.render(100)), /question: Proceed\?/);
      assert.doesNotMatch(flattened(chat.render(100)), /\[object Object\]|undefined|null/);
      assert.match(flattened(chat.render(100)), /answer:.*unavailable/i);
    }
    row.updateResult({ content: [{ type: 'text', text: 'User cancelled the questions.' }], isError: false });
    assert.match(flattened(chat.render(100)), /answer:.*cancelled/i);
    for (const args of [undefined, null, {}, { questions: 'bad' }, { questions: [null, 7, {}] }]) {
      row.updateArgs(args);
      assert.doesNotThrow(() => chat.render(20));
      assertFits(api, row);
    }
  } finally { view.dispose(); }
});

test('legacy single question and alias retain full multiline question, answer and notes', async () => {
  const api = await ready;
  const { tui, chat, view } = scene(api);
  const row = tool(api, tui, 'ask_questions', { question: 'First question line\nSecond question line' }, {
    question: 'First question line\nSecond question line', answer: { answer: 'First answer line\nSecond answer line', notes: 'Helpful note' },
  });
  chat.addChild(row);
  try {
    const lines = plain(chat.render(100));
    assert.ok(lines.includes('   question: First question line'));
    assert.ok(lines.some(line => line.trim() === 'Second question line'));
    assert.ok(lines.includes('   answer: First answer line'));
    assert.ok(lines.some(line => line.trim() === 'Second answer line'));
    assert.ok(lines.some(line => line.includes('notes: Helpful note')));
  } finally { view.dispose(); }
});

test('create_agent displays name and template plus fully wrapped task, including default and legacy prompt', async () => {
  const api = await ready;
  const { tui, chat, view } = scene(api);
  const task = 'Investigate every relevant module and report the complete findings.\nKeep the second line and its final word: tail.';
  const row = tool(api, tui, 'functions.create_agent', { name: 'reviewer', agent_template: 'read-only', task });
  chat.addChild(row);
  try {
    assert.equal(plain(chat.render(160))[1], ' create agent reviewer · template: read-only');
    assert.ok(plain(chat.render(160)).slice(2).every(line => line.startsWith('   ')));
    assert.ok(noWhitespace(plain(chat.render(32)).slice(2).join('')).includes(noWhitespace(task)), 'task must not be truncated');
    for (const agent_template of [undefined, null]) {
      row.updateArgs({ name: 'reviewer', agent_template, prompt: task });
      const lines = plain(chat.render(160));
      assert.equal(lines[1], ' create agent reviewer · template: default');
      assert.ok(noWhitespace(lines.slice(2).join('')).includes(noWhitespace(task)));
    }
    assertFits(api, row);
  } finally { view.dispose(); }
});

test('send_message shows destination and full multiline body, refreshing streamed args', async () => {
  const api = await ready;
  const { tui, chat, view } = scene(api);
  const body = 'Review all modules carefully without dropping this detailed request.\n\nSecond paragraph with 界 👩‍💻 e\u0301 and a final tail.';
  const row = tool(api, tui, 'send_message', { agent_name: 'worker', message: body });
  chat.addChild(row);
  try {
    const wide = plain(chat.render(160));
    assert.equal(wide[1], ' send message to worker');
    assert.deepEqual(wide.slice(2), body.split('\n').map(line => '   ' + line));
    const narrow = plain(chat.render(28));
    assert.ok(noWhitespace(narrow.slice(2).join('')).includes(noWhitespace(body)));
    row.updateArgs({ agent_name: 'another', message: 'Updated\nmessage' });
    assert.deepEqual(plain(chat.render(100)), ['', ' send message to another', '   Updated', '   message']);
    assertFits(api, row);
  } finally { view.dispose(); }
});

test('real custom received-message components use envelope details, not boxed native content', async () => {
  const api = await ready;
  const { chat, view } = scene(api);
  const body = 'Full received report including all the relevant findings and the final tail.\nA second line.';
  const details = freeze({ from: 'reviewer', to: 'main', message: body, id: 'message-1' });
  const row = message(api, details, 'Message from wrong:\nWRONG CONTENT');
  chat.addChild(row);
  const snapshot = structuredClone(row.message);
  try {
    assert.deepEqual(plain(chat.render(160)), ['', ' receive message from reviewer', ...body.split('\n').map(line => '   ' + line)]);
    assert.ok(noWhitespace(flattened(chat.render(30))).includes(noWhitespace(body)));
    assert.ok(!chat.render(100).join('').includes('\x1b[48;'));
    assert.doesNotMatch(flattened(chat.render(100)), /native custom renderer|WRONG CONTENT|subagents\.message/);
    assert.deepEqual(row.message, snapshot);
    assert.equal(row.message.details, details);
    assertFits(api, row);
  } finally { view.dispose(); }
});

test('received-message fallback is restricted to the known custom type and preserves multiline text', async () => {
  const api = await ready;
  const { chat, view } = scene(api);
  const body = 'Fallback body\nAnother line with a tail.';
  const row = message(api, undefined, `Message from legacy-worker:\n${body}`);
  const blocks = message(api, undefined, [{ type: 'text', text: `Message from block-worker:\n${body}` }]);
  const unknown = message(api, { from: 'not-a-subagent', message: body }, `Message from fake:\n${body}`, 'unrelated.custom');
  const nativeUnknown = unknown.render(100);
  chat.addChild(row);
  chat.addChild(blocks);
  chat.addChild(unknown);
  try {
    const lines = plain(chat.render(100));
    assert.ok(lines.includes(' receive message from legacy-worker'));
    assert.ok(lines.includes(' receive message from block-worker'));
    assert.equal(lines.filter(line => line === '   Fallback body').length, 2);
    assert.deepEqual(unknown.render(100), nativeUnknown);
    for (const details of [null, {}, { from: 12, message: false }]) {
      chat.addChild(message(api, details, 'Malformed envelope text'));
    }
    assert.doesNotThrow(() => chat.render(80));
  } finally { view.dispose(); }
});

test('operational summaries show goal/status/reason, approval, wait sender, scope and session action without stdin', async () => {
  const api = await ready;
  const { tui, chat, view } = scene(api);
  const specs = [
    ['set_goal', { goal: 'Ship the release' }, undefined, ['Ship the release']],
    ['set_goal_status', { status: 'blocked', reason: 'Need reviewer approval' }, undefined, ['blocked', 'Need reviewer approval']],
    ['finish_plan', { approved: false }, undefined, ['false']],
    ['finish_plan', { approved: true }, undefined, ['true']],
    ['wait_message', { timeout: 45 }, { status: 'received', messages: [{ from: 'reviewer', id: 'm', message: 'DO NOT PRINT RECEIVED BODY' }] }, ['45', 'reviewer']],
    ['list_agents', { all: true }, undefined, ['all']],
    ['list_agents', { all: false }, undefined, []],
    ['list_agents', {}, undefined, []],
    ['wait_message', {}, undefined, ['120']],
    ['interact_bash', { session_name: 'build-session' }, undefined, ['build-session', 'poll']],
    ['interact_bash', { session_name: 'empty-session', stdin: '' }, undefined, ['empty-session', 'poll']],
    ['interact_bash', { session_name: 'input-session', stdin: 'SECRET STDIN' }, undefined, ['input-session', 'send']],
    ['close_bash', { session_name: 'old-session' }, undefined, ['old-session']],
  ];
  try {
    for (const [name, args, details, expected] of specs) {
      const row = tool(api, tui, `functions.${name}`, args, details, `op-${chat.children.length}`);
      chat.addChild(row);
      chat.render(160);
      const text = flattened(row.render(160));
      for (const part of expected) assert.ok(text.includes(part), `${name} should include ${part}: ${text}`);
      assert.doesNotMatch(text, /SECRET STDIN|DO NOT PRINT RECEIVED BODY|native result body/);
      assertFits(api, row);
    }
    const scope = chat.children.filter(row => row.toolName === 'functions.list_agents').map(row => flattened(row.render(100)));
    assert.notEqual(scope[0], scope[1], 'all agents and direct children need distinguishable scopes');
    assert.equal(scope[1], scope[2], 'default list scope is direct children');
    const wait = tool(api, tui, 'wait_message', { timeout: 9 }, { status: 'timeout', messages: [] });
    chat.addChild(wait);
    assert.match(flattened(chat.render(160)), /timed out|timeout/i);
  } finally { view.dispose(); }
});

test('nested codemode uses the same question grouping and custom tool body renderers', async () => {
  const api = await ready;
  const { tui, chat, view } = scene(api);
  const specs = [
    ['ask_question', { questions: [{ question: 'First nested?' }] }, { questions: [answer('First nested?', 'First nested answer')] }],
    ['ask_questions', { questions: [{ question: 'Second nested?' }] }, { questions: [answer('Second nested?', 'Second nested answer', 'Nested note')] }],
    ['create_agent', { name: 'nested-worker', task: 'Complete nested task\nDo not drop this line', agent_template: 'review' }],
    ['send_message', { agent_name: 'nested-worker', message: 'Complete nested message\nPreserve this tail' }],
    ['set_goal_status', { status: 'blocked', reason: 'Nested reason' }],
    ['interact_bash', { session_name: 'nested-session', stdin: 'NESTED SECRET' }],
  ];
  const calls = specs.map(([name, args], index) => ({ id: `cm/${index}`, name: `functions.${name}`, args: JSON.stringify(args), status: 'ok' }));
  const row = tool(api, tui, 'codemode', { code: 'await tools.list_agents({});' }, { calls }, 'cm');
  specs.forEach(([name, args, details], index) => view.nestedCalls.set(`cm/${index}`, { name: `functions.${name}`, args, result: result(details), running: false }));
  chat.addChild(row);
  try {
    const lines = plain(chat.render(160));
    assert.equal(lines[1], ' codemode');
    assert.equal(lines.filter(line => /ask_questions?/.test(line)).length, 1);
    assert.ok(lines.includes('     question: First nested?'));
    assert.ok(lines.includes('     answer: First nested answer'));
    assert.ok(lines.includes('     answer: Second nested answer'));
    assert.ok(lines.some(line => line.includes('notes: Nested note')));
    assert.ok(lines.includes('   create agent nested-worker · template: review'));
    assert.ok(lines.includes('     Complete nested task'));
    assert.ok(lines.includes('     Do not drop this line'));
    assert.ok(lines.includes('   send message to nested-worker'));
    assert.ok(lines.includes('     Preserve this tail'));
    assert.match(lines.join('\n'), /Nested reason/);
    assert.doesNotMatch(lines.join('\n'), /NESTED SECRET/);
    assertFits(api, row);
    view.nestedCalls.get('cm/0').running = true;
    assert.match(flattened(chat.render(100)), /answer:.*pending/i);
    view.nestedCalls.clear();
    assert.doesNotThrow(() => chat.render(80), 'restored calls have arguments but no retained results');
    assert.match(flattened(chat.render(160)), /question: First nested\?/);
  } finally { view.dispose(); }
});

test('custom tools and messages fit unicode widths, follow themes, and strip terminal control sequences', async () => {
  const api = await ready;
  const { tui, chat, view } = scene(api);
  const hostile = '界 👩‍💻 e\u0301\x1b[2J\x1b]52;c;c2VjcmV0\x07\x1b]8;;https://bad.invalid\x1b\\link\x1b]8;;\x1b\\\x1b[31mred\x1b[0m\r\nSafe tail\x00';
  const rows = [
    tool(api, tui, 'ask_question', { questions: [{ question: hostile }] }, { questions: [answer(hostile, hostile, hostile)] }),
    tool(api, tui, 'create_agent', { name: hostile, agent_template: hostile, task: hostile }),
    tool(api, tui, 'send_message', { agent_name: hostile, message: hostile }),
    message(api, { from: hostile, to: 'main', message: hostile, id: 'safe' }),
  ];
  rows.forEach(row => chat.addChild(row));
  try {
    const dark = chat.render(100);
    api.themes.initTheme('light');
    const light = chat.render(100);
    assert.notDeepEqual(light, dark);
    assert.deepEqual(plain(light), plain(dark));
    for (const row of rows) assertFits(api, row);
    const raw = chat.render(160).join('\n');
    assert.ok(!raw.includes('\x1b]'), 'OSC clipboard/hyperlinks must not reach the terminal');
    assert.ok(!raw.includes('\x1b[2J'), 'cursor/erase sequences must not reach the terminal');
    assert.ok(!raw.includes('\x07') && !raw.includes('\x00') && !raw.includes('\r'));
    assert.ok(!raw.includes('\x1b[31m'), 'input SGR styling must not override the theme');
    assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(plain([raw])[0]), 'only trusted generated SGR escapes may remain');
    assert.match(plain([raw])[0], /Safe tail/);
  } finally { view.dispose(); api.themes.initTheme('dark'); }
});

test('compact rendering restores native instances exactly and never mutates args/results/messages or prototypes', async () => {
  const api = await ready;
  const { tui, chat, view } = scene(api);
  const args = freeze({ questions: [{ question: 'Immutable question?' }] });
  const details = freeze({ questions: [answer('Immutable question?', 'Immutable answer', 'Immutable note')] });
  const row = tool(api, tui, 'ask_question', args, details);
  const incoming = message(api, freeze({ from: 'worker', to: 'main', message: 'Immutable message', id: 'm' }));
  const nativeTool = row.render(100);
  const nativeMessage = incoming.render(100);
  const toolPrototype = api.ToolExecutionComponent.prototype.render;
  const messagePrototype = api.CustomMessageComponent.prototype.render;
  const savedResult = row.result;
  const savedMessage = incoming.message;
  const snapshot = structuredClone({ args, result: savedResult, message: savedMessage });
  chat.addChild(row);
  chat.addChild(incoming);
  try {
    chat.render(100);
    assert.notDeepEqual(row.render(100), nativeTool);
    assert.notDeepEqual(incoming.render(100), nativeMessage);
    assert.equal(row.args, args);
    assert.equal(row.result, savedResult);
    assert.equal(incoming.message, savedMessage);
    assert.deepEqual({ args: row.args, result: row.result, message: incoming.message }, snapshot);
    assert.equal(api.ToolExecutionComponent.prototype.render, toolPrototype);
    assert.equal(api.CustomMessageComponent.prototype.render, messagePrototype);
    view.enabled = false;
    assert.deepEqual(row.render(100), nativeTool);
    assert.deepEqual(incoming.render(100), nativeMessage);
    view.enabled = true;
    chat.render(100);
    view.dispose();
    view.dispose();
    assert.equal(Object.hasOwn(row, 'render'), false);
    assert.equal(Object.hasOwn(incoming, 'render'), false);
    assert.equal(Object.hasOwn(chat, 'render'), false);
    assert.deepEqual(row.render(100), nativeTool);
    assert.deepEqual(incoming.render(100), nativeMessage);
  } finally { view.dispose(); }
});
