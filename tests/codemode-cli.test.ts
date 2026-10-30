import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const COMPACT_CODEMODE_ENV = "UNUSED_NATIVE_CODEMODE";

const cli = process.env.PI_SHELL_JOBS_TEST_CLI ?? fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/codemode-provider.js", import.meta.url));
const mcpFixture = fileURLToPath(new URL("./fixtures/codemode-mcp.mjs", import.meta.url));
type RunOptions = { fixed?: boolean; pattern?: string; mode?: "on" | "only"; budget?: number; active?: boolean; mcp?: boolean; packageEnabled?: boolean; exclude?: boolean };
// `fixed` is the default; `exclude` is the 0.12.1-era `-builtin:codemode` setup.
function run({ fixed = true, pattern = "parity", mode = "on", budget = 3000, active = true, mcp = false, packageEnabled = true, exclude = false }: RunOptions = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-exec-codemode-"));
	try {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
			cacheWarming: "off", defaultProjectTrust: "always", compaction: { enabled: false }, retry: { enabled: false }, enableAnalytics: false, enableInstallTelemetry: false,
			...(active ? { defaultTools: ["+codemode"] } : {}), codemode: { mode, inlineBudget: budget },
			extensions: exclude ? ["-builtin:codemode"] : [],
		}));
		const capture = join(root, "requests.jsonl");
		const child = spawnSync(process.execPath, [
			cli, "--mode", "json", "--no-session", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
			"-e", provider, ...(packageEnabled ? ["-e", extension, "--keep-builtin-bash"] : []),
			"--provider", "exec-codemode-offline", "--model", "codemode-model", "--thinking", "off", "run fixture",
		], {
			cwd: root, env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
				[COMPACT_CODEMODE_ENV]: fixed ? undefined : "0", EXEC_CODEMODE_PATTERN: pattern, EXEC_CODEMODE_CAPTURE: capture,
				EXEC_CODEMODE_MCP: mcp ? mcpFixture : "",
			}, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
		});
		assert.equal(child.error, undefined);
		assert.equal(child.status, 0, child.stderr);
		const events = child.stdout.trim().split("\n").map(line => JSON.parse(line));
		const requests = readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line));
		const ends = events.filter(e => e.type === "tool_execution_end" && e.toolName === "codemode");
		for (const end of ends) assert.equal(end.isError, false, JSON.stringify(end.result));
		assert.match(child.stdout, /EXEC_CODEMODE_OK/);
		return { events, requests, ends, stderr: child.stderr };
	} finally { rmSync(root, { recursive: true, force: true }); }
}

for (const mode of ["on", "only"] as const) {
	test(`native Pi codemode uses shell jobs structured results: ${mode}`, { timeout: 40_000 }, () => {
		const result = run({ mode });
		assert.ok(result.ends.length > 0);
		assert.doesNotMatch(result.stderr, /was not loaded|registers tool|conflict/i);
		const stores = result.events.filter(e => e.type === "entry_appended" && e.entry.customType === "codemode-store").map(e => e.entry.data);
		assert.equal(stores[0].set.probe.exit_code, 0);
	});
}
