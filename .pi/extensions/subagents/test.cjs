const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, mkdir, writeFile, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {load} = require('./test-helper.cjs');
test('strict YAML normalization and validation', async () => {
  const {parseTemplate} = await load('templates.ts');
  const p = text => parseTemplate(text, '/tmp/agents/test.yaml');
  const t = p('name: worker');
  assert.equal(t.model.name,'parent'); assert.equal(t.skills.include_defaults,true);
  assert.deepEqual(t.subagents.allowed,[]);
  assert.equal(p('name: worker\nmodel: {name: provider/model/with/slashes, thinking: high}').model.name, 'provider/model/with/slashes');
  assert.equal(p('name: worker\nskills: {extra_paths: [./skills]}').skills.extra_paths[0],'/tmp/agents/skills');
  for (const body of ['name: worker\nname: duplicate','name: worker\nunknown: true','name: worker\nmodel: {foo: true}','name: worker\ntools: {extra: bash}','name: worker\nsubagents: {allowed: [], default: worker}','name: worker\nmodel: {thinking: huge}','name: worker\n---\nname: second','name: worker\nprompt: !unsafe text']) assert.throws(()=>p(body), undefined,body);
  assert.throws(()=>p('name: worker\nprompt: ' + 'a'.repeat(140000)),/128 KiB/);
});
test('discovery precedence, quarantine and trusted config', async () => {
  const {discoverTemplates} = await load('templates.ts'), {loadConfig} = await load('config.ts');
  const dir = await mkdtemp(join(tmpdir(),'subagents-config-'));
  try {
    for(const d of ['user/agents','project/.pi/agents']) await mkdir(join(dir,d),{recursive:true});
    await writeFile(join(dir,'user/agents/a.yaml'),'name: main\nprompt: user');
    await writeFile(join(dir,'project/.pi/agents/a.yaml'),'name: main\nprompt: project');
    let result = await discoverTemplates([join(dir,'user/agents'),join(dir,'project/.pi/agents')]);
    assert.equal(result.templates.get('main').prompt,'project');
    await writeFile(join(dir,'project/.pi/agents/a.yaml'),'name: main\ntools: {oops: true}');
    result = await discoverTemplates([join(dir,'user/agents'),join(dir,'project/.pi/agents')]);
    assert.equal(result.templates.has('main'),false); assert.match(result.diagnostics.join(' '),/unknown/);
    await writeFile(join(dir,'project/.pi/subagents.json'),JSON.stringify({max_running:3,agent_paths:['./extra']}));
    assert.equal((await loadConfig(join(dir,'user'),join(dir,'project'),false)).max_running,8);
    const c = await loadConfig(join(dir,'user'),join(dir,'project'),true);
    assert.equal(c.max_running,3); assert.equal(c.agent_paths[0],join(dir,'project/.pi/extra'));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('independent model inheritance, child permissions and strict tool schemas', async () => {
  const {selection,loadout} = await load('loadout.ts'), {parseTemplate} = await load('templates.ts'), {registerTools} = await load('tools.ts');
  const parent={model:{provider:'p',id:'one'},thinking:'low'}, global={model:{provider:'g',id:'two'},thinking:'high'};
  const t=parseTemplate('name: worker\nmodel: {name: global, thinking: parent}', '/tmp/w.yaml');
  assert.deepEqual(selection(t,parent,global,{modelRegistry:{find(){}}}),{model:global.model,thinking:'low'});
  assert.equal(loadout(t).includes('create_agent'),false);
  const tools=[]; registerTools({registerTool:t=>tools.push(t)},()=>{},'worker',false);
  assert.equal(tools.find(t=>t.name==='create_agent').exposure,'hidden');
  for(const t of tools) assert.equal(t.parameters.additionalProperties,false);
});
