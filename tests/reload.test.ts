import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activate from "../src/index.ts";

function adapter(owner = {}) {
	const tools = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const messages: any[] = [];
	const context = { cwd: process.cwd(), sessionManager: owner, hasUI: false,
		ui: { notify() {}, setStatus() {}, setWidget() {} } };
	activate({ registerTool: (t: any) => tools.set(t.name, t), registerFlag() {}, registerCommand() {},
		on: (event: string, h: any) => handlers.set(event, [...handlers.get(event) ?? [], h]),
		getFlag: () => false, getActiveTools: () => ["bash", "powershell"], setActiveTools() {},
		sendMessage: (message: any) => messages.push(message),
	} as unknown as ExtensionAPI);
	let callId = 0;
	return { messages, owner,
		async emit(event: string, data: any = {}) { for (const h of handlers.get(event) ?? []) await h(data, context); },
		async call(name: string, args: any, id = `call-${++callId}`) { return tools.get(name).execute(id, args, undefined, undefined, context); },
	};
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("reload upgrades a pre-receipt context without losing nested completion recovery", { timeout: 10000 }, async () => {
	const old = adapter(), next = adapter(old.owner);
	try {
		await old.emit("session_start", { reason: "startup" });
		const start = await old.call("exec_command", { cmd: `node -e "process.stdin.resume();process.stdin.on('end',()=>console.log('done'))"`, yield_time_ms: 250, on_exit: "wake" });
		await old.emit("session_shutdown", { reason: "reload" });
		const retained = (globalThis as any)[Symbol.for("pi-shell-jobs.reload.v1")].get(old.owner);
		delete retained.terminalResults; delete retained.nestedResults;
		const original = Object.getPrototypeOf(retained.coordinator);
		Object.setPrototypeOf(retained.coordinator, Object.assign(Object.create(original), {
			handleToolExecutionEnd(this: any, id: string, error: boolean) { original.handleToolExecutionEnd.call(this, id, error); },
		}));
		await next.emit("session_start", { reason: "reload" });
		const sid = start.details.session_id;
		await next.call("write_stdin", { session_id: sid, end_stdin: true, yield_time_ms: 5000 }, "root/1");
		await next.emit("tool_execution_end", { toolCallId: "root/1", parentToolCallId: "root", isError: false });
		await pause(300);
		assert.equal(next.messages.length, 0);
		await next.emit("tool_execution_end", { toolCallId: "root", isError: true });
		assert.equal(next.messages.length, 1);
		const recovered = await next.call("write_stdin", { session_id: sid, yield_time_ms: 0 });
		assert.equal(recovered.details.output_replayed, true);
		assert.match(recovered.details.output, /done/);
	} finally { await next.emit("session_shutdown", { reason: "quit" }); }
});

test("reload transfers the same PID, output, deadline and pending completion to the new adapter", { timeout: 15000 }, async () => {
	const old = adapter();
	const next = adapter(old.owner);
	try {
		await old.emit("session_start", { reason: "startup" });
		const started = await old.call("exec_command", { cmd: "sleep 1.2; echo completed", on_exit: "wake", timeout_seconds: 6, yield_time_ms: 250 });
		const sid = started.details.session_id;
		const before = await old.call("list_sessions", {});
		await old.emit("session_shutdown", { reason: "reload" });
		await pause(1400); // Finish while no Pi adapter is attached.
		assert.equal(old.messages.length, 0);
		await next.emit("session_start", { reason: "reload" });
		assert.equal(next.messages.length, 1);
		assert.equal(old.messages.length, 0);
		const result = await next.call("write_stdin", { session_id: sid });
		assert.equal(result.details.exit_code, 0);
		assert.match(result.details.output, /completed/);
		assert.equal(result.details.supervision.deadline_utc, started.details.supervision.deadline_utc);
		assert.equal(next.messages[0].details.sessions[0].sessionId, before.details.sessions[0].session_id);
		await next.emit("agent_settled");
		assert.equal(next.messages.length, 1);
	} finally { await next.emit("session_shutdown", { reason: "quit" }); }
});

test("reload keeps a live process and does not restart its hard deadline", { timeout: 10000 }, async () => {
	const old = adapter();
	const next = adapter(old.owner);
	try {
		await old.emit("session_start", { reason: "startup" });
		const start = await old.call("exec_command", { cmd: "sleep 30", timeout_seconds: 2, yield_time_ms: 250 });
		const before = (await old.call("list_sessions", {})).details.sessions[0];
		await old.emit("session_shutdown", { reason: "reload" });
		await next.emit("session_start", { reason: "reload" });
		const after = (await next.call("list_sessions", {})).details.sessions[0];
		assert.equal(after.pid, before.pid);
		const done = await next.call("write_stdin", { session_id: start.details.session_id });
		assert.equal(done.details.supervision.state, "timed_out");
		assert.equal(done.details.supervision.deadline_utc, start.details.supervision.deadline_utc);
	} finally { await next.emit("session_shutdown", { reason: "quit" }); }
});

test("independent Pi runtimes cannot adopt each other's jobs", async () => {
	const a = adapter();
	const b = adapter();
	try {
		await a.emit("session_start", { reason: "startup" });
		const job = await a.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250 });
		await a.emit("session_shutdown", { reason: "reload" });
		await b.emit("session_start", { reason: "reload" });
		await assert.rejects(b.call("write_stdin", { session_id: job.details.session_id }), /unknown session/);
		await a.emit("session_start", { reason: "reload" });
	} finally {
		await a.emit("session_shutdown", { reason: "quit" });
		await b.emit("session_shutdown", { reason: "quit" });
	}
});

test("removing the extension during reload triggers the handoff cleanup deadline", { timeout: 18000 }, async () => {
	const a = adapter();
	await a.emit("session_start", { reason: "startup" });
	try {
		await a.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250 });
		await a.emit("session_shutdown", { reason: "reload" });
		await pause(10500);
		const listed = await a.call("list_sessions", {});
		assert.equal(listed.details.active_count, 0);
		assert.equal(a.messages.length, 0);
	} finally { await a.emit("session_shutdown", { reason: "quit" }); }
});

for (const tty of [false, true]) test(`native Windows PowerShell observes the hard deadline (tty=${tty})`, { skip: process.platform !== "win32", timeout: 10000 }, async () => {
	const a = adapter();
	try {
		await a.emit("session_start", { reason: "startup" });
		let result = await a.call("exec_command", { cmd: "Start-Sleep -Seconds 30", shell: "powershell", tty,
			timeout_seconds: 1, yield_time_ms: 250 });
		if (result.details.session_id) result = await a.call("write_stdin", { session_id: result.details.session_id });
		assert.equal(result.details.supervision.state, "timed_out");
	} finally { await a.emit("session_shutdown", { reason: "quit" }); }
});
