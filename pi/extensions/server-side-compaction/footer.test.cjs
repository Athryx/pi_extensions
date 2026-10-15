const {test} = require('node:test');
const assert = require('node:assert/strict');
const {stripVTControlCharacters:stripAnsi} = require('node:util');
const {execFileSync} = require('node:child_process');
const {realpathSync} = require('node:fs');
const {join, resolve, dirname} = require('node:path');
const {pathToFileURL} = require('node:url');
const root = resolve(dirname(realpathSync(execFileSync('which', ['pi'], {encoding:'utf8'}).trim())), '../..');
const host = path => import(pathToFileURL(join(root, path)).href);
const loaded = (async () => {
  const agent = await host('dist/index.js');
  const tui = await host('node_modules/@earendil-works/pi-tui/dist/index.js');
  const dependencies = {'@earendil-works/pi-coding-agent':agent, '@earendil-works/pi-tui':tui};
  const esbuild = require(require.resolve('esbuild', {paths:[root]}));
  const result = await esbuild.build({entryPoints:[join(__dirname,'footer.ts')],bundle:true,write:false,platform:'node',format:'cjs',external:Object.keys(dependencies)});
  const module = {exports:{}};
  new Function('module','exports','require',result.outputFiles[0].text)(module,module.exports,name=>dependencies[name] ?? require(name));
  return {...module.exports,...agent,...tui};
})();

test('exact auto and override footer labels', async () => {
  const {compactionLabel} = await loaded;
  for (const backend of ['server','pi']) {
    assert.equal(compactionLabel(backend,'auto'), `${backend} compaction (auto)`);
    for (const mode of ['server','pi']) assert.equal(compactionLabel(backend,mode), `${backend} compaction (override)`);
  }
});

test('native footer appends grey label at right without changing other rows or overflowing', async () => {
  const {CompactionFooter,FooterComponent,visibleWidth} = await loaded;
  const component = Object.create(FooterComponent.prototype);
  let native = ['cwd', '\x1b[90mstats'+ ' '.repeat(75) +'model • medium\x1b[0m', 'other status'];
  const original = () => native;
  component.render = original;
  let text = '\x1b[90m • server compaction (auto)\x1b[0m', redraws = 0;
  const adapter = new CompactionFooter({children:[{children:[component]}],requestRender(){redraws++;}},()=>text);
  const first = component.render(100);
  assert.match(stripAnsi(first[1]), /model • medium • server compaction \(auto\)$/);
  assert.equal(visibleWidth(first[1]), visibleWidth(native[1]));
  assert.equal(first[0], 'cwd'); assert.equal(first[2], 'other status');
  assert.equal(native[1].includes('compaction'),false);
  assert.equal(component.render(100)[1],first[1]); // unchanged frame cache
  text = '\x1b[37m • pi compaction (override)\x1b[0m';
  const changed = component.render(100)[1];
  assert.notEqual(changed,first[1]); assert.match(changed,/\x1b\[37m/);
  native = ['cwd','stats  model','other status'];
  assert.equal(component.render(12)[1],native[1]); // narrow: leave native untouched
  adapter.refresh(); assert.equal(redraws,1);
  adapter.dispose(); assert.equal(component.render,original);
  adapter.refresh(); assert.equal(redraws,1);
});

test('footer coexistence and disposal never overwrite another adapter', async () => {
  const {CompactionFooter,FooterComponent} = await loaded;
  const component = Object.create(FooterComponent.prototype);
  component.render = () => ['cwd','stats'+ ' '.repeat(60) +'model'];
  const adapter = new CompactionFooter({children:[component],requestRender(){}},()=> ' • pi compaction (auto)');
  const inner = component.render;
  const outer = width => [...inner(width),'usage'];
  component.render = outer;
  adapter.dispose(); adapter.attach();
  assert.equal(component.render,outer);
  assert.deepEqual(component.render(100),['cwd','stats'+ ' '.repeat(60) +'model','usage']);
});
