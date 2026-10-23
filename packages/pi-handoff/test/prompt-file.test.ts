import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

let directory: string;
let cwd: string;
let agentDir: string;
let projectFile: string;
let userFile: string;
let resolvePrompt: typeof import("../src/prompt-file.js")["resolvePrompt"];
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

beforeAll(async () => {
	vi.stubEnv("PI_CODING_AGENT_DIR", join(tmpdir(), "pi-handoff-prompt-import"));
	resolvePrompt = (await import("../src/prompt-file.js")).resolvePrompt;
});
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-handoff-prompt-"));
	cwd = join(directory, "project");
	agentDir = join(directory, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	projectFile = join(cwd, ".pi", "system-prompts", "handoff.md");
	userFile = join(agentDir, "system-prompts", "handoff.md");
	vi.mocked(readFileSync).mockImplementation(actualFs.readFileSync);
});
afterEach(() => {
	vi.mocked(readFileSync).mockReset();
	rmSync(directory, { recursive: true, force: true });
});
afterAll(() => vi.unstubAllEnvs());

function promptFile(path: string, text: string) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
}

it("does not create files or directories when neither scope is configured", () => {
	expect(resolvePrompt(cwd, true)).toEqual({ errors: [] });
	expect(readdirSync(cwd)).toEqual([]);
	expect(readdirSync(agentDir)).toEqual([]);
});

it.each([
	["trusted project wins", true, " Project focus \n", "User focus", "Project focus"],
	["untrusted project is not read", false, "Project focus", "User focus", "User focus"],
	["missing project", true, undefined, "User focus", "User focus"],
	["blank project", true, " \n\t", "User focus", "User focus"],
	["empty user", true, undefined, "", undefined],
	["both blank", true, " \n", "\t", undefined],
	["only an untrusted project", false, "Project focus", undefined, undefined],
] as const)("%s", (_label, trusted, project, user, expected) => {
	if (project !== undefined) promptFile(projectFile, project);
	if (user !== undefined) promptFile(userFile, user);
	expect(resolvePrompt(cwd, trusted)).toEqual(
		expected === undefined ? { errors: [] } : { text: expected, errors: [] },
	);
	if (!trusted) {
		expect(vi.mocked(readFileSync).mock.calls.some(([path]) => path === projectFile)).toBe(false);
	}
});

it.each(["ENOENT", "ENOTDIR", "EISDIR"])("treats %s as an absent project prompt", (code) => {
	promptFile(userFile, "User focus");
	vi.mocked(readFileSync).mockImplementationOnce(() => {
		throw Object.assign(new Error("not a prompt file"), { code });
	});
	expect(resolvePrompt(cwd, true)).toEqual({ text: "User focus", errors: [] });
});

it.each(["EACCES", "EIO"])("reports %s and continues to the user scope", (code) => {
	promptFile(userFile, "User focus");
	vi.mocked(readFileSync).mockImplementationOnce(() => {
		throw Object.assign(new Error("cannot read"), { code });
	});
	const result = resolvePrompt(cwd, true);
	expect(result.text).toBe("User focus");
	expect(result.errors).toEqual([expect.stringContaining(projectFile)]);
	expect(result.errors[0]).toContain("cannot read");
});

it("reports an unreadable user prompt and leaves the built-in prompt usable", () => {
	vi.mocked(readFileSync).mockImplementationOnce(() => {
		throw Object.assign(new Error("cannot read user prompt"), { code: "EACCES" });
	});
	const result = resolvePrompt(cwd, false);
	expect(result.text).toBeUndefined();
	expect(result.errors).toEqual([expect.stringContaining(userFile)]);
});

it("reads edits on the next handoff and does not rewrite either prompt file", () => {
	promptFile(projectFile, "First focus");
	promptFile(userFile, "User focus");
	expect(resolvePrompt(cwd, true).text).toBe("First focus");
	promptFile(projectFile, "Revised focus");
	expect(resolvePrompt(cwd, true).text).toBe("Revised focus");
	expect(actualFs.readFileSync(projectFile, "utf8")).toBe("Revised focus");
	expect(actualFs.readFileSync(userFile, "utf8")).toBe("User focus");
});
