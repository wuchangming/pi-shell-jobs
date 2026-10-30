import { writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/compat";

// Scripted model decisions; Pi, the extension, and the Node REPL are real.
export default function (pi) {
  let sessionId;
  pi.on("tool_execution_end", event => {
    if (event.isError) throw new Error(`Demo tool failed: ${event.toolName}`);
    if (event.toolName === "exec_command") sessionId = event.result.details.session_id;
  });
  pi.on("agent_end", () => writeFileSync("demo.done", "done"));
  const faux = fauxProvider({ provider: "demo", models: [{ id: "scripted-model" }] });
  const tool = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
  const steps = [
    () => tool("exec_command", { cmd: "node --interactive", tty: true, yield_time_ms: 250 }),
    () => tool("write_stdin", { session_id: sessionId, chars: "6 * 7\n", yield_time_ms: 250 }),
    () => tool("write_stdin", { session_id: sessionId, chars: ".exit\n", yield_time_ms: 1000 }),
    () => fauxAssistantMessage("The same live Node REPL returned 42, then exited cleanly."),
  ];
  faux.setResponses(steps.map(step => async () => {
    await new Promise(resolve => setTimeout(resolve, 2000));
    return step();
  }));
  pi.registerProvider(faux.provider);
}
