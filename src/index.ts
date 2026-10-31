/**
 * shell-jobs — pi extension that ports codex's unified_exec session model,
 * with pi's built-in `bash` tool's on-disk retention layered on top.
 *
 * Tools exposed to the LLM:
 *   - exec_command(cmd, workdir?, shell?, tty?, yield_time_ms?, on_exit?)
 *   - write_stdin(session_id, chars?, yield_time_ms?, yield_until?)
 *   - set_on_exit(session_id, on_exit)            [disarm/re-arm wake without kill]
 *   - kill_session(session_id, signal?)          [pi-flavor; codex has no equivalent]
 *   - list_sessions()                            [pi-flavor]
 *
 * Semantics:
 *   - Every exec_command starts a long-lived session. If the process is still
 *     alive when the call's yield deadline expires, the tool returns with
 *     `session_id` in its body and the LLM can follow up with write_stdin.
 *   - `write_stdin` with empty `chars` is a pure poll; with non-empty, it also
 *     writes the bytes (including \\x03 for Ctrl-C, \\x04 for EOF).
 *   - Aborting the tool call (Esc) breaks the wait but does not kill the
 *     session; the next turn can still drive it.
 *   - Same-process reload retains sessions; new/resume/fork/quit terminate them.
 *   - Output is mirrored, up to the log quota, to a per-session file at
 *     /tmp/pi-shell-jobs-<sid>-<random>.log. The LLM sees the last ~50 KiB
 *     / 2000 lines per call and the retained file is available via `read`.
 */

import { constants as osConstants } from "node:os";
import { type AgentToolResult, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type TUnsafe } from "typebox";

import type { CollectResult } from "./collect.ts";
import { LogBudget, timeoutSeconds } from "./supervision.ts";
import { CompletionCoordinator, type OnExitPolicy, sanitizeMeta } from "./completion.ts";
import { formatElapsed } from "./format-time.ts";
import { type LongWaitOutcome, startRateLimitedStream, waitForExitOrDeadline } from "./long-wait.ts";
import { sleep } from "./notify.ts";
import { sanitizeOutputText } from "./output-safety.ts";
import { getPtyLoadError, isPtyAvailable } from "./pty.ts";
import {
	renderExecCommandCall,
	renderKillSessionCall,
	renderKillSessionResult,
	renderListSessionsCall,
	renderListSessionsResult,
	renderProcessResult,
	renderSetOnExitCall,
	renderSetOnExitResult,
	renderWriteStdinCall,
} from "./render.ts";
import {
	killNotFoundScriptResult,
	killScriptResult,
	killScriptResultSchema,
	listSessionsScriptResult,
	listSessionsScriptResultSchema,
	processScriptResult,
	processScriptResultSchema,
	setOnExitScriptResult,
	setOnExitScriptResultSchema,
} from "./script-result.ts";
import { ExecSession } from "./session.ts";
import { SessionStore } from "./session-store.ts";
import {
	isNestedToolCall,
	type PendingProbe,
	STEER_NESTED_ERROR,
	STEER_NOTE,
	SteerGate,
	steerInterruptEnabled,
} from "./steer-gate.ts";
import { buildShellCommand, IS_WINDOWS, resolveDefaultShell, resolveWindowsShell } from "./shell.ts";
import { MIN_EMPTY_YIELD_TIME_MS, nowUtcIso, parseYieldUntil, resolveEmptyPollYield } from "./time.ts";
export { MAX_EMPTY_POLL_ENV_VAR, resolveMaxEmptyPollMs } from "./time.ts";
import {
	finalizeKillResult,
	finalizeProcessResult,
	renderKillResultText,
	renderProcessResultText,
	type FinalizeProcessInput,
	type ProcessResultDetails,
} from "./tool-result.ts";
import { unescapeChars } from "./unescape.ts";
import { NestedResults } from "./nested-results.ts";
import { SHELL_JOBS_GUIDANCE } from "./agent-guidance.ts";

// ---------------- Constants (mirror codex) ----------------

const MIN_YIELD_TIME_MS = 250;
const MAX_YIELD_TIME_MS = 30_000;
const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_WRITE_STDIN_YIELD_MS = 250;
const EARLY_EXIT_GRACE_PERIOD_MS = 150;
const MAX_SESSIONS = 64;
const WARNING_SESSIONS = 60;
const LRU_PROTECTED_COUNT = 8;
const OUTPUT_POLL_INTERVAL_MS = 250; // exec/input updates and short empty-poll rate limit
// PTY dimension clamps for exec_command's cols/rows (tty: true only).
const MIN_PTY_COLS = 20;
const MAX_PTY_COLS = 500;
const MIN_PTY_ROWS = 5;
const MAX_PTY_ROWS = 300;
// Long empty polls use output-driven updates, never a periodic heartbeat.
const LONG_WAIT_UPDATE_INTERVAL_MS = 30_000;
const SESSION_UI_KEY = "shell-jobs.sessions";

/**
 * Google-compatible string enum schema (plain `type: "string"` + `enum`,
 * mirroring pi-ai's StringEnum helper) — a TypeBox literal union (anyOf/const)
 * breaks Google models.
 */
function StringEnum<T extends readonly string[]>(values: T, description: string): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({ type: "string", enum: values as unknown as string[], description });
}

// ---------------- Helpers ----------------

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

function clampYield(ms: number | undefined, defaultMs: number): number {
	const v = typeof ms === "number" && ms > 0 ? ms : defaultMs;
	return clamp(Math.floor(v), MIN_YIELD_TIME_MS, MAX_YIELD_TIME_MS);
}

/**
 * Normalize a user/LLM-supplied signal name ("TERM", "sigint", "SIGKILL") to
 * a valid NodeJS.Signals for the current platform. Throws on unknown names so
 * a typo doesn't silently no-op and then escalate to SIGKILL.
 */
function normalizeSignal(raw: string | undefined): NodeJS.Signals {
	if (!raw) return "SIGTERM";
	let name = raw.trim().toUpperCase();
	if (!name.startsWith("SIG")) name = `SIG${name}`;
	if (!(name in osConstants.signals)) {
		throw new Error(`unknown signal "${raw}" (use SIGTERM, SIGINT, SIGKILL, …)`);
	}
	return name as NodeJS.Signals;
}

const textDecoder = new TextDecoder("utf-8", { fatal: false });
const textEncoder = new TextEncoder();

type ResponseShape = ProcessResultDetails;
type ProcessUpdateDetails = Partial<ProcessResultDetails> & { pid?: number; total_bytes?: number };
type FinalizeInput = Omit<FinalizeProcessInput, "operation">;

function decode(bytes: Uint8Array): string {
	return textDecoder.decode(bytes);
}

function encode(str: string): Uint8Array {
	return textEncoder.encode(str);
}

// ---------------- Extension ----------------

interface ExtensionCtx {
	store: SessionStore;
	logBudget: LogBudget;
	reloadTimer?: NodeJS.Timeout;
	/** Agent-level wake scheduling for on_exit: "wake" (see completion.ts). */
	coordinator: CompletionCoordinator;
	/** Bounded by the registry; a weak key also releases evicted job results. */
	terminalResults: WeakMap<ExecSession, ResponseShape>;
	nestedResults: NestedResults;
	ui: ExtensionContext["ui"] | undefined;
	widgetVisible: boolean;
	exitUnsubscribers: Map<number, () => void>;
	warnedShellFallback: boolean;
	notifiedBashSource: boolean;
	/**
	 * Sessions spawned but not yet inserted into the store (inside the
	 * early-exit grace window). session_shutdown must see these too —
	 * otherwise a shutdown racing exec_command orphans the child.
	 */
	pendingSessions: Set<ExecSession>;
	cleanupPending: Set<ExecSession>;
	/** Set on session_shutdown; new exec_commands are rejected. */
	shuttingDown: boolean;
	/** Ends attached waits early while a human steer is queued (steer-gate.ts). */
	steer: SteerGate;
}

// The SessionManager object remains stable across Pi's extension reload. A WeakMap
// fences independent SDK instances, even when they open the same session file.
const reloadKey = Symbol.for("pi-shell-jobs.reload.v1");
const reloadHost = globalThis as typeof globalThis & { [reloadKey]?: WeakMap<object, ExtensionCtx> };
const reloads = reloadHost[reloadKey] ??= new WeakMap<object, ExtensionCtx>();

type ExecCommandArgs = {
	cmd: string;
	timeout_seconds?: number;
	workdir?: string;
	shell?: string;
	tty?: boolean;
	cols?: number;
	rows?: number;
	yield_time_ms?: number;
	on_exit?: OnExitPolicy;
};

type WriteStdinArgs = {
	end_stdin?: boolean;
	cols?: number;
	rows?: number;
	session_id: number;
	chars?: string;
	chars_b64?: string;
	yield_time_ms?: number;
	yield_until?: string;
};

/**
 * Resolve the two mutually-exclusive input channels (`chars` and
 * `chars_b64`) to a single byte payload. Throws on conflicts or malformed
 * base64.
 */
function resolveWriteInput(args: WriteStdinArgs): Uint8Array | undefined {
	const hasChars = typeof args.chars === "string" && args.chars.length > 0;
	const hasB64 = typeof args.chars_b64 === "string" && args.chars_b64.length > 0;
	if (hasChars && hasB64) {
		throw new Error("write_stdin: pass either `chars` or `chars_b64`, not both.");
	}
	if (hasB64) {
		const b64 = args.chars_b64!.replace(/\s+/g, "");
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
			throw new Error("write_stdin: `chars_b64` is not valid base64.");
		}
		return new Uint8Array(Buffer.from(b64, "base64"));
	}
	if (hasChars) {
		// Decode C-style escapes so the LLM can send \x03, \x1b, \n, etc.
		return encode(unescapeChars(args.chars!));
	}
	return undefined;
}

const HELD_OPEN_NOTE =
	"shell has exited, but background process(es) still hold the output pipe " +
	"(inherited stdout/stderr, or a backgrounded `cd … && cmd &` chain whose subshell is still waiting), " +
	"so this session stays open until they exit. To detach: redirect inside the job — " +
	"`(cd dir && cmd >log 2>&1 </dev/null) &` or `setsid cmd >log 2>&1 </dev/null &` — " +
	"or end the session with kill_session.";

/**
 * Explanation for sessions whose shell has exited but whose output pipe is
 * still held open by background processes: they report "running" even though
 * the foreground command is long done. State-driven (never command-text
 * matching), so it covers any construct that leaves a pipe holder behind.
 */
function heldOpenNote(session: ExecSession): string | undefined {
	return session.shellExited && !session.hasExited ? HELD_OPEN_NOTE : undefined;
}

/** Note for a live session whose wait ended because the human steered. */
function steeredNote(session: ExecSession): string {
	const held = heldOpenNote(session);
	return held ? `${STEER_NOTE} Also: ${held}` : STEER_NOTE;
}

async function runExecCommand(
	ctx: ExtensionCtx,
	args: ExecCommandArgs,
	signal: AbortSignal | undefined,
	steerSignal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	cwd: string,
	toolCallId: string,
): Promise<ResponseShape> {
	let session: ExecSession | undefined;
	const finalizeResponse = (input: FinalizeInput): ResponseShape => {
		const shape = finalizeProcessResult({ ...input, operation: "exec_command" });
		if (session) recordProcessResult(ctx, session, shape, toolCallId);
		return shape;
	};
	if (ctx.shuttingDown) {
		throw new Error("shell-jobs: session is shutting down; not starting new commands.");
	}
	if (signal?.aborted) throw new Error("Command cancelled before spawn");
	const timeout = timeoutSeconds(args.timeout_seconds);
	const tty = args.tty ?? false;
	if (tty && !isPtyAvailable()) {
		throw new Error(
			`tty: true requires @homebridge/node-pty-prebuilt-multiarch but it failed to load: ${getPtyLoadError() ?? "unknown"}.\n` +
				`Run:  cd .pi/extensions/shell-jobs && npm install\n` +
				`Or call with tty: false (default).`,
		);
	}

	let shellBin = args.shell;
	if (!shellBin) {
		const resolved = resolveDefaultShell();
		shellBin = resolved.shell;
		if (resolved.fellBack && !ctx.warnedShellFallback) {
			ctx.warnedShellFallback = true;
			ctx.ui?.notify(
				"shell-jobs: no bash found (PATH, git-derived, or known install roots); falling back to powershell. Install Git Bash or set PI_SHELL_JOBS_BASH.",
				"warning",
			);
		} else if (
			!resolved.fellBack &&
			resolved.bashSource &&
			resolved.bashSource !== "path" &&
			resolved.bashSource !== "env" &&
			!ctx.notifiedBashSource
		) {
			// bash located off PATH (derived from git.exe or a known install
			// root) — say so once, so shell selection is never mysterious.
			ctx.notifiedBashSource = true;
			ctx.ui?.notify(`shell-jobs: using bash at ${resolved.shell} (not on PATH)`, "info");
		}
	} else if (IS_WINDOWS) {
		// Resolve bare names to the absolute PATH match, failing closed —
		// Windows' CreateProcess checks the child's cwd (the LLM-supplied
		// workdir) before PATH for bare names, so an unresolved name must
		// never reach spawn.
		shellBin = resolveWindowsShell(shellBin);
	}
	const shellCommand = buildShellCommand(shellBin, args.cmd);
	const effectiveCwd = args.workdir && args.workdir.length > 0 ? args.workdir : cwd;
	const yieldTimeMs = clampYield(args.yield_time_ms, DEFAULT_EXEC_YIELD_MS);
	const wantsWake = args.on_exit === "wake";

	if ([...ctx.cleanupPending].some(s => !s.hasExited)) throw new Error("Previous session cleanup is still pending; no command was started");
	ctx.store.assertCapacity();
	if (ctx.coordinator.recordCount >= MAX_SESSIONS) throw new Error("Completion backlog full; collect results or disarm pending wakes before starting another job");
	if (ctx.logBudget.remaining === 0) throw new Error("Runtime log budget exhausted; no command was started. Start a new Pi session.");
	const id = ctx.store.allocateId();
	session = ExecSession.spawn(id, {
		command: shellCommand.command,
		timeoutSeconds: timeout,
		logBudget: ctx.logBudget,
		cwd: effectiveCwd,
		env: process.env,
		tty,
		cols: args.cols !== undefined ? clamp(Math.floor(args.cols), MIN_PTY_COLS, MAX_PTY_COLS) : undefined,
		rows: args.rows !== undefined ? clamp(Math.floor(args.rows), MIN_PTY_ROWS, MAX_PTY_ROWS) : undefined,
		displayCommand: args.cmd,
		shell: shellBin,
		windowsVerbatimArguments: shellCommand.windowsVerbatimArguments,
	});

	if (session.failureMessage) {
		return finalizeResponse({
			wallTimeSec: 0,
			collected: new Uint8Array(0),
			sessionId: undefined,
			exitCode: -1,
			signal: null,
			failure: session.failureMessage,
			tty,
			logPath: undefined, // spawn failed — no log file
			cwd: effectiveCwd,
			command: args.cmd,
			yieldTimeMs,
		});
	}

	// Admission, spawn and registration are synchronous: another call cannot
	// consume this slot while the child is still in its early-exit window.
	ctx.pendingSessions.add(session);
	const { pruned, count } = ctx.store.insert(session);
	watchSessionExit(ctx, session);
	if (pruned) {
		unwatchSessionExit(ctx, pruned.id);
		ctx.coordinator.handleEviction(pruned);
	}
	if (count >= WARNING_SESSIONS) {
		ctx.ui?.notify(`shell-jobs: ${count}/${ctx.store.maxSessions} sessions open`, "warning");
	}

	try {
		// Keep a non-optional binding inside the asynchronous interaction.
		const activeSession = session;
		return await activeSession.interact(async () => {
		const session = activeSession;
		// Early-exit grace: if the process dies within 150 ms, treat it as a
		// short-lived command and remove its registration.
		const start = Date.now();
		const earlyDeadline = start + EARLY_EXIT_GRACE_PERIOD_MS;
		await Promise.race([
			new Promise<void>((resolve) => {
				if (session.hasExited) return resolve();
				session.exited.addEventListener("abort", () => resolve(), { once: true });
			}),
			sleep(EARLY_EXIT_GRACE_PERIOD_MS, signal),
		]);

		if (session.hasExited && Date.now() <= earlyDeadline + 20) {
			if (!isNestedToolCall(toolCallId)) removeSession(ctx, session.id);
			// Fully short-lived: collect everything in the buffer + any trailing
			// bytes. macOS can deliver stdout/stderr shortly after the exit event
			// for very fast commands — give the trailing drain a bounded window.
			const collected = await session.collect({ deadlineMs: Date.now() + 500, externalAbort: signal });
			const wallSec = (Date.now() - start) / 1000;
			return finalizeResponse({
				wallTimeSec: wallSec,
				collected: collected.bytes,
				omittedBytes: collected.omittedBytes,
				totalBytes: session.totalBytesSeen,
				sessionId: undefined,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: session.failureMessage,
				tty,
				logPath: session.logPath,
				supervision: session.supervision,
				cwd: effectiveCwd,
				command: args.cmd,
				yieldTimeMs,
				extra: {
					on_exit: args.on_exit,
					// Exit delivered in this very result: a requested wake is
					// satisfied directly without ever being armed.
					...(wantsWake ? { completion_delivery: "direct" as const, tool_time_utc: nowUtcIso() } : {}),
				},
			});
		}

		// Keep completed output available for write_stdin. Inventory and UI reads
		// are non-consuming; only collection, explicit stop, or capacity eviction
		// removes a stored record.

		// Wait until the yield deadline (or abort/exit). Stream updates meanwhile.
		const deadlineMs = start + yieldTimeMs;
		const pollStream = startStreaming(session, onUpdate, deadlineMs, signal);
		const collected = await session.collect({ deadlineMs, externalAbort: signal, stopSignal: steerSignal });
		pollStream.stop();

		session.touch();
		const stillAlive = !session.hasExited;
		const steered = steerSignal?.aborted === true && signal?.aborted !== true && Date.now() < deadlineMs;
		const wallSec = (Date.now() - start) / 1000;

		if (stillAlive) {
			// COMMIT POINT for on_exit: "wake" — we are now returning a background
			// session_id, so arm the wake. If the process exits a moment after this
			// check, the coordinator's exit listener (which fires even for
			// already-exited sessions) keeps the completion eligible for one submission.
			if (wantsWake) ctx.coordinator.register(session);
			return finalizeResponse({
				wallTimeSec: wallSec,
				collected: collected.bytes,
				omittedBytes: collected.omittedBytes,
				totalBytes: session.totalBytesSeen,
				sessionId: session.id,
				exitCode: undefined,
				signal: null,
				failure: null,
				tty,
				logPath: session.logPath,
				supervision: session.supervision,
				cwd: effectiveCwd,
				command: args.cmd,
				yieldTimeMs,
				extra: {
					on_exit: args.on_exit,
					...(wantsWake ? { completion_notification: "armed" as const } : {}),
					...(steered ? { wait_status: "interrupted_by_steer" as const } : {}),
					tool_time_utc: nowUtcIso(),
					note: steered ? steeredNote(session) : heldOpenNote(session),
				},
			});
		}
		// Process exited during this call. Direct callers consume the result;
		// nested callers retain it until their enclosing result is delivered.
		if (!isNestedToolCall(toolCallId)) removeSession(ctx, session.id);
		return finalizeResponse({
			wallTimeSec: wallSec,
			collected: collected.bytes,
			omittedBytes: collected.omittedBytes,
			totalBytes: session.totalBytesSeen,
			sessionId: undefined,
			exitCode: session.exitCode,
			signal: session.signal,
			failure: session.failureMessage,
			tty,
			logPath: session.logPath,
			supervision: session.supervision,
			cwd: effectiveCwd,
			command: args.cmd,
			yieldTimeMs,
			extra: {
				on_exit: args.on_exit,
				...(wantsWake ? { completion_delivery: "direct" as const, tool_time_utc: nowUtcIso() } : {}),
			},
		});
		});
	} finally {
		ctx.pendingSessions.delete(session);
	}
}

async function runWriteStdin(
	ctx: ExtensionCtx,
	args: WriteStdinArgs,
	signal: AbortSignal | undefined,
	steerSignal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	toolCallId: string,
): Promise<ResponseShape> {
	const session = ctx.store.get(args.session_id);
	if (!session) {
		throw new Error(`unknown session_id: ${args.session_id}`);
	}
	const finalizeResponse = (input: FinalizeInput): ResponseShape => {
		const shape = finalizeProcessResult({ ...input, operation: "write_stdin" });
		recordProcessResult(ctx, session, shape, toolCallId);
		return shape;
	};
	const writeBytes = resolveWriteInput(args);
	const resizing = args.cols !== undefined || args.rows !== undefined;
	if (resizing && (!session.tty || !Number.isInteger(args.cols) || !Number.isInteger(args.rows)
		|| args.cols! < MIN_PTY_COLS || args.cols! > MAX_PTY_COLS || args.rows! < MIN_PTY_ROWS || args.rows! > MAX_PTY_ROWS)) {
		throw new Error("PTY resize requires cols (20..500) and rows (5..300)");
	}
	if (args.end_stdin && session.tty) throw new Error("end_stdin only supports pipes; send the terminal EOF key for a PTY");
	const isEmptyPoll = (!writeBytes || writeBytes.length === 0) && !args.end_stdin && !resizing;
	if (!isEmptyPoll && signal?.aborted) throw new Error("Input cancelled before delivery");
	const hasYieldUntil = typeof args.yield_until === "string" && args.yield_until.length > 0;

	// Relative durations and absolute UTC deadlines are mutually exclusive.
	if (hasYieldUntil && args.yield_time_ms !== undefined) {
		throw new Error(
			`write_stdin: pass either yield_time_ms (relative wait) or ` +
				`yield_until (absolute UTC deadline), not both. tool_time_utc: ${nowUtcIso()}`,
		);
	}
	// `yield_until` is only valid for an empty poll (no input bytes).
	if (hasYieldUntil && !isEmptyPoll) {
		throw new Error(
			`write_stdin: yield_until is only valid for an empty poll (no non-empty chars or chars_b64). ` +
				`Send the input with a relative yield_time_ms first, then follow up with an empty yield_until poll. ` +
				`tool_time_utc: ${nowUtcIso()}`,
		);
	}
	if (isEmptyPoll) {
		const parsed = hasYieldUntil ? parseYieldUntil(args.yield_until!, Date.now()) : undefined;
		const wait: EmptyWait = parsed
			? { mode: "absolute", durationMs: parsed.remainingMs, yieldUntil: parsed.normalized }
			: { mode: args.yield_time_ms === 0 ? "immediate" : "relative", durationMs: resolveEmptyPollYield(args.yield_time_ms) };
		return runAttachedWait(ctx, session, wait, signal, steerSignal, onUpdate, toolCallId);
	}
	const replay = replayTerminalResult(ctx, session, toolCallId, signal);
	if (replay) return { ...replay, note: "Process already exited; no input or resize was delivered." };

	const yieldTimeMs = clampYield(args.yield_time_ms, DEFAULT_WRITE_STDIN_YIELD_MS);

	const start = Date.now();
	session.touch();

	// Observation lease: while this call may return terminal status, a
	// concurrent exit is held instead of enqueuing a wake (see completion.ts).
	ctx.coordinator.beginObservation(session.id, toolCallId);
	try {
		let writeFailure: string | null = null;
		if (resizing) session.resize(args.cols!, args.rows!);
		if (writeBytes) {
			const ok = session.write(writeBytes);
			if (!ok && !session.hasExited) {
				// Still running but stdin is gone (child closed it / EPIPE earlier).
				writeFailure = "stdin write failed: the child closed its stdin; bytes were not delivered";
			}
			if (!ok && session.hasExited) {
				// Session already exited; return its final state.
				const collected = await session.collect({ deadlineMs: Date.now() + 50, externalAbort: signal });
				const armed = ctx.coordinator.isArmed(session.id);
				if (!isNestedToolCall(toolCallId)) removeSession(ctx, session.id);
				ctx.coordinator.markPendingTerminal(session.id, toolCallId);
				const wallSec = (Date.now() - start) / 1000;
				return finalizeResponse({
					wallTimeSec: wallSec,
					collected: collected.bytes,
					omittedBytes: collected.omittedBytes,
					totalBytes: session.totalBytesSeen,
					sessionId: undefined,
					exitCode: session.exitCode,
					signal: session.signal,
					failure: session.failureMessage,
					tty: session.tty,
					logPath: session.logPath,
					supervision: session.supervision,
					cwd: session.cwd,
					command: session.displayCommand,
					yieldTimeMs,
					// This path is only reachable for input writes (never an empty
					// poll), so no wait_mode is reported — just direct delivery.
					extra: terminalWaitExtra(undefined, armed),
				});
			}
			// Give the child a small window to react before the poll.
			await sleep(100, signal);
		}

		if (args.end_stdin) session.endInput();
		const deadlineMs = start + yieldTimeMs;
		const pollStream = startStreaming(session, onUpdate, deadlineMs, signal);
		const collected = await session.collect({ deadlineMs, externalAbort: signal, stopSignal: steerSignal });
		pollStream.stop();
		const wallSec = (Date.now() - start) / 1000;
		const steered = steerSignal?.aborted === true && signal?.aborted !== true && Date.now() < deadlineMs;

		if (session.hasExited) {
			const armed = ctx.coordinator.isArmed(session.id);
			if (!isNestedToolCall(toolCallId)) removeSession(ctx, session.id);
			// Terminal result constructed: keep the lease until Pi finalizes it
			// (tool_execution_end) so an error/cancelled finalization keeps the
			// completion wake-eligible.
			ctx.coordinator.markPendingTerminal(session.id, toolCallId);
			return finalizeResponse({
				wallTimeSec: wallSec,
				collected: collected.bytes,
				omittedBytes: collected.omittedBytes,
				totalBytes: session.totalBytesSeen,
				sessionId: undefined,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: session.failureMessage ?? writeFailure,
				tty: session.tty,
				logPath: session.logPath,
				supervision: session.supervision,
				cwd: session.cwd,
				command: session.displayCommand,
				yieldTimeMs,
				extra: terminalWaitExtra(undefined, armed),
			});
		}
		// Still running: release the lease WITHOUT marking observed — the wake
		// (if armed) stays eligible.
		const armed = ctx.coordinator.isArmed(session.id);
		ctx.coordinator.releaseObservation(session.id, toolCallId);
		return finalizeResponse({
			wallTimeSec: wallSec,
			collected: collected.bytes,
			omittedBytes: collected.omittedBytes,
			totalBytes: session.totalBytesSeen,
			sessionId: session.id,
			exitCode: undefined,
			signal: null,
			failure: writeFailure,
			tty: session.tty,
			logPath: session.logPath,
			supervision: session.supervision,
			cwd: session.cwd,
			command: session.displayCommand,
			yieldTimeMs,
			extra: {
				tool_time_utc: nowUtcIso(),
				...(armed ? { on_exit: "wake" as const, completion_notification: "armed" as const } : {}),
				...(steered ? { wait_status: "interrupted_by_steer" as const } : {}),
				note: steered ? steeredNote(session) : heldOpenNote(session),
			},
		});
	} catch (err) {
		// Handler failure: release the lease so the wake stays eligible.
		ctx.coordinator.releaseObservation(session.id, toolCallId);
		throw err;
	}
}

/** Shared "exited" extra fields for direct terminal delivery. */
function terminalWaitExtra(
	waitMode: "immediate" | "relative" | "absolute" | undefined,
	wakeWasArmed: boolean,
): Partial<ResponseShape> {
	return {
		wait_mode: waitMode,
		wait_status: waitMode ? ("completed" as const) : undefined,
		completion_delivery: "direct",
		tool_time_utc: nowUtcIso(),
		...(wakeWasArmed ? { on_exit: "wake" as const, on_exit_wake: "consumed" as const } : {}),
	};
}

type EmptyWait =
	| { mode: "immediate" | "relative"; durationMs: number }
	| { mode: "absolute"; durationMs: number; yieldUntil: string };

/** All empty reads retain bounded output in the session, not in the wait. */
async function runAttachedWait(
	ctx: ExtensionCtx,
	session: ExecSession,
	wait: EmptyWait,
	signal: AbortSignal | undefined,
	steerSignal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	toolCallId: string,
): Promise<ResponseShape> {
	const startedAt = performance.now();
	const waitFields: Partial<ResponseShape> =
		wait.mode === "absolute"
			? { wait_mode: wait.mode, yield_until: wait.yieldUntil }
			: { wait_mode: wait.mode, yield_time_ms: wait.durationMs };
	// Reject before observation or collection, including an already-exited job.
	if (wait.mode === "immediate" && signal?.aborted) throw new Error("Output read cancelled before collection");
	const replay = replayTerminalResult(ctx, session, toolCallId, signal);
	if (replay) return { ...replay, ...waitFields, wait_status: "completed" };
	session.touch();
	ctx.coordinator.beginObservation(session.id, toolCallId);
	let pendingTerminal = false;
	let streamer: { stop: () => void } | undefined;
	try {
		if (onUpdate && wait.mode !== "immediate") {
			streamer = startRateLimitedStream({
				outputNotify: session.outputNotify,
				minIntervalMs: wait.mode === "relative" && wait.durationMs <= MAX_YIELD_TIME_MS
					? OUTPUT_POLL_INTERVAL_MS : LONG_WAIT_UPDATE_INTERVAL_MS,
				emit: () => onUpdate(buildStreamUpdate(session, waitFields)),
			});
		}
		let outcome: LongWaitOutcome = wait.mode === "immediate"
			? (session.hasExited ? "exit" : "deadline")
			: await waitForExitOrDeadline({
				exited: session.exited,
				externalAbort: signal,
				steerAbort: steerSignal,
				durationMs: wait.durationMs,
			});
		// Exit wins close races. A cancelled live wait never drains output; a
		// steered one drains like a reached deadline (the session stays live).
		if (session.hasExited) outcome = "exit";
		const collected = outcome === "cancelled"
			? { bytes: new Uint8Array(0), omittedBytes: 0 }
			: await session.collect({
				deadlineMs: Date.now() + (outcome === "exit" && wait.mode !== "immediate" ? 1000 : 0),
				externalAbort: outcome === "exit" ? undefined : signal,
			});
		const armed = ctx.coordinator.isArmed(session.id);
		const elapsedMs = performance.now() - startedAt;
		const extra: Partial<ResponseShape> = { ...waitFields };
		if (outcome === "exit") {
			Object.assign(extra, terminalWaitExtra(wait.mode, armed));
		} else {
			extra.wait_status = outcome === "cancelled" ? "cancelled"
				: outcome === "steered" ? "interrupted_by_steer"
				: wait.mode === "immediate" ? "snapshot"
				: wait.mode === "relative" ? "relative_deadline_reached" : "absolute_deadline_reached";
			extra.effective_wait_ms = elapsedMs;
			extra.tool_time_utc = nowUtcIso();
			extra.note = outcome === "steered" ? steeredNote(session) : heldOpenNote(session);
			if (armed) {
				extra.on_exit = "wake";
				extra.completion_notification = "armed";
			}
		}
		const shape = finalizeProcessResult({
			operation: "write_stdin",
			wallTimeSec: elapsedMs / 1000,
			collected: collected.bytes,
			omittedBytes: collected.omittedBytes,
			totalBytes: session.totalBytesSeen,
			sessionId: outcome === "exit" ? undefined : session.id,
			exitCode: outcome === "exit" ? session.exitCode : undefined,
			signal: outcome === "exit" ? session.signal : null,
			failure: outcome === "exit" ? session.failureMessage : null,
			tty: session.tty,
			logPath: session.logPath,
			supervision: session.supervision,
			cwd: session.cwd,
			command: session.displayCommand,
			extra,
		});
		if (outcome === "exit") {
			if (!isNestedToolCall(toolCallId)) removeSession(ctx, session.id);
			ctx.coordinator.markPendingTerminal(session.id, toolCallId);
			pendingTerminal = true;
		} else {
			session.touch();
		}
		recordProcessResult(ctx, session, shape, toolCallId);
		return shape;
	} finally {
		streamer?.stop();
		// Successful terminal delivery is committed by tool_execution_end.
		if (!pendingTerminal) ctx.coordinator.releaseObservation(session.id, toolCallId);
	}
}

/** Nested callers retain final output: their scripts may fail or omit text(). */
function recordProcessResult(ctx: ExtensionCtx, session: ExecSession, shape: ResponseShape, toolCallId: string): void {
	if (!isNestedToolCall(toolCallId)) return;
	if (!shape.running && ctx.store.get(session.id) === session) {
		ctx.terminalResults.set(session, { ...shape });
		if (shape.operation === "exec_command" && shape.on_exit === "wake") ctx.coordinator.register(session);
		ctx.coordinator.markPendingTerminal(session.id, toolCallId);
		shape.completion_delivery = "enclosing_tool";
		if (shape.on_exit_wake) shape.on_exit_wake = "pending";
	}
	ctx.nestedResults.record(toolCallId, session.id, shape);
}

function replayTerminalResult(ctx: ExtensionCtx, session: ExecSession, toolCallId: string, signal?: AbortSignal): ResponseShape | undefined {
	const saved = ctx.terminalResults.get(session);
	if (!saved) return;
	if (signal?.aborted) throw new Error("Output read cancelled before collection");
	session.touch();
	const shape: ResponseShape = {
		...saved, operation: "write_stdin", wall_time_seconds: 0, tool_time_utc: nowUtcIso(), output_replayed: true,
		...terminalWaitExtra(undefined, ctx.coordinator.isArmed(session.id)),
	};
	// The saved payload belongs to an earlier call; its wait deadline does not.
	for (const field of ["yield_time_ms", "yield_until", "effective_wait_ms", "wait_mode", "wait_status"] as const) delete shape[field];
	if (!ctx.coordinator.isArmed(session.id)) { delete shape.on_exit_wake; delete shape.on_exit; }
	ctx.coordinator.markPendingTerminal(session.id, toolCallId);
	if (!isNestedToolCall(toolCallId)) removeSession(ctx, session.id);
	recordProcessResult(ctx, session, shape, toolCallId);
	return shape;
}

/** Result of terminating a session via kill_session or the sessions command. */
interface TerminateOutcome {
	session: ExecSession;
	escalated: boolean;
	collected: CollectResult;
	/** true when the process is confirmed dead; false = kill did NOT land. */
	killed: boolean;
}

/**
 * Kill a session (initial signal → 2s grace → SIGKILL escalation), drain its
 * trailing output, and remove it from the store — but ONLY on confirmed
 * exit. A kill that doesn't land (taskkill failure, access denied,
 * unkillable state) keeps the session in the store and returns
 * killed: false, so ownership of a live process is never silently dropped.
 * Shared by the kill_session tool and the /shell-jobs-sessions command.
 */
async function terminateSessionById(
	ctx: ExtensionCtx,
	sid: number,
	initial: NodeJS.Signals,
): Promise<TerminateOutcome | undefined> {
	const session = ctx.store.get(sid);
	if (!session) return undefined;
	// Explicit kill (model tool or human slash command): suppress the wake
	// BEFORE signaling so the induced exit can never race a wake enqueue.
	ctx.coordinator.suppress(sid);
	session.kill(initial);
	// ExecSession owns the 2s escalation timer, including unattended stops.
	// Allow another 500ms for SIGKILL to land; do not race a second timer.
	await waitForExitOrDeadline({ exited: session.exited, durationMs: IS_WINDOWS ? 2000 : 2500 });
	// Final drain.
	const collected = await session.collect({ deadlineMs: Date.now() + 100 });
	const killed = session.hasExited;
	if (killed) {
		ctx.coordinator.confirmKill(sid);
		removeSession(ctx, sid);
	} else {
		// The kill did NOT land — the process is still alive and still owned.
		// Restore its prior wake eligibility.
		ctx.coordinator.restoreAfterFailedKill(sid);
	}
	return { session, escalated: session.escalated, collected, killed };
}

function runningSessions(ctx: ExtensionCtx): ExecSession[] {
	return ctx.store
		.values()
		.filter((s) => !s.hasExited)
		.sort((a, b) => a.id - b.id);
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
	return n === 1 ? singular : pluralForm;
}

function oneLineCommand(command: string, max = 120): string {
	// sanitizeMeta strips control chars (ESC included) — \s+ alone would let
	// terminal escape sequences through to widgets and pickers.
	const oneLine = sanitizeMeta(command).replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function formatRunningSessionsWidget(ctx: ExtensionCtx, sessions: ExecSession[]): string[] {
	const now = Date.now();
	const shown = sessions.slice(0, 5);
	const lines = [
		`⚠ shell-jobs: ${sessions.length} ${plural(sessions.length, "session")} still running`,
		...shown.map((s) => {
			const wake = ctx.coordinator.isArmed(s.id) ? " [wake]" : "";
			const held = s.shellExited ? " (shell exited, pipe held)" : "";
			return `  #${s.id} ${formatElapsed(now - s.startedAt)}${wake}${held} ${oneLineCommand(s.displayCommand, 72)} (${s.cwd})`;
		}),
	];
	if (sessions.length > shown.length) lines.push(`  … ${sessions.length - shown.length} more; use list_sessions`);
	lines.push("  Use list_sessions, write_stdin, set_on_exit (disarm wake), or kill_session.");
	return lines;
}

function updateRunningSessionsUi(ctx: ExtensionCtx, opts: { showWidget?: boolean; notifyTree?: boolean } = {}): void {
	const ui = ctx.ui;
	if (!ui) return;
	const sessions = runningSessions(ctx);
	const status = sessions.length ? `shell-jobs: ${sessions.length} ${plural(sessions.length, "session")} running` : undefined;
	ui.setStatus(SESSION_UI_KEY, status);

	if (opts.notifyTree && sessions.length > 0) {
		ui.notify(
			`shell-jobs: ${sessions.length} ${plural(sessions.length, "session")} still running after /tree.`,
			"warning",
		);
	}

	if (sessions.length === 0) {
		if (ctx.widgetVisible) {
			ui.setWidget(SESSION_UI_KEY, undefined);
			ctx.widgetVisible = false;
		}
		return;
	}

	if (opts.showWidget || ctx.widgetVisible) {
		ui.setWidget(SESSION_UI_KEY, formatRunningSessionsWidget(ctx, sessions), { placement: "aboveEditor" });
		ctx.widgetVisible = true;
	}
}

function watchSessionExit(ctx: ExtensionCtx, session: ExecSession): void {
	ctx.exitUnsubscribers.get(session.id)?.();
	const unsubscribe = session.onExit(() => {
		// Preserve lazy-drain semantics: an exited session stays in the store until
		// write_stdin/kill_session collects it (or capacity reclamation evicts it). The UI only reflects
		// currently running processes.
		updateRunningSessionsUi(ctx);
	});
	ctx.exitUnsubscribers.set(session.id, unsubscribe);
}

function unwatchSessionExit(ctx: ExtensionCtx, id: number): void {
	ctx.exitUnsubscribers.get(id)?.();
	ctx.exitUnsubscribers.delete(id);
}

function removeSession(ctx: ExtensionCtx, id: number): ExecSession | undefined {
	unwatchSessionExit(ctx, id);
	return ctx.store.remove(id);
}

function clearSessionExitWatchers(ctx: ExtensionCtx): void {
	for (const unsubscribe of ctx.exitUnsubscribers.values()) {
		unsubscribe();
	}
	ctx.exitUnsubscribers.clear();
}

/** Shared streaming-update payload (relative polls and absolute waits). */
function buildStreamUpdate(
	session: ExecSession,
	extra?: Partial<ProcessResultDetails>,
): AgentToolResult<ProcessUpdateDetails> {
	const tailText = sanitizeOutputText(decode(session.snapshotStreamTail()));
	return {
		content: [{ type: "text", text: tailText }],
		details: {
			session_id: session.id,
			pid: session.pid,
			running: !session.hasExited,
			total_bytes: session.totalBytesSeen,
			tty: session.tty,
			command: session.displayCommand,
			cwd: session.cwd,
			log_path: session.logPath,
			supervision: session.supervision,
			// Populate `output` so renderResult has a single source regardless
			// of streaming vs final state.
			output: tailText,
			...extra,
		},
	};
}

/**
 * The steer signal for one exec_command/write_stdin call. A top-level call
 * made while a steer is already queued returns promptly (its wait sees an
 * aborted signal). A nested codemode call throws instead: otherwise a script
 * polling in a loop would spin on instant returns and still hold the steer.
 */
function steerSignalFor(ctx: ExtensionCtx, toolCallId: string, probe: PendingProbe): AbortSignal | undefined {
	if (!ctx.steer.enabled) return undefined;
	if (ctx.steer.isPending(probe) && isNestedToolCall(toolCallId)) throw new Error(STEER_NESTED_ERROR);
	return ctx.steer.signal;
}

function startStreaming(
	session: ExecSession,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	deadlineMs: number,
	externalAbort: AbortSignal | undefined,
): { stop: () => void } {
	if (!onUpdate) return { stop: () => {} };
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;
	const tick = () => {
		if (stopped) return;
		try {
			onUpdate(buildStreamUpdate(session));
		} catch {
			// ignore transient errors
		}
		if (stopped) return;
		if (Date.now() >= deadlineMs) return;
		if (externalAbort?.aborted) return;
		timer = setTimeout(tick, OUTPUT_POLL_INTERVAL_MS);
	};
	timer = setTimeout(tick, OUTPUT_POLL_INTERVAL_MS);
	return {
		stop: () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		},
	};
}

export default function (pi: ExtensionAPI) {
	const delivery = {
		send: (message: import("./completion.ts").WakeMessage) => {
			// If pi is idle this starts a model turn; if a run is active it is
			// queued as a follow-up — never steering/interrupting the current turn.
			// This API returns void: async host errors are not delivery receipts.
			pi.sendMessage(
				{
					customType: "shell-jobs-completed",
					content: message.content,
					display: true,
					details: message.details,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
		onSendError: (err: unknown) => {
			ctx.ui?.notify(
				`shell-jobs: failed to deliver completion notification: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		},
	};
	const coordinator = new CompletionCoordinator(delivery);
	let ctx: ExtensionCtx = {
		logBudget: new LogBudget(),
		coordinator,
		terminalResults: new WeakMap(),
		nestedResults: new NestedResults(),
		// Eviction UI (status clear + warning) is handled at the insert site;
		// no onEvict callback needed.
		store: new SessionStore({ maxSessions: MAX_SESSIONS, lruProtectedCount: LRU_PROTECTED_COUNT }),
		ui: undefined,
		widgetVisible: false,
		exitUnsubscribers: new Map(),
		warnedShellFallback: false,
		notifiedBashSource: false,
		pendingSessions: new Set(),
		cleanupPending: new Set(),
		shuttingDown: false,
		steer: new SteerGate({ enabled: steerInterruptEnabled() }),
	};

	// By default, shell-jobs removes pi's built-in `bash` tool so the LLM
	// is steered toward exec_command/write_stdin. Pass --keep-builtin-bash to
	// preserve the built-in alongside the shell-jobs tools.
	pi.registerFlag("keep-builtin-bash", {
		description: "Keep pi's built-in shell tools alongside exec_command/write_stdin. By default it is removed.",
		type: "boolean",
		default: false,
	});

	// Observation finalization: "observed" is committed at pi's finalized
	// tool-result event, not merely when the handler returns — see completion.ts.
	pi.on("tool_result", async (event) => {
		if (event.parentToolCallId) return;
		const receipt = ctx.nestedResults.attach(event.toolCallId, id => !!ctx.store.get(id));
		if (receipt) return {
			content: [...event.content, { type: "text" as const, text: receipt }],
			...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
		};
	});
	pi.on("tool_execution_end", async (event) => {
		const hadNestedResults = ctx.nestedResults.finish(event.toolCallId, event.parentToolCallId);
		// A successful nested call is not a model-visible delivery. The outer
		// tool's receipt and successful finalization commit it; failure keeps wake.
		ctx.coordinator.handleToolExecutionEnd(event.toolCallId, event.isError === true ||
			(!event.parentToolCallId && hadNestedResults === false), event.parentToolCallId);
	});
	pi.on("before_agent_start", async event => {
		if (!event.systemPrompt.includes(SHELL_JOBS_GUIDANCE)) return { systemPrompt: `${event.systemPrompt}\n\n${SHELL_JOBS_GUIDANCE}` };
	});
	pi.on("agent_settled", async () => {
		ctx.steer.reset();
		ctx.nestedResults.clear();
		ctx.coordinator.flushPending();
	});

	// Steer interrupt: a human steer queued during a long wait ends the wait
	// early so Pi can deliver it after this tool batch (see steer-gate.ts).
	pi.on("input", async (event, eventCtx) => {
		if (event.streamingBehavior === "steer") ctx.steer.onSteerInput(eventCtx);
	});
	pi.on("message_start", async (event) => {
		if (event.message.role === "user") ctx.steer.onUserMessageDelivered();
	});

	pi.on("session_start", async (event, eventCtx) => {
		const owner = eventCtx.sessionManager;
		const retained = event.reason === "reload" && owner ? reloads.get(owner) : undefined;
		if (retained) {
			if (ctx !== retained) ctx.coordinator.shutdown();
			ctx = retained;
			// v1 handoffs from an older extension lack the additive recovery fields.
			// Coordinator instance fields remain compatible; use the newly loaded
			// methods so old jobs also get the enclosing-tool observation fix.
			ctx.terminalResults ??= new WeakMap();
			ctx.nestedResults = new NestedResults();
			Object.setPrototypeOf(ctx.coordinator, CompletionCoordinator.prototype);
			clearTimeout(ctx.reloadTimer);
			ctx.reloadTimer = undefined;
			reloads.delete(owner);
		}
		ctx.ui = eventCtx.ui;
		ctx.shuttingDown = false; // reload/new/resume re-arms the extension
		ctx.steer.reset();
		if (!retained) {
			ctx.coordinator.reset();
			ctx.logBudget = new LogBudget();
		}
		ctx.coordinator.bindDelivery(delivery.send, delivery.onSendError);
		updateRunningSessionsUi(ctx);
		// Default behavior is to remove the built-in `bash` tool. Only keep it
		// if --keep-builtin-bash was passed. Flag lookup uses the registered
		// name without leading dashes.
		const keep = pi.getFlag("keep-builtin-bash");
		if (keep !== true) {
			const active = pi.getActiveTools();
			const filtered = active.filter((name) => name !== "bash" && name !== "powershell");
			if (filtered.length !== active.length) {
				pi.setActiveTools(filtered);
			}
		}
		if (!isPtyAvailable() && eventCtx.hasUI) {
			// Non-fatal: pipes mode still works.
			eventCtx.ui.notify(
				"shell-jobs: node-pty not available; tty: true will fail. Pipes (tty: false) still work.",
				"info",
			);
		}
	});

	pi.on("session_tree", async (_event, eventCtx) => {
		ctx.ui = eventCtx.ui;
		updateRunningSessionsUi(ctx, { showWidget: true, notifyTree: runningSessions(ctx).length > 0 });
	});

	pi.on("session_shutdown", async (event, eventCtx) => {
		ctx.nestedResults.clear();
		if (event.reason === "reload" && eventCtx.sessionManager) {
			ctx.shuttingDown = true;
			ctx.coordinator.pauseDelivery();
			ctx.steer.reset();
			ctx.ui = undefined;
			reloads.set(eventCtx.sessionManager, ctx);
			const owner = eventCtx.sessionManager;
			const retained = ctx;
			// If the extension is removed or fails to reload, do not orphan its jobs.
			retained.reloadTimer = setTimeout(() => {
				if (reloads.get(owner) !== retained) return;
				reloads.delete(owner);
				retained.coordinator.shutdown();
				clearSessionExitWatchers(retained);
				for (const s of new Set([...retained.store.values(), ...retained.pendingSessions])) s.terminate();
			}, 10_000);
			retained.reloadTimer.unref();
			return;
		}
		// Reject new sessions from here on and terminate everything we own —
		// including sessions still inside exec_command's early-exit grace
		// window (spawned but not yet inserted into the store).
		ctx.shuttingDown = true;
		ctx.steer.reset();
		// Cancel wake timers/listeners first: no stale prompt may ever be
		// injected into a new or closed session.
		ctx.coordinator.shutdown();
		const drained = ctx.store.terminateAll();
		for (const s of ctx.cleanupPending) { s.terminate(); drained.push(s); }
		for (const s of ctx.pendingSessions) {
			if (!s.hasExited) {
				s.terminate();
				drained.push(s);
			}
		}
		clearSessionExitWatchers(ctx);
		updateRunningSessionsUi(ctx);
		// Children run detached (own process groups), so anything that ignores
		// SIGTERM would outlive pi as an orphan. Give them a short grace, then
		// SIGKILL survivors and wait briefly for confirmation. On Windows the
		// initial kill is already a force tree-kill and a second taskkill is
		// byte-identical, so skip the escalation there (the grace wait above
		// still confirms exits). Event-driven per session: each wait resolves
		// the instant that session's exit fires.
		await Promise.all(drained.map((s) => waitForExitOrDeadline({ exited: s.exited, durationMs: 1000 })));
		if (!IS_WINDOWS) {
			const survivors = drained.filter((s) => !s.hasExited);
			for (const s of survivors) s.kill("SIGKILL");
			await Promise.all(survivors.map((s) => waitForExitOrDeadline({ exited: s.exited, durationMs: 500 })));
		}
		for (const s of drained.filter(s => !s.hasExited)) {
			ctx.cleanupPending.add(s);
			s.onExit(() => ctx.cleanupPending.delete(s));
		}
		if (drained.length && ctx.ui) {
			const leftover = drained.filter((s) => !s.hasExited).length;
			ctx.ui.notify(
				`shell-jobs: terminated ${drained.length - leftover} live session(s) on shutdown` +
					(leftover ? `; ${leftover} did not confirm exit` : ""),
				 leftover ? "warning" : "info",
			);
		}
	});

	// Human-facing escape hatch: inspect and kill live sessions without going
	// through the model.
	pi.registerCommand("shell-jobs-sessions", {
		description: "List live shell-jobs sessions and optionally kill one (or all)",
		handler: async (_args, cmdCtx) => {
			ctx.ui = cmdCtx.ui;
			// The picker filters live sessions without consuming completed results.
			updateRunningSessionsUi(ctx);
			const sessions = runningSessions(ctx);
			if (sessions.length === 0) {
				cmdCtx.ui.notify("shell-jobs: no live sessions", "info");
				return;
			}
			const now = Date.now();
			const labels = sessions.map((s) => {
				const wake = ctx.coordinator.isArmed(s.id) ? " [wake]" : "";
				const held = s.shellExited ? " (shell exited, pipe held)" : "";
				return `#${s.id} ${formatElapsed(now - s.startedAt)}${wake}${held} ${oneLineCommand(s.displayCommand, 60)}`;
			});
			const KILL_ALL = `Kill all ${sessions.length} ${plural(sessions.length, "session")}`;
			const choice = await cmdCtx.ui.select(
				`shell-jobs: ${sessions.length} live ${plural(sessions.length, "session")} — select to kill (Esc to cancel)`,
				[...labels, KILL_ALL],
			);
			if (!choice) return;
			const targets = choice === KILL_ALL ? sessions : sessions.filter((s) => choice.startsWith(`#${s.id} `));
			let killed = 0;
			let failed = 0;
			for (const s of targets) {
				const outcome = await terminateSessionById(ctx, s.id, "SIGTERM");
				if (outcome?.killed) killed++;
				else if (outcome) failed++;
			}
			updateRunningSessionsUi(ctx);
			cmdCtx.ui.notify(
				`shell-jobs: killed ${killed} ${plural(killed, "session")}` +
					(failed ? `; ${failed} did not confirm exit (still listed)` : ""),
				failed ? "warning" : "info",
			);
		},
	});

	// ---------------- Tools ----------------

	pi.registerTool({
		name: "exec_command",
		label: "exec_command",
		description:
			'Run a command in a persistent session. Returns `session_id` if still running (drive with write_stdin) or `exit_code` if it finished within yield_time_ms. on_exit defaults to "none". Use on_exit: "wake" for finite background work whose result is needed to complete the user request. Use set_on_exit to disarm or re-arm a running session.',
		promptSnippet: "Run a shell command; long-running ones yield a session_id",
		promptGuidelines: [
			"Prefer dedicated file tools when available (read/grep/find/ls). Otherwise use exec_command with rg for content search, fd or find for file names, and ls for directories.",
			"Every command has a hard timeout_seconds (default 1800, maximum 86400); choose a finite lifetime even for servers. The yield window does not change that deadline.",
			"Use a small yield_time_ms (~500ms) for quick one-shots and background work, or the 10s default for ordinary commands. Drive returned session_ids with write_stdin.",
			"Empty write_stdin waits have no built-in maximum; respect any operator limit. Pi manages cache warming independently.",
		],
		outputSchema: processScriptResultSchema,
		parameters: Type.Object({
			cmd: Type.String({ description: "Shell command to execute." }),
			timeout_seconds: Type.Optional(Type.Number({ minimum: 0.001, maximum: 86400, description: "Hard runtime deadline in seconds, independent of yield_time_ms. Default 1800; maximum 86400. Applies even after returning control or reloading." })),
			workdir: Type.Optional(Type.String({ description: "Working directory. Defaults to the session cwd." })),
			shell: Type.Optional(
				Type.String({
					description:
						"Shell binary. Defaults to bash (on Windows: bash if on PATH, else powershell). cmd and powershell/pwsh get shell-appropriate flags.",
				}),
			),
			tty: Type.Optional(Type.Boolean({ description: "Allocate a PTY. Default false (plain pipes)." })),
			cols: Type.Optional(
				Type.Number({
					description: `PTY width in columns (tty: true only; ignored for pipes). Default 120, clamped to [${MIN_PTY_COLS}, ${MAX_PTY_COLS}].`,
				}),
			),
			rows: Type.Optional(
				Type.Number({
					description: `PTY height in rows (tty: true only; ignored for pipes). Default 30, clamped to [${MIN_PTY_ROWS}, ${MAX_PTY_ROWS}].`,
				}),
			),
			yield_time_ms: Type.Optional(
				Type.Number({
					description: `How long (ms) this call stays attached waiting for output before yielding — an attachment window, not the command's lifetime or completion timeout. Default ${DEFAULT_EXEC_YIELD_MS}, clamped to [${MIN_YIELD_TIME_MS}, ${MAX_YIELD_TIME_MS}].`,
				}),
			),
			on_exit: Type.Optional(
				StringEnum(
					["none", "wake"] as const,
					'"none" (default): no auto-resume; poll with write_stdin. "wake": ONE follow-up notification on unobserved exit that resumes the agent — for finite background work whose result is needed for the request. Change later via set_on_exit. A completion observed directly by a tool result consumes the wake.',
				),
			),
		}, { additionalProperties: false }),
		async execute(toolCallId, params, signal, onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const steerSignal = steerSignalFor(ctx, toolCallId, eventCtx);
			const shape = await runExecCommand(ctx, params, signal, steerSignal, onUpdate, eventCtx.cwd, toolCallId);
			updateRunningSessionsUi(ctx);
			return {
				content: [{ type: "text", text: renderProcessResultText(shape) }],
				details: shape,
				structuredContent: processScriptResult(shape),
			};
		},
		renderCall: renderExecCommandCall,
		renderResult: renderProcessResult,
	});

	pi.registerTool({
		name: "write_stdin",
		label: "write_stdin",
		description:
			"Read output from a running or retained completed session, or send input to a running process. Omit both chars and chars_b64 to read without writing. Use `chars` for text with C-style escapes (e.g. \\x03 Ctrl-C, \\x1b ESC, \\n newline); use `chars_b64` for raw binary. For empty reads, yield_time_ms: 0 reads current output immediately; otherwise wait with a finite yield_time_ms (relative, no built-in maximum) or yield_until (absolute UTC deadline, only when the human explicitly asks). Completed output read inside a script is retained for recovery; repeat reads set output_replayed: true.",
		promptSnippet: "Read running/completed job output or send input to a running job",
		promptGuidelines: [
			"To inspect current progress, use an empty write_stdin with yield_time_ms: 0. It returns unread output immediately; do not loop on empty snapshots. Omitted durations default to 5 seconds; positive durations have a 5-second minimum and no built-in maximum. Choose a wait based on expected job duration and needed responsiveness, not cache lifetime. Exit or cancellation returns early; cancellation leaves the process alive. Respect any configured operator limit.",
			'Use yield_until ONLY when the human explicitly asks for a long attached wait or an explicit UTC deadline. Omit yield_time_ms and pass a future UTC timestamp ending in "Z" (compute it from tool_time_utc in tool results). Finite non-interactive sessions only. The call returns immediately when the process exits.',
			"NEVER use yield_until for REPLs, sudo, ssh, password prompts, dev servers, file watchers, debuggers, or any indefinite/interactive session — it is only for finite commands that will exit on their own.",
			'on_exit wake is set via exec_command or set_on_exit, not write_stdin. A successful direct result consumes an armed wake. Inside codemode, the enclosing tool must finalize successfully with a shell-jobs receipt; failure keeps wake eligible. To disarm wake without killing, call set_on_exit(session_id, on_exit: "none").',
			"In tty sessions, submit lines with \\r (the Enter key) rather than \\n: POSIX terminals accept both, but Windows console programs only execute input on \\r.",
			"For very noisy jobs, rely on the log_path and final/truncated output instead of repeatedly polling.",
		],
		outputSchema: processScriptResultSchema,
		parameters: Type.Object({
			session_id: Type.Number({ description: "Session id from exec_command." }),
			end_stdin: Type.Optional(Type.Boolean({ description: "Close pipe stdin after sending input, allowing programs waiting for EOF to exit. Pipes only." })),
			cols: Type.Optional(Type.Integer({ minimum: 20, maximum: 500, description: "Resize a PTY; supply rows too." })),
			rows: Type.Optional(Type.Integer({ minimum: 5, maximum: 300, description: "Resize a PTY; supply cols too." })),
			chars: Type.Optional(
				Type.String({
					description:
						"Text with C-style escapes: \\xHH, \\uHHHH, \\u{H\u2026}, \\n \\r \\t \\0 \\a \\e \\b \\f \\v \\\\ \\\". Unknown \\X preserved literally. Mutually exclusive with chars_b64.",
				}),
			),
			chars_b64: Type.Optional(
				Type.String({
					description: "Raw bytes (base64) to write. Mutually exclusive with chars.",
				}),
			),
			yield_time_ms: Type.Optional(
				Type.Number({
					description: `Attachment window in ms, not a process timeout. With input: default ${DEFAULT_WRITE_STDIN_YIELD_MS}, clamped to [${MIN_YIELD_TIME_MS}, ${MAX_YIELD_TIME_MS}]. Empty polls: explicit 0 reads immediately; default and positive minimum ${MIN_EMPTY_YIELD_TIME_MS}, no built-in maximum; an optional PI_SHELL_JOBS_MAX_EMPTY_POLL_MS limit rejects larger values. Use a non-negative finite number no greater than Number.MAX_SAFE_INTEGER; fractional ms are rounded down. Mutually exclusive with yield_until.`,
				}),
			),
			yield_until: Type.Optional(
				Type.String({
					description:
						'Absolute UTC deadline to stay attached to an EMPTY poll, as strict RFC 3339 UTC ("2026-07-21T18:30:00Z" or with .mmm; uppercase Z, full date+time with seconds; no offsets). Only when the human explicitly asks for a long attached wait. Returns immediately when the process exits. No default max horizon. Mutually exclusive with yield_time_ms and with input bytes.',
				}),
			),
		}, { additionalProperties: false }),
		async execute(toolCallId, params, signal, onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const steerSignal = steerSignalFor(ctx, toolCallId, eventCtx);
			const session = ctx.store.get(params.session_id);
			if (!session) throw new Error(`unknown session_id: ${params.session_id}`);
			const shape = await session.interact(() => runWriteStdin(ctx, params, signal, steerSignal, onUpdate, toolCallId));
			updateRunningSessionsUi(ctx);
			return {
				content: [{ type: "text", text: renderProcessResultText(shape) }],
				details: shape,
				structuredContent: processScriptResult(shape),
			};
		},
		renderCall: renderWriteStdinCall,
		renderResult: renderProcessResult,
	});

	pi.registerTool({
		name: "set_on_exit",
		label: "set_on_exit",
		description:
			'Change on_exit policy for a session without killing it. on_exit: "none" disarms a pending wake (including coordinator tombstones after eviction). on_exit: "wake" arms auto-resume if the process is still running. Cannot recall a follow-up already queued to the agent. kill_session both kills and suppresses.',
		promptSnippet: "Disarm or re-arm on_exit wake for a session",
		promptGuidelines: [
			'Default on_exit is "none". If you set "wake" and no longer need auto-resume (wrong command, user moved on, abandoned approach), call set_on_exit with "none" promptly — do not leave stale wakes armed.',
			"This does not stop the process. Use kill_session to terminate.",
			"Arm wake for finite background work whose result is still needed to complete the user request; keep start-only and indefinite work quiet.",
			"Disarm cannot recall a completion follow-up that was already delivered to pi.",
		],
		outputSchema: setOnExitScriptResultSchema,
		parameters: Type.Object({
			session_id: Type.Number({ description: "Session id from exec_command." }),
			on_exit: StringEnum(
				["none", "wake"] as const,
				'"none": disarm wake (process keeps running). "wake": arm auto-resume if still running.',
			),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const { session_id: sid, on_exit: policy } = params as { session_id: number; on_exit: OnExitPolicy };
			const session = ctx.store.get(sid);
			if (policy === "wake" && !session) {
				return {
					content: [{ type: "text", text: `No such session: ${sid}` }],
					details: { session_id: sid, found: false },
					structuredContent: setOnExitScriptResult({ session_id: sid, found: false }),
				};
			}
			const status = ctx.coordinator.setOnExit(sid, policy, session);
			// unknown id: no store session and nothing to disarm
			if (!session && status === "already_none") {
				return {
					content: [{ type: "text", text: `No such session: ${sid}` }],
					details: { session_id: sid, found: false },
					structuredContent: setOnExitScriptResult({ session_id: sid, found: false }),
				};
			}
			const running = session ? !session.hasExited : false;
			const armed = ctx.coordinator.isArmed(sid);
			const text =
				`set_on_exit session_id=${sid} on_exit=${policy} → ${status}` +
				(session ? (running ? " (process still running)" : " (process already exited)") : " (no store session; coordinator only)") +
				(armed ? "; wake armed" : "; wake not armed");
			return {
				content: [{ type: "text", text }],
				structuredContent: setOnExitScriptResult({
					session_id: sid,
					found: true,
					on_exit: policy,
					status,
					running,
					wake_armed: armed,
				}),
				details: {
					session_id: sid,
					found: true,
					on_exit: policy,
					status,
					running,
					wake_armed: armed,
					command: session?.displayCommand,
					log_path: session?.logPath,
					tool_time_utc: nowUtcIso(),
				},
			};
		},
		renderCall: renderSetOnExitCall,
		renderResult: renderSetOnExitResult,
	});

	pi.registerTool({
		name: "kill_session",
		label: "kill_session",
		description:
			"Terminate a session (SIGTERM, escalates to SIGKILL after 2s; on Windows any signal force-kills the process tree). Use when the process won't exit via Ctrl-C. Check killed: true before treating the session_id as invalid; kill_failed retains the session for inspection or retry. Successful termination suppresses any armed on_exit wake.",
		promptSnippet: "Terminate a session",
		outputSchema: killScriptResultSchema,
		parameters: Type.Object({
			session_id: Type.Number({ description: "Session to terminate." }),
			signal: Type.Optional(
				Type.String({ description: 'Initial signal (default "SIGTERM"). Examples: SIGINT, SIGHUP, SIGKILL.' }),
			),
		}, { additionalProperties: false }),
		async execute(toolCallId, params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const sid = (params as { session_id: number; signal?: string }).session_id;
			const initial = normalizeSignal((params as { signal?: string }).signal);
			const startedAt = Date.now();
			const outcome = await terminateSessionById(ctx, sid, initial);
			if (!outcome) {
				return {
					content: [{ type: "text", text: `No such session: ${sid}` }],
					details: {
						operation: "kill_session",
						status: "kill_failed",
						running: false,
						session_id: sid,
						found: false,
					} as const,
					structuredContent: killNotFoundScriptResult(sid),
				};
			}
			const { session, escalated, collected, killed } = outcome;
			updateRunningSessionsUi(ctx);
			const killFailure = killed
				? session.failureMessage
				: [
						`process still running after ${initial}${escalated ? " and SIGKILL escalation" : ""}; ` +
							"the session remains registered — retry kill_session or check permissions",
						session.failureMessage,
					]
					.filter((value): value is string => Boolean(value))
					.join("; ");
			const details = finalizeKillResult({
				wallTimeSec: (Date.now() - startedAt) / 1000,
				collected: collected.bytes,
				omittedBytes: collected.omittedBytes,
				totalBytes: session.totalBytesSeen,
				sessionId: sid,
				pid: session.pid,
				requestedSignal: initial,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: killFailure || null,
				tty: session.tty,
				logPath: session.logPath,
				supervision: session.supervision,
				cwd: session.cwd,
				command: session.displayCommand,
				escalated,
				killed,
			});
			ctx.nestedResults.record(toolCallId, sid, details);
			return {
				content: [{ type: "text", text: renderKillResultText(details) }],
				details,
				structuredContent: killScriptResult(details),
			};
		},
		renderCall: renderKillSessionCall,
		renderResult: renderKillSessionResult,
	});

	pi.registerTool({
		name: "list_sessions",
		label: "list_sessions",
		description: "Inspect running and retained completed sessions without consuming output or disarming notifications. Collect results with write_stdin.",
		promptSnippet: "Inspect shell jobs without consuming results",
		outputSchema: listSessionsScriptResultSchema,
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_toolCallId, _params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			// Inventory is non-consuming: only output collection acknowledges completion.
			updateRunningSessionsUi(ctx);
			const now = Date.now();
			const sessions = ctx.store.values()
				.sort((a, b) => a.id - b.id)
				.map((s) => ({
					session_id: s.id,
					command: s.displayCommand,
					cwd: s.cwd,
					tty: s.tty,
					pid: s.pid,
					started_at_ms: s.startedAt,
					elapsed_ms: now - s.startedAt,
					running: !s.hasExited,
					wake_armed: ctx.coordinator.isArmed(s.id),
					exit_code: s.hasExited ? s.exitCode : undefined,
					signal: s.hasExited ? (s.signal ?? undefined) : undefined,
					failure_message: s.failureMessage ?? undefined,
					output_bytes_total: s.totalBytesSeen,
					log_path: s.logPath,
					supervision: s.supervision,
				}));
			const toolTimeUtc = nowUtcIso();
			const lines = sessions.length
				? sessions.map((s) => {
						const exitedSuffix = s.running
							? ""
							: `  [exited${s.exit_code !== undefined && s.exit_code !== null ? ` exit_code=${s.exit_code}` : ""}${s.signal ? ` signal=${s.signal}` : ""}; output available]`;
						const wake = s.wake_armed ? " [wake]" : "";
						return `  ${String(s.session_id).padStart(3)}  pid=${String(s.pid ?? "?").padStart(6)}  ${
							s.tty ? "tty" : "pipe"
						}  ${((s.elapsed_ms / 1000).toFixed(1) + "s").padStart(8)}${wake}  ${oneLineCommand(s.command, 60)}${exitedSuffix}\n        output_bytes_total: ${s.output_bytes_total} | quiet_ms: ${s.supervision.quiet_ms}\n        log: ${s.log_path}`;
					})
				: ["  (no retained sessions)"];
			const activeCount = sessions.filter(s => s.running).length;
			const completedCount = sessions.length - activeCount;
			const header = `shell-jobs sessions (${activeCount} live, ${completedCount} completed):`;
			return {
				// tool_time_utc lets the model compute a yield_until deadline from a
				// trustworthy host clock without an extra probing call.
				content: [{ type: "text", text: `${header}\n${lines.join("\n")}\ntool_time_utc: ${toolTimeUtc}` }],
				details: { sessions, active_count: activeCount, completed_count: completedCount, just_exited_count: completedCount, tool_time_utc: toolTimeUtc },
				structuredContent: listSessionsScriptResult({
					sessions,
					active_count: activeCount,
					completed_count: completedCount,
					just_exited_count: completedCount,
					tool_time_utc: toolTimeUtc,
				}),
			};
		},
		renderCall: renderListSessionsCall,
		renderResult: renderListSessionsResult,
	});


}
