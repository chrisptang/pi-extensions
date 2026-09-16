import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	createReadTool,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type AutocompleteProvider, CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { test } from "vitest";

const extensionDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Real Pi package install, resource loader, extension runner and completion provider.
// No credentials or provider requests; every persistent path is inside a temp home.
test("installed extension filters actual Pi prompt/completion, keeps files readable, runs analysis and reloads config", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-skill-visibility-integration-"));
	const home = join(dir, "home");
	const agentDir = join(home, ".pi", "agent");
	const cwd = join(dir, "project");
	const claudeDir = join(home, ".claude");
	const savedEnv = {
		HOME: process.env.HOME,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
		PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR,
	};
	let dispose: (() => void) | undefined;
	try {
		await mkdir(agentDir, { recursive: true });
		await mkdir(cwd);
		Object.assign(process.env, {
			HOME: home,
			PI_CODING_AGENT_DIR: agentDir,
			CLAUDE_CONFIG_DIR: claudeDir,
		});
		delete process.env.PI_CODING_AGENT_SESSION_DIR;
		execFileSync(
			process.execPath,
			[
				resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
				"install",
				extensionDirectory,
			],
			{
				cwd,
				env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
				timeout: 30_000,
				encoding: "utf8",
			},
		);
		assert.ok(
			(await readFile(join(agentDir, "settings.json"), "utf8")).includes(extensionDirectory),
		);
		for (const name of ["hide", "keep", "unused"]) {
			const skillDir = join(agentDir, "skills", name);
			await mkdir(skillDir, { recursive: true });
			await writeFile(
				join(skillDir, "SKILL.md"),
				`---\nname: ${name}\ndescription: fixture ${name}\n---\nfixture body ${name}`,
			);
		}
		const configPath = join(agentDir, "pi-skill-visibility.json");
		await writeFile(configPath, '["hide"]');
		const now = new Date().toISOString();
		await mkdir(join(agentDir, "sessions"), { recursive: true });
		await mkdir(join(claudeDir, "projects"), { recursive: true });
		await writeFile(
			join(agentDir, "sessions", "pi.jsonl"),
			JSON.stringify({
				type: "message",
				timestamp: now,
				message: { role: "user", content: "keep" },
			}),
		);
		await writeFile(
			join(claudeDir, "projects", "claude.jsonl"),
			JSON.stringify({
				type: "user",
				timestamp: now,
				message: { role: "user", content: "keep" },
			}),
		);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noContextFiles: true,
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			modelsStorePath: join(agentDir, "models-store.json"),
			allowModelNetwork: false,
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			resourceLoader: loader,
			modelRuntime,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
		});
		dispose = () => session.dispose();
		const runner = session.extensionRunner;
		let provider: AutocompleteProvider = new CombinedAutocompleteProvider(
			loader.getSkills().skills.map((s) => ({
				name: `skill:${s.name}`,
				description: s.description,
			})),
			cwd,
		);
		const notices: string[] = [];
		await session.bindExtensions({
			mode: "tui",
			uiContext: {
				...runner.getUIContext(),
				addAutocompleteProvider: (wrapper) => {
					provider = wrapper(provider);
				},
				notify: (text) => {
					notices.push(text);
				},
			},
		});
		const suggestions = await provider.getSuggestions(["/skill:"], 0, 7, {
			signal: new AbortController().signal,
		});
		assert.deepEqual(
			suggestions?.items.map((item) => item.value),
			["skill:keep", "skill:unused"],
		);
		const ctx = runner.createCommandContext();
		const filtered = await runner.emitBeforeAgentStart(
			"test",
			undefined,
			ctx.getSystemPrompt(),
			ctx.getSystemPromptOptions(),
		);
		assert.ok(filtered?.systemPrompt?.includes("<name>keep</name>"));
		assert.ok(!filtered?.systemPrompt?.includes("<name>hide</name>"));
		assert.equal(
			loader.getSkills().skills.length,
			3,
			"underlying registry is intentionally unchanged",
		);
		const read = await createReadTool(cwd).execute(
			"read-hidden",
			{ path: join(agentDir, "skills", "hide", "SKILL.md") },
			new AbortController().signal,
		);
		assert.match(JSON.stringify(read.content), /fixture body hide/);
		for (const args of ["", "7"]) {
			await session.prompt(`/skills-analysis${args ? ` ${args}` : ""}`);
			const entries = session.sessionManager.getEntries();
			const report = [...entries]
				.reverse()
				.find(
					(entry) => entry.type === "custom" && entry.customType === "skill-visibility-analysis",
				);
			assert.ok(report && report.type === "custom");
			assert.ok(JSON.stringify(report.data).includes(`最近 ${args || "60"} 天`));
			const markdown = (report.data as { markdown: string }).markdown;
			assert.ok(markdown.includes(`| keep | 0 | 0 | 2 | ${now} | 当前可发现 |`));
			assert.ok(markdown.includes("| hide | 0 | 0 | 0 | — | 已配置排除；当前可发现 |"));
			assert.ok(markdown.includes("| unused | 0 | 0 | 0 | — | 当前可发现 |"));
			const sections = markdown.split("## 窗口内未观察到使用，可考虑排除");
			assert.equal(sections.length, 2);
			assert.ok(!sections[0]!.includes("| unused |"));
			assert.ok(sections[1]!.includes("| unused |"));
			assert.deepEqual(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(markdown)![1]!), ["unused"]);
			assert.equal(session.messages.length, 0, "report must not enter LLM context");
		}
		await session.prompt("/skills-analysis -1");
		assert.ok(notices.some((text) => text.includes("用法")));
		assert.equal(await readFile(configPath, "utf8"), '["hide"]');
		// Reload factories rereads config; no prototype or installed source modifications.
		await writeFile(configPath, '["keep"]');
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const { session: reloaded } = await createAgentSession({
			cwd,
			agentDir,
			resourceLoader: loader,
			modelRuntime,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
		});
		try {
			await reloaded.bindExtensions({ mode: "print" });
			const reloadCtx = reloaded.extensionRunner.createCommandContext();
			const next = await reloaded.extensionRunner.emitBeforeAgentStart(
				"test",
				undefined,
				reloadCtx.getSystemPrompt(),
				reloadCtx.getSystemPromptOptions(),
			);
			assert.ok(next?.systemPrompt?.includes("<name>hide</name>"));
			assert.ok(!next?.systemPrompt?.includes("<name>keep</name>"));
		} finally {
			reloaded.dispose();
		}
		assert.equal(
			await readFile(join(agentDir, "skills", "hide", "SKILL.md"), "utf8"),
			"---\nname: hide\ndescription: fixture hide\n---\nfixture body hide",
		);
	} finally {
		dispose?.();
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(dir, { recursive: true, force: true });
	}
});
