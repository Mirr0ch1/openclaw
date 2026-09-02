import { InputFile } from "grammy";
import type { InlineKeyboardMarkup, InputMediaPhoto, InputMediaVideo, Message } from "grammy/types";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import type { ResolvedTelegramAccount } from "./accounts.js";
import { telegramCaptionDeliveryMetadata } from "./caption.js";
import { prepareTelegramOutboundMedia } from "./outbound-media.js";
import type { TelegramOutboundPromptContextMessage as TelegramMessageLike } from "./outbound-message-context.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import { isTelegramEmptyContentError, isTelegramHtmlParseError } from "./rich-plain-fallback.js";
import {
  logTelegramOutboundSendOk,
  resolveAcceptedReplyToMessageId,
  resolveTelegramMessageIdOrThrow,
  toAcceptedThreadScopedParams,
  type TelegramApi,
  type TelegramThreadScopedParams,
} from "./send-context.js";
import type { TelegramSendOpts, TelegramSendResult } from "./send-message-types.js";
import { createTelegramPreparedSender } from "./send-prepared.js";
import {
  buildOutboundMediaLoadOptions,
  loadWebMedia,
  type OpenClawConfig,
} from "./send.runtime.js";
import { recordSentMessage } from "./sent-message-cache.js";

const MAX_TELEGRAM_MEDIA_GROUP_ITEMS = 10;

type ReportTelegramDelivery = (
  messageId: string | number,
  deliveredChatId: string | number,
  message: TelegramMessageLike,
  meta?: TelegramSendResult["meta"],
  kind?: "text" | "media",
  onPrepared?: (delivery: TelegramSendResult) => void,
) => Promise<TelegramSendResult>;

type RecordDeliveredPromptContext = (
  params: Omit<
    Parameters<typeof recordOutboundMessageForPromptContext>[0],
    "cfg" | "account" | "botUserId" | "chatId" | "promptContextProjection"
  >,
  finalPart: boolean,
) => Promise<void>;

export type TelegramMediaGroupSendContext = {
  cfg: OpenClawConfig;
  account: ResolvedTelegramAccount;
  ownerAgentId: string;
  api: TelegramApi;
  chatId: string;
  preparedThreadParams: TelegramThreadScopedParams;
  sender: ReturnType<typeof createTelegramPreparedSender>;
  singleUseReplyTo: boolean;
  replyMarkup: InlineKeyboardMarkup | undefined;
  mediaMaxBytes: number;
  textMode: "markdown" | "html";
  tableMode: MarkdownTableMode;
  reportDelivery: ReportTelegramDelivery;
  recordDeliveredPromptContext: RecordDeliveredPromptContext;
  shouldSendTelegramImageAsPhoto: (buffer: Buffer) => Promise<boolean>;
  sendChunkedText: (
    rawText: string,
    context: string,
    options?: {
      replyToAlreadyUsed?: boolean;
      beforeFirstAccepted?: () => Promise<void>;
    },
  ) => Promise<TelegramSendResult>;
  opts: TelegramSendOpts;
};

/**
 * Sends multiple photos/videos as a single Telegram album (media group).
 * Returns undefined when the media group path is not applicable so callers can
 * fall back to sending each attachment as its own message.
 */
export async function sendTelegramMediaAlbum(
  context: TelegramMediaGroupSendContext,
  urls: readonly string[],
  albumText: string,
): Promise<TelegramSendResult | undefined> {
  const {
    cfg,
    account,
    ownerAgentId,
    api,
    chatId,
    preparedThreadParams,
    sender,
    singleUseReplyTo,
    replyMarkup,
    mediaMaxBytes,
    textMode,
    tableMode,
    reportDelivery,
    recordDeliveredPromptContext,
    shouldSendTelegramImageAsPhoto,
    sendChunkedText,
    opts,
  } = context;
  if (
    urls.length < 2 ||
    urls.length > MAX_TELEGRAM_MEDIA_GROUP_ITEMS ||
    opts.asVoice ||
    opts.asVideoNote ||
    opts.forceDocument
  ) {
    return undefined;
  }
  const loadOptions = buildOutboundMediaLoadOptions({
    maxBytes: mediaMaxBytes,
    mediaAccess: opts.mediaAccess,
    mediaLocalRoots: opts.mediaLocalRoots,
    mediaReadFile: opts.mediaReadFile,
  });
  let loaded: Array<Awaited<ReturnType<typeof loadWebMedia>>>;
  try {
    loaded = await Promise.all(urls.map((url) => loadWebMedia(url, loadOptions)));
  } catch (error) {
    logVerbose(
      `telegram media group load failed; falling back to separate sends: ${formatErrorMessage(
        error,
      )}`,
    );
    return undefined;
  }
  const plans: Array<{
    media: Awaited<ReturnType<typeof loadWebMedia>>;
    plan: ReturnType<typeof prepareTelegramOutboundMedia>;
  }> = [];
  for (const media of loaded) {
    const plan = prepareTelegramOutboundMedia({ media, textMode, tableMode });
    if (
      plan.isGif ||
      plan.isVideoNote ||
      (plan.deliveryKind !== "image" && plan.deliveryKind !== "video")
    ) {
      return undefined;
    }
    if (plan.deliveryKind === "image" && !(await shouldSendTelegramImageAsPhoto(media.buffer))) {
      return undefined;
    }
    plans.push({ media, plan });
  }

  // Only the first media carries the caption; the rest are captionless.
  const firstPlan = prepareTelegramOutboundMedia({
    media: loaded[0]!,
    text: albumText,
    textMode,
    tableMode,
  });
  const { followUpText } = firstPlan;
  const htmlCaption = firstPlan.htmlCaption;
  const plainCaption = firstPlan.plainCaption;
  const needsSeparateText = Boolean(followUpText);

  const buildInputs = (
    captionValue: string | undefined,
    parseMode: "HTML" | undefined,
  ): Array<InputMediaPhoto | InputMediaVideo> =>
    plans.map(({ media, plan }, index) => {
      const mediaRef = new InputFile(media.buffer, plan.fileName);
      const input: InputMediaPhoto | InputMediaVideo =
        plan.deliveryKind === "video"
          ? { type: "video", media: mediaRef }
          : { type: "photo", media: mediaRef };
      if (index === 0 && captionValue) {
        input.caption = captionValue;
        if (parseMode) {
          input.parse_mode = parseMode;
        }
      }
      return input;
    });

  const groupParams: Record<string, unknown> = {
    ...preparedThreadParams,
    ...(opts.silent === true ? { disable_notification: true } : {}),
  };
  const sendGroup = (inputs: Array<InputMediaPhoto | InputMediaVideo>) =>
    sender.request("sendMediaGroup", groupParams, (effective) =>
      api.sendMediaGroup(chatId, inputs, effective),
    );
  let groupDelivery: { result: Message[]; acceptedParams: Record<string, unknown> };
  let deliveredCaption: string | undefined;
  try {
    groupDelivery = await sendGroup(buildInputs(htmlCaption, "HTML"));
    deliveredCaption = plainCaption;
  } catch (error) {
    if (isTelegramHtmlParseError(error) && plainCaption) {
      logVerbose(
        `telegram sendMediaGroup caption HTML rejected; retrying as plain caption: ${formatErrorMessage(
          error,
        )}`,
      );
      groupDelivery = await sendGroup(buildInputs(plainCaption, undefined));
      deliveredCaption = plainCaption;
    } else if (isTelegramEmptyContentError(error) && htmlCaption) {
      groupDelivery = await sendGroup(buildInputs(undefined, undefined));
      deliveredCaption = undefined;
    } else {
      // Telegram sends are explicitly non-idempotent: a reset or timeout can
      // occur after the album was accepted. Falling back to per-media sends
      // here could duplicate user-visible media, so propagate the uncertain
      // outcome instead of resending every item.
      opts.promptContextProjectionPlan?.cursor.invalidate();
      logVerbose(
        `telegram sendMediaGroup failed; propagating instead of resending: ${formatErrorMessage(
          error,
        )}`,
      );
      throw error;
    }
  }
  const results = groupDelivery.result;
  const primary = results[0];
  if (!primary) {
    throw new Error("Telegram media group send returned no messages");
  }
  const acceptedMediaParams = toAcceptedThreadScopedParams(groupDelivery.acceptedParams);
  const mediaUsedReplyTo = resolveAcceptedReplyToMessageId(acceptedMediaParams) !== undefined;
  const primaryMessageId = resolveTelegramMessageIdOrThrow(primary, "media group send");
  const resolvedChatId = String(primary.chat?.id ?? chatId);
  // Telegram rejects reply_markup on sendMediaGroup, so the inline keyboard is
  // attached to the accepted primary message afterwards. A failed edit keeps
  // the delivered album but reports a partial delivery, mirroring the
  // single-media recovery pattern.
  let keyboardError: unknown;
  if (!needsSeparateText && replyMarkup) {
    try {
      await api.editMessageReplyMarkup(resolvedChatId, primaryMessageId, {
        reply_markup: replyMarkup,
      });
    } catch (editError) {
      keyboardError = editError;
    }
  }
  const hasInlineKeyboard =
    !needsSeparateText && Boolean(replyMarkup) && keyboardError === undefined;
  const albumResults = results.map((message) => ({
    messageId: String(resolveTelegramMessageIdOrThrow(message, "media group send")),
    chatId: resolvedChatId,
  }));
  let mediaDeliveryResult: TelegramSendResult | undefined;
  // Every physical album message stays in delivery custody so a later observer
  // or follow-up failure reports all delivered ids, not just the primary one.
  for (const [index, message] of results.entries()) {
    const isPrimary = index === 0;
    const messageId = resolveTelegramMessageIdOrThrow(message, "media group send");
    await sender.accept(
      {
        result: message,
        acceptedParams: groupDelivery.acceptedParams,
        plainText: isPrimary ? (deliveredCaption ?? "") : "",
        hasInlineKeyboard: isPrimary ? hasInlineKeyboard : false,
      },
      async () => {
        recordSentMessage(chatId, messageId, cfg, {
          accountId: account.accountId,
          agentId: ownerAgentId,
        });
        if (!isPrimary) {
          return;
        }
        const meta = {
          ...(deliveredCaption ? { telegramDeliveredText: deliveredCaption } : {}),
          telegramHasInlineKeyboard: hasInlineKeyboard,
        };
        telegramCaptionDeliveryMetadata.add(meta);
        mediaDeliveryResult = await reportDelivery(
          messageId,
          resolvedChatId,
          message,
          meta,
          "media",
          (delivery) => {
            mediaDeliveryResult = delivery;
          },
        );
        if (!needsSeparateText) {
          await recordDeliveredPromptContext(
            {
              message,
              messageId,
              ...(deliveredCaption ? { text: deliveredCaption } : {}),
              ...(acceptedMediaParams?.message_thread_id !== undefined
                ? { messageThreadId: acceptedMediaParams.message_thread_id }
                : {}),
            },
            true,
          );
        }
      },
      () => ({
        ...(mediaDeliveryResult?.receipt ? { receipt: mediaDeliveryResult.receipt } : {}),
        visibleReplySent: true,
      }),
    );
  }
  const albumReceipt = createMessageReceiptFromOutboundResults({
    results: albumResults,
    kind: "media",
  });
  logTelegramOutboundSendOk({
    accountId: account.accountId,
    chatId: resolvedChatId,
    messageId: String(primaryMessageId),
    operation: "sendMediaGroup",
    deliveryKind: "media_group",
    messageThreadId: acceptedMediaParams?.message_thread_id,
    replyToMessageId: opts.replyToMessageId,
    silent: opts.silent,
  });
  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "outbound",
  });

  if (keyboardError !== undefined) {
    // The album was delivered; only the inline keyboard edit failed.
    throw createChannelPartialDeliveryError(keyboardError, {
      messageIds: albumResults.map((entry) => entry.messageId),
      receipt: albumReceipt,
      visibleReplySent: true,
    });
  }

  // If text was too long for a caption, send it as a separate follow-up message.
  if (needsSeparateText && followUpText) {
    let textResult: TelegramSendResult;
    try {
      textResult = await sendChunkedText(followUpText, "media group text follow-up send", {
        replyToAlreadyUsed: singleUseReplyTo && mediaUsedReplyTo,
      });
    } catch (error) {
      if (!isChannelPartialDeliveryError(error) && isTelegramEmptyContentError(error)) {
        await recordDeliveredPromptContext({ message: primary, messageId: primaryMessageId }, true);
        const finalMediaResult = mediaDeliveryResult ?? {
          messageId: String(primaryMessageId),
          chatId: resolvedChatId,
        };
        if (!hasInlineKeyboard) {
          return finalMediaResult;
        }
        const meta = { ...finalMediaResult.meta, telegramHasInlineKeyboard: true };
        telegramCaptionDeliveryMetadata.add(meta);
        return { ...finalMediaResult, meta };
      }
      await recordDeliveredPromptContext({ message: primary, messageId: primaryMessageId }, false);
      return sender.fail(error);
    }
    const receipt = createMessageReceiptFromOutboundResults({
      results: [...albumResults, textResult],
      kind: "text",
    });
    receipt.parts = receipt.parts.map((part, index) => ({
      ...part,
      index,
      ...(index === 0 ? { kind: "media" } : {}),
    }));
    return { ...textResult, chatId: resolvedChatId, receipt };
  }

  return {
    messageId: String(primaryMessageId),
    chatId: resolvedChatId,
    ...(mediaDeliveryResult?.meta ? { meta: mediaDeliveryResult.meta } : {}),
    receipt: albumReceipt,
  };
}
