import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("actual Pi 1.4 reload reuses the live runtime through a fresh jiti extension factory", { timeout: 30000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-reload-"));
	const agent = join(root, "agent");
	mkdirSync(agent);
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", cacheWarming: "off", compaction: { enabled: false } }));
	writeFileSync(join(root, "job.cjs"), 'console.log("job-pid=" + process.pid); setInterval(() => {}, 1000);');
	const child = spawn(process.execPath, [
		fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url)),
		"--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-themes", "--no-prompt-templates",
		"-e", fileURLToPath(new URL("./fixtures/reload-provider.js", import.meta.url)),
		"-e", fileURLToPath(new URL("../src/index.ts", import.meta.url)),
		"--provider", "jobs-reload-offline", "--model", "reload-model", "--thinking", "off",
	], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" }, stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += chunk;
		if (phase === 1 && stderr.includes('"type":"fixture_reloaded"')) {
			phase = 2;
			send("inspect the running job");
		}
	});
	let started: any;
	let listed: any;
	let phase = 0;
	let timer: NodeJS.Timeout | undefined;
	const send = (message: string) => child.stdin.write(JSON.stringify({ type: "prompt", message }) + "\n");
	const lines = createInterface({ input: child.stdout });
	try {
		await new Promise<void>((resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`reload timeout: ${stderr}`)), 24000);
			child.once("error", reject);
			child.once("exit", code => reject(new Error(`Pi exited ${code}: ${stderr}`)));
			lines.on("line", line => {
				if (!line.startsWith("{")) return;
				const event = JSON.parse(line);
				if (event.type === "tool_execution_end") {
					if (event.toolName === "exec_command") started = event.result.details;
					if (event.toolName === "list_sessions") listed = event.result.details;
				}
				if (event.type === "agent_end" && phase === 0) {
					phase = 1;
					send("/fixture-reload");
				} else if (event.type === "fixture_reloaded") {
					phase = 2;
					send("inspect the running job");
				} else if (event.type === "agent_end" && phase === 2) resolve();
			});
			send("start the job");
		});
		assert.equal(listed.active_count, 1, JSON.stringify({ started, listed, stderr }));
		assert.equal(listed.sessions[0].session_id, started.session_id);
		assert.equal(listed.sessions[0].log_path, started.log_path);
		assert.equal(listed.sessions[0].supervision.deadline_utc, started.supervision.deadline_utc);
	} finally {
		clearTimeout(timer);
		lines.close();
		const exit = new Promise<void>(resolve => child.once("exit", () => resolve()));
		child.stdin.end();
		const force = setTimeout(() => child.kill("SIGKILL"), 5000);
		await exit;
		clearTimeout(force);
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}
});
