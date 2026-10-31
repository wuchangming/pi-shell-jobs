import assert from "node:assert/strict";
import { test } from "node:test";
import { NestedResults } from "../src/nested-results.ts";
import type { ProcessResultDetails } from "../src/tool-result.ts";

const result = (overrides: Partial<ProcessResultDetails> = {}): ProcessResultDetails => ({
	operation: "write_stdin", status: "running", running: true, chunk_id: "test", output: "NEVER_INCLUDE_RAW_OUTPUT",
	wall_time_seconds: 0, ...overrides,
});

test("nested recovery receipts aggregate and follow wrappers to the model-visible boundary", () => {
	const receipts = new NestedResults();
	receipts.record("root/1/1", 1, result());
	receipts.record("root/1/2", 1, result({ status: "exited", running: false, exit_code: 7 }));
	receipts.record("root/2", 2, result());
	assert.equal(receipts.finish("root/1", "root"), false);
	const text = receipts.attach("root", id => id === 1)!;
	assert.match(text, /"session_id":1,"status":"exited","exit_code":7/);
	assert.match(text, /"session_id":2,"status":"running","result_available":false/);
	assert.doesNotMatch(text, /NEVER_INCLUDE_RAW_OUTPUT/);
	assert.equal(receipts.finish("root"), true);
	assert.equal(receipts.attach("root", () => true), undefined);
});

test("receipt size is bounded and omitted sessions direct the model to inventory", () => {
	const receipts = new NestedResults();
	for (let id = 0; id < 1000; id++) receipts.record(`root/${id}`, id, result({ command: "\x1b[31m" + "x".repeat(5000), log_path: "x".repeat(5000) }));
	const text = receipts.attach("root", () => true)!;
	assert.equal(text.split("\n").filter(line => line.startsWith("{")).length, 16);
	assert.ok(text.length < 24000);
	assert.doesNotMatch(text, /\x1b|NEVER_INCLUDE_RAW_OUTPUT/);
	assert.match(text, /More results omitted; use list_sessions/);
});

test("a missing receipt or cleared lifecycle is not a successful attachment", () => {
	const receipts = new NestedResults();
	receipts.record("root/1", 1, result());
	assert.equal(receipts.finish("root"), false);
	receipts.record("root/1", 1, result());
	receipts.clear();
	assert.equal(receipts.attach("root", () => true), undefined);
	assert.equal(receipts.finish("root"), undefined);
});
