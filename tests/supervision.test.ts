import assert from "node:assert/strict";
import { statSync, readFileSync, unlinkSync } from "node:fs";
import { test } from "node:test";
import { ExecSession, type SessionSpawnOptions } from "../src/session.ts";
import { LogBudget, timeoutSeconds } from "../src/supervision.ts";
import { waitForExitOrDeadline } from "../src/long-wait.ts";
import { isPtyAvailable } from "../src/pty.ts";
import { Notify } from "../src/notify.ts";
import { HeadTailBuffer } from "../src/head-tail-buffer.ts";
import { collectOutputUntilDeadline } from "../src/collect.ts";
import { Gate } from "../src/notify.ts";
import { SessionStore } from "../src/session-store.ts";

function start(code: string, options: Partial<SessionSpawnOptions> = {}) {
	return ExecSession.spawn(1, { command: [process.execPath, "-e", code], cwd: process.cwd(),
		env: process.env, tty: false, timeoutSeconds: 8, ...options });
}
async function finish(session: ExecSession) {
	await waitForExitOrDeadline({ exited: session.exited, durationMs: 6000 });
	assert.ok(session.hasExited, "supervised child did not exit");
	await session.collect({ deadlineMs: Date.now() + 1000 });
	await session.outputClosed.closed();
}
async function dispose(session: ExecSession) {
	if (!session.hasExited) session.kill("SIGKILL");
	await finish(session);
	unlinkSync(session.logPath);
}

test("rejects invalid lifetimes before creating a process", () => {
	for (const value of [0, -1, NaN, Infinity, 86401]) assert.throws(() => timeoutSeconds(value));
	assert.equal(timeoutSeconds(), 1800);
});

for (const tty of [false, true]) {
	test(`hard deadline stops a CPU loop without any attached tool (tty=${tty})`, { skip: tty && !isPtyAvailable(), timeout: 10000 }, async () => {
		const s = start("while(true) {}", { tty, timeoutSeconds: 0.3 });
		try {
			await finish(s);
			assert.equal(s.supervision.state, "timed_out");
			assert.match(s.failureMessage!, /deadline/);
			assert.equal(s.supervision.cleanup, "unconfirmed");
		} finally { await dispose(s); }
	});
}

test("deadline escalates a child that ignores SIGTERM", { skip: process.platform === "win32", timeout: 10000 }, async () => {
	const s = start('process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)', { timeoutSeconds: 1 });
	try {
		await finish(s);
		assert.equal(s.signal, "SIGKILL");
		assert.equal(s.escalated, true);
		assert.equal(s.supervision.stop_reason, "timed_out");
	} finally { await dispose(s); }
});

test("an explicitly requested SIGKILL is not reported as escalation", async () => {
	const s = start('setInterval(() => {}, 1000)');
	try {
		s.kill("SIGKILL");
		await finish(s);
		assert.equal(s.escalated, false);
	} finally { await dispose(s); }
});

test("quiet time is telemetry, not an inactivity kill", async () => {
	const s = start('setTimeout(() => console.log("done"), 300)');
	try {
		await finish(s);
		assert.equal(s.supervision.state, "completed");
		assert.equal(s.supervision.log_truncated, false);
		assert.match(readFileSync(s.logPath, "utf8"), /done/);
		if (process.platform !== "win32") assert.equal(statSync(s.logPath).mode & 0o777, 0o600);
	} finally { await dispose(s); }
});

test("log quota stops a noisy job and never writes past the cap", async () => {
	const s = start('setInterval(() => process.stdout.write("x".repeat(65536)), 2)', { maxLogBytes: 8192 });
	try {
		await finish(s);
		assert.equal(s.supervision.state, "log_limit");
		assert.equal(s.supervision.log_truncated, true);
		assert.equal(statSync(s.logPath).size, 8192);
		assert.ok(s.totalBytesSeen > s.supervision.log_bytes);
	} finally { await dispose(s); }
});

test("runtime log budget is shared, including already completed jobs", async () => {
	const budget = new LogBudget(10);
	const a = start('process.stdout.write("12345678")', { logBudget: budget });
	let b: ExecSession | undefined;
	try {
		await finish(a);
		b = start('process.stdout.write("abcdefgh")', { logBudget: budget });
		await finish(b);
		assert.equal(statSync(a.logPath).size + statSync(b.logPath).size, 10);
		assert.equal(b.supervision.stop_reason, "log_limit");
		assert.equal(budget.remaining, 0);
	} finally { await dispose(a); if (b) await dispose(b); }
});

test("concurrent interaction is rejected and cancellation can bypass the reader", async () => {
	const s = start('setInterval(() => {}, 1000)');
	try {
		const first = s.interact(() => waitForExitOrDeadline({ exited: s.exited, durationMs: 5000 }));
		await assert.rejects(s.interact(async () => undefined), /attached reader/);
		s.kill();
		assert.equal(await first, "exit");
		assert.equal(await s.interact(async () => 42), 42);
	} finally { await dispose(s); }
});

test("reclaiming completed inventory preserves its log and never stops a live job", async () => {
	const store = new SessionStore({ maxSessions: 2, lruProtectedCount: 0 });
	const completed = start('console.log("retained-after-eviction")');
	const live = ExecSession.spawn(2, { command: [process.execPath, "-e", "setInterval(() => {}, 1000)"], cwd: process.cwd(), env: process.env, tty: false, timeoutSeconds: 10 });
	let next: ExecSession | undefined;
	try {
		store.insert(completed);
		store.insert(live);
		// Wait for settlement without collecting its pending output.
		await completed.outputClosed.closed();
		for (let i = 0; i < 3; i++) assert.equal(store.values().length, 2);
		store.assertCapacity();
		next = ExecSession.spawn(3, { command: [process.execPath, "-e", "console.log('next')"], cwd: process.cwd(), env: process.env, tty: false, timeoutSeconds: 8 });
		assert.equal(store.insert(next).pruned, completed);
		assert.equal(store.get(completed.id), undefined);
		assert.equal(store.size, 2);
		assert.equal(live.hasExited, false);
		assert.match(readFileSync(completed.logPath, "utf8"), /retained-after-eviction/);
	} finally {
		await dispose(completed);
		await dispose(live);
		if (next) await dispose(next);
	}
});

test("cancelled output subscriptions release parked listeners without new output", async () => {
	const notify = new Notify();
	for (let i = 0; i < 1000; i++) {
		const abort = new AbortController();
		const pending = notify.notified(abort.signal);
		abort.abort();
		await pending;
	}
	assert.equal(notify.pendingWaiters, 0);
});

test("storage failure stops a live child and keeps exit state truthful", async () => {
	const s = start('setInterval(() => {}, 1000)');
	try {
		(s as any).logStream.destroy(new Error("simulated disk full"));
		await finish(s);
		assert.equal(s.supervision.state, "storage_error");
		assert.equal(s.supervision.log_truncated, true);
		assert.match(s.failureMessage!, /simulated disk full/);
	} finally { await dispose(s); }
});

test("attached collection stays bounded across many individually small output bursts", async () => {
	const buffer = new HeadTailBuffer(4096);
	const outputNotify = new Notify();
	const outputClosed = new Gate();
	const exit = new AbortController();
	const collecting = collectOutputUntilDeadline({ buffer, outputNotify, outputClosed,
		exited: exit.signal, deadlineMs: Date.now() + 5000 });
	for (let i = 0; i < 200; i++) {
		buffer.pushChunk(new Uint8Array(1024).fill(65 + i % 26));
		outputNotify.notifyAll();
		await new Promise(resolve => setImmediate(resolve));
	}
	exit.abort();
	outputClosed.close();
	outputNotify.notifyAll();
	const result = await collecting;
	assert.ok(result.bytes.length < 5000);
	assert.ok(result.omittedBytes > 190000);
	assert.match(new TextDecoder().decode(result.bytes), /bytes omitted/);
	assert.equal(outputNotify.pendingWaiters, 0);
});

test("pipe EOF lets a program finish after consuming its input", async () => {
	const s = start('let n=0;process.stdin.on("data",d=>n+=d.length);process.stdin.on("end",()=>console.log("bytes="+n))');
	try {
		assert.ok(s.write(Buffer.from("hello")));
		s.endInput();
		await finish(s);
		assert.equal(s.exitCode, 0);
		assert.match(readFileSync(s.logPath, "utf8"), /bytes=5/);
	} finally { await dispose(s); }
});

test("PTY can be resized while the program is running", { skip: !isPtyAvailable() }, async () => {
	const s = start('process.stdin.on("data",()=>{console.log("size="+process.stdout.columns+"x"+process.stdout.rows);process.exit(0)})', { tty: true });
	try {
		s.resize(97, 41);
		await new Promise(resolve => setTimeout(resolve, 200));
		s.write(Buffer.from("check\r"));
		await finish(s);
		assert.match(readFileSync(s.logPath, "utf8"), /size=97x41/);
	} finally { await dispose(s); }
});
