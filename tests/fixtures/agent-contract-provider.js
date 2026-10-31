import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/compat";

// Fault injection through real Pi; this fixture does not evaluate model decisions.
export default function (pi) {
	const failure = process.env.JOBS_CONTRACT_FAILURE === "1";
	const short = process.env.JOBS_CONTRACT_SHORT === "1";
	const f = fauxProvider({ provider: "jobs-contract-offline", models: [{ id: "contract" }] });
	const call = code => fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });
	let step = 0, sid;
	f.setResponses(Array.from({ length: 10 }, () => context => {
		appendFileSync(process.env.JOBS_CONTRACT_CAPTURE, JSON.stringify(context) + "\n");
		const messages = context.messages.filter(m => m.role === "toolResult");
		const last = messages.at(-1)?.content.filter(c => c.type === "text").map(c => c.text).join("\n") ?? "";
		if (short) {
			if (step++ === 0) return call('await tools.exec_command({cmd:"node short.cjs",yield_time_ms:5000,on_exit:"wake",timeout_seconds:20}); throw new Error("short-command-script-failed");');
			if (step === 2) {
				sid = Number(/"session_id":(\d+)/.exec(last)?.[1]);
				if (!sid || !last.includes('"exit_code":7')) throw new Error(`Missing short result receipt: ${last}`);
				return fauxAssistantMessage("WAIT_FOR_RECOVERY_NOTICE");
			}
			if (step === 3) {
				if (!JSON.stringify(context.messages).includes("[shell-jobs]")) throw new Error("Missing short command recovery wake");
				return call(`const r = await tools.write_stdin({session_id:${sid},yield_time_ms:0}); text(r);`);
			}
			if (!last.includes("FINAL_RESULT") || !/"output_replayed"\s*:\s*true/.test(last)) throw new Error(`Short output not recovered: ${last}`);
			return fauxAssistantMessage("AGENT_CONTRACT_OK");
		}
		if (step++ === 0) return call('const r = await tools.exec_command({cmd:"node job.cjs",yield_time_ms:250,on_exit:"wake",timeout_seconds:20}); text(r.output);');
		if (step === 2) {
			// Recover the handle solely from what the model actually receives.
			sid = Number(/"session_id":(\d+)/.exec(last)?.[1]);
			if (!sid) throw new Error(`No recovery handle in model context: ${last}`);
			return call(`
for (const [name,args] of [["set_on_exit",{session_id:${sid},on_exit:"none",end_stdin:true}], ["write_stdin",{session_id:${sid},yield_time_ms:0,on_exit:"wake"}]]) {
 let rejected=false; try { await tools[name](args); } catch { rejected=true; }
 if (!rejected) throw new Error("Unsupported arguments silently accepted: "+name);
}
await tools.write_stdin({session_id:${sid},end_stdin:true,yield_time_ms:5000}); ${failure ? 'throw new Error("after-read-failure");' : ''}`);
		}
		if (step === 3 && failure) return fauxAssistantMessage("WAIT_FOR_RECOVERY_NOTICE");
		if (step === (failure ? 4 : 3)) {
			if (!last.includes('"exit_code":7')) throw new Error(`Missing exit status in receipt: ${last}`);
			if (failure && !JSON.stringify(context.messages).includes("[shell-jobs]")) throw new Error("Missing recovery wake");
			return call(`const r = await tools.write_stdin({session_id:${sid},yield_time_ms:0}); text(r);`);
		}
		if (step === (failure ? 5 : 4)) {
			if (!last.includes("FINAL_RESULT") || !/"output_replayed"\s*:\s*true/.test(last)) throw new Error(`Final output not recovered: ${last}`);
			return fauxAssistantMessage("AGENT_CONTRACT_OK");
		}
		throw new Error("Unexpected extra wake or model turn");
	}));
	pi.registerProvider(f.provider);
}
