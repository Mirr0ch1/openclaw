import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";

/** Keep both compaction hooks on the same narrow context, not the full attempt. */
export function buildCodexCompactionHookContext(params: EmbeddedRunAttemptParamsV2) {
  return {
    runId: params.runId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    messageProvider: params.messageProvider ?? undefined,
    trigger: params.trigger,
    channelId: params.messageChannel ?? params.messageProvider ?? undefined,
  };
}
