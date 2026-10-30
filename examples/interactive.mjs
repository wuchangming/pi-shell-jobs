import { createInterface } from "node:readline";

// Works over pipes and PTYs. Send "quit" or close pipe stdin to finish.
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
console.log("interactive: ready (type a line, or quit)");
input.on("line", line => {
  if (line === "quit") input.close();
  else console.log(`echo: ${line}`);
});
input.on("close", () => console.log("interactive: done"));
