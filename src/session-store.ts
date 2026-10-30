/** Bounded registry: only completed jobs may be evicted. Admission happens before spawn. */

import { ExecSession } from "./session.ts";

export interface SessionStoreOptions {
	maxSessions: number;
	lruProtectedCount: number;
	/** Called when a session is evicted (for UI cleanup). */
	onEvict?: (session: ExecSession, reason: "lru" | "shutdown") => void;
}

export class SessionStore {
	private readonly sessions = new Map<number, ExecSession>();
	private nextId = 1;
	readonly maxSessions: number;
	readonly lruProtectedCount: number;
	private readonly onEvict: SessionStoreOptions["onEvict"];

	constructor(opts: SessionStoreOptions) {
		this.maxSessions = opts.maxSessions;
		this.lruProtectedCount = opts.lruProtectedCount;
		this.onEvict = opts.onEvict;
	}

	/** Allocate a new monotonic session id (never reused). */
	allocateId(): number {
		return this.nextId++;
	}

	get(id: number): ExecSession | undefined {
		return this.sessions.get(id);
	}

	values(): ExecSession[] {
		return Array.from(this.sessions.values());
	}

	get size(): number {
		return this.sessions.size;
	}

	/**
	 * Insert a session. Returns the evicted session, if any. If inserting the
	 * new session would exceed the cap, prune an LRU non-protected entry first.
	 */
	insert(session: ExecSession): { pruned?: ExecSession; count: number } {
		let pruned: ExecSession | undefined;
		if (this.sessions.size >= this.maxSessions) {
			pruned = this.pruneLru() ?? undefined;
			if (!pruned) throw new Error(`shell-jobs capacity reached (${this.maxSessions}); stop or wait for an existing job`);
		}
		this.sessions.set(session.id, session);
		return { pruned, count: this.sessions.size };
	}

	/** Remove a session (e.g., when it exits). */
	remove(id: number): ExecSession | undefined {
		const entry = this.sessions.get(id);
		if (!entry) return undefined;
		this.sessions.delete(id);
		return entry;
	}

	/** Terminate all sessions and clear the store. Used on session_shutdown. */
	terminateAll(): ExecSession[] {
		const drained = Array.from(this.sessions.values());
		this.sessions.clear();
		for (const s of drained) {
			try {
				s.terminate();
			} catch {
				// ignore
			}
			this.onEvict?.(s, "shutdown");
		}
		return drained;
	}

	/** Synchronous preflight; call immediately before spawn/insert without awaiting. */
	assertCapacity(): void {
		if (this.sessions.size >= this.maxSessions && !this.values().some(s => s.hasExited)) {
			throw new Error(`shell-jobs capacity reached (${this.maxSessions}); no command was started`);
		}
	}

	private pruneLru(): ExecSession | null {
		const victim = this.values().filter(s => s.hasExited).sort((a, b) => a.lastUsed - b.lastUsed)[0];
		if (!victim) return null;
		this.sessions.delete(victim.id);
		this.onEvict?.(victim, "lru");
		return victim;
	}
}
