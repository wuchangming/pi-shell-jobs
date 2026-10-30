import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/compat";

// Drives the installed package through Pi's real model/tool event loop.
export default function (pi) {
	const tty = process.env.JOBS_PACKAGE_SCENARIO === "pty";
	let sessionId;
	pi.on("tool_execution_end", event => {
		if (event.toolName === "exec_command") sessionId = event.result.details?.session_id;
	});
	const steps = tty ? [
		["exec_command", () => ({ cmd: "node examples/interactive.mjs", tty: true, yield_time_ms: 500, timeout_seconds: 20 })],
		["write_stdin", () => ({ session_id: sessionId, cols: 100, rows: 35, chars: "hello\r", yield_time_ms: 500 })],
		["write_stdin", () => ({ session_id: sessionId, chars: "quit\r", yield_time_ms: 5000 })],
	] : [
		["exec_command", () => ({ cmd: "node examples/interactive.mjs", yield_time_ms: 500, timeout_seconds: 20 })],
		["set_on_exit", () => ({ session_id: sessionId, on_exit: "wake" })],
		["list_sessions", () => ({})],
		["set_on_exit", () => ({ session_id: sessionId, on_exit: "none" })],
		["write_stdin", () => ({ session_id: sessionId, chars: "hello\n", end_stdin: true, yield_time_ms: 5000 })],
		["exec_command", () => ({ cmd: "node examples/interactive.mjs", yield_time_ms: 500, timeout_seconds: 20 })],
		["kill_session", () => ({ session_id: sessionId })],
		["exec_command", () => ({ cmd: "node examples/progress.mjs", yield_time_ms: 500, timeout_seconds: 20 })],
		["write_stdin", () => ({ session_id: sessionId, yield_time_ms: 10000 })],
	];
	let next = 0;
	const faux = fauxProvider({ provider: "jobs-package-offline", models: [{ id: "package-model" }] });
	faux.setResponses(Array.from({ length: 16 }, () => () => {
		const step = steps[next++];
		if (step) return fauxAssistantMessage(fauxToolCall(step[0], step[1]()), { stopReason: "toolUse" });
		const active = pi.getActiveTools();
		const required = ["exec_command", "write_stdin", "list_sessions", "set_on_exit", "kill_session"];
		if (!required.every(name => active.includes(name)) || active.includes("bash") || active.includes("powershell")) {
			throw new Error(`Incorrect installed tool selection: ${active.join(", ")}`);
		}
		return fauxAssistantMessage("PACKAGE_SMOKE_OK");
	}));
	pi.registerProvider(faux.provider);
}
