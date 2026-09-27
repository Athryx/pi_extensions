import { randomBytes } from "node:crypto";
import { createWriteStream, openSync, type WriteStream } from "node:fs";
import { access, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { waitForChildProcess } from "./child-process.ts";
import { getShellConfig, killProcessTree } from "./shell.ts";
import { OutputAccumulator, type OutputSnapshot } from "./output-accumulator.ts";

export const MAX_YIELD_MS = 300_000;
export function yieldMs(value: number | undefined, fallback: number): number {
	const ms = value ?? fallback;
	if (!Number.isInteger(ms) || ms < 0 || ms > MAX_YIELD_MS) {
		throw new Error(`yield_timeout_ms must be an integer between 0 and ${MAX_YIELD_MS}`);
	}
	return ms;
}

export interface SessionResult {
	finished: boolean;
	exitCode: number | null;
	error?: Error;
	snapshot: OutputSnapshot;
	lastLineBytes: number;
}

export class BashSession {
	private child: ChildProcess;
	private log: WriteStream;
	private output = new OutputAccumulator({ persistOutput: false });
	private readonly done: Promise<void>;
	private exitCode: number | null = null;
	private error?: Error;
	private finished = false;
	busy = false;

	private constructor(readonly name: string, readonly outputPath: string, child: ChildProcess, log: WriteStream) {
		this.child = child;
		this.log = log;
		const onData = (data: Buffer) => {
			this.output.append(data);
			if (!log.destroyed && !log.write(data)) {
				child.stdout?.pause();
				child.stderr?.pause();
			}
		};
		const onDrain = () => {
			child.stdout?.resume();
			child.stderr?.resume();
		};
		log.on("drain", onDrain);
		log.on("error", (error: Error) => {
			this.error = error;
			this.kill();
			// Release paused streams even if the log cannot be written.
			child.stdout?.resume();
			child.stderr?.resume();
		});
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		this.done = (async () => {
			try {
				this.exitCode = await waitForChildProcess(child);
			} catch (error) {
				this.error = error instanceof Error ? error : new Error(String(error));
			} finally {
				child.stdout?.off("data", onData);
				child.stderr?.off("data", onData);
				log.off("drain", onDrain);
				if (!log.destroyed) await new Promise<void>((resolve) => log.end(resolve));
				this.finished = true;
			}
		})();
	}

	static async start(name: string, command: string, cwd: string, env: NodeJS.ProcessEnv, shellPath?: string): Promise<BashSession> {
		const config = getShellConfig(shellPath);
		try {
			await access(cwd, constants.F_OK);
		} catch {
			throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
		}
		const outputPath = join(tmpdir(), `pi-bash-${randomBytes(12).toString("hex")}.log`);
		const fd = openSync(outputPath, "wx", 0o600);
		const log = createWriteStream(outputPath, { fd, autoClose: true });
		const fromStdin = config.commandTransport === "stdin";
		try {
			const child = spawn(config.shell, fromStdin ? config.args : [...config.args, command], {
				cwd, env, detached: process.platform !== "win32", windowsHide: true,
				stdio: ["pipe", "pipe", "pipe"],
			});
			const session = new BashSession(name, outputPath, child, log);
			if (fromStdin) {
				// Legacy WSL bash uses -s rather than -c. Its stdin transports the command.
				child.stdin?.write(`${command}\n`);
			}
			return session;
		} catch (error) {
			log.destroy();
			await unlink(outputPath).catch(() => {});
			throw error;
		}
	}

	write(input: string): void {
		if (this.finished || this.child.stdin?.destroyed || !this.child.stdin?.writable) {
			throw new Error(`Bash session ${this.name} is not accepting stdin`);
		}
		this.child.stdin.write(input);
	}

	kill(): void {
		if (this.child.pid) killProcessTree(this.child.pid);
		this.child.stdin?.destroy();
	}

	async close(): Promise<void> {
		if (!this.finished) this.kill();
		await this.done;
	}

	async discardLog(): Promise<void> {
		await this.done;
		await unlink(this.outputPath).catch(() => {});
	}

	async collect(ms: number, signal?: AbortSignal): Promise<SessionResult> {
		if (signal?.aborted) throw new Error("aborted");
		let timer: NodeJS.Timeout | undefined;
		let abort: (() => void) | undefined;
		try {
			await Promise.race([
				this.done,
				new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
				...(signal ? [new Promise<void>((_resolve, reject) => {
					abort = () => reject(new Error("aborted"));
					signal.addEventListener("abort", abort, { once: true });
					if (signal.aborted) abort();
				})] : []),
			]);
		} finally {
			if (timer) clearTimeout(timer);
			if (abort) signal?.removeEventListener("abort", abort);
		}
		// Ensure the log contains everything shown in this tool result.
		if (!this.finished && !this.log.destroyed) {
			await new Promise<void>((resolve) => this.log.write("", resolve));
		}
		if (this.error && !this.finished) await this.done;
		const output = this.output;
		output.finish();
		const snapshot = output.snapshot();
		this.output = new OutputAccumulator({ persistOutput: false });
		return { finished: this.finished, exitCode: this.exitCode, error: this.error, snapshot, lastLineBytes: output.getLastLineBytes() };
	}
}

/** Registry is scoped to one Pi extension runtime/session. */
export class BashSessions {
	private sessions = new Map<string, BashSession | null>();
	private counter = 0;

	async start(name: string | undefined, command: string, cwd: string, env: NodeJS.ProcessEnv, shellPath?: string): Promise<BashSession> {
		let resolved = name;
		if (resolved !== undefined && !resolved.trim()) throw new Error("Session name cannot be empty");
		if (resolved === undefined) {
			do { resolved = `bash${++this.counter}`; } while (this.sessions.has(resolved));
		}
		if (this.sessions.has(resolved)) throw new Error(`Bash session ${resolved} already exists`);
		// Reserve the name before awaiting filesystem checks/spawn, even with parallel tool calls.
		this.sessions.set(resolved, null);
		try {
			const session = await BashSession.start(resolved, command, cwd, env, shellPath);
			this.sessions.set(resolved, session);
			return session;
		} catch (error) {
			this.sessions.delete(resolved);
			throw error;
		}
	}

	get(name: string): BashSession {
		const session = this.sessions.get(name);
		if (!session) throw new Error(`Unknown bash session: ${name}`);
		return session;
	}

	remove(name: string): void { this.sessions.delete(name); }

	async closeAll(): Promise<void> {
		const all = [...this.sessions.values()].filter((session): session is BashSession => !!session);
		this.sessions.clear();
		await Promise.all(all.map((session) => session.close()));
	}
}
