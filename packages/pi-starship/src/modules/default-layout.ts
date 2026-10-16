import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { StyledChunk } from "../format/style.js";
import type { ModuleName } from "./catalog.js";

// Only the new built-in layout opts into shrinking environment fields; usage is never shortened.
export function fitDefaultEnvironment(modules: Record<ModuleName, StyledChunk[]>, width: number) {
	const environment = [
		"directory",
		"git_branch",
		"git_status",
		"activity",
		"model",
		"thinking",
	] as const;
	let overflow = environment.reduce((total, name) => total + chunkWidth(modules[name]), 1) - width;
	for (const [name, minimum] of [
		["directory", 12],
		["git_branch", 23],
		["model", 20],
	] as const) {
		if (overflow <= 0) break;
		const current = chunkWidth(modules[name]);
		const target = Math.max(minimum, current - overflow);
		if (target >= current) continue;
		modules[name] = middleTruncate(modules[name], target);
		overflow -= current - chunkWidth(modules[name]);
	}
}

function chunkWidth(chunks: readonly StyledChunk[]): number {
	return chunks.reduce((total, chunk) => total + visibleWidth(chunk.text), 0);
}

function middleTruncate(chunks: readonly StyledChunk[], width: number): StyledChunk[] {
	const head = Math.ceil((width - 1) / 2);
	const tail = Math.floor((width - 1) / 2);
	return [
		...sliceChunks(chunks, 0, head),
		{ text: "…", style: chunks[0]?.style },
		...sliceChunks(chunks, chunkWidth(chunks) - tail, tail),
	];
}

function sliceChunks(chunks: readonly StyledChunk[], start: number, width: number): StyledChunk[] {
	let column = 0;
	return chunks.flatMap((chunk) => {
		const end = column + visibleWidth(chunk.text);
		const from = Math.max(start, column);
		const to = Math.min(start + width, end);
		const text = sliceByColumn(chunk.text, from - column, Math.max(0, to - from), true);
		column = end;
		return text ? [{ ...chunk, text }] : [];
	});
}
