import { describe, expect, test } from "vitest";
import { computeFileLists, formatFileOperations } from "../src/file-lists.js";
import { mergeInstructions } from "../src/instructions.js";

describe("mergeInstructions", () => {
	test("puts the file prompt before the per-invocation instructions", () => {
		expect(mergeInstructions("standing policy", "this compaction")).toBe(
			"standing policy\n\nthis compaction",
		);
	});

	test("returns the single present part on its own", () => {
		expect(mergeInstructions("standing policy", undefined)).toBe("standing policy");
		expect(mergeInstructions(undefined, "this compaction")).toBe("this compaction");
	});

	test("treats blank parts as absent", () => {
		expect(mergeInstructions("  \n ", "  ")).toBeUndefined();
		expect(mergeInstructions("  \n ", "kept")).toBe("kept");
	});

	test("returns nothing when both parts are absent", () => {
		expect(mergeInstructions(undefined, undefined)).toBeUndefined();
	});
});

describe("file lists", () => {
	test("excludes modified paths from the read-only list and sorts both", () => {
		const lists = computeFileLists({
			read: new Set(["b.ts", "a.ts", "changed.ts"]),
			written: new Set(["new.ts"]),
			edited: new Set(["changed.ts"]),
		});

		expect(lists).toEqual({
			readFiles: ["a.ts", "b.ts"],
			modifiedFiles: ["changed.ts", "new.ts"],
		});
	});

	test("renders only the sections that have paths", () => {
		expect(formatFileOperations({ readFiles: ["a.ts"], modifiedFiles: [] })).toBe(
			"\n\n<read-files>\na.ts\n</read-files>",
		);
		expect(formatFileOperations({ readFiles: [], modifiedFiles: ["b.ts"] })).toBe(
			"\n\n<modified-files>\nb.ts\n</modified-files>",
		);
	});

	test("renders nothing when no files were touched", () => {
		expect(formatFileOperations({ readFiles: [], modifiedFiles: [] })).toBe("");
	});
});
