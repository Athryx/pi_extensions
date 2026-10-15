// Uses the repository's existing development TypeScript installation, never a second Pi SDK.
const {mkdtempSync, writeFileSync, rmSync, realpathSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join, resolve, dirname} = require('node:path');
const {execFileSync} = require('node:child_process');
const root = resolve(dirname(realpathSync(execFileSync('which',['pi'],{encoding:'utf8'}).trim())), '../..');
const temp = mkdtempSync(join(tmpdir(),'pi-compaction-types-'));
const paths = {
  '@earendil-works/pi-coding-agent':[join(root,'dist/index.d.ts')],
  '@earendil-works/pi-ai':[join(root,'node_modules/@earendil-works/pi-ai/dist/compat.d.ts')],
  '@earendil-works/pi-agent-core':[join(root,'node_modules/@earendil-works/pi-agent-core/dist/index.d.ts')],
};
try {
  writeFileSync(join(temp,'tsconfig.json'),JSON.stringify({compilerOptions:{noEmit:true,strict:true,skipLibCheck:true,target:'ES2023',module:'ESNext',moduleResolution:'Bundler',allowImportingTsExtensions:true,types:['node'],typeRoots:[resolve(__dirname,'../subagents/node_modules/@types')],paths},include:[join(__dirname,'*.ts'),resolve(__dirname,'../shared/agent-role.ts')]}));
  execFileSync(process.execPath,[resolve(__dirname,'../subagents/node_modules/typescript/bin/tsc'),'-p',join(temp,'tsconfig.json')],{stdio:'inherit'});
} finally {rmSync(temp,{recursive:true,force:true});}
