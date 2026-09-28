import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getShellEnv } from "./shell.ts";
import { BashSessions, MAX_YIELD_MS, yieldMs, type SessionResult } from "./session.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	yield_timeout_ms: Type.Optional(Type.Number({ description: `Wait up to this many milliseconds (default 10000, max ${MAX_YIELD_MS}); return a session if still running` })),
	session_name: Type.Optional(Type.String({ description: "Optional unique name for a background bash session" })),
}, { additionalProperties: false });
const interactSchema = Type.Object({
	session_name: Type.String({ description: "Name of the background bash session" }),
	stdin: Type.Optional(Type.String({ description: "Exact text to write to stdin (no newline added); omit or use empty string to just poll output" })),
	yield_timeout_ms: Type.Optional(Type.Number({ description: `Wait up to this many milliseconds (default 1000 when sending stdin, 10000 when polling, max ${MAX_YIELD_MS})` })),
}, { additionalProperties: false });
const closeSchema = Type.Object({ session_name: Type.String({ description: "Name of the background bash session to kill" }) }, { additionalProperties: false });

interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	sessionName?: string;
	elapsedSeconds: number;
	waitedSeconds?: number;
}

function seconds(ms: number): string { return `${(ms / 1000).toFixed(1)}s`; }

function truncationDescription(result: TruncationResult, lastLineBytes: number): string {
	const headBytes = formatSize(result.headOutputBytes ?? 0);
	const tailBytes = formatSize(result.tailOutputBytes ?? 0);
	if (result.truncatedBy === "lines") {
		const headEnd = result.headOutputLines ?? 0;
		const tailStart = result.totalLines - (result.tailOutputLines ?? 0) + 1;
		return `Showing lines 1-${headEnd} and ${tailStart}-${result.totalLines} of ${result.totalLines}`;
	}
	const lastLine = result.lastLinePartial ? ` (last line is ${formatSize(lastLineBytes)})` : "";
	return `Showing first ${headBytes} and last ${tailBytes} of ${formatSize(result.totalBytes)}${lastLine}`;
}

function getBashEnvironment(ctx: ExtensionContext | undefined): NodeJS.ProcessEnv {
	const env = { ...getShellEnv() };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	if (ctx) {
		env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) env.PI_SESSION_FILE = sessionFile;
		if (ctx.model) {
			env.PI_PROVIDER = ctx.model.provider;
			env.PI_MODEL = ctx.model.id;
		}
		if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	}
	return env;
}

function formatResult(
	result: SessionResult,
	name: string,
	path: string,
	options: { background: boolean; closed?: boolean; showSessionInstructions?: boolean; includeWaitedTime?: boolean },
) {
	const { background, closed = false, showSessionInstructions = false, includeWaitedTime = !closed } = options;
	const { snapshot, lastLineBytes } = result;
	const t = snapshot.truncation;
	let text = snapshot.content || "(no new output)";
	const fullOutput = `${t.truncated ? `${truncationDescription(t, lastLineBytes)}. ` : ""}Full output: ${path}`;
	const details: BashToolDetails = {
		fullOutputPath: path,
		elapsedSeconds: result.elapsedMs / 1000,
		...(includeWaitedTime ? { waitedSeconds: result.waitedMs / 1000 } : {}),
	};
	if (t.truncated) {
		details.truncation = t;
	}
	if (background) {
		details.sessionName = name;
		const instructions = showSessionInstructions ? " Use interact_bash to send stdin or read new output; close_bash to stop it." : "";
		const waited = includeWaitedTime ? `; waited: ${seconds(result.waitedMs)} this call` : "";
		text += `\n\n[Running bash session: ${name}. Command elapsed: ${seconds(result.elapsedMs)}${waited}. ${fullOutput}.${instructions}]`;
	} else if (closed) {
		text += `\n\n[Closed bash session ${name}. Command ran for ${seconds(result.elapsedMs)}. ${fullOutput}]`;
	} else if (result.error) {
		throw new Error(`${text}\n\n[Command ran for ${seconds(result.elapsedMs)}${t.truncated ? `. ${fullOutput}` : ""}]\n${result.error.message}`);
	} else if (result.exitCode !== 0 && result.exitCode !== null) {
		throw new Error(`${text}\n\n[Command ran for ${seconds(result.elapsedMs)}${t.truncated ? `. ${fullOutput}` : ""}]\nCommand exited with code ${result.exitCode}`);
	} else {
		const waited = includeWaitedTime ? `; waited: ${seconds(result.waitedMs)} this call` : "";
		text += `\n\n[Command ran for ${seconds(result.elapsedMs)}${waited}.${t.truncated ? ` ${fullOutput}` : ""}]`;
	}
	return { content: [{ type: "text" as const, text }], details };
}

export function createBashTools(cwd: string, options: { shellPath?: string; commandPrefix?: string } = {}) {
	const sessions = new BashSessions();

	const bash: ToolDefinition<typeof bashSchema, BashToolDetails> = {
		name: "bash", label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr, truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Waits up to yield_timeout_ms (default 10000, max ${MAX_YIELD_MS}); if still running, returns a named background session. Background output is continuously saved to a file.`,
		promptSnippet: "Execute bash commands; long-running commands yield a session for interact_bash/close_bash",
		promptGuidelines: ["You can inspect PI_* environment variables for current model and session details."],
		parameters: bashSchema,
		constrainedSampling: process.env.PI_EXPERIMENTAL === "1" ? { type: "json_schema", strict: "prefer" } : undefined,
		async execute(_id, { command, yield_timeout_ms, session_name }, signal, _onUpdate, ctx) {
			const ms = yieldMs(yield_timeout_ms, 10_000);
			if (signal?.aborted) throw new Error("Command aborted");
			const resolved = options.commandPrefix ? `${options.commandPrefix}\n${command}` : command;
			const session = await sessions.start(session_name, resolved, ctx?.cwd || cwd, getBashEnvironment(ctx), options.shellPath);
			session.busy = true;
			try {
				const result = await session.collect(ms, signal);
				if (result.finished) {
					sessions.remove(session.name);
					if (!result.snapshot.truncation.truncated && !result.error && result.exitCode === 0) {
						await session.discardLog();
						return {
							content: [{ type: "text", text: `${result.snapshot.content || "(no output)"}\n\n[Command ran for ${seconds(result.elapsedMs)}.]` }],
							details: { elapsedSeconds: result.elapsedMs / 1000 },
						};
					}
				}
			return formatResult(result, session.name, session.outputPath, {
				background: !result.finished,
				showSessionInstructions: true,
				includeWaitedTime: false,
			});
			} catch (error) {
				// An aborted initial call must not leave behind an unreferenced process.
				if (signal?.aborted) {
					sessions.remove(session.name);
					await session.close();
					await session.discardLog();
				}
				throw error;
			} finally {
				session.busy = false;
			}
		},
	};

	const interact: ToolDefinition<typeof interactSchema, BashToolDetails> = {
		name: "interact_bash", label: "interact_bash",
		description: `Send text to a running bash session's stdin or poll for new stdout/stderr. Returns only output since the previous call (last ${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES / 1024}KB); full combined output stays in its log. Waits up to yield_timeout_ms (max ${MAX_YIELD_MS}); defaults to 1000ms when sending stdin, 10000ms when polling.`,
		promptSnippet: "Send stdin to or poll a background bash session for new output",
		parameters: interactSchema,
		async execute(_id, { session_name, stdin, yield_timeout_ms }, signal) {
			const ms = yieldMs(yield_timeout_ms, stdin ? 1_000 : 10_000);
			const session = sessions.get(session_name);
			if (session.busy) throw new Error(`Bash session ${session_name} is already being polled`);
			session.busy = true;
			try {
				if (signal?.aborted) throw new Error("Command aborted");
				if (stdin) session.write(stdin);
				const result = await session.collect(ms, signal);
				if (result.finished) sessions.remove(session_name);
			return formatResult(result, session_name, session.outputPath, { background: !result.finished });
			} finally {
				session.busy = false;
			}
		},
	};

	const close: ToolDefinition<typeof closeSchema, BashToolDetails> = {
		name: "close_bash", label: "close_bash",
		description: `Kill a background bash session and its process tree. Returns output since the last poll (last ${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES / 1024}KB); its full output log is retained.`,
		promptSnippet: "Stop a background bash session by name",
		parameters: closeSchema,
		async execute(_id, { session_name }) {
			const session = sessions.get(session_name);
			if (session.busy) throw new Error(`Bash session ${session_name} is already being polled`);
			session.busy = true;
			try {
				await session.close();
				const result = await session.collect(0);
			const { content, details } = formatResult(result, session_name, session.outputPath, { background: false, closed: true });
				sessions.remove(session_name);
				return { content, details };
			} finally {
				session.busy = false;
			}
		},
	};

	return { tools: [bash, interact, close], shutdown: () => sessions.closeAll() };
}
