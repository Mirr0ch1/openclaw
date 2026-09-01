import { describe, expect, it, vi } from "vitest";
import {
  codexChannelLoginRuntime,
  decideProviderLoginSessionAdoption,
  providerChannelLoginRuntime,
  type ProviderChannelLoginChoice,
  type ProviderLoginSessionEntry,
} from "./provider-auth-login-flow-runtime.js";

const choice: ProviderChannelLoginChoice = {
  choiceId: "xai-oauth",
  pluginId: "xai",
  providerId: "xai",
  methodId: "oauth",
  label: "xAI OAuth",
  providerLabel: "xAI (Grok)",
  command: "xai",
  mode: "chat",
};

const snapshot: ProviderLoginSessionEntry = {
  sessionId: "session-1",
  authProfileOverride: "xai:old",
  authProfileOverrideSource: "user",
};

describe("provider channel login runtime", () => {
  it("fails closed when an offered provider asks chat for extra input", async () => {
    const sendMessage = vi.fn(async () => {});

    await expect(
      providerChannelLoginRuntime.runLoginFlow({
        choice,
        agentId: "main",
        config: {},
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        sendMessage,
        unsupportedPromptMessage: "Open Control UI → Models and choose Sign in.",
        runLoginFlow: async (options) => {
          await options.prompter.text({ message: "Enter a secret" });
          return { providerId: "xai", methodId: "oauth", profiles: [] };
        },
      }),
    ).rejects.toThrow("Open Control UI");
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      "Open Control UI → Models and choose Sign in.",
    );
  });

  it("passes the selected manifest owner to provider execution", async () => {
    const runLoginFlow = vi.fn(async () => ({
      providerId: "xai",
      methodId: "oauth",
      modelAccess: "already-visible" as const,
      profiles: [],
    }));

    await providerChannelLoginRuntime.runLoginFlow({
      choice,
      agentId: "main",
      config: {},
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      sendMessage: vi.fn(async () => {}),
      unsupportedPromptMessage: "Open Control UI → Models and choose Sign in.",
      runLoginFlow,
    });

    expect(runLoginFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "xai",
        method: "oauth",
        ownerPluginId: "xai",
        credentialOnly: true,
      }),
    );
  });

  it("retains the released Codex channel-login facade", async () => {
    expect([
      codexChannelLoginRuntime.resolveProvider(undefined),
      codexChannelLoginRuntime.resolveProvider(""),
      codexChannelLoginRuntime.resolveProvider("codex"),
      codexChannelLoginRuntime.resolveProvider("OPENAI"),
      codexChannelLoginRuntime.resolveProvider("xai"),
    ]).toEqual(["openai", "openai", "openai", "openai", null]);
    expect(codexChannelLoginRuntime.resolveProviderScopedProfileId("OpenAI:owner", "openai")).toBe(
      "OpenAI:owner",
    );
    expect(
      codexChannelLoginRuntime.resolveProviderScopedProfileId("xai:owner", "openai"),
    ).toBeUndefined();

    const runLoginFlow = vi.fn(async () => ({
      providerId: "openai",
      methodId: "device-code",
      modelAccess: "already-visible" as const,
      profiles: [],
    }));
    await codexChannelLoginRuntime.runDeviceLoginFlow({
      provider: "openai",
      agentId: "main",
      config: {},
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      sendMessage: vi.fn(async () => {}),
      unsupportedPromptMessage: "Use the Control UI.",
      runLoginFlow,
    });

    expect(runLoginFlow).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", method: "device-code" }),
    );
  });

  it.each([
    {
      name: "patches an unchanged authoritative snapshot",
      params: {
        currentModelProvider: "xai",
        loginProvider: "xai",
        nextProfileId: "xai:new",
        snapshot,
        current: snapshot,
      },
      status: "patch",
    },
    {
      name: "rejects a profile changed during login",
      params: {
        currentModelProvider: "xai",
        loginProvider: "xai",
        nextProfileId: "xai:new",
        snapshot,
        current: { ...snapshot, authProfileOverride: "xai:concurrent" },
      },
      status: "rejected",
    },
    {
      name: "does not pin after the session switches providers",
      params: {
        currentModelProvider: "xai",
        loginProvider: "xai",
        nextProfileId: "xai:new",
        snapshot: { ...snapshot, providerOverride: "xai" },
        current: { ...snapshot, providerOverride: "openai" },
      },
      status: "unchanged",
    },
    {
      name: "does not pin credentials for another model provider",
      params: {
        currentModelProvider: "openai",
        loginProvider: "xai",
        nextProfileId: "xai:new",
        snapshot,
        current: snapshot,
      },
      status: "unchanged",
    },
    {
      name: "rejects a later user choice on a newly created session",
      params: {
        currentModelProvider: "xai",
        loginProvider: "xai",
        nextProfileId: "xai:new",
        snapshot: undefined,
        current: { ...snapshot, authProfileOverride: "xai:later" },
      },
      status: "rejected",
    },
  ])("$name", ({ params, status }) => {
    expect(decideProviderLoginSessionAdoption(params)).toMatchObject({ status });
  });
});
