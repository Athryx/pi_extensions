const {load,host,root}=require('../subagents/test-helper.cjs');
module.exports={load:file=>load('../tavily-search/'+file),host,root};
