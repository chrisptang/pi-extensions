import assert from "node:assert/strict";
import { test } from "vitest";
import { readCliModelArgument } from "../src/cli-model.js";

const argv = (...args: string[]) => ["/usr/bin/node", "/usr/bin/pi", ...args];

test("reads the value following --model", () => {
	assert.equal(readCliModelArgument(argv("--model", "sonnet")), "sonnet");
});

test("reads --model when other flags surround it", () => {
	assert.equal(
		readCliModelArgument(argv("-p", "hi", "--model", "sonnet", "--thinking", "high")),
		"sonnet",
	);
});

test("ignores a --model with no value", () => {
	assert.equal(readCliModelArgument(argv("--model")), undefined);
});

test("returns undefined when --model is absent", () => {
	assert.equal(readCliModelArgument(argv("-p", "hello")), undefined);
});

// Pi only accepts the space-separated spelling, so `--model=x` is not a model flag.
test("ignores the equals spelling Pi does not accept", () => {
	assert.equal(readCliModelArgument(argv("--model=sonnet")), undefined);
});

// An explicit provider addresses Pi's catalog, so the value is never an alias name.
test("defers to Pi when --provider is given", () => {
	assert.equal(readCliModelArgument(argv("--provider", "local", "--model", "sonnet")), undefined);
	assert.equal(readCliModelArgument(argv("--model", "sonnet", "--provider", "local")), undefined);
});
