// Covers payload-transport routing for multi-media outbound payloads: channels
// that expose sendPayload receive the whole media list (so they can group it,
// e.g. Telegram albums), while single-media payloads stay on the per-media fanout.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { deliverOutboundPayloadsCore } from "./deliver-core.js";
import { createUnmodifiedPreparedOutboundBatch } from "./prepared-batch.js";

const createResult = (messageId: string) => ({
  channel: "matrix" as const,
  messageId,
  receipt: createMessageReceiptFromOutboundResults({
    results: [{ channel: "matrix", messageId }],
  }),
});

function installOutbound(outbound: ChannelOutboundAdapter) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: createOutboundTestPlugin({ id: "matrix", outbound }),
      },
    ]),
  );
}

async function deliverPayloads(params: {
  outbound: ChannelOutboundAdapter;
  payloads: Parameters<typeof createUnmodifiedPreparedOutboundBatch>[0];
}) {
  installOutbound(params.outbound);
  return await deliverOutboundPayloadsCore({
    cfg: {},
    channel: "matrix",
    to: "room-parent",
    payloads: [...params.payloads],
    preparedBatch: createUnmodifiedPreparedOutboundBatch(params.payloads),
  });
}

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  vi.restoreAllMocks();
});

describe("outbound payload-transport routing", () => {
  it("routes a multi-media payload through sendPayload instead of per-media fanout", async () => {
    const sendPayload = vi.fn(async (ctx: { payload: { mediaUrls?: string[]; text?: string } }) =>
      createResult(`album:${ctx.payload.mediaUrls?.length}`),
    );
    const sendMedia = vi.fn(async ({ mediaUrl }: { mediaUrl?: string }) =>
      createResult(`media:${mediaUrl}`),
    );
    const outbound = {
      deliveryMode: "direct",
      sendText: vi.fn(async ({ text }: { text: string }) => createResult(`text:${text}`)),
      sendPayload,
      sendMedia,
    } satisfies ChannelOutboundAdapter;

    const results = await deliverPayloads({
      outbound,
      payloads: [
        {
          text: "album caption",
          mediaUrls: ["https://example.com/one.png", "https://example.com/two.png"],
        },
      ],
    });

    expect(sendPayload).toHaveBeenCalledTimes(1);
    expect(sendMedia).not.toHaveBeenCalled();
    expect(sendPayload.mock.calls[0]?.[0].payload.mediaUrls).toEqual([
      "https://example.com/one.png",
      "https://example.com/two.png",
    ]);
    expect(results.map((result) => result.messageId)).toEqual(["album:2"]);
  });

  it("keeps single-media payloads on the per-media fanout", async () => {
    const sendPayload = vi.fn(async () => createResult("payload:single"));
    const sendMedia = vi.fn(async ({ mediaUrl }: { mediaUrl?: string }) =>
      createResult(`media:${mediaUrl}`),
    );
    const outbound = {
      deliveryMode: "direct",
      sendText: vi.fn(async ({ text }: { text: string }) => createResult(`text:${text}`)),
      sendPayload,
      sendMedia,
    } satisfies ChannelOutboundAdapter;

    const results = await deliverPayloads({
      outbound,
      payloads: [{ text: "single", mediaUrls: ["https://example.com/one.png"] }],
    });

    expect(sendPayload).not.toHaveBeenCalled();
    expect(sendMedia).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.messageId)).toEqual([
      "media:https://example.com/one.png",
    ]);
  });
});
