import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const AUTO_TITLE_SETTINGS_FILE = "pi-auto-title.json";
export const MAX_SETTINGS_FILE_BYTES = 64 * 1024;

export interface AutoTitleSettings {
	enabled: boolean;
	model: string;
	triggerTurn: number;
	maxTitleLength: number;
	fallbackToCurrentModel: boolean;
}

export const DEFAULT_AUTO_TITLE_SETTINGS: AutoTitleSettings = {
	enabled: true,
	model: "haiku",
	triggerTurn: 2,
	maxTitleLength: 40,
	fallbackToCurrentModel: true,
};

export function userSettingsFilePath(agentDir = getAgentDir()): string {
	return join(agentDir, AUTO_TITLE_SETTINGS_FILE);
}

export function projectSettingsFilePath(workspaceDir: string): string {
	return join(workspaceDir, CONFIG_DIR_NAME, AUTO_TITLE_SETTINGS_FILE);
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
	try {
		const stat = statSync(path);
		if (stat.size > MAX_SETTINGS_FILE_BYTES) return undefined;
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

export function normalizeSettings(
	doc: Record<string, unknown> | undefined,
): Partial<AutoTitleSettings> {
	if (!doc) return {};
	const result: Partial<AutoTitleSettings> = {};

	if (typeof doc.enabled === "boolean") {
		result.enabled = doc.enabled;
	}
	if (typeof doc.model === "string" && doc.model.trim().length > 0) {
		result.model = doc.model.trim();
	}
	if (
		typeof doc.triggerTurn === "number" &&
		Number.isInteger(doc.triggerTurn) &&
		doc.triggerTurn >= 1
	) {
		result.triggerTurn = doc.triggerTurn;
	}
	if (
		typeof doc.maxTitleLength === "number" &&
		Number.isInteger(doc.maxTitleLength) &&
		doc.maxTitleLength >= 10 &&
		doc.maxTitleLength <= 200
	) {
		result.maxTitleLength = doc.maxTitleLength;
	}
	if (typeof doc.fallbackToCurrentModel === "boolean") {
		result.fallbackToCurrentModel = doc.fallbackToCurrentModel;
	}

	return result;
}

export interface LoadSettingsOptions {
	agentDir?: string;
	cwd?: string;
	isProjectTrusted?: boolean;
	warn?: (msg: string) => void;
}

export function loadSettings(options: LoadSettingsOptions = {}): AutoTitleSettings {
	const userPath = userSettingsFilePath(options.agentDir);
	const userDoc = readJsonFile(userPath);
	const userNormalized = normalizeSettings(userDoc);

	let projectNormalized: Partial<AutoTitleSettings> = {};
	if (options.cwd && options.isProjectTrusted) {
		const projPath = projectSettingsFilePath(options.cwd);
		const projDoc = readJsonFile(projPath);
		projectNormalized = normalizeSettings(projDoc);
	}

	return {
		...DEFAULT_AUTO_TITLE_SETTINGS,
		...userNormalized,
		...projectNormalized,
	};
}

export async function saveUserSettings(
	patch: Partial<AutoTitleSettings>,
	agentDir = getAgentDir(),
): Promise<AutoTitleSettings> {
	const filePath = userSettingsFilePath(agentDir);
	const existingDoc = readJsonFile(filePath) ?? {};
	const updatedDoc: Record<string, unknown> = {
		...existingDoc,
		...patch,
	};

	const dir = dirname(filePath);
	await mkdir(dir, { recursive: true });

	const tempPath = `${filePath}.${randomUUID()}.tmp`;
	try {
		await writeFile(tempPath, `${JSON.stringify(updatedDoc, null, 2)}\n`, "utf8");
		await rename(tempPath, filePath);
	} catch (error) {
		try {
			await rm(tempPath, { force: true });
		} catch {
			// ignore cleanup error
		}
		throw error;
	}

	return {
		...DEFAULT_AUTO_TITLE_SETTINGS,
		...normalizeSettings(updatedDoc),
	};
}
