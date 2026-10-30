import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { spawnChild } from "../../src/pty.ts";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const root = mkdtempSync(join(tmpdir(), "pi-shell-jobs-demo-"));
const agent = join(root, "agent");
mkdirSync(agent);
writeFileSync(join(agent, "settings.json"), JSON.stringify({
  cacheWarming: "off", defaultProjectTrust: "always", compaction: { enabled: false },
  enableAnalytics: false, enableInstallTelemetry: false,
}));
const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const output = path("../../assets/demo.cast");
mkdirSync(path("../../assets"), { recursive: true });
const events: unknown[] = [{ version: 2, width: 110, height: 34,
  title: "pi-shell-jobs: interactive Node REPL (scripted model, real tools)",
  env: { TERM: "xterm-256color" } }];
const started = performance.now();
const terminal = spawnChild({
  command: [process.execPath, path("../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "-e", path("./provider.js"), "-e", path("../../src/index.ts"),
    "--provider", "demo", "--model", "scripted-model", "--thinking", "off"],
  cwd: root, tty: true, cols: 110, rows: 34,
  env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", TERM: "xterm-256color" },
});
let exited = false;
let recording = true;
const decoder = new StringDecoder("utf8");
terminal.onData(chunk => {
  if (recording) events.push([(performance.now() - started) / 1000, "o", decoder.write(Buffer.from(chunk))]);
});
terminal.onExit(() => { exited = true; });
try {
  await pause(2500);
  terminal.write(Buffer.from("Open a Node REPL, calculate 6 * 7, then exit.\r"));
  const deadline = Date.now() + 30000;
  while (!existsSync(join(root, "demo.done"))) {
    if (exited || Date.now() > deadline) throw new Error("Demo did not finish");
    await pause(100);
  }
  await pause(4000);
  events.push([(performance.now() - started) / 1000, "o", ""]);
  recording = false;
  writeFileSync(output, events.map(event => JSON.stringify(event)).join("\n") + "\n");
  console.log(`Recorded ${output}`);
} finally {
  terminal.write(Buffer.from("\x03"));
  await pause(300);
  terminal.write(Buffer.from("\x03"));
  for (let n = 0; n < 50 && !exited; n++) await pause(100);
  if (!exited) terminal.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
