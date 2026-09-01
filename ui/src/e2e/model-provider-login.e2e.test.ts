import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI provider login", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("signs in without changing the configured model", async () => {
    const artifactDir = recordVisuals
      ? createControlUiE2eArtifactDir("model-provider-login")
      : undefined;
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const authCapabilities = [
      {
        provider: "xai",
        apiKeySupported: true,
        quickApiKeySetup: true,
        accessOptions: [{ id: "xai-oauth", label: "xAI OAuth", mode: "login" }],
      },
    ];
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "config.patch",
        "models.authLogin.start",
        "wizard.next",
      ],
      methodResponses: {
        "config.get": {
          config: { agents: { defaults: { model: "openai/gpt-5.5" } } },
          sourceConfig: { agents: { defaults: { model: "openai/gpt-5.5" } } },
          hash: "provider-login-config",
          issues: [],
          raw: '{"agents":{"defaults":{"model":"openai/gpt-5.5"}}}',
          valid: true,
        },
        "models.list": { models: [] },
        "models.authStatus": {
          ts: 1,
          providerCapabilities: authCapabilities,
          providers: [],
        },
        "models.authLogin.start": {
          sessionId: "xai-login-session",
          done: false,
          status: "running",
        },
        "wizard.next": {
          sequence: [
            {
              done: false,
              status: "running",
              step: {
                id: "xai-device-code",
                type: "note",
                title: "xAI OAuth",
                message: "Open the xAI sign-in page.",
                externalUrl: "https://accounts.x.ai/oauth2/device",
                deviceCode: { code: "XAI-ABCD", expiresInMinutes: 10 },
              },
            },
            { done: true, status: "done" },
          ],
        },
        "usage.status": { updatedAt: 1, providers: [] },
        "sessions.usage": { aggregates: { byProvider: [] } },
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      const xaiCard = page.locator('[data-provider-id="xai"]');
      await xaiCard.waitFor();
      await xaiCard.getByRole("button", { name: "Sign in with xAI OAuth" }).click();

      const start = await gateway.waitForRequest("models.authLogin.start");
      expect(start.params).toEqual(
        expect.objectContaining({ agentId: "main", authChoice: "xai-oauth" }),
      );
      await page.getByText("XAI-ABCD").waitFor();
      await expect
        .poll(() => page.getByRole("link", { name: "Open sign-in page" }).getAttribute("href"))
        .toBe("https://accounts.x.ai/oauth2/device");
      if (artifactDir) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(artifactDir, "device-code.png"),
        });
      }

      await gateway.setMethodResponse("models.authStatus", {
        ts: 2,
        providerCapabilities: authCapabilities,
        providers: [
          {
            provider: "xai",
            displayName: "xAI",
            status: "ok",
            profiles: [{ profileId: "xai:owner", type: "oauth", status: "ok" }],
          },
        ],
      });
      await gateway.deferNext("models.authStatus");
      await page.getByRole("button", { name: "Continue" }).click();

      await page.getByRole("status").filter({ hasText: "Signed in." }).waitFor();
      await gateway.resolveDeferred("models.authStatus");
      await expect.poll(async () => xaiCard.textContent()).toContain("Signed in");
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      expect(
        (await gateway.getRequests("models.list")).some(
          (request) => request.params.refresh === true,
        ),
      ).toBe(false);
      if (artifactDir) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "signed-in.png"),
        });
      }
    } finally {
      await context.close();
    }
  });

  it("uses the shared wizard for masked credentials and provider setup", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const accessCapabilities = [
      {
        provider: "groq",
        apiKeySupported: true,
        quickApiKeySetup: true,
        accessOptions: [{ id: "groq-api-key", label: "Groq API key", mode: "login" }],
      },
      {
        provider: "vllm",
        apiKeySupported: false,
        quickApiKeySetup: false,
        accessOptions: [{ id: "vllm", label: "vLLM", mode: "setup" }],
      },
    ];
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "config.patch",
        "models.authLogin.start",
        "openclaw.setup.prepare.start",
        "wizard.next",
      ],
      methodResponses: {
        "config.get": {
          config: { agents: { defaults: { model: "openai/gpt-5.5" } } },
          sourceConfig: { agents: { defaults: { model: "openai/gpt-5.5" } } },
          hash: "provider-access-config",
          issues: [],
          raw: '{"agents":{"defaults":{"model":"openai/gpt-5.5"}}}',
          valid: true,
        },
        "models.list": { models: [] },
        "models.authStatus": {
          ts: 1,
          providerCapabilities: accessCapabilities,
          providers: [],
        },
        "models.authLogin.start": {
          sessionId: "groq-login-session",
          done: false,
          status: "running",
        },
        "openclaw.setup.prepare.start": {
          sessionId: "vllm-setup-session",
          done: false,
          status: "running",
        },
        "wizard.next": {
          sequence: [
            {
              done: false,
              status: "running",
              step: {
                id: "groq-key",
                type: "text",
                message: "Enter Groq API key",
                sensitive: true,
              },
            },
            { done: true, status: "done" },
          ],
        },
        "usage.status": { updatedAt: 1, providers: [] },
        "sessions.usage": { aggregates: { byProvider: [] } },
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      await page.getByRole("button", { name: "Sign in with Groq API key" }).click();
      const secretInput = page.getByLabel("Enter Groq API key");
      await secretInput.waitFor();
      expect(await secretInput.getAttribute("type")).toBe("password");
      await secretInput.fill("test-groq-key");
      await page.getByRole("button", { name: "Submit" }).click();
      await page.getByRole("status").filter({ hasText: "Signed in." }).waitFor();

      await gateway.setMethodResponse("wizard.next", {
        sequence: [
          {
            done: false,
            status: "running",
            step: {
              id: "vllm-url",
              type: "text",
              message: "vLLM base URL",
              placeholder: "http://127.0.0.1:8000/v1",
            },
          },
          { done: true, status: "done" },
        ],
      });
      await page.getByRole("button", { name: "Set up vLLM" }).click();
      await page.getByLabel("vLLM base URL").fill("http://127.0.0.1:8000/v1");
      await page.getByRole("button", { name: "Submit" }).click();
      await page.getByRole("status").filter({ hasText: "Configured" }).waitFor();

      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      expect(await gateway.getRequests("models.authLogin.start")).toHaveLength(1);
      expect(await gateway.getRequests("openclaw.setup.prepare.start")).toHaveLength(1);
    } finally {
      await context.close();
    }
  });
});
