import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

for (const mode of ["on", "only"] as const) for (const scenario of ["silent", "failure", "short"]) {
	const failure = scenario !== "silent";
	test(`actual Pi agent contract: ${mode}, ${scenario}`, { timeout: 30000 }, () => {
		const root = mkdtempSync(join(tmpdir(), "pi-agent-contract-"));
		try {
			const agent = join(root, "agent"); mkdirSync(agent);
			writeFileSync(join(agent, "settings.json"), JSON.stringify({
				cacheWarming: "off", defaultProjectTrust: "always", compaction: { enabled: false }, retry: { enabled: false },
				defaultTools: ["+codemode"], codemode: { mode, inlineBudget: 1000 },
			}));
			writeFileSync(join(root, "job.cjs"), "console.log('READY'); process.stdin.resume(); process.stdin.on('end',()=>{console.log('FINAL_RESULT');process.exitCode=7;});");
			writeFileSync(join(root, "short.cjs"), "console.log('FINAL_RESULT');process.exitCode=7;");
			const capture = join(root, "context.jsonl");
			const result = spawnSync(process.execPath, [
				process.env.PI_SHELL_JOBS_TEST_CLI ?? fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url)),
				"--mode", "json", "--no-session", "--no-skills", "--no-themes", "--no-prompt-templates", "--no-context-files",
				"-e", fileURLToPath(new URL("./fixtures/agent-contract-provider.js", import.meta.url)),
				"-e", fileURLToPath(new URL("../src/index.ts", import.meta.url)),
				"--provider", "jobs-contract-offline", "--model", "contract", "--thinking", "off", "Exercise result recovery.",
			], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1",
				JOBS_CONTRACT_FAILURE: failure ? "1" : "0", JOBS_CONTRACT_SHORT: scenario === "short" ? "1" : "0", JOBS_CONTRACT_CAPTURE: capture }, encoding: "utf8", timeout: 25000, maxBuffer: 16 * 1024 * 1024 });
			assert.equal(result.error, undefined);
			assert.equal(result.status, 0, result.stderr);
			assert.ok(result.stdout.includes("AGENT_CONTRACT_OK"), result.stdout.slice(-5000));
			const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
			const notices = events.filter(e => e.type === "message_start" && e.message?.customType === "shell-jobs-completed");
			assert.equal(notices.length, failure ? 1 : 0);
			const contexts = readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line));
			assert.match(JSON.stringify(contexts[0]), /Shell job workflow/);
			assert.match(JSON.stringify(contexts[0]), /quiet_ms measures silence/);
			const reads = events.filter(e => e.type === "tool_execution_end" && e.toolName === "write_stdin" && !e.isError);
			assert.equal(reads.length, scenario === "short" ? 1 : 2);
			assert.equal(reads.at(-1).result.structuredContent.output_replayed, true);
			assert.equal(reads.at(-1).result.structuredContent.exit_code, 7);
		} finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
	});
}
