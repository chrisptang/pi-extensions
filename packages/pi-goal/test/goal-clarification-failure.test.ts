import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { registerGoalCommand } from "../src/command-registration.js";
import { GoalCommandController } from "../src/commands.js";
import { GoalRuntime } from "../src/runtime.js";

for (const failure of ["prompt", "kickoff", "tool-policy", "workflow"]) {
	test(`clarification handles ${failure} failure without leaving a new active Goal`, async () => {
		const mock = createMockPi({ activeTools: ["goal_confirm", "goal_complete", "goal_blocked"] });
		const runtime = new GoalRuntime(mock.pi);
		registerGoalCommand(mock.pi, runtime, new GoalCommandController(runtime));
		const context = createMockContext({ mode: "tui" });
		const command = mock.commands.get("goal");
		const tool = mock.tools.find((tool) => tool.name === "goal_confirm");
		assert.ok(command && tool);
		if (failure === "prompt") {
			mock.rawPi.sendMessage = () => {
				throw new Error("prompt rejected");
			};
			await assert.rejects(async () => command.handler("draft", context.ctx), /prompt rejected/);
			assert.equal(runtime.cancelClarification, undefined);
		} else {
			await command.handler("draft", context.ctx);
			if (failure === "kickoff")
				mock.rawPi.sendUserMessage = () => {
					throw new Error("kickoff rejected");
				};
			if (failure === "tool-policy") mock.rawPi.setActiveTools(["goal_confirm"]);
			if (failure === "workflow")
				mock.eventBus.on("workflow:mutex:v1", (value) => {
					(value as { busy: boolean }).busy = true;
				});
			const message = mock.sentMessages.at(-1)?.message as { content: string };
			await assert.rejects(
				(tool.execute as (...args: unknown[]) => Promise<unknown>)(
					"confirm",
					{
						request_id: /Request ID: (\S+)/.exec(message.content)?.[1],
						objective: "approved objective",
					},
					undefined,
					undefined,
					context.ctx,
				),
				/activation failed/,
			);
		}
		assert.equal(runtime.activeGoal, undefined);
		assert.equal(mock.sentUserMessages.length, 0);
		const attempt = {
			session: (context.ctx as { sessionManager: object }).sessionManager,
			group: "agent-workflow",
			busy: false,
		};
		// Exclude the deliberately installed competing workflow observer.
		if (failure !== "workflow") {
			mock.eventBus.emit("workflow:mutex:v1", attempt);
			assert.equal(attempt.busy, false);
		}
	});
}
