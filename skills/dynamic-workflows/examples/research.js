// @options: {"max_output_tokens": 2000}
// Run from a project containing README.md and AGENTS.md.
// Define two read-only roles, gather findings in parallel, then summarize them.
await workflow.register_agents([
  {
    name: "researcher",
    tools: { include_defaults: false, extra: ["read"] },
    skills: { include_defaults: false },
    prompt: "Read only the assigned files. Return concise findings with supporting paths. Report missing files or uncertainty. Do not change files.",
    subagents: { include_defaults: false },
  },
  {
    name: "summarizer",
    tools: { include_defaults: false, extra: [] },
    skills: { include_defaults: false },
    prompt: "Summarize only the supplied findings. Preserve supporting paths and uncertainty; do not invent facts or make file changes.",
    subagents: { include_defaults: false },
  },
]);

return await workflow.sequence([
  async (_prior, w) => {
    await w.set_status("Research project files");
    return await w.parallel([
      async branch => {
        await branch.set_status("Read project overview");
        return await branch.agent("Read README.md and summarize the project's purpose and architecture with paths.", "researcher");
      },
      async branch => {
        await branch.set_status("Read project conventions");
        return await branch.agent("Read AGENTS.md and summarize the project's development conventions with paths.", "researcher", "conventions");
      },
    ], "Gather evidence");
  },
  async (findings, w) => {
    await w.set_status("Summarize project findings");
    return await w.agent(
      "Create a concise project overview from these two research results (overview first, conventions second). Keep supporting paths and any caveats.\n" + JSON.stringify(findings),
      "summarizer",
    );
  },
], "Project overview");
