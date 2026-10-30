/**
 * Held-open session diagnostics — regression tests for the "shell exited but
 * the output pipe is still held by background processes" state.
 *
 * Live-session background jobs that inherited stdout/stderr (or a
 * backgrounded `cd … && cmd &` chain whose subshell keeps waiting) delay the
 * close-based session exit indefinitely. The shell's own `exit` event is
 * exposed as `shellExited` so callers can distinguish "command still working"
 * from "shell gone, pipe held" and attach an explanatory note to
 * `[still running]` results.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ExecSession, type SessionSpawnOptions } from "../src/session.ts";
import { IS_WINDOWS } from "../src/shell.ts";
import { finalizeProcessResult, renderProcessResultText } from "../src/tool-result.ts";

const HELD_OPEN_NOTE = "shell has exited, but background process(es) still hold the output pipe";

function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve) => {
		const poll = () => {
			if (cond() || Date.now() >= deadline) return resolve(cond());
			setTimeout(poll, 50);
		};
		poll();
	});
}

let nextId = 1000;

function spawnShell(cmd: string, workdir: string): ExecSession {
	const opts: SessionSpawnOptions = {
		command: ["bash", "-c", cmd],
		cwd: workdir,
		env: process.env,
		tty: false,
	};
	const session = ExecSession.spawn(nextId++, opts);
	assert.equal(session.failureMessage, null, "spawn must succeed");
	return session;
}

/** Kill the whole process group and wait for the close-based exit. */
async function cleanup(session: ExecSession): Promise<void> {
	session.kill("SIGKILL");
	await waitFor(() => session.hasExited, 5000);
}

describe("held-open session diagnostics", { skip: IS_WINDOWS }, () => {
	const workdir = mkdtempSync(join(tmpdir(), "held-open-"));

	it("un-redirected background job: shell exits, session stays open, shellExited exposes it", async () => {
		const session = spawnShell("sleep 5 & echo done", workdir);
		try {
			// The shell itself is gone within a moment…
			assert.equal(await waitFor(() => session.shellExited, 3000), true, "shell must exit quickly");
			// …but the background job inherited the output pipe, so the
			// close-based session exit is still pending.
			assert.equal(session.hasExited, false, "session must stay open while the pipe is held");
			// The exact state the note is keyed on.
			assert.equal(session.shellExited && !session.hasExited, true);
		} finally {
			await cleanup(session);
		}
	});

	it("incident pattern `cd … && nohup cmd >log 2>&1 &`: chain subshell holds the pipe", async () => {
		const log = join(workdir, "incident.log");
		const session = spawnShell(`cd ${workdir} && nohup sleep 5 > ${log} 2>&1 & echo done`, workdir);
		try {
			assert.equal(await waitFor(() => session.shellExited, 3000), true, "shell must exit quickly");
			assert.equal(session.hasExited, false, "session must stay open while the chain subshell waits");
		} finally {
			await cleanup(session);
		}
	});

	it("control: background job with its own redirects does NOT hold the session open", async () => {
		const session = spawnShell("sleep 5 > /dev/null 2>&1 & echo done", workdir);
		try {
			// Redirected stdout/stderr mean no pipe holder: the close-based
			// exit lands immediately even though the job runs for 5 s.
			assert.equal(await waitFor(() => session.hasExited, 3000), true, "session must close promptly");
		} finally {
			await cleanup(session);
		}
	});

	it("normal foreground process: shellExited stays false while it runs", async () => {
		const session = spawnShell("sleep 2", workdir);
		try {
			assert.equal(session.shellExited, false, "shell is alive while the command runs");
			assert.equal(session.hasExited, false);
			assert.equal(await waitFor(() => session.hasExited, 5000), true, "exits normally when done");
			assert.equal(session.shellExited, true);
		} finally {
			await cleanup(session);
		}
	});

	it("render: held-open sessions carry the explanatory note, exited sessions do not", () => {
		const running = finalizeProcessResult({
			operation: "exec_command",
			wallTimeSec: 1,
			collected: new Uint8Array(0),
			sessionId: 7,
			exitCode: undefined,
			signal: null,
			failure: null,
			tty: false,
			extra: { note: HELD_OPEN_NOTE },
		});
		const runningText = renderProcessResultText(running);
		assert.match(runningText, /\[still running\]/);
		assert.match(runningText, /note: shell has exited, but background process/);

		const exited = finalizeProcessResult({
			operation: "exec_command",
			wallTimeSec: 0.1,
			collected: new Uint8Array(0),
			sessionId: undefined,
			exitCode: 0,
			signal: null,
			failure: null,
			tty: false,
		});
		const exitedText = renderProcessResultText(exited);
		assert.match(exitedText, /\[exited\]/);
		assert.doesNotMatch(exitedText, /note:/);
	});

	it("held-open sessions are still killable and close after the kill", async () => {
		const session = spawnShell("sleep 5 & echo done", workdir);
		try {
			await waitFor(() => session.shellExited, 3000);
			assert.equal(session.hasExited, false);
			session.kill("SIGTERM");
			assert.equal(await waitFor(() => session.hasExited, 3000), true, "kill lands on the group");
		} finally {
			await cleanup(session);
		}
	});
});
