import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { AgentDefinition } from "./agent-definitions.js";
import { type ModelCandidateLookup, resolveAgentModel } from "./agent-model.js";
import { AgentRegistry } from "./agent-registry.js";
import {
	applyOverride,
	type InstructionOverrides,
	loadInstructionOverrides,
} from "./instruction-overrides.js";
import { modelVisibleJson } from "./model-output.js";
import { resolveMaxTurns, resolveTimeoutMs } from "./process.js";
import { type RuntimeDependencies, SubagentRuntime } from "./runtime.js";
import type { SkillDefinition } from "./skill-definitions.js";
import { SkillRegistry } from "./skill-registry.js";
import { MAX_IDENTIFIER_LENGTH, sanitizeTerminalText } from "./text.js";
import {
	CHILD_CORE_TOOL_NAMES,
	DEFAULT_MAX_TURNS,
	DEFAULT_SUBAGENT_TOOLS,
	SUBAGENT_THINKING_LEVELS,
	type SubagentThinkingLevel,
} from "./types.js";

/**
 * Built-in prompt text for each overridable tool, named so
 * `~/.pi/agent/subagent_instruction.md` can replace a field without the
 * fallback being buried in a registration call.
 */
const BUILTIN_INSTRUCTIONS = {
	subagent_spawn: {
		description:
			"Use subagent_spawn to start one Pi subagent job and return its jobId immediately. The task defines the child's specialization, and the selected tools define its capabilities. A job cannot ask you anything: it runs to completion and publishes one asynchronous result, so the task must carry every decision the child needs. Call it more than once in one parallel batch only for tasks that are mutually independent: each must be completable without any other's result, and parallel writers must own disjoint files. When one task needs another's output, start it only after that job's result has been collected.",
		guidelines: [
			// The restraint rule comes first: a model that reads only one of these
			// bullets should read the one that stops an unnecessary delegation. The
			// cost is real and invisible to the model — a child re-reads the files
			// this session already has, and its result still has to be verified here.
			"Do the work yourself by default. A subagent is worth its cost in three cases: several independent tasks can run at once, a wide search or file survey would flood this context, or the user asks for one. Otherwise it is slower and you must verify its claims anyway.",
			"Never delegate planning, the critical path, integration, deterministic checks, authorization decisions, or the final answer to the user. Keep those here even when subagents are doing other work.",
			"Batch multiple subagent_spawn calls only for mutually independent tasks. A task that needs another task's result is not independent and must wait for that job's completion.",
			"Give each parallel writer disjoint file ownership. Concurrent writes to one file are not serialized or merged.",
		],
	},
	skill_run: {
		description:
			"Use skill_run to execute one skill inside a subagent instead of loading it into this session. The skill's instructions become the child's system prompt, so its step-by-step work and intermediate file reads stay out of the main context and only the final result returns. Pass the user's request for the skill through args. Returns a jobId immediately; collect the result with subagent_wait. The same independence rule as subagent_spawn applies: batch multiple runs only when the skills' tasks do not depend on one another's results.",
	},
	subagent_inspect: {
		description:
			"Use subagent_inspect to return one privacy-filtered snapshot of retained jobs without exposing task text, complete child output, prompts, selected tools, or context.",
	},
	subagent_cancel: {
		description:
			"Use subagent_cancel to idempotently cancel one queued or running job and release its process, timer, and temporary resources. Other jobs are unaffected, and file changes the child already made are kept rather than rolled back. Terminal jobs remain unchanged. A job whose error says it was cancelled by the user was stopped deliberately by the human: report that and do not restart the same work unless asked.",
	},
	subagent_wait: {
		description:
			"Use subagent_wait to wait for one job to become terminal. An incoming child request or response interrupts the wait without cancelling the job. A timeout or caller cancellation stops only this wait.",
	},
} as const satisfies Record<string, { description: string; guidelines?: readonly string[] }>;

const MAX_TASK_BYTES = 50 * 1024;
/** Width the active-jobs widget can show; longer descriptions are truncated, never rejected. */
const MAX_DESCRIPTION_LENGTH = 60;
/** Schema bound only to stop a runaway string; the display limit does the real work. */
const MAX_DESCRIPTION_INPUT_LENGTH = 1_000;
const MAX_SKILL_ARGS_BYTES = 50 * 1024;
const MAX_TOOLS = 64;
const CHILD_CORE_TOOL_SET = new Set<string>(CHILD_CORE_TOOL_NAMES);
const THINKING_LEVEL_SET = new Set<string>(SUBAGENT_THINKING_LEVELS);

/** Shared by spawn and skill_run: the budget means the same thing for both. */
const MaxTurnsParameter = Type.Optional(
	Type.Integer({
		minimum: 1,
		description: `Turn budget: model responses the child may take before it is asked to stop exploring and report. Defaults to ${DEFAULT_MAX_TURNS}. Raise it for a genuinely wide survey, lower it for a focused lookup.`,
	}),
);

/**
 * Spawn's schema is built per registration so the `agent` parameter can carry the
 * roster of available agent names. That roster is the only agent information the
 * main session sees by default; bodies stay on disk until a job selects one.
 */
function buildSpawnParameters(agents: AgentRegistry) {
	return Type.Object(
		{
			task: Type.String({
				description: "Self-contained task, constraints, and expected result. Maximum 50 KiB.",
				maxLength: MAX_TASK_BYTES,
			}),
			description: Type.String({
				description:
					'Short label for this job, shown in the active-jobs widget while it runs. Say what the job is doing, in a few words: "review auth middleware diff". Anything past 60 characters is truncated for display.',
				maxLength: MAX_DESCRIPTION_INPUT_LENGTH,
			}),
			agent: Type.Optional(
				Type.String({
					description: agentParameterDescription(agents),
					maxLength: MAX_IDENTIFIER_LENGTH,
				}),
			),
			background: Type.Optional(
				Type.Boolean({
					description:
						"Run without blocking and interrupt the main agent with the completion when the job ends. Defaults to false, where the caller collects the result with subagent_wait.",
				}),
			),
			tools: Type.Optional(
				Type.Array(
					StringEnum(CHILD_CORE_TOOL_NAMES, {
						description: "Available Pi core child work tool name.",
					}),
					{
						description:
							"Child work tools. Defaults to read, grep, find, and ls. Communication tools are always added.",
						maxItems: MAX_TOOLS,
					},
				),
			),
			thinkingLevel: Type.Optional(
				StringEnum(SUBAGENT_THINKING_LEVELS, {
					description:
						"Child thinking level. Omit it: the child inherits this session's effective level, which is almost always right. Set it only to deliberately spend less thinking on a mechanical job or more on a hard one.",
				}),
			),
			maxTurns: MaxTurnsParameter,
		},
		{ additionalProperties: false },
	);
}

/**
 * Describe the loaded agents inline, so selecting one needs no extra tool call.
 * A `role: main` definition describes this session and is not offered as a child.
 */
function agentParameterDescription(agents: AgentRegistry): string {
	const roster = agents
		.listPrimary()
		.filter((definition) => definition.role !== "main")
		.map((definition) => `${definition.name} (${definition.description})`)
		.join("; ");
	const base =
		"Agent definition name. Its instructions become the child's system prompt and supply default tools, model, and thinking level.";
	return roster ? `${base} Available: ${roster}.` : base;
}

const InspectParameters = Type.Object({}, { additionalProperties: false });

const CancelParameters = Type.Object(
	{
		jobId: Type.String({
			description: "Job ID returned by subagent_spawn.",
			maxLength: MAX_IDENTIFIER_LENGTH,
		}),
	},
	{ additionalProperties: false },
);

const WaitParameters = Type.Object(
	{
		jobId: Type.String({ description: "Job to wait for.", maxLength: MAX_IDENTIFIER_LENGTH }),
		timeout: Type.Optional(
			Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
		),
	},
	{ additionalProperties: false },
);

type WaitArguments = Static<typeof WaitParameters>;

export interface SubagentToolsDependencies extends RuntimeDependencies {
	agents?: AgentRegistry;
	skills?: SkillRegistry;
	/** Injectable for tests; defaults to reading the user's instruction file. */
	instructions?: InstructionOverrides;
}

export interface RegisteredSubagentTools {
	runtime: SubagentRuntime;
	agents: AgentRegistry;
	skills: SkillRegistry;
	startSession(): Promise<void>;
	shutdown(): Promise<void>;
}

export function registerSubagentTools(
	pi: ExtensionAPI,
	dependencies: SubagentToolsDependencies = {},
): RegisteredSubagentTools {
	const runtime = new SubagentRuntime(pi, dependencies);
	const agents = dependencies.agents ?? new AgentRegistry();
	const skills = dependencies.skills ?? new SkillRegistry();
	const overrides = dependencies.instructions ?? loadInstructionOverrides();
	// Text is resolved once at registration: Pi reads descriptions and guidelines
	// when it builds the system prompt, so a later edit takes effect next session.
	const instruction = (name: keyof typeof BUILTIN_INSTRUCTIONS) => {
		const builtin = BUILTIN_INSTRUCTIONS[name];
		const guidelines = "guidelines" in builtin ? [...builtin.guidelines] : undefined;
		return applyOverride(overrides, name, { description: builtin.description, guidelines });
	};
	let lifecycle = Promise.resolve();

	const spawnInstruction = instruction("subagent_spawn");
	pi.registerTool({
		name: "subagent_spawn",
		label: "Subagent · Spawn",
		description: spawnInstruction.description,
		promptSnippet: "Use subagent_spawn to start one Pi subagent job",
		promptGuidelines: spawnInstruction.guidelines,
		parameters: buildSpawnParameters(agents),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			throwIfAborted(signal, "Subagent spawn was cancelled");
			assertNotNested();
			const task = validateTask(params.task, "subagent_spawn");
			const description = validateDescription(params.description);
			const agent = params.agent === undefined ? undefined : requireAgent(agents, params.agent);
			// Explicit arguments always win over the agent definition's defaults.
			const tools =
				params.tools !== undefined
					? resolveTools(params.tools)
					: (agent?.tools ?? [...DEFAULT_SUBAGENT_TOOLS]);
			const inherited = resolveChildModel(ctx);
			const selected = agent
				? resolveAgentModel(agent.model, modelLookup(ctx))
				: { model: undefined, limitation: undefined };
			const thinkingLevel = resolveThinkingLevel(
				params.thinkingLevel ?? agent?.thinkingLevel ?? ctx.thinkingLevel ?? pi.getThinkingLevel(),
			);
			const maxTurns = resolveMaxTurns(params.maxTurns ?? DEFAULT_MAX_TURNS);
			return toolResult(
				runtime.start({
					task,
					tools,
					model: selected.model ?? inherited,
					description,
					...(agent ? { agent: agent.name, systemPrompt: agent.body } : {}),
					...(selected.limitation ? { limitations: [selected.limitation] } : {}),
					thinkingLevel,
					cwd: ctx.cwd,
					maxTurns,
					projectTrusted: ctx.isProjectTrusted(),
					notifyOnCompletion: params.background === true,
				}),
			);
		},
	});

	pi.registerTool({
		name: "skill_run",
		label: "Subagent · Skill",
		description: instruction("skill_run").description,
		promptSnippet: "Use skill_run to execute one skill inside a subagent",
		parameters: buildSkillRunParameters(skills),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			throwIfAborted(signal, "Skill run was cancelled");
			assertNotNested();
			const skill = requireSkill(skills, params.name);
			const description = validateDescription(params.description);
			const args = params.args === undefined ? undefined : validateSkillArgs(params.args);
			// Explicit arguments always win over the skill's declared defaults.
			const tools = params.tools !== undefined ? resolveTools(params.tools) : skillTools(skill);
			const inherited = resolveChildModel(ctx);
			const selected = resolveAgentModel(skill.model, modelLookup(ctx));
			const thinkingLevel = resolveThinkingLevel(
				params.thinkingLevel ?? skill.thinkingLevel ?? ctx.thinkingLevel ?? pi.getThinkingLevel(),
			);
			const maxTurns = resolveMaxTurns(params.maxTurns ?? DEFAULT_MAX_TURNS);
			const limitations = [
				...(selected.limitation ? [selected.limitation] : []),
				...skillToolLimitations(skill, params.tools !== undefined),
			];
			return toolResult(
				runtime.start({
					task: buildSkillTask(skill, args),
					tools,
					model: selected.model ?? inherited,
					agent: `skill:${skill.name}`,
					description,
					systemPrompt: buildSkillSystemPrompt(skill),
					...(limitations.length > 0 ? { limitations } : {}),
					thinkingLevel,
					cwd: ctx.cwd,
					maxTurns,
					projectTrusted: ctx.isProjectTrusted(),
					notifyOnCompletion: params.background === true,
				}),
			);
		},
	});

	pi.registerTool({
		name: "subagent_inspect",
		label: "Subagent · Inspect",
		description: instruction("subagent_inspect").description,
		promptSnippet: "Use subagent_inspect to inspect retained subagent jobs",
		parameters: InspectParameters,
		async execute(_toolCallId, _params, signal) {
			throwIfAborted(signal, "Subagent inspection was cancelled");
			const jobs = runtime.inspectJobs();
			return toolResult({ jobs: jobs.jobs, omitted: { jobs: jobs.omitted } });
		},
	});

	pi.registerTool({
		name: "subagent_cancel",
		label: "Subagent · Cancel",
		description: instruction("subagent_cancel").description,
		promptSnippet: "Use subagent_cancel to cancel one active subagent job",
		parameters: CancelParameters,
		async execute(_toolCallId, params, signal) {
			throwIfAborted(signal, "Subagent cancellation was cancelled");
			return toolResult(await runtime.cancel(requiredIdentifier(params.jobId, "jobId")));
		},
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Subagent · Wait",
		description: instruction("subagent_wait").description,
		promptSnippet: "Use subagent_wait to wait for one subagent job or incoming message",
		parameters: WaitParameters,
		prepareArguments: prepareWaitArguments,
		async execute(_toolCallId, params, signal) {
			const timeoutMs = resolveTimeoutMs(params.timeout);
			return toolResult(
				await runtime.wait(requiredIdentifier(params.jobId, "jobId"), timeoutMs, signal),
			);
		},
	});

	const queueLifecycle = (operation: () => Promise<void>): Promise<void> => {
		const work = lifecycle.then(operation, operation);
		lifecycle = work.catch(() => undefined);
		return work;
	};

	return {
		runtime,
		agents,
		skills,
		startSession: () =>
			queueLifecycle(async () => {
				await runtime.shutdown();
				runtime.beginSession();
			}),
		shutdown: () =>
			queueLifecycle(async () => {
				await runtime.shutdown();
			}),
	};
}

function validateTask(value: string, toolName: string): string {
	const task = requiredString(value, "task");
	if (task.includes("\0")) throw new Error(`${toolName} task must not contain NUL bytes.`);
	if (Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES) {
		throw new Error(`${toolName} task must be at most ${MAX_TASK_BYTES} UTF-8 bytes.`);
	}
	return task;
}

/**
 * An over-long description is a display problem, not a caller error, so it is
 * truncated rather than rejected; a rejection would cost the main agent a turn.
 */
function validateDescription(value: string): string {
	const description = requiredString(value, "description").replace(/\s+/gu, " ").trim();
	return description.length > MAX_DESCRIPTION_LENGTH
		? `${description.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd()}…`
		: description;
}

function resolveTools(value: unknown): string[] {
	if (value === undefined) return [...DEFAULT_SUBAGENT_TOOLS];
	if (!Array.isArray(value) || value.length > MAX_TOOLS) {
		throw new Error(`Subagent tools must be an array of at most ${MAX_TOOLS} names.`);
	}
	const tools: string[] = [];
	for (const candidate of value) {
		if (typeof candidate !== "string") throw new Error("Subagent tool names must be strings.");
		const name = candidate.trim();
		if (!CHILD_CORE_TOOL_SET.has(name)) {
			throw new Error(
				`Unavailable subagent tool: ${sanitizeTerminalText(name).slice(0, 128) || "(empty)"}. Available: ${CHILD_CORE_TOOL_NAMES.join(", ")}.`,
			);
		}
		if (!tools.includes(name)) tools.push(name);
	}
	return tools;
}

function resolveChildModel(ctx: ExtensionContext): string {
	const model = ctx.model;
	if (!model)
		throw new Error("Subagent model is unavailable because no main-agent model is selected.");
	const provider = sanitizeTerminalText(model.provider).slice(0, 128);
	if (isExtensionProvider(ctx, model.provider)) {
		throw new Error(
			`Subagent model provider ${provider} is unavailable because children disable parent extensions.`,
		);
	}
	if (usesRuntimeCredentials(ctx, model.provider)) {
		throw new Error(
			`Subagent model provider ${provider} uses a process-local runtime API key. Configure stored or environment credentials that child processes can read.`,
		);
	}
	return `${model.provider}/${model.id}`;
}

/**
 * Whether a provider is usable from a child process. Children run with
 * `--no-extensions` and their own credential lookup, so the same two rules that
 * guard the inherited model also decide whether an agent's model can be honoured.
 */
function isChildUsableProvider(ctx: ExtensionContext, provider: string): boolean {
	return !isExtensionProvider(ctx, provider) && !usesRuntimeCredentials(ctx, provider);
}

function isExtensionProvider(ctx: ExtensionContext, provider: string): boolean {
	return ctx.modelRegistry.getRegisteredProviderIds().includes(provider);
}

function usesRuntimeCredentials(ctx: ExtensionContext, provider: string): boolean {
	return ctx.modelRegistry.getProviderAuthStatus(provider).source === "runtime";
}

function modelLookup(ctx: ExtensionContext): ModelCandidateLookup {
	return {
		isUsable(provider, modelId) {
			if (!isChildUsableProvider(ctx, provider)) return false;
			const model = ctx.modelRegistry.find(provider, modelId);
			// A registered model without credentials would fail on the child's first request.
			return model !== undefined && ctx.modelRegistry.hasConfiguredAuth(model);
		},
	};
}

function requireAgent(agents: AgentRegistry, requested: string): AgentDefinition {
	const agent = agents.find(requested);
	if (agent?.role === "main") {
		throw new Error(
			`Agent ${agent.name} has role: main; it describes the main session and cannot run as a child.`,
		);
	}
	if (agent) return agent;
	const known = agents.knownNames();
	const available = known.length > 0 ? known.join(", ") : "none";
	throw new Error(
		`Unknown subagent agent: ${sanitizeTerminalText(requested).slice(0, 128) || "(empty)"}. Available: ${available}.`,
	);
}

/**
 * `skill_run`'s schema is built per registration so the `name` parameter can
 * carry the roster of primary-tier skills, the same way spawn carries agents.
 */
function buildSkillRunParameters(skills: SkillRegistry) {
	return Type.Object(
		{
			name: Type.String({
				description: skillParameterDescription(skills),
				maxLength: MAX_IDENTIFIER_LENGTH,
			}),
			description: Type.String({
				description:
					'Short label for this job, shown in the active-jobs widget while it runs. Say what the job is doing, in a few words: "review auth middleware diff". Anything past 60 characters is truncated for display.',
				maxLength: MAX_DESCRIPTION_INPUT_LENGTH,
			}),
			args: Type.Optional(
				Type.String({
					description:
						"The user's request for this skill, in their own words, plus any context the skill needs. The child cannot see this conversation, so state the objective in full. Maximum 50 KiB.",
					maxLength: MAX_SKILL_ARGS_BYTES,
				}),
			),
			background: Type.Optional(
				Type.Boolean({
					description:
						"Run without blocking and interrupt the main agent with the completion when the job ends. Defaults to false, where the caller collects the result with subagent_wait.",
				}),
			),
			tools: Type.Optional(
				Type.Array(
					StringEnum(CHILD_CORE_TOOL_NAMES, {
						description: "Available Pi core child work tool name.",
					}),
					{
						description:
							"Override the child's work tools. Defaults to the skill's own allowed-tools, or to read, grep, find, and ls when it declares none.",
						maxItems: MAX_TOOLS,
					},
				),
			),
			thinkingLevel: Type.Optional(
				StringEnum(SUBAGENT_THINKING_LEVELS, {
					description: "Child thinking level. Defaults to the skill's, then the main agent's.",
				}),
			),
			maxTurns: MaxTurnsParameter,
		},
		{ additionalProperties: false },
	);
}

/** Describe the loaded skills inline, so selecting one needs no extra tool call. */
function skillParameterDescription(skills: SkillRegistry): string {
	const roster = skills
		.listPrimary()
		.map((definition) => `${definition.name} (${definition.description})`)
		.join("; ");
	const base =
		"Skill name. Its SKILL.md becomes the child's system prompt and supplies default tools, model, and thinking level. A skill installed outside the advertised set can still be named directly.";
	return roster ? `${base} Available: ${roster}.` : base;
}

function requireSkill(skills: SkillRegistry, requested: string): SkillDefinition {
	const name = requiredString(requested, "name");
	const skill = skills.find(name);
	if (skill) return skill;
	const known = skills.knownNames();
	const available = known.length > 0 ? known.join(", ") : "none";
	throw new Error(
		`Unknown skill: ${sanitizeTerminalText(name).slice(0, 128) || "(empty)"}. Available: ${available}.`,
	);
}

function validateSkillArgs(value: string): string {
	const args = requiredString(value, "args");
	if (args.includes("\0")) throw new Error("skill_run args must not contain NUL bytes.");
	if (Buffer.byteLength(args, "utf8") > MAX_SKILL_ARGS_BYTES) {
		throw new Error(`skill_run args must be at most ${MAX_SKILL_ARGS_BYTES} UTF-8 bytes.`);
	}
	return args;
}

/**
 * A skill that declares an empty or entirely unsupported `allowed-tools` would
 * otherwise start a child with no way to read its own reference files, so the
 * read-only default stands in unless the skill named at least one usable tool.
 */
function skillTools(skill: SkillDefinition): string[] {
	return skill.tools.length > 0 ? [...skill.tools] : [...DEFAULT_SUBAGENT_TOOLS];
}

/**
 * Report tool requests that could not be honoured. These are recorded as job
 * limitations rather than raised as errors, because a skill written for another
 * harness routinely names tools Pi children do not have, and the rest of the
 * skill usually still runs.
 */
function skillToolLimitations(skill: SkillDefinition, overridden: boolean): string[] {
	if (overridden || skill.unsupportedTools.length === 0) return [];
	return [
		`Skill ${skill.name} requests tools unavailable to Pi subagents: ${skill.unsupportedTools.join(", ")}. They were dropped.`,
	];
}

/**
 * The child receives the skill body as its system prompt, matching how an agent
 * definition specializes a child. The location lines matter because a child runs
 * with `--no-skills`: nothing else tells it where its own scripts and references
 * live, and relative paths in the body would otherwise resolve against the cwd.
 */
function buildSkillSystemPrompt(skill: SkillDefinition): string {
	return [
		`You are executing the "${skill.name}" skill as a subagent.`,
		`The skill directory is ${skill.baseDir}.`,
		"Resolve every relative path in the instructions below against that directory and use the absolute path in tool calls.",
		"",
		skill.body,
	].join("\n");
}

/**
 * The task text carries only the caller's request. Keeping it separate from the
 * system prompt preserves the skill-instructions / user-request boundary the
 * skill was written against.
 */
function buildSkillTask(skill: SkillDefinition, args: string | undefined): string {
	if (!args) {
		return `Carry out the ${skill.name} skill as specified in your system prompt, and report the result.`;
	}
	return [
		"Carry out your skill instructions for the following request, and report the result.",
		"",
		"Request:",
		args,
	].join("\n");
}

function resolveThinkingLevel(value: unknown): SubagentThinkingLevel {
	if (typeof value !== "string" || !THINKING_LEVEL_SET.has(value)) {
		throw new Error("Subagent thinkingLevel is invalid.");
	}
	return value as SubagentThinkingLevel;
}

function prepareWaitArguments(args: unknown): WaitArguments {
	return prepareTimeoutArguments(args) as WaitArguments;
}

function prepareTimeoutArguments(args: unknown): Record<string, unknown> {
	if (!args || typeof args !== "object") return args as Record<string, unknown>;
	if (!Object.hasOwn(args, "timeoutMs")) return args as Record<string, unknown>;
	const record = args as Record<string, unknown>;
	if (typeof record.timeoutMs !== "number") return record;
	const { timeoutMs, ...prepared } = record;
	if (prepared.timeout === undefined) return { ...prepared, timeout: timeoutMs / 1000 };
	return prepared;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`Subagent ${field} is required.`);
	return value.trim();
}

function requiredIdentifier(value: unknown, field: string): string {
	const identifier = requiredString(value, field);
	if (
		identifier.length > MAX_IDENTIFIER_LENGTH ||
		[...identifier].some((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
		})
	) {
		throw new Error(`Subagent ${field} is invalid.`);
	}
	return identifier;
}

function assertNotNested(): void {
	if ((Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0) > 0) {
		throw new Error("Nested subagents are not supported by pi-subagents.");
	}
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
	if (signal?.aborted) throw abortError(message);
}

function abortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function toolResult<T>(value: T): {
	content: Array<{ type: "text"; text: string }>;
	details: T;
} {
	return {
		content: [{ type: "text", text: modelVisibleJson(value, { indent: 2 }) }],
		details: value,
	};
}
