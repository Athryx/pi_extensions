const {load,host,root}=require('../subagents/test-helper.cjs');
module.exports={load:file=>load('../codex-web-search/'+file),host,root};
