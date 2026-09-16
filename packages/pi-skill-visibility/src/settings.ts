import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const SETTINGS_FILE = "pi-skill-visibility.json";
const LEGACY_SETTINGS_FILE = "excluded-skills.json";

export interface ExclusionSettings {
	excluded: Set<string>;
	warning?: string;
}

type ReadResult =
	| { kind: "missing" }
	| { kind: "invalid"; warning: string }
	| { kind: "loaded"; text: string; settings: ExclusionSettings };

/**
 * Loads the canonical setting first. A valid legacy file is copied atomically once,
 * then removed only if it has not changed during migration.
 */
export async function loadExclusionSettings(): Promise<ExclusionSettings> {
	const agentDir = getAgentDir();
	const canonicalPath = join(agentDir, SETTINGS_FILE);
	const legacyPath = join(agentDir, LEGACY_SETTINGS_FILE);
	const canonical = await readSettingsFile(canonicalPath);
	if (canonical.kind !== "missing") return withLegacyNotice(canonical, legacyPath);

	const legacy = await readSettingsFile(legacyPath);
	const canonicalAfterLegacyRead = await readSettingsFile(canonicalPath);
	if (canonicalAfterLegacyRead.kind !== "missing") {
		return withLegacyNotice(canonicalAfterLegacyRead, legacyPath);
	}
	if (legacy.kind === "missing") return { excluded: new Set() };
	if (legacy.kind === "invalid") return asSettings(legacy);

	const { settings, text } = legacy;
	try {
		await migrateLegacyFile({ canonicalPath, legacyPath, legacyText: text });
		return {
			excluded: settings.excluded,
			warning: `Migrated ${LEGACY_SETTINGS_FILE} to ${SETTINGS_FILE}.`,
		};
	} catch (error) {
		return {
			excluded: settings.excluded,
			warning: `Using legacy ${LEGACY_SETTINGS_FILE}; could not migrate it to ${SETTINGS_FILE}: ${formatError(error)}`,
		};
	}
}

/** Exported for focused validation tests and compatibility consumers. */
export async function readExclusions(path: string): Promise<ExclusionSettings> {
	return asSettings(await readSettingsFile(path));
}

export function settingsFilePath(): string {
	return join(getAgentDir(), SETTINGS_FILE);
}

export function legacySettingsFilePath(): string {
	return join(getAgentDir(), LEGACY_SETTINGS_FILE);
}

async function readSettingsFile(path: string): Promise<ReadResult> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing" };
		return {
			kind: "invalid",
			warning: `Cannot read ${path}; no skills will be hidden: ${formatError(error)}`,
		};
	}
	try {
		const value: unknown = JSON.parse(text);
		if (
			!Array.isArray(value) ||
			!value.every((name) => typeof name === "string" && name.length > 0 && name.trim() === name)
		) {
			throw new Error(
				"expected a JSON array of nonempty skill names without surrounding whitespace",
			);
		}
		return { kind: "loaded", text, settings: { excluded: new Set(value) } };
	} catch (error) {
		return {
			kind: "invalid",
			warning: `Cannot use ${path}; no skills will be hidden: ${formatError(error)}`,
		};
	}
}

async function withLegacyNotice(
	result: ReadResult,
	legacyPath: string,
): Promise<ExclusionSettings> {
	const settings = asSettings(result);
	if (!(await pathExists(legacyPath))) return settings;
	return {
		...settings,
		warning: `${settings.warning ? `${settings.warning} ` : ""}Legacy ${LEGACY_SETTINGS_FILE} is ignored because ${SETTINGS_FILE} takes precedence. Remove it after confirming the migration.`,
	};
}

function asSettings(result: ReadResult): ExclusionSettings {
	if (result.kind === "loaded") return result.settings;
	if (result.kind === "invalid") return { excluded: new Set(), warning: result.warning };
	return { excluded: new Set() };
}

async function migrateLegacyFile({
	canonicalPath,
	legacyPath,
	legacyText,
}: {
	canonicalPath: string;
	legacyPath: string;
	legacyText: string;
}): Promise<void> {
	await mkdir(dirname(canonicalPath), { recursive: true });
	const temporaryPath = `${canonicalPath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, legacyText, "utf8");
		if (await pathExists(canonicalPath)) {
			throw new Error(`${SETTINGS_FILE} was created concurrently; restart to use it`);
		}
		await rename(temporaryPath, canonicalPath);
		const currentLegacy = await readFile(legacyPath, "utf8").catch(() => undefined);
		if (currentLegacy === legacyText) await rm(legacyPath, { force: true });
	} catch (error) {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return false;
		throw error;
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
