/**
 * File-operation tail appended to a generated summary.
 *
 * Pi's default compaction appends these lists from the same `FileOperations` this
 * extension receives, but it does not export the helpers that build them. Replacing the
 * default summary therefore means reproducing the tail here so paths keep reaching the
 * next context deterministically instead of depending on the model to repeat them.
 */

import type { FileOperations } from "@earendil-works/pi-coding-agent";

export interface FileLists {
	readFiles: string[];
	modifiedFiles: string[];
}

/** Split tracked operations into read-only paths and modified paths. */
export function computeFileLists(fileOps: FileOperations): FileLists {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	return {
		readFiles: [...fileOps.read].filter((file) => !modified.has(file)).sort(),
		modifiedFiles: [...modified].sort(),
	};
}

/** Render the lists as the XML tail Pi's default compaction appends. */
export function formatFileOperations(lists: FileLists): string {
	const sections: string[] = [];
	if (lists.readFiles.length > 0) {
		sections.push(`<read-files>\n${lists.readFiles.join("\n")}\n</read-files>`);
	}
	if (lists.modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${lists.modifiedFiles.join("\n")}\n</modified-files>`);
	}
	return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}
