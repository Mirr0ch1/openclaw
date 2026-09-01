/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { card, mount, props, text } from "./view.test-support.ts";

describe("model provider card UX", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("shows native runtime access as ready without claiming provider credentials", () => {
    const container = mount(
      props({
        cards: [
          card({
            apiKey: undefined,
            credentialProviderIds: [],
            modelCount: 4,
            availableModelCount: 4,
            runtimeAvailableModelCount: 4,
            runtimeLabels: ["Claude CLI"],
          }),
        ],
      }),
    );
    const provider = container.querySelector('[data-provider-id="openai"]');

    expect(text(provider)).toContain("Ready");
    expect(text(provider)).toContain("Access through Claude CLI");
    expect(text(provider)).not.toContain("Not configured");
    expect(text(provider)).not.toContain("Not set up");
  });

  it("keeps expired auth more urgent than native runtime readiness", () => {
    const container = mount(
      props({
        cards: [
          card({
            auth: { kind: "expired", profileCount: 1 },
            profiles: [{ profileId: "openai:expired", type: "oauth", status: "expired" }],
            runtimeAvailableModelCount: 1,
            runtimeLabels: ["Claude CLI"],
          }),
        ],
      }),
    );
    const provider = container.querySelector('[data-provider-id="openai"]');

    expect(text(provider)).toContain("Expired");
    expect(text(provider)).not.toContain("Ready");
  });

  it("hides empty usage sections", () => {
    const container = mount(props());
    const provider = container.querySelector('[data-provider-id="openai"]');

    expect(provider?.querySelector(".model-providers__global-metrics")).toBeNull();
    expect(text(provider)).not.toContain("No live usage data reported");
  });

  it("reports unknown local cost instead of a false zero", () => {
    const container = mount(
      props({
        cards: [
          card({
            localCost: {
              totalCost: 0,
              totalTokens: 2_100_000,
              sessionCount: 28,
              missingCostEntries: 28,
            },
          }),
        ],
      }),
    );
    const provider = container.querySelector('[data-provider-id="openai"]');

    expect(text(provider)).toContain("Cost unavailable");
    expect(text(provider)).not.toContain("$0.00");
    expect(text(provider)).toContain("2.1M tokens · 28 sessions");
  });
});
