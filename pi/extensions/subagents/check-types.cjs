const {mkdtempSync, writeFileSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join,resolve} = require('node:path');
const {execFileSync} = require('node:child_process');
const {root} = require('./test-helper.cjs');
const temp = mkdtempSync(join(tmpdir(),'pi-subagents-types-'));
const paths = {'@earendil-works/pi-coding-agent':[join(root,'dist/index.d.ts')],typebox:[join(root,'node_modules/typebox/build/index.d.mts')]};
for(const name of ['pi-ai','pi-agent-core','pi-tui']) paths['@earendil-works/'+name] = [join(root,'node_modules/@earendil-works',name,'dist/index.d.ts')];
try {
  writeFileSync(join(temp,'tsconfig.json'), JSON.stringify({compilerOptions:{noEmit:true,strict:true,skipLibCheck:true,target:'ES2023',module:'ESNext',moduleResolution:'Bundler',allowImportingTsExtensions:true,types:['node'],typeRoots:[join(__dirname,'node_modules/@types')],paths},include:[join(__dirname,'*.ts'),resolve(__dirname,'../shared/*.ts'),resolve(__dirname,'../ui/*.ts'),...['ask-question','plan-mode','goal-mode'].map(name=>resolve(__dirname,'..',name,'index.ts'))]}));
  execFileSync(process.execPath,[join(__dirname,'node_modules/typescript/bin/tsc'),'-p',join(temp,'tsconfig.json')],{stdio:'inherit'});
} finally {rmSync(temp,{recursive:true,force:true});}
