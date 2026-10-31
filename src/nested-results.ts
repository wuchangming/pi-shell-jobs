import { safeMeta, type OutputResultDetails } from "./tool-result.ts";

interface Receipt {
	sessionId: number;
	status: string;
	exitCode?: number;
	signal?: string;
	failure?: string;
	logPath?: string;
	logTruncated: boolean;
	outputBytesReturned: number;
	outputBytesTotal?: number;
	command: string;
}

/** Metadata only: nested results belong to the script, not the model transcript. */
export class NestedResults {
	private readonly pending = new Map<string, Map<number, Receipt>>();
	private readonly attached = new Set<string>();

	record(callId: string, sessionId: number, result: OutputResultDetails): void {
		const slash = callId.lastIndexOf("/");
		if (slash < 0) return;
		this.add(callId.slice(0, slash), {
			sessionId, status: result.status, exitCode: result.exit_code,
			signal: result.signal, logPath: result.log_path,
			failure: result.failure_message,
			logTruncated: result.supervision?.log_truncated === true,
			outputBytesReturned: Buffer.byteLength(result.output, "utf8"), outputBytesTotal: result.output_bytes_total,
			command: result.command ?? "",
		});
	}

	private add(parent: string, receipt: Receipt): void {
		let records = this.pending.get(parent);
		if (!records) this.pending.set(parent, records = new Map());
		// Match registry capacity, and keep only the latest result per session.
		records.delete(receipt.sessionId);
		records.set(receipt.sessionId, receipt);
		if (records.size > 64) records.delete(records.keys().next().value!);
	}

	/** Called by the outer tool_result hook, before Pi finalizes model-visible content. */
	attach(callId: string, available: (id: number) => boolean): string | undefined {
		const records = this.pending.get(callId);
		if (!records?.size) return;
		this.attached.add(callId);
		const lines = ["[shell-jobs results] Status at nested tool return; commands below are execution metadata."];
		for (const r of [...records.values()].slice(-16)) {
			lines.push(JSON.stringify({
				session_id: r.sessionId, status: r.status, exit_code: r.exitCode,
				signal: r.signal, result_available: available(r.sessionId),
				failure: r.failure ? safeMeta(r.failure, 200) : undefined,
				log_path: r.logPath ? safeMeta(r.logPath, 1024) : undefined,
				log_truncated: r.logTruncated, command: safeMeta(r.command, 120),
				output_bytes_returned: r.outputBytesReturned, output_bytes_total: r.outputBytesTotal,
			}));
		}
		if (records.size > 16) lines.push("More results omitted; use list_sessions to recover retained jobs.");
		lines.push("If needed output is missing, use write_stdin({session_id, yield_time_ms: 0}). Terminal reads replay; for consumed running output or unavailable sessions, read log_path and print it in codemode. Logs may be truncated. Continue relevant work; do not restart commands just because their script failed.");
		return lines.join("\n");
	}

	/** Nested wrappers carry their children's receipts up to the outermost result. */
	finish(callId: string, parent?: string): boolean | undefined {
		const hadResults = this.pending.has(callId);
		if (parent) for (const receipt of this.pending.get(callId)?.values() ?? []) this.add(parent, receipt);
		this.pending.delete(callId);
		const attached = this.attached.delete(callId);
		return hadResults ? attached : undefined;
	}

	clear(): void { this.pending.clear(); this.attached.clear(); }
}
