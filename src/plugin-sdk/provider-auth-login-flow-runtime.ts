import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../packages/normalization-core/src/string-coerce.js";
import type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
} from "../commands/models/auth.js";
import {
  listProviderChannelLoginChoices,
  resolveProviderChannelLoginChoice,
  type ProviderChannelLoginChoice,
} from "../plugins/provider-login-options.js";
import { createLazyRuntimeMethodBinder, createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { OpenClawConfig } from "./config-contracts.js";
import type { RuntimeEnv } from "./runtime-env.js";

export type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
} from "../commands/models/auth.js";
export type { ProviderChannelLoginChoice } from "../plugins/provider-login-options.js";

type ProviderAuthLoginFlowRuntime = typeof import("../commands/models/auth.js");
type RunModelsAuthLoginFlow = (opts: ModelsAuthLoginFlowOptions) => Promise<unknown>;

const CODEX_LOGIN_PROVIDER = "openai";
const CODEX_LOGIN_METHOD = "device-code";
const CODEX_LOGIN_PROVIDER_ALIASES = new Set(["codex", "openai"]);

export type ProviderLoginSessionEntry = {
  sessionId: string;
  providerOverride?: string;
  modelProvider?: string;
  authProfileOverride?: string;
  authProfileOverrideSource?: "auto" | "user";
  authProfileOverrideCompactionCount?: number;
};

export type ProviderLoginSessionAdoption =
  | { status: "unchanged" }
  | {
      status: "patch";
      patch: {
        authProfileOverride: string;
        authProfileOverrideSource: "user";
        authProfileOverrideCompactionCount: undefined;
      };
    }
  | { status: "rejected" };

const PROVIDER_LOGIN_FLOW_TTL_MS = 15 * 60_000;

type ProviderLoginFlowRecord = {
  expiresAt: number;
  signal: AbortSignal;
  cancel: () => void;
};

type ProviderLoginFlowReservation =
  | { status: "active" }
  | { status: "reserved"; record: ProviderLoginFlowRecord };

function createProviderLoginFlowRegistry(): Map<string, ProviderLoginFlowRecord> {
  return new Map();
}

const loadProviderAuthLoginFlowRuntime = createLazyRuntimeModule(
  () => import("../commands/models/auth.js"),
);
const bindProviderAuthLoginFlowRuntime = createLazyRuntimeMethodBinder(
  loadProviderAuthLoginFlowRuntime,
);

export const runModelsAuthLoginFlow: ProviderAuthLoginFlowRuntime["runModelsAuthLoginFlowCore"] =
  bindProviderAuthLoginFlowRuntime((runtime) => runtime.runModelsAuthLoginFlowCore);

function resolveCodexLoginProvider(rawProvider: string | undefined): string | null {
  const normalized = normalizeLowercaseStringOrEmpty(rawProvider ?? "codex").replace(/_/gu, "-");
  if (!normalized) {
    return CODEX_LOGIN_PROVIDER;
  }
  return CODEX_LOGIN_PROVIDER_ALIASES.has(normalized) ? CODEX_LOGIN_PROVIDER : null;
}

function resolveProviderScopedProfileId(
  authProfileOverride: string | undefined,
  provider: string,
): string | undefined {
  const profileId = normalizeOptionalString(authProfileOverride);
  if (!profileId) {
    return undefined;
  }
  const providerPrefix = `${normalizeLowercaseStringOrEmpty(provider)}:`;
  return normalizeLowercaseStringOrEmpty(profileId).startsWith(providerPrefix)
    ? profileId
    : undefined;
}

function hasConfiguredCommandOwnerAllowlist(cfg: OpenClawConfig): boolean {
  const owners = cfg.commands?.ownerAllowFrom;
  return Array.isArray(owners) && owners.some((owner) => normalizeOptionalString(String(owner)));
}

function matchesLoginSnapshot(
  current: ProviderLoginSessionEntry,
  snapshot: ProviderLoginSessionEntry,
): boolean {
  return (
    current.sessionId === snapshot.sessionId &&
    current.authProfileOverride === snapshot.authProfileOverride &&
    current.authProfileOverrideSource === snapshot.authProfileOverrideSource &&
    current.authProfileOverrideCompactionCount === snapshot.authProfileOverrideCompactionCount
  );
}

function resolvePersistedModelProvider(entry: ProviderLoginSessionEntry): string | undefined {
  const provider = normalizeLowercaseStringOrEmpty(entry.providerOverride ?? entry.modelProvider);
  return provider || undefined;
}

/** Decide one session-profile adoption from the authoritative row read immediately before write. */
export function decideProviderLoginSessionAdoption(params: {
  currentModelProvider: string | undefined;
  loginProvider: string;
  nextProfileId: string | undefined;
  snapshot: ProviderLoginSessionEntry | undefined;
  current: ProviderLoginSessionEntry | undefined;
}): ProviderLoginSessionAdoption {
  if (!params.nextProfileId) {
    return { status: "rejected" };
  }
  if (
    !params.currentModelProvider ||
    normalizeLowercaseStringOrEmpty(params.currentModelProvider) !==
      normalizeLowercaseStringOrEmpty(params.loginProvider) ||
    !params.current
  ) {
    return { status: "unchanged" };
  }
  const currentProvider = resolvePersistedModelProvider(params.current);
  const snapshotProvider = params.snapshot
    ? resolvePersistedModelProvider(params.snapshot)
    : undefined;
  if (
    (currentProvider &&
      currentProvider !== normalizeLowercaseStringOrEmpty(params.loginProvider)) ||
    (params.snapshot && currentProvider !== snapshotProvider)
  ) {
    return { status: "unchanged" };
  }
  if (params.snapshot) {
    if (!matchesLoginSnapshot(params.current, params.snapshot)) {
      return { status: "rejected" };
    }
  } else {
    const source =
      params.current.authProfileOverrideSource ??
      (typeof params.current.authProfileOverrideCompactionCount === "number"
        ? "auto"
        : params.current.authProfileOverride
          ? "user"
          : undefined);
    if (source === "user" && params.current.authProfileOverride !== params.nextProfileId) {
      return { status: "rejected" };
    }
  }
  const needsPatch =
    params.current.authProfileOverride !== params.nextProfileId ||
    params.current.authProfileOverrideSource !== "user" ||
    params.current.authProfileOverrideCompactionCount !== undefined;
  return needsPatch
    ? {
        status: "patch",
        patch: {
          authProfileOverride: params.nextProfileId,
          authProfileOverrideSource: "user",
          authProfileOverrideCompactionCount: undefined,
        },
      }
    : { status: "unchanged" };
}

function reserveProviderLoginFlow(params: {
  flows: Map<string, ProviderLoginFlowRecord>;
  flowKey: string;
  now?: number;
  replacementMessage?: string;
}): ProviderLoginFlowReservation {
  const now = params.now ?? Date.now();
  const activeFlow = params.flows.get(params.flowKey);
  if (activeFlow && activeFlow.expiresAt > now) {
    return { status: "active" };
  }
  if (activeFlow) {
    activeFlow.cancel();
    params.flows.delete(params.flowKey);
  }
  const abortController = new AbortController();
  const record = {
    expiresAt: now + PROVIDER_LOGIN_FLOW_TTL_MS,
    signal: abortController.signal,
    cancel: () =>
      abortController.abort(
        new Error(params.replacementMessage ?? "Provider login was replaced by a newer flow."),
      ),
  };
  params.flows.set(params.flowKey, record);
  return { status: "reserved", record };
}

function reserveCodexLoginFlow(params: {
  flows: Map<string, ProviderLoginFlowRecord>;
  flowKey: string;
  now?: number;
}): ProviderLoginFlowReservation {
  return reserveProviderLoginFlow({
    ...params,
    replacementMessage: "Codex login was replaced by a newer flow.",
  });
}

function releaseProviderLoginFlow(params: {
  flows: Map<string, ProviderLoginFlowRecord>;
  flowKey: string;
  record: ProviderLoginFlowRecord;
}): void {
  if (params.flows.get(params.flowKey) === params.record) {
    params.flows.delete(params.flowKey);
  }
}

function buildProviderChannelLoginPrompter(params: {
  sendMessage: (message: string) => Promise<void>;
  sendDeviceCode?: NonNullable<ModelsAuthLoginFlowOptions["prompter"]["deviceCode"]>;
  signal?: AbortSignal;
  unsupportedPromptMessage: string;
}): ModelsAuthLoginFlowOptions["prompter"] {
  const sendCleanMessage = async (message: string) => {
    params.signal?.throwIfAborted();
    const text = message.trim();
    if (text) {
      await params.sendMessage(text);
      params.signal?.throwIfAborted();
    }
  };
  const sendDeviceCode = params.sendDeviceCode;
  const unsupportedPrompt = async () => {
    await sendCleanMessage(params.unsupportedPromptMessage);
    throw new Error(params.unsupportedPromptMessage);
  };
  return {
    intro: async () => {},
    outro: async () => {},
    note: async (message, title) => {
      await sendCleanMessage([title?.trim(), message.trim()].filter(Boolean).join("\n\n"));
    },
    ...(sendDeviceCode
      ? {
          deviceCode: async (deviceCode) => {
            params.signal?.throwIfAborted();
            await sendDeviceCode(deviceCode);
            params.signal?.throwIfAborted();
          },
        }
      : {}),
    plain: sendCleanMessage,
    select: unsupportedPrompt as ModelsAuthLoginFlowOptions["prompter"]["select"],
    multiselect: unsupportedPrompt as ModelsAuthLoginFlowOptions["prompter"]["multiselect"],
    text: unsupportedPrompt as ModelsAuthLoginFlowOptions["prompter"]["text"],
    confirm: unsupportedPrompt as ModelsAuthLoginFlowOptions["prompter"]["confirm"],
    progress: () => ({
      update: () => {},
      stop: () => {},
    }),
  };
}

function parseModelsAuthLoginFlowResult(value: unknown): ModelsAuthLoginFlowResult {
  if (!value || typeof value !== "object") {
    throw new Error("Provider login returned an invalid result.");
  }
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.profiles)) {
    throw new Error("Provider login returned an invalid result.");
  }
  const parseRequiredString = (input: unknown, label: string): string => {
    if (typeof input !== "string" || !input.trim()) {
      throw new Error(`Provider login returned an invalid ${label}.`);
    }
    return input.trim();
  };
  const providerId = parseRequiredString(result.providerId, "provider id");
  const methodId = parseRequiredString(result.methodId, "method id");
  const profiles = result.profiles.map((profile): ModelsAuthLoginFlowResult["profiles"][number] => {
    if (!profile || typeof profile !== "object") {
      throw new Error("Provider login returned an invalid profile.");
    }
    const record = profile as Record<string, unknown>;
    const profileId = parseRequiredString(record.profileId, "profile id");
    const provider = parseRequiredString(record.provider, "profile provider");
    const mode = parseRequiredString(record.mode, "profile mode");
    if (mode !== "api_key" && mode !== "oauth" && mode !== "token") {
      throw new Error("Provider login returned an invalid profile.");
    }
    return {
      profileId,
      provider,
      mode,
    };
  });
  const defaultModel =
    result.defaultModel === undefined
      ? undefined
      : parseRequiredString(result.defaultModel, "default model");
  const modelAccess = parseRequiredString(result.modelAccess, "model access result");
  if (modelAccess !== "enabled" && modelAccess !== "already-visible" && modelAccess !== "failed") {
    throw new Error("Provider login returned an invalid model access result.");
  }
  return {
    providerId,
    methodId,
    ...(result.imported === true ? { imported: true } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    modelAccess,
    profiles,
  };
}

async function runProviderChannelLoginFlow(params: {
  choice: ProviderChannelLoginChoice;
  agentId: string;
  profileId?: string;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  sendMessage: (message: string) => Promise<void>;
  sendDeviceCode?: NonNullable<ModelsAuthLoginFlowOptions["prompter"]["deviceCode"]>;
  signal?: AbortSignal;
  unsupportedPromptMessage: string;
  runLoginFlow?: RunModelsAuthLoginFlow;
}): Promise<ModelsAuthLoginFlowResult> {
  const result = await (params.runLoginFlow ?? runModelsAuthLoginFlow)({
    provider: params.choice.providerId,
    method: params.choice.methodId,
    ownerPluginId: params.choice.pluginId,
    credentialOnly: true,
    agent: params.agentId,
    ...(params.profileId ? { profileId: params.profileId } : {}),
    config: params.config,
    runtime: params.runtime,
    signal: params.signal,
    prompter: buildProviderChannelLoginPrompter({
      sendMessage: params.sendMessage,
      sendDeviceCode: params.sendDeviceCode,
      signal: params.signal,
      unsupportedPromptMessage: params.unsupportedPromptMessage,
    }),
    isRemote: true,
    openUrl: async () => {},
  });
  return parseModelsAuthLoginFlowResult(result);
}

async function runCodexDeviceLoginFlow(params: {
  provider: string;
  agentId: string;
  profileId?: string;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  sendMessage: (message: string) => Promise<void>;
  sendDeviceCode?: NonNullable<ModelsAuthLoginFlowOptions["prompter"]["deviceCode"]>;
  signal?: AbortSignal;
  unsupportedPromptMessage: string;
  runLoginFlow?: RunModelsAuthLoginFlow;
}): Promise<ModelsAuthLoginFlowResult> {
  return await runProviderChannelLoginFlow({
    choice: {
      choiceId: "openai-device-code",
      pluginId: params.provider,
      providerId: params.provider,
      methodId: CODEX_LOGIN_METHOD,
      label: "ChatGPT Device Pairing",
      providerLabel: "OpenAI",
      command: "codex",
      mode: "chat",
    },
    agentId: params.agentId,
    ...(params.profileId ? { profileId: params.profileId } : {}),
    config: params.config,
    runtime: params.runtime,
    signal: params.signal,
    sendMessage: params.sendMessage,
    sendDeviceCode: params.sendDeviceCode,
    unsupportedPromptMessage: params.unsupportedPromptMessage,
    runLoginFlow: params.runLoginFlow,
  });
}

function formatProviderLoginCommand(choice: ProviderChannelLoginChoice): string {
  return `/login ${choice.command}`;
}

function formatProviderLoginComplete(
  choice: ProviderChannelLoginChoice,
  imported: boolean,
  modelAccess: ModelsAuthLoginFlowResult["modelAccess"],
): string {
  const login = imported
    ? `${choice.providerLabel} login complete using your existing CLI sign-in.`
    : `${choice.providerLabel} login complete.`;
  if (modelAccess === "failed") {
    return `${login} Your credential is saved, but OpenClaw could not enable its models. Retry ${formatProviderLoginCommand(choice)} after the current config change finishes.`;
  }
  if (modelAccess === "enabled") {
    return `${login} All ${choice.providerLabel} models are enabled. Your default model is unchanged. Use /models to browse; the first list may still be loading.`;
  }
  return `${login} Try your request again now.`;
}

function formatProviderLoginSessionSwitchFailed(
  choice: ProviderChannelLoginChoice,
  sessionLabel = "session",
): string {
  return `${choice.providerLabel} login completed, but this ${sessionLabel} could not switch to the newly authenticated profile. Retry \`${formatProviderLoginCommand(choice)}\`, or select the profile manually.`;
}

function formatProviderLoginFailed(choice: ProviderChannelLoginChoice): string {
  return `${choice.providerLabel} login did not complete. Send \`${formatProviderLoginCommand(choice)}\` to try again.`;
}

function formatProviderLoginControlUiHandoff(choice: ProviderChannelLoginChoice): string {
  if (choice.mode === "setup") {
    return `${choice.label} configures provider setup, not only a credential. Open Control UI → Models, find ${choice.providerLabel}, and choose “Set up ${choice.label}”.`;
  }
  return `${choice.label} needs secure input that chat must not store. Open Control UI → Models, find ${choice.providerLabel}, and choose “Sign in with ${choice.label}”.`;
}

function formatProviderLoginChoices(choices: ProviderChannelLoginChoice[]): string {
  const visible = choices
    .toSorted((a, b) => Number(b.mode === "chat") - Number(a.mode === "chat"))
    .slice(0, 8);
  const commands = visible.map((choice) => `\`${formatProviderLoginCommand(choice)}\``).join(", ");
  const remaining = choices.length - visible.length;
  return remaining > 0 ? `${commands}, and ${remaining} more in Control UI → Models` : commands;
}

export const providerChannelLoginRuntime = {
  createFlowRegistry: createProviderLoginFlowRegistry,
  listChoices: listProviderChannelLoginChoices,
  resolveChoice: resolveProviderChannelLoginChoice,
  hasConfiguredCommandOwnerAllowlist,
  reserveFlow: reserveProviderLoginFlow,
  releaseFlow: releaseProviderLoginFlow,
  runLoginFlow: runProviderChannelLoginFlow,
  formatCommand: formatProviderLoginCommand,
  formatComplete: formatProviderLoginComplete,
  formatSessionSwitchFailed: formatProviderLoginSessionSwitchFailed,
  formatFailed: formatProviderLoginFailed,
  formatControlUiHandoff: formatProviderLoginControlUiHandoff,
  formatChoices: formatProviderLoginChoices,
};

/** @deprecated Use providerChannelLoginRuntime. */
export const codexChannelLoginRuntime = {
  createFlowRegistry: createProviderLoginFlowRegistry,
  resolveProvider: resolveCodexLoginProvider,
  hasConfiguredCommandOwnerAllowlist,
  resolveProviderScopedProfileId,
  reserveFlow: reserveCodexLoginFlow,
  releaseFlow: releaseProviderLoginFlow,
  runDeviceLoginFlow: runCodexDeviceLoginFlow,
};
