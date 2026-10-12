const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, mkdir, writeFile, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {load} = require('./test-helper.cjs');
test('default_agent is optional, strict, project-trusted and project-preferred', async () => {
  const {loadConfig} = await load('config.ts');
  const dir = await mkdtemp(join(tmpdir(), 'subagents-default-agent-'));
  const user = join(dir, 'user'), project = join(dir, 'project');
  try {
    await mkdir(user); await mkdir(join(project, '.pi'), {recursive: true});
    assert.equal((await loadConfig(user, project, true)).default_agent, undefined);
    await writeFile(join(user, 'subagents.json'), JSON.stringify({default_agent: 'user_agent'}));
    await writeFile(join(project, '.pi/subagents.json'), JSON.stringify({default_agent: 'Project-Agent'}));
    assert.equal((await loadConfig(user, project, false)).default_agent, 'user_agent');
    assert.equal((await loadConfig(user, project, true)).default_agent, 'Project-Agent');
    await writeFile(join(project, '.pi/subagents.json'), JSON.stringify({max_depth: 2}));
    assert.equal((await loadConfig(user, project, true)).default_agent, 'user_agent');
    for (const value of [null, false, 1, [], {}, '', ' ', 'bad name', '../main', '1main', 'a'.repeat(65)]) {
      await writeFile(join(project, '.pi/subagents.json'), JSON.stringify({default_agent: value}));
      await assert.rejects(loadConfig(user, project, true), /default_agent/);
      assert.equal((await loadConfig(user, project, false)).default_agent, 'user_agent');
    }
    await writeFile(join(project, '.pi/subagents.json'), JSON.stringify({default_agent: 'a'.repeat(64)}));
    assert.equal((await loadConfig(user, project, true)).default_agent.length, 64);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('discovery has no implicit bundled definitions', async () => {
  const {discoverTemplates} = await load('templates.ts');
  const result = await discoverTemplates([]);
  assert.equal(result.templates.size, 0);
  assert.deepEqual(result.diagnostics, []);
});

test('strict YAML normalization and validation', async () => {
  const {parseTemplate} = await load('templates.ts');
  const p = text => parseTemplate(text, '/tmp/agents/test.yaml');
  const t = p('name: worker');
  assert.equal(t.model.name,'parent'); assert.equal(t.skills.include_defaults,true);
  assert.deepEqual(t.subagents.allowed,[]);
  assert.equal(t.selectable,true);
  assert.equal(t.subagents.include_defaults,false);
  assert.equal(p('name: worker\nselectable: false').selectable,false);
  assert.deepEqual(p('name: worker\nsubagents: {include_defaults: false, extra: [worker], default: worker}').subagents.allowed,['worker']);
  assert.equal(p('name: worker\nsubagents: {include_defaults: true, default: worker}').subagents.default,'worker');
  for (const body of ['selectable: no','selectable: null','subagents: {include_defaults: null}','subagents: {include_defaults: yes}','subagents: {extra: worker}','subagents: {allowed: [], extra: []}','subagents: {allowed: [], include_defaults: true}']) assert.throws(()=>p('name: worker\n'+body));
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
test('default child permissions expand after precedence and transitive quarantine', async () => {
  const {discoverTemplates} = await load('templates.ts');
  const dir = await mkdtemp(join(tmpdir(),'subagents-defaults-'));
  try {
    for (const d of ['agents','extras']) await mkdir(join(dir,d));
    for (const [file, body] of Object.entries({
      'agents/main.yaml': 'name: main\nsubagents: {include_defaults: true, extra: [hidden, hidden], default: hidden}',
      'agents/hidden.yaml': 'name: hidden\nselectable: false',
      'agents/leaf.yaml': 'name: leaf',
      'agents/broken.yaml': 'name: broken\nsubagents: {extra: [missing]}',
      'agents/dependent.yaml': 'name: dependent\nsubagents: {extra: [broken]}',
      'agents/bad-default.yaml': 'name: bad-default\nsubagents: {include_defaults: true, default: missing}',
      'extras/leaf.yaml': 'name: leaf\nprompt: override',
      'extras/extra.yaml': 'name: extra',
    })) await writeFile(join(dir,file), body);
    const {templates, diagnostics} = await discoverTemplates([join(dir,'agents'),join(dir,'extras')]);
    assert.deepEqual([...templates.keys()].sort(), ['extra','hidden','leaf','main']);
    assert.deepEqual([...templates.get('main').subagents.allowed].sort(), ['extra','hidden','leaf','main']);
    assert.equal(templates.get('hidden').selectable,false);
    assert.equal(templates.get('leaf').prompt,'override');
    assert.deepEqual(templates.get('leaf').subagents.allowed,[]);
    assert.match(diagnostics.join(' '),/missing child template/);
    // Refresh resolves defaults again rather than preserving the old catalog.
    await rm(join(dir,'extras/extra.yaml'));
    const refreshed = await discoverTemplates([join(dir,'agents'),join(dir,'extras')]);
    assert.equal(refreshed.templates.get('main').subagents.allowed.includes('extra'),false);
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
  for (const name of ['send_message','wait_message','list_agents']) {
    assert.ok(loadout(t).includes(name));
    assert.notEqual(tools.find(tool=>tool.name===name).exposure,'hidden');
  }
  const mainTools=[]; registerTools({registerTool:tool=>mainTools.push(tool)},()=>{},'main',false);
  assert.ok(mainTools.every(tool=>tool.exposure==='hidden'));
  const explicit=parseTemplate('name: leaf\ntools: {extra: [create_agent, send_message, wait_message, list_agents]}', '/tmp/leaf.yaml');
  assert.deepEqual(loadout(explicit, ['read','list_agents'], 'main'), ['read']);
  for(const t of tools) assert.equal(t.parameters.additionalProperties,false);
});
