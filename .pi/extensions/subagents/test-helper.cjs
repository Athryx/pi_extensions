const {realpathSync, mkdtempSync, writeFileSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const output = mkdtempSync(require('node:path').join(tmpdir(), 'pi-subagents-tests-'));
let sequence = 0;
process.on("exit", () => rmSync(output, {recursive: true, force: true}));
const {execFileSync} = require('node:child_process');
const {dirname, resolve, join} = require('node:path');
const {pathToFileURL} = require('node:url');
const root = resolve(dirname(realpathSync(execFileSync('which', ['pi'], {encoding:'utf8'}).trim())), '../..');
const esbuild = require(require.resolve('esbuild', {paths:[root]}));
async function load(file) {
  const result = await esbuild.build({
    entryPoints:[join(__dirname,file)], bundle:true, platform:'node', format:'esm', write:false,
    banner:{js: `import {createRequire as __createRequire} from 'node:module'; const require = __createRequire(${JSON.stringify(pathToFileURL(__filename).href)});`},
    plugins:[{name:'host', setup(build) {
      build.onResolve({filter:/^(@earendil-works\/pi-|typebox)/}, args => {
        const path = args.path === '@earendil-works/pi-coding-agent' ? join(root,'dist/index.js') : require.resolve(args.path, {paths:[root]});
        return {path, external:true};
      });
    }}],
  });
  const path = join(output, (++sequence) + '.mjs');
  writeFileSync(path, result.outputFiles[0].text);
  return import(pathToFileURL(path).href);
}
module.exports = {load, root, host: path => import(pathToFileURL(join(root,path)).href)};
