import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { getPtyLoadError, isPtyAvailable, spawnChild, type SpawnedChild } from "../src/pty.ts";

const available = isPtyAvailable();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number) => {
	try { process.kill(pid, 0); return true; } catch { return false; }
};

for (const mode of ["exit", "cancel", "steer"] as const) {
	test(`actual Pi TUI over native PTY: ${mode}`, { skip: !available && !process.env.EXPECT_PTY, timeout: 40000 }, async () => {
		assert.ok(available, getPtyLoadError());
		const root = mkdtempSync(join(tmpdir(), "pi-jobs-tui-"));
		const agent = join(root, "agent");
		mkdirSync(agent);
		writeFileSync(join(agent, "settings.json"), JSON.stringify({
			cacheWarming: "off", defaultProjectTrust: "always", compaction: { enabled: false },
			enableAnalytics: false, enableInstallTelemetry: false,
		}));
		writeFileSync(join(root, "events.jsonl"), "");
		writeFileSync(join(root, "job.cjs"), `
require("node:fs").writeFileSync("job.pid", String(process.pid));
console.log("job-started");
setTimeout(() => console.log("job-finished"), ${mode === "exit" ? 5000 : 30000});
`);
		let terminal: SpawnedChild | undefined;
		let exited = false;
		let output = "";
		const events = () => readFileSync(join(root, "events.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
		const screen = () => stripVTControlCharacters(output);
		async function until(check: () => boolean, label: string, timeout = 15000) {
			const deadline = Date.now() + timeout;
			while (Date.now() < deadline) {
				if (check()) return;
				await pause(50);
			}
			assert.fail(`${label}\n${screen().slice(-6000)}`);
		}
		try {
			terminal = spawnChild({
				command: [process.execPath,
					fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url)),
					"--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
					"-e", fileURLToPath(new URL("./fixtures/wait-provider.js", import.meta.url)),
					"-e", fileURLToPath(new URL("../src/index.ts", import.meta.url)),
					"--provider", "exec-wait-offline", "--model", "wait-model", "--thinking", "off", "run fixture"],
				cwd: root, tty: true, cols: 140, rows: 42,
				env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", TERM: "xterm-256color",
					PI_SHELL_JOBS_MAX_EMPTY_POLL_MS: "", EXEC_WAIT_SCENARIO: "off" },
			});
			terminal.onData(chunk => { output = (output + Buffer.from(chunk).toString()).slice(-256000); });
			terminal.onExit(() => { exited = true; });
			await until(() => events().some(e => e.type === "wait-start"), "tool never attached");
			const pid = Number(readFileSync(join(root, "job.pid"), "utf8"));
			await until(() => screen().includes("900.0s"), "attached wait not rendered");
			assert.ok(alive(pid));
			if (mode !== "exit") terminal.write(Buffer.from(mode === "cancel" ? "\x1b" : "SMOKE-TEST-1234\r"));
			await until(() => events().some(e => e.type === "wait-end"), "wait never returned");
			const end = events().find(e => e.type === "wait-end");
			assert.equal(end.isError, false);
			assert.equal(end.details.wait_status, mode === "exit" ? "completed" : mode === "cancel" ? "cancelled" : "interrupted_by_steer");
			if (mode !== "exit") {
				assert.equal(end.details.running, true);
				assert.ok(alive(pid), "interrupting the wait must leave the job alive");
			} else {
				await until(() => screen().includes("EXEC_WAIT_OK"), "final answer not rendered");
				assert.match(screen(), /job-finished/);
			}
			// Exercise Pi's normal shutdown rather than terminating its host.
			terminal.write(Buffer.from("\x03"));
			await pause(300);
			terminal.write(Buffer.from("\x03"));
			await until(() => exited, "Pi did not exit normally", 8000);
			await until(() => !alive(pid), "shutdown left the job alive", 5000);
		} finally {
			if (terminal && !exited) {
				terminal.kill("SIGKILL");
				await until(() => exited, "failed to stop test terminal", 5000);
			}
			if (existsSync(join(root, "job.pid"))) {
				const pid = Number(readFileSync(join(root, "job.pid"), "utf8"));
				if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
			}
			rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		}
	});
}
