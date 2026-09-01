import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { WizardSession } from "../../wizard/session.js";
import { createAdmittedWizardSession, respondSetupAdmissionBusy } from "./setup-admission.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

type WizardRunner = ConstructorParameters<typeof WizardSession>[0];

/** Admit, register, and acknowledge one remote wizard before its first interactive step. */
export async function startGatewayWizardSession(params: {
  context: GatewayRequestContext;
  respond: RespondFn;
  sessionId: string;
  timeoutMs: number;
  run: WizardRunner;
}): Promise<WizardSession | null> {
  if (params.context.wizardSessions.has(params.sessionId)) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "wizard session already exists"),
    );
    return null;
  }
  const session = await createAdmittedWizardSession(
    () => new WizardSession(params.run, { timeoutMs: params.timeoutMs }),
  );
  if (!session) {
    respondSetupAdmissionBusy(params.respond);
    return null;
  }
  params.context.wizardSessions.set(params.sessionId, session);
  params.respond(true, { sessionId: params.sessionId, done: false, status: "running" }, undefined);
  return session;
}
