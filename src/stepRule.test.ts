import { describe, expect, it } from "vitest";
import { STEP_RULE } from "./baseLessons";
import { SESSION_DISPLAY } from "./claude";
import { GLOBAL_ACTION_DOCS, taskChatPrompt } from "./openInClaude";
import { adhocPrompt, planPrompt, recheckStepsPrompt } from "./prompts";

describe("one rule for how long a step is", () => {
  it("is given wherever steps are written", () => {
    const prompts = [
      planPrompt({ title: "x", description: null, link: null, requester: null, source: "Slack", userId: null }),
      // The assessment's claude_steps.
      adhocPrompt({ userId: "U1", previous: [], previousReplies: [], projectChannels: [], lastRefreshedAt: null, now: new Date(2026, 10, 4), index: [] }),
      // A task chat restating its plan, and every session's plan block.
      taskChatPrompt({ id: "manual:a", title: "x" }, "", [{ title: "Draft the Jira ticket", by: "claude" }]),
      SESSION_DISPLAY,
      // The Demian chat's set_task_plan.
      GLOBAL_ACTION_DOCS,
      recheckStepsPrompt({ task: "x", steps: [{ title: "Draft the Jira ticket", by: "claude", state: "todo" }], conversation: [] }),
    ];
    for (const p of prompts) expect(p).toContain(STEP_RULE);
  });
});
