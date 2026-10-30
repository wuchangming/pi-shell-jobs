import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/compat";

export default function (pi) {
	pi.registerCommand("fixture-reload", { description: "Reload fixture", handler: async (_args, ctx) => {
		await ctx.reload();
		process.stdout.write(JSON.stringify({ type: "fixture_reloaded" }) + "\n");
	} });
	const faux = fauxProvider({ provider: "jobs-reload-offline", models: [{ id: "reload-model" }] });
	faux.setResponses(Array.from({ length: 8 }, () => context => {
		const result = context.messages.findLast(m => m.role === "toolResult");
		if (!result) return fauxAssistantMessage(fauxToolCall("exec_command", {
			cmd: "node job.cjs", yield_time_ms: 250, timeout_seconds: 20,
		}), { stopReason: "toolUse" });
		const last = context.messages.at(-1);
		if (last?.role === "user") return fauxAssistantMessage(fauxToolCall("list_sessions", {}), { stopReason: "toolUse" });
		return fauxAssistantMessage("FIXTURE_DONE");
	}));
	pi.registerProvider(faux.provider);
}
