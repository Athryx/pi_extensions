/** Callback closures and undefined results never cross the JSON host bridge. */
export function runtimeSource(root: string, toolNames: string[], modelNames: string[]): string {
  return `const workflow = (() => {
    const host = __workflowHost;
    function facade(scope) {
      const call = (op, data = {}) => host({op, scope, ...data});
      const scopedTools = {};
      for (const name of ${JSON.stringify(toolNames)}) scopedTools[name] = args => call("tool", {name,args});
      const scopedModels = {};
      for (const name of ${JSON.stringify(modelNames)}) scopedModels[name] = (...args) => call("model", {name,args});
      function validate(callbacks, label) {
        if (!Array.isArray(callbacks))
          throw new TypeError("Composition requires an array of functions");
        // Snapshot every index, including holes, before the first host await.
        const copy = Array.from(callbacks);
        if (!copy.every(fn => typeof fn === "function"))
          throw new TypeError("Composition requires an array of functions");
        if (label !== undefined && (typeof label !== "string" || !label.length || [...label].length > 80))
          throw new TypeError("Composition label must be 1–80 characters");
        return copy;
      }
      async function sequence(stages, label) {
        stages = validate(stages, label);
        const group = await call("create", {kind:"sequence",count:stages.length,label});
        let prior;
        try {
          for (let i=0;i<stages.length;i++) {
            const child = group.children[i];
            await host({op:"start",scope:child});
            try { prior = await stages[i](prior,facade(child)); }
            catch (error) { await host({op:"finish",scope:child,status:"failed"}); throw error; }
            await host({op:"finish",scope:child,status:"completed"});
          }
          await host({op:"finish",scope:group.id,status:"completed"});
          return prior;
        } catch(error) {
          await host({op:"finish",scope:group.id,status:"failed"});
          throw error;
        }
      }
      async function parallel(branches, label) {
        branches = validate(branches, label);
        const group = await call("create", {kind:"parallel",count:branches.length,label});
        let failure, failed = false, cleanup, reportFailure;
        const firstFailure = new Promise(resolve => { reportFailure = resolve; });
        const jobs = branches.map(async (branch, i) => {
          const child = group.children[i];
          try {
            await host({op:"start",scope:child});
            const value = await branch(facade(child));
            await host({op:"finish",scope:child,status:"completed"});
            return value;
          } catch(error) {
            if (!failed) {
              failed = true; failure = error;
              cleanup = host({op:"fail",scope:group.id,failed_scope:child});
              reportFailure({failed:true});
            }
            throw error;
          }
        });
        // Observe all callbacks, but never await pure-JS work that cancellation cannot settle.
        for (const job of jobs) job.catch(()=>{});
        const results = await Promise.race([Promise.all(jobs).catch(()=>({failed:true})), firstFailure]);
        if (failed) {
          await cleanup;
          if (failure instanceof Error) failure.message += " (parallel " + (label || "branches") + ")";
          throw failure;
        }
        await host({op:"finish",scope:group.id,status:"completed"});
        return results;
      }
      return Object.freeze({
        agent: (prompt, template, name) => call("agent",{prompt,template,name}),
        register_agents: definitions => call("register",{definitions}),
        set_status: label => call("status",{label}),
        sequence, parallel, tools:Object.freeze(scopedTools), models:Object.freeze(scopedModels)
      });
    }
    return facade(${JSON.stringify(root)});
  })();
`;
}
export function mapStack(stack: string, sourcePath: string, prefixLines: number): string {
  return stack.replace(/codemode\.js:(\d+)(?::(\d+))?/g, (_match,line,column)=>{
    const number=Number(line)-prefixLines;
    return number > 0 ? sourcePath + ":" + number + (column ? ":" + column : "") : "<workflow runtime>";
  });
}
