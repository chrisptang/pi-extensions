import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";

export interface SkillInfo {
	name: string;
	filePath?: string;
}
export type EvidenceKind = "invocation" | "load" | "mention";
export interface Usage {
	name: string;
	known: boolean;
	excluded: boolean;
	invocation: number;
	load: number;
	mention: number;
	lastUsed?: string;
}
export interface SourceSummary {
	source: "pi" | "claude";
	root: string;
	files: number;
	messages: number;
	invalid: number;
	warnings: string[];
}
export interface AnalysisResult {
	days: number;
	since: string;
	until: string;
	sources: SourceSummary[];
	usage: Usage[];
}
export interface AnalysisOptions {
	days: number;
	now?: number;
	skills: SkillInfo[];
	excluded: ReadonlySet<string>;
	roots: { source: "pi" | "claude"; root: string }[];
	signal?: AbortSignal;
}

type Obj = Record<string, unknown>;
function object(value: unknown): Obj {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}

export function parseDays(input: string): number {
	const text = input.trim();
	if (!text) return 60;
	const days = Number(text);
	if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(days) || days > 100_000_000) {
		throw new Error("用法：/skills-analysis [正整数天数]，默认 60；最大 100000000。");
	}
	return days;
}

/** Do not count injected catalogs, tool output or copied skill bodies as casual mentions. */
export function conversationText(text: string): string {
	return text
		.replace(/<available_skills>[\s\S]*?<\/available_skills>/g, "")
		.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
		.replace(/<skill\b[^>]*>[\s\S]*?<\/skill>/g, "");
}

function namedReferences(text: string): string[] {
	const names: string[] = [];
	for (const match of text.matchAll(
		/(?:^|[^a-zA-Z0-9_-])\/skill:([a-zA-Z0-9_-]+)(?![a-zA-Z0-9_-])/g,
	)) {
		const name = match[1];
		if (name) names.push(name);
	}
	return names;
}

export interface EvidenceContext {
	cwd?: string;
	warn?: (message: string) => void;
}

function pathSkill(
	path: string,
	skills: SkillInfo[],
	context: EvidenceContext,
): string | undefined {
	const normalized = path.replace(/^@/, "");
	const absolute = isAbsolute(normalized)
		? normalized
		: context.cwd && isAbsolute(context.cwd) && !normalized.startsWith("~")
			? resolve(context.cwd, normalized)
			: undefined;
	const known =
		absolute &&
		skills.find(
			(s) => s.filePath && isAbsolute(s.filePath) && resolve(s.filePath) === resolve(absolute),
		);
	if (known) return known.name;
	if (basename(normalized) !== "SKILL.md") return undefined;
	context.warn?.(
		absolute
			? "历史 skill 路径不在当前清单中，名称仅由目录推断。"
			: "历史 skill 相对路径缺少可靠工作目录或包含未展开的 ~，无法可靠归属。",
	);
	return basename(dirname(normalized)) || undefined;
}

function toolEvidence(
	block: Obj,
	skills: SkillInfo[],
	add: (name: string, kind: EvidenceKind) => void,
	context: EvidenceContext,
): void {
	const name = typeof block.name === "string" ? block.name.toLowerCase().split(".").pop() : "";
	const args = object(block.arguments ?? block.input);
	if (name === "skill" && typeof args.skill === "string") add(args.skill, "invocation");
	if (name === "read") {
		const path = args.path ?? args.file_path;
		if (typeof path === "string") {
			const skill = pathSkill(path, skills, context);
			if (skill) add(skill, "load");
		}
	}
	// Recognize shell reads, not arbitrary arguments or file creation commands.
	if (
		name === "bash" &&
		typeof args.command === "string" &&
		/(?:^|[;|&\s])(cat|head|tail|sed|less|more)\s/.test(args.command)
	) {
		const changesDirectory = /(?:^|[;|&\s])(?:cd|pushd)\s/.test(args.command);
		if (changesDirectory) context.warn?.("shell 加载包含目录切换，无法可靠解析相对 skill 路径。");
		const shellContext = changesDirectory ? { ...context, cwd: undefined } : context;
		for (const match of args.command.matchAll(
			/(?:"([^"\n]*\/SKILL\.md)"|'([^'\n]*\/SKILL\.md)'|([^\s'";|&]+\/SKILL\.md))/g,
		)) {
			const path = match[1] ?? match[2] ?? match[3];
			if (!path) continue;
			const skill = pathSkill(path, skills, shellContext);
			if (skill) add(skill, "load");
		}
	}
}

/** One evidence count per skill/kind/message, regardless of repeated words or tool blocks. */
export function extractEvidence(
	content: unknown,
	skills: SkillInfo[],
	names: Iterable<string>,
	context: EvidenceContext = {},
): Map<string, Set<EvidenceKind>> {
	const knownNames = new Set(names);
	const result = new Map<string, Set<EvidenceKind>>();
	const add = (name: string, kind: EvidenceKind) => {
		if (
			!name ||
			name.length > 256 ||
			/[\s<>]/.test(name) ||
			[...name].some((character) => character.charCodeAt(0) <= 31)
		)
			return;
		const kinds = result.get(name) ?? new Set<EvidenceKind>();
		kinds.add(kind);
		result.set(name, kinds);
	};
	const texts: string[] = [];
	for (const value of typeof content === "string"
		? [{ type: "text", text: content }]
		: Array.isArray(content)
			? content
			: []) {
		const block = object(value);
		if (block.type === "toolCall" || block.type === "tool_use")
			toolEvidence(block, skills, add, context);
		if (block.type !== "text" || typeof block.text !== "string") continue;
		const withoutCatalogs = block.text
			.replace(/<available_skills>[\s\S]*?<\/available_skills>/g, "")
			.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
		// Pi expands slash invocations before saving the user message.
		for (const match of withoutCatalogs.matchAll(/<skill\s+name="([^"]+)"\s+location="/g)) {
			const name = match[1];
			if (name) add(name, "invocation");
		}
		const text = conversationText(withoutCatalogs);
		for (const name of namedReferences(text)) add(name, "invocation");
		// Claude's stored slash invocation uses command-name tags.
		for (const match of text.matchAll(/<command-name>\/?([^<\s]+)<\/command-name>/g)) {
			const command = match[1]?.replace(/^skill:/, "");
			if (command && knownNames.has(command)) add(command, "invocation");
		}
		texts.push(text);
	}
	const text = texts.join("\n");
	for (const name of knownNames) {
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (new RegExp(`(?<![a-zA-Z0-9_-])${escaped}(?![a-zA-Z0-9_-])`, "u").test(text))
			add(name, "mention");
	}
	return result;
}

async function* sessionFiles(
	dir: string,
	summary: SourceSummary,
	signal?: AbortSignal,
): AsyncGenerator<string> {
	signal?.throwIfAborted();
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		summary.warnings.push(
			`无法扫描 ${dir}：${(error as NodeJS.ErrnoException).code ?? "读取失败"}`,
		);
		return;
	}
	for (const entry of entries) {
		signal?.throwIfAborted();
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* sessionFiles(path, summary, signal);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
		else if (entry.isSymbolicLink()) summary.warnings.push(`未跟随符号链接：${path}`);
	}
}

async function scanFile(
	path: string,
	summary: SourceSummary,
	options: AnalysisOptions,
	usage: Map<string, Usage>,
	seen: Set<string>,
	since: number,
	until: number,
): Promise<void> {
	summary.files++;
	const stream = createReadStream(path, {
		encoding: "utf8",
		signal: options.signal,
	});
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	let lineNumber = 0;
	let sessionCwd: string | undefined;
	const pathWarnings = new Set<string>();
	try {
		for await (const line of lines) {
			options.signal?.throwIfAborted();
			lineNumber++;
			if (!line.trim()) continue;
			let entry: Obj;
			try {
				entry = object(JSON.parse(line));
			} catch {
				summary.invalid++;
				continue;
			}
			if (summary.source === "pi" && entry.type === "session") {
				sessionCwd = typeof entry.cwd === "string" && isAbsolute(entry.cwd) ? entry.cwd : undefined;
			}
			const messageCwd =
				typeof entry.cwd === "string" && isAbsolute(entry.cwd) ? entry.cwd : sessionCwd;
			const isMessage =
				summary.source === "pi"
					? entry.type === "message"
					: entry.type === "user" || entry.type === "assistant";
			if (!isMessage) continue;
			const message = object(entry.message);
			if (typeof message.role !== "string") {
				summary.invalid++;
				continue;
			}
			if (message.role !== "user" && message.role !== "assistant") continue;
			const rawTime = entry.timestamp ?? message.timestamp;
			const time =
				typeof rawTime === "number"
					? rawTime
					: typeof rawTime === "string"
						? Date.parse(rawTime)
						: NaN;
			if (
				!Number.isFinite(time) ||
				!(typeof message.content === "string" || Array.isArray(message.content))
			) {
				summary.invalid++;
				continue;
			}
			if (time < since || time > until) continue;
			// Preserve distinct messages but eliminate replay/copy duplicates across files.
			const digest = createHash("sha256")
				.update(
					JSON.stringify([
						summary.source,
						entry.uuid ?? entry.id,
						messageCwd,
						time,
						message.role,
						message.content,
					]),
				)
				.digest("hex");
			if (seen.has(digest)) continue;
			seen.add(digest);
			summary.messages++;
			for (const [name, kinds] of extractEvidence(
				message.content,
				options.skills,
				[...options.skills.map((skill) => skill.name), ...options.excluded],
				{ cwd: messageCwd, warn: (warning) => pathWarnings.add(warning) },
			)) {
				const row = usage.get(name) ?? {
					name,
					known: false,
					excluded: options.excluded.has(name),
					invocation: 0,
					load: 0,
					mention: 0,
				};
				for (const kind of kinds) row[kind]++;
				const timestamp = new Date(time).toISOString();
				if (!row.lastUsed || timestamp > row.lastUsed) row.lastUsed = timestamp;
				usage.set(name, row);
			}
		}
	} catch (error) {
		options.signal?.throwIfAborted();
		summary.warnings.push(
			`读取失败 ${path}:${lineNumber}：${(error as NodeJS.ErrnoException).code ?? "流错误"}`,
		);
	} finally {
		lines.close();
		stream.destroy();
		for (const warning of pathWarnings) summary.warnings.push(`${path}：${warning}`);
	}
}

export async function analyzeSessions(options: AnalysisOptions): Promise<AnalysisResult> {
	const days = parseDays(String(options.days));
	const until = options.now ?? Date.now();
	const since = Math.max(-8.64e15, until - days * 86400000);
	const usage = new Map<string, Usage>();
	for (const name of new Set([...options.skills.map((s) => s.name), ...options.excluded])) {
		usage.set(name, {
			name,
			known: options.skills.some((s) => s.name === name),
			excluded: options.excluded.has(name),
			invocation: 0,
			load: 0,
			mention: 0,
		});
	}
	const sources: SourceSummary[] = [];
	const seen = new Set<string>();
	for (const source of options.roots) {
		const summary: SourceSummary = {
			...source,
			files: 0,
			messages: 0,
			invalid: 0,
			warnings: [],
		};
		sources.push(summary);
		for await (const path of sessionFiles(source.root, summary, options.signal))
			await scanFile(path, summary, options, usage, seen, since, until);
	}
	return {
		days,
		since: new Date(since).toISOString(),
		until: new Date(until).toISOString(),
		sources,
		usage: [...usage.values()].sort((a, b) => a.name.localeCompare(b.name)),
	};
}
