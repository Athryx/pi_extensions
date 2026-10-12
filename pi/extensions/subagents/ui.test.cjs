const {test} = require('node:test');
const assert = require('node:assert/strict');
const {load,host} = require('./test-helper.cjs');
async function ui() {
  const themes=await host('dist/modes/interactive/theme/theme.js'); themes.initTheme('dark');
  const {AgentsView}=await load('view.ts'), tui=await host('node_modules/@earendil-works/pi-tui/dist/index.js');
  const message={role:'assistant',api:'test',provider:'test',model:'test',timestamp:1,stopReason:'stop',content:[{type:'text',text:'**Live output**\n'+Array.from({length:80},(_,i)=>'line '+i+' 日本語').join('\n')}],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  const record=name=>({identity:{name,parentName:name==='main'?null:'main'},status:name==='idle'?'idle':'running',messages:[{...message}],inbox:[],pending:[]});
  const records=new Map(['main','active','idle'].map(n=>[n,record(n)]));
  const listeners=new Set();
  const workspace={records,subscribe:l=>{listeners.add(l);return ()=>listeners.delete(l);}};
  const terminal=new tui.Container(); terminal.terminal={rows:18,columns:80};terminal.requestRender=()=>{};
  let done=false;
  const view=new AgentsView(workspace,terminal,themes.theme,()=>done=true);
  return {view,terminal,records,listeners,tui,get done(){return done;}};
}
test('read-only viewer cycles active agents, groups idle, scrolls and disposes subscriptions',async()=>{
  const f=await ui();
  assert.equal(f.listeners.size,1);
  const plain=lines=>lines.map(f.tui.stripTerminalSequences);
  assert.match(plain(f.view.render(80))[0],/main.*active/); assert.doesNotMatch(plain(f.view.render(80))[0],/idle/);
  f.view.handleInput('\t');assert.equal(f.view.selected,'active');
  f.view.handleInput('i');f.view.handleInput('\t');assert.equal(f.view.selected,'idle');
  f.view.render(80);f.view.handleInput('\x1b[H');
  assert.match(plain(f.view.render(80)).join('\n'),/Live output/);
  f.view.handleInput('\x1b[F');
  assert.match(plain(f.view.render(80)).join('\n'),/line 79/);
  f.view.handleInput('\x1b');assert.equal(f.done,true);assert.equal(f.listeners.size,0);
});
test('narrow widths, resize, live updates, terminal-sequence removal and tool projections',async()=>{
  const f=await ui();
  try {
    for(const width of [12,35,80]) for(const line of f.view.render(width)) assert.ok(f.tui.visibleWidth(line)<=width);
    f.records.get('active').status='idle';f.view.handleInput('\t');assert.equal(f.view.selected,'main');
    f.records.get('main').messages.push({role:'custom',customType:'test',display:true,content:'notice\x1b]52;c;bad\x07',timestamp:2});
    for(const l of f.listeners) l();
    const rendered=f.view.render(80).join('\n');assert.match(rendered,/notice/);assert.doesNotMatch(rendered,/52;c;bad/);
    f.terminal.terminal.rows=10;assert.equal(f.view.render(30).length,10);
  } finally {f.view.dispose();}
});
