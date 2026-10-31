import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const scenario of ["busy", "idle"]) test(`actual Pi: progress and completion while ${scenario}`, { timeout: 35000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-progress-"));
	const agent = join(root, "agent");
	mkdirSync(agent);
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", cacheWarming: "off", compaction: { enabled: false } }));
	writeFileSync(join(root, "job.cjs"), `
const fs = require('node:fs'); let phase = false;
const timer = setInterval(() => {
 if (!phase && fs.existsSync('progress')) {
  phase = true; process.stdout.write('phase-two\\n', () => fs.writeFileSync('progressed', ''));
 }
 if (fs.existsSync('finish')) { console.log('final-result'); fs.writeFileSync('finished', ''); clearInterval(timer); }
}, 20);
`);
	writeFileSync(join(root, "independent.cjs"), `
const fs = require('node:fs'); fs.writeFileSync('progress', '');
const timer = setInterval(() => { if (fs.existsSync('progressed')) { console.log('independent-done'); clearInterval(timer); } }, 20);
`);
	const child = spawn(process.execPath, [
		process.env.PI_SHELL_JOBS_TEST_CLI ?? fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url)),
		"--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-themes", "--no-prompt-templates",
		"-e", fileURLToPath(new URL("./fixtures/progress-provider.js", import.meta.url)),
		"-e", fileURLToPath(new URL("../src/index.ts", import.meta.url)),
		"--provider", "jobs-progress-offline", "--model", "progress-model", "--thinking", "off",
	], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", JOBS_PROGRESS_SCENARIO: scenario, PI_SHELL_JOBS_MAX_EMPTY_POLL_MS: "" }, stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.on("data", chunk => { stderr += chunk; });
	const events: any[] = [];
	const lines = createInterface({ input: child.stdout });
	let timer: NodeJS.Timeout | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`progress timeout: ${stderr}\n${JSON.stringify(events).slice(-6000)}`)), 28000);
			child.once("error", reject);
			child.once("exit", code => reject(new Error(`Pi exited ${code}: ${stderr}`)));
			lines.on("line", line => {
				if (!line.startsWith("{")) return;
				const event = JSON.parse(line);
				events.push(event);
				if (event.type === "message_end" && event.message?.role === "assistant" && event.message.content?.some((p: any) => p.text === "PROGRESS_FLOW_DONE")) resolve();
			});
			child.stdin.write(JSON.stringify({ type: "prompt", message: "Run the finite job, do independent work, inspect progress and collect its final result." }) + "\n");
		});
		const tools = events.filter(e => e.type === "tool_execution_end");
		assert.ok(tools.every(e => !e.isError), JSON.stringify(tools));
		const reads = tools.filter(e => e.toolName === "write_stdin");
		assert.equal(reads.length, 2);
		assert.equal(reads[0].result.details.wait_status, "snapshot");
		assert.match(reads[0].result.details.output, /phase-two/);
		assert.equal(reads[0].result.structuredContent.wait_mode, "immediate");
		assert.equal(reads[1].result.details.wait_status, "completed");
		assert.match(reads[1].result.details.output, /final-result/);
		const listing = tools.find(e => e.toolName === "list_sessions").result.structuredContent;
		assert.equal(listing.completed_count, 1);
		assert.equal(listing.just_exited_count, 1);
		assert.ok(listing.sessions[0].output_bytes_total > 0);
		const notices = events.filter(e => e.type === "message_start" && e.message?.customType === "shell-jobs-completed");
		assert.equal(notices.length, 1, JSON.stringify(events));
		const boundary = events.findIndex(e => e.type === "message_end" && e.message?.role === "assistant" && e.message.content?.some((p: any) => p.text === "WAITING_FOR_COMPLETION"));
		assert.ok(boundary >= 0 && events.indexOf(notices[0]) > boundary, "followUp must not steer the current run");
	} finally {
		clearTimeout(timer);
		lines.close();
		const exit = new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", () => resolve()); });
		child.stdin.end();
		const force = setTimeout(() => child.kill("SIGKILL"), 5000);
		await exit;
		clearTimeout(force);
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}
});
