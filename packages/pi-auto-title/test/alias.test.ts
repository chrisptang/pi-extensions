import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, test } from "vitest";
import { parseModelReference, readAliasCandidates, resolveTitleModel } from "../src/alias.js";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-auto-title-test-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

test("parseModelReference parses provider and modelId", () => {
	assert.deepEqual(parseModelReference("anthropic/claude-3-5-haiku"), {
		provider: "anthropic",
		modelId: "claude-3-5-haiku",
	});
	assert.deepEqual(parseModelReference("openrouter/anthropic/claude-3.5-haiku"), {
		provider: "openrouter",
		modelId: "anthropic/claude-3.5-haiku",
	});
	assert.equal(parseModelReference("invalid-reference"), undefined);
});

test("readAliasCandidates parses various alias formats from model-alias.json", () => {
	const aliasFile = join(tempDir, "model-alias.json");
	writeFileSync(
		aliasFile,
		JSON.stringify({
			aliases: {
				haiku: "anthropic/claude-3-5-haiku-20241022:low",
				pool: ["openai/gpt-4o-mini", "anthropic/claude-3-5-haiku"],
				objectForm: {
					models: ["google/gemini-2.0-flash:medium"],
				},
			},
		}),
	);

	assert.deepEqual(readAliasCandidates("haiku", tempDir), ["anthropic/claude-3-5-haiku-20241022"]);
	assert.deepEqual(readAliasCandidates("pool", tempDir), [
		"openai/gpt-4o-mini",
		"anthropic/claude-3-5-haiku",
	]);
	assert.deepEqual(readAliasCandidates("objectForm", tempDir), ["google/gemini-2.0-flash"]);
	assert.deepEqual(readAliasCandidates("nonexistent", tempDir), []);
});

test("resolveTitleModel resolves alias when authenticated", () => {
	const aliasFile = join(tempDir, "model-alias.json");
	writeFileSync(
		aliasFile,
		JSON.stringify({
			aliases: {
				haiku: "anthropic/claude-3-5-haiku-20241022",
			},
		}),
	);

	const mockModel = {
		provider: "anthropic",
		id: "claude-3-5-haiku-20241022",
	} as unknown as Model<Api>;
	const mockRegistry = {
		find(provider: string, modelId: string) {
			if (provider === "anthropic" && modelId === "claude-3-5-haiku-20241022") {
				return mockModel;
			}
			return undefined;
		},
		hasConfiguredAuth() {
			return true;
		},
	};

	const model = resolveTitleModel({
		requestedModelOrAlias: "haiku",
		modelRegistry: mockRegistry,
		agentDir: tempDir,
	});

	assert.ok(model);
	assert.equal(model?.provider, "anthropic");
	assert.equal(model?.id, "claude-3-5-haiku-20241022");
});

test("resolveTitleModel falls back to available haiku model when alias is unconfigured", () => {
	const availableModel = {
		provider: "openrouter",
		id: "anthropic/claude-3.5-haiku",
		name: "Claude Haiku",
	} as unknown as Model<Api>;

	const mockRegistry = {
		find() {
			return undefined;
		},
		hasConfiguredAuth() {
			return true;
		},
		getAvailable() {
			return [availableModel];
		},
	};

	const model = resolveTitleModel({
		requestedModelOrAlias: "haiku",
		modelRegistry: mockRegistry,
		agentDir: tempDir,
	});

	assert.ok(model);
	assert.equal(model?.provider, "openrouter");
	assert.equal(model?.id, "anthropic/claude-3.5-haiku");
});

test("resolveTitleModel falls back to current model when no haiku is available", () => {
	const currentModel = {
		provider: "anthropic",
		id: "claude-sonnet-4-5",
	} as unknown as Model<Api>;

	const mockRegistry = {
		find() {
			return undefined;
		},
		hasConfiguredAuth() {
			return true;
		},
		getAvailable() {
			return [];
		},
	};

	const model = resolveTitleModel({
		requestedModelOrAlias: "haiku",
		modelRegistry: mockRegistry,
		agentDir: tempDir,
		currentModel,
		fallbackToCurrentModel: true,
	});

	assert.equal(model, currentModel);
});
