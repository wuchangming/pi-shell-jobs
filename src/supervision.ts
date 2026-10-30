/** Lifetime limits are independent of tool attachment windows. */
export const DEFAULT_TIMEOUT_SECONDS = 1800;
export const MAX_TIMEOUT_SECONDS = 86400;
export const DEFAULT_LOG_BYTES = 16 * 1024 * 1024;
export const RUNTIME_LOG_BYTES = 256 * 1024 * 1024;
export const MAX_LOG_QUEUE_BYTES = 1024 * 1024;

export type StopReason = "cancelled" | "timed_out" | "log_limit" | "storage_error" | "shutdown";
export interface SupervisionSnapshot {
	state: "running" | "stopping" | "completed" | "failed" | StopReason;
	stop_reason?: StopReason;
	deadline_utc: string;
	quiet_ms: number;
	log_bytes: number;
	log_truncated: boolean;
	/** Exit of the direct child/streams is not proof that all descendants died. */
	cleanup: "not_requested" | "pending" | "unconfirmed";
}

export function timeoutSeconds(value = DEFAULT_TIMEOUT_SECONDS): number {
	if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMEOUT_SECONDS) {
		throw new Error(`timeout_seconds must be > 0 and <= ${MAX_TIMEOUT_SECONDS}`);
	}
	return value;
}

/** Shared by every job in one runtime, retained across reloads. */
export class LogBudget {
	private used = 0;
	constructor(readonly limit = RUNTIME_LOG_BYTES) {}
	get remaining(): number { return Math.max(0, this.limit - this.used); }
	claim(bytes: number): number {
		const accepted = Math.min(bytes, this.remaining);
		this.used += accepted;
		return accepted;
	}
}
