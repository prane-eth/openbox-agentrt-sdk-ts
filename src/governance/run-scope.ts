// runScope — brackets one governed run.
//
// Emission order (load-bearing): WorkflowStarted (telemetry, creates the session)
// -> SignalReceived (ENFORCE) -> pre-screen ActivityStarted (ENFORCE) -> body ->
// WorkflowCompleted. WorkflowCompleted is skipped when a gate already closed the
// workflow; a body failure closes it with WorkflowFailed. An allowed pre-screen
// row that no model call consumed, and any row a deadline/abort abandoned, are
// closed before the workflow is.

import { toErrorInfo } from "../error-info.js";
import {
  buildActivityStarted,
  buildSignalReceived,
  buildWorkflowCompleted,
  buildWorkflowStarted
} from "../lifecycle-events.js";
import { toJsonSafe } from "../serialization.js";
import { coerceRedactedText } from "../message-extraction.js";
import {
  closeLlmActivity,
  closeOpenActivities,
  closeUnusedPreScreen,
  closeWorkflow,
  enforceGate,
  identityFor,
  openActivity,
  sendTelemetry,
  type GovernanceContext
} from "./context.js";
import { mintRunState, runWithState, type RunState } from "./run-state.js";

export async function runScope<T>(
  ctx: GovernanceContext,
  prompt: string,
  body: (run: RunState) => Promise<T>
): Promise<T> {
  const run = mintRunState(ctx.options.taskQueue);
  return runWithState(run, async () => {
    try {
      if (ctx.options.sendRunStartEvent) {
        await sendTelemetry(ctx, buildWorkflowStarted(identityFor(ctx, run)));
      }

      if (prompt.trim().length > 0) {
        await enforceGate(
          ctx,
          run,
          buildSignalReceived({
            ...identityFor(ctx, run),
            signalName: "user_prompt",
            extra: { signal_args: [prompt] }
          })
        );

        if (ctx.options.sendLlmStartEvent) {
          const activityId = `${run.runId}-pre`;
          openActivity(run, activityId, "llm_call");
          const result = await enforceGate(
            ctx,
            run,
            buildActivityStarted({
              ...identityFor(ctx, run),
              activityId,
              activityType: "llm_call",
              activityInput: [{ prompt }]
            }),
            (error) => closeLlmActivity(ctx, run, activityId, error)
          );
          run.preScreen = {
            activityId,
            prompt,
            redactedInput: coerceRedactedText(result.guardrails?.redactedInput)
          };
        }
      }

      const value = await body(run);

      await closeUnusedPreScreen(ctx, run);
      await closeOpenActivities(ctx, run);
      if (!run.workflowClosed && ctx.options.sendRunEndEvent) {
        run.workflowClosed = true;
        await sendTelemetry(
          ctx,
          buildWorkflowCompleted({
            ...identityFor(ctx, run),
            extra: {
              status: "completed",
              workflow_output: toJsonSafe(run.output)
            }
          })
        );
      }
      return value;
    } catch (error) {
      const info = toErrorInfo(error);
      await closeUnusedPreScreen(ctx, run, info);
      await closeOpenActivities(ctx, run, info);
      await closeWorkflow(ctx, run, info);
      throw error;
    }
  });
}
