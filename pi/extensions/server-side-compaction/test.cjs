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
const checkpoints = load('checkpoint.ts'), state = load('state.ts');
const timestamp = '2026-01-01T00:00:00.000Z';
const message = (id, parentId, content) => ({ type: 'message', id, parentId, timestamp, message: { role: 'user', content, timestamp: 1 } });
function encrypted(id, parentId, kept, through) {
  const marker = `Server-side OpenAI checkpoint [${id}]`;
  return { type: 'compaction', id, parentId, timestamp, summary: marker, firstKeptEntryId: kept, tokensBefore: 100, details: { kind: 'server-side-compaction', version: 1, marker, compatibility: { provider: 'openai', api: 'openai-responses', model: 'test', endpoint: 'https://api.openai.com/v1/responses/compact', accountFingerprint: 'a'.repeat(64) }, output: [{ type: 'compaction', encrypted_content: 'opaque' }], source: { summarizedThroughEntryId: through, firstKeptEntryId: kept }, readFiles: [], modifiedFiles: [] } };
}
const branch = () => [message('a', null, 'old fact'), message('b', 'a', 'retained one'), encrypted('c', 'b', 'b', 'a'), message('d', 'c', 'next user')];
const texts = messages => messages.map(m => m.summary ?? (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

test('mode is branch-local, last wins and reset is durable', async () => {
  const { getMode, MODE_ENTRY, modeRecord } = await state;
  const entry = (id, mode) => ({ type: 'custom', id, parentId: null, timestamp, customType: MODE_ENTRY, data: modeRecord(mode) });
  assert.equal(getMode([]), undefined);
  assert.equal(getMode([entry('1', 'server'), entry('2', 'pi')]), 'pi');
  assert.equal(getMode([entry('1', 'server'), entry('2')]), undefined);
  assert.equal(getMode([entry('1', 'server')]), 'server');
  const corrupt = { ...entry('1'), data: { mode: 'bad' } };
  assert.throws(() => getMode([corrupt]));
  assert.equal(getMode([corrupt, entry('2')]), undefined);
  assert.equal(getMode([corrupt, entry('2', 'server')]), 'server');
});

test('only latest projected encrypted checkpoint is active', async () => {
  const { checkpoint } = await checkpoints;
  const entries = branch();
  assert.equal(checkpoint(entries).entry.id, 'c');
  entries.push({ type: 'compaction', id: 'native', parentId: 'd', timestamp, summary: 'real readable summary', firstKeptEntryId: 'd', tokensBefore: 100 });
  assert.equal(checkpoint(entries), undefined);
  // Corruption in an abandoned/superseded old encrypted checkpoint is irrelevant.
  entries[2].details.version = 999;
  assert.equal(checkpoint(entries), undefined);
});

test('reconstruction restores older source once, excludes kept tail and markers', async () => {
  const { reconstructPrefix, reconstructReadableProjection } = await checkpoints;
  const entries = branch();
  const prefix = reconstructPrefix(entries, 'b');
  assert.equal(texts(prefix), 'old fact');
  assert.equal(texts(reconstructReadableProjection(entries).messages), 'old fact\nretained one\nnext user');
  entries.push(message('e', 'd', 'new tail'), encrypted('f', 'e', 'e', 'd'));
  assert.equal(texts(reconstructPrefix(entries, 'e')), 'old fact\nretained one\nnext user');
});

test('readable native baseline and later source edits remain authoritative', async () => {
  const { reconstructPrefix } = await checkpoints;
  const entries = [message('a', null, 'obsolete original'), message('b', 'a', 'baseline tail'), { type: 'compaction', id: 'native', parentId: 'b', timestamp, summary: 'semantic baseline', firstKeptEntryId: 'b', tokensBefore: 100 }, message('d', 'native', 'discard me'), message('e', 'd', 'tail'), encrypted('f', 'e', 'e', 'd'), { type: 'context_edit', id: 'edit', parentId: 'f', timestamp, targetId: 'b', replacement: { content: 'edited baseline tail' } }, { type: 'context_edit', id: 'delete', parentId: 'edit', timestamp, targetId: 'd', replacement: null }];
  const result = texts(reconstructPrefix(entries, 'e'));
  assert.match(result, /semantic baseline/); assert.match(result, /edited baseline tail/);
  assert.doesNotMatch(result, /obsolete original|discard me|Server-side/);
});

test('portable custom message replaces checkpoint semantics without duplication', async () => {
  const { checkpoint, reconstructReadableProjection } = await checkpoints;
  const { PORTABLE_ENTRY } = await state;
  const entries = branch();
  entries.push({ type: 'custom_message', id: 'p', parentId: 'd', timestamp, customType: PORTABLE_ENTRY, display: true, content: 'real portable summary', details: { checkpointId: 'c', summary: 'real portable summary' } });
  assert.equal(checkpoint(entries).portable.summary, 'real portable summary');
  const result = texts(reconstructReadableProjection(entries).messages);
  assert.equal(result.split('real portable summary').length - 1, 1);
  assert.doesNotMatch(result, /old fact|Server-side/); assert.match(result, /retained one/);
});

test('portable edits and content corruption fail closed; latest clean record repairs history', async () => {
  const { checkpoint, reconstructReadableProjection } = await checkpoints;
  const { PORTABLE_ENTRY } = await state;
  const portable = (id, parentId, summary) => ({ type: 'custom_message', id, parentId, timestamp, customType: PORTABLE_ENTRY, display: true, content: summary, details: { checkpointId: 'c', summary } });
  for (const replacement of [null, { content: 'changed' }]) {
    const entries = [...branch(), portable('p', 'd', 'portable one'), { type: 'context_edit', id: 'edit', parentId: 'p', timestamp, targetId: 'p', replacement }];
    assert.throws(() => checkpoint(entries), /invalid|missing/);
    assert.throws(() => reconstructReadableProjection(entries), /invalid|missing/);
    entries.push(portable('repair', 'edit', 'clean repaired summary'));
    assert.equal(checkpoint(entries).portable.summary, 'clean repaired summary');
    const result = texts(reconstructReadableProjection(entries).messages);
    assert.match(result, /clean repaired summary/); assert.doesNotMatch(result, /portable one|changed/);
  }
  const mismatched = [...branch(), { ...portable('p', 'd', 'summary'), content: 'different' }];
  assert.throws(() => checkpoint(mismatched), /invalid|missing/);
  mismatched.push(portable('p2', 'p', 'repaired content'));
  assert.equal(checkpoint(mismatched).portable.summary, 'repaired content');
  const corrupt = [...branch(), portable('p', 'd', '')];
  assert.throws(() => checkpoint(corrupt), /invalid|missing/);
  corrupt.push(portable('p2', 'p', 'repaired corrupt record'));
  assert.equal(checkpoint(corrupt).portable.summary, 'repaired corrupt record');
});

test('corrupt active checkpoint, missing anchors, future versions fail closed', async () => {
  const { checkpoint, reconstructPrefix } = await checkpoints;
  for (const change of [entry => entry.details.version = 99, entry => entry.details.output = [], entry => entry.details.source.summarizedThroughEntryId = 'missing', entry => entry.details.source.firstKeptEntryId = 'a', entry => entry.details.compatibility.endpoint = 'https://evil.example/compact']) {
    const entries = branch(); change(entries[2]); assert.throws(() => checkpoint(entries), /invalid|missing/);
  }
  assert.throws(() => reconstructPrefix(branch(), 'missing'), /invalid|missing/);
});
