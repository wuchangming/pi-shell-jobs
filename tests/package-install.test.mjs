import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const cli = join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const provider = fileURLToPath(new URL("./fixtures/package-provider.js", import.meta.url));

test("packed package installs, is discovered by Pi and executes pipes and PTYs", { timeout: 180000 }, () => {
	// Use a path with spaces, outside the checkout, so imports cannot silently
	// fall back to this repository's development dependencies.
	const root = mkdtempSync(join(tmpdir(), "pi package install "));
	const agent = join(root, "agent");
	const installed = join(root, "node_modules/pi-shell-jobs");
	const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" };
	function run(args, cwd = root, extraEnv = {}, timeout = 60000) {
		const result = spawnSync(process.execPath, args, {
			cwd, env: { ...env, ...extraEnv }, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024,
		});
		assert.equal(result.error, undefined, `${result.error}\n${result.stderr}`);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		return result;
	}
	try {
		assert.ok(process.env.npm_execpath, "Run this check with npm run test:package");
		mkdirSync(agent);
		writeFileSync(join(agent, "settings.json"), JSON.stringify({
			cacheWarming: "off", defaultProjectTrust: "always", compaction: { enabled: false },
			retry: { enabled: false }, enableAnalytics: false, enableInstallTelemetry: false,
		}));
		writeFileSync(join(root, "package.json"), '{"name":"package-smoke","private":true}');
		const packed = JSON.parse(run([process.env.npm_execpath, "pack", "--json", "--pack-destination", root], repo).stdout)[0];
		for (const path of ["src/index.ts", "LICENSE", "THIRD_PARTY_NOTICES.md", "examples/progress.mjs", "examples/interactive.mjs", "docs/testing.md"]) {
			assert.ok(packed.files.some(file => file.path === path), `Missing from package: ${path}`);
		}
		assert.ok(!packed.files.some(file => /^(tests|node_modules|\.github)\//.test(file.path)));
		run([process.env.npm_execpath, "install", join(root, packed.filename), "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"], root, {}, 90000);
		assert.ok(!existsSync(join(root, "node_modules/@earendil-works/pi-coding-agent")), "package must use Pi's host, not install another copy");
		run([cli, "install", installed]);
		const settings = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"));
		const isInstalled = source => resolve(agent, typeof source === "string" ? source : source.source) === installed;
		assert.ok(settings.packages.some(isInstalled), JSON.stringify(settings.packages));
		for (const scenario of ["pipes", "pty"]) {
			// No -e src/index.ts: loading must come from pi install + manifest.
			const result = run([cli, "--mode", "json", "--no-session", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
				"-e", provider, "--provider", "jobs-package-offline", "--model", "package-model", "--thinking", "off", "run package examples"],
				installed, { JOBS_PACKAGE_SCENARIO: scenario });
			const events = result.stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
			const ends = events.filter(event => event.type === "tool_execution_end");
			assert.equal(ends.length, scenario === "pipes" ? 9 : 3, result.stdout);
			for (const event of ends) assert.equal(event.isError, false, JSON.stringify(event));
			assert.match(result.stdout, /PACKAGE_SMOKE_OK/);
			assert.doesNotMatch(result.stderr, /was not loaded|conflict|failed to load/i);
			const output = ends.map(event => event.result.details.output ?? "").join("\n");
			assert.match(output, /echo: hello/);
			assert.match(output, /interactive: done/);
			assert.equal(ends.at(-1).result.details.exit_code, 0);
			if (scenario === "pipes") {
				assert.equal(ends.find(event => event.toolName === "kill_session").result.details.killed, true);
				assert.match(output, /progress: done/);
			} else assert.equal(ends[0].result.details.tty, true);
		}
		run([cli, "remove", installed]);
		assert.ok(!JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")).packages.some(isInstalled));
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}
});
