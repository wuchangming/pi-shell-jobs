import { existsSync, writeFileSync } from "node:fs";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/compat";

/** Scripted model for the actual Pi notification queue, never a network provider. */
export default function (pi) {
	const busy = process.env.JOBS_PROGRESS_SCENARIO === "busy";
	let released = false;
	let inspected = false;
	let step = 0;
	let sid;
	const release = () => { released = true; writeFileSync("finish", ""); };
	pi.on("agent_settled", () => {
		if (!busy && inspected && !released) release();
	});
	pi.registerTool({
		name: "fixture_finish_and_hold", label: "Finish fixture", description: "Test queueing during a tool call",
		parameters: Type.Object({}),
		async execute() {
			release();
			const deadline = Date.now() + 5000;
			while (!existsSync("finished")) {
				if (Date.now() >= deadline) throw new Error("job did not finish");
				await new Promise(resolve => setTimeout(resolve, 20));
			}
			// Keep the host busy past the completion coordinator's debounce.
			await new Promise(resolve => setTimeout(resolve, 700));
			return { content: [{ type: "text", text: "BUSY_WORK_DONE" }], details: {} };
		},
	});
	const faux = fauxProvider({ provider: "jobs-progress-offline", models: [{ id: "progress-model" }] });
	const call = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
	faux.setResponses(Array.from({ length: 12 }, () => context => {
		const current = step++;
		if (current === 0) return call("exec_command", {
			cmd: "node job.cjs", yield_time_ms: 250, timeout_seconds: 20, on_exit: "wake",
		});
		if (current === 1) {
			const started = context.messages.find(m => m.role === "toolResult" && m.toolName === "exec_command");
			const text = started.content.filter(p => p.type === "text").map(p => p.text).join("\n");
			sid = Number(/^session_id: (\d+)/m.exec(text)?.[1]);
			if (!sid) throw new Error(`no background ID: ${text}`);
			return call("exec_command", { cmd: "node independent.cjs", yield_time_ms: 10000, timeout_seconds: 10 });
		}
		if (current === 2) return call("write_stdin", { session_id: sid, yield_time_ms: 0 });
		if (current === 3) {
			inspected = true;
			return busy ? call("fixture_finish_and_hold", {}) : fauxAssistantMessage("WAITING_FOR_COMPLETION");
		}
		if (busy && current === 4) return fauxAssistantMessage("WAITING_FOR_COMPLETION");
		const followupStep = current - (busy ? 5 : 4);
		if (followupStep === 0) {
			if (!JSON.stringify(context.messages).includes("[shell-jobs]")) throw new Error("missing completion in model context");
			return call("list_sessions", {});
		}
		if (followupStep === 1) return call("write_stdin", { session_id: sid, yield_time_ms: 0 });
		return fauxAssistantMessage("PROGRESS_FLOW_DONE");
	}));
	pi.registerProvider(faux.provider);
}
