import type { OpenClawConfig } from "../config/config.js";
import type { FinalizedMsgContext, MsgContext } from "./templating.js";
import type { GetReplyOptions } from "./types.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import type { DispatchFromConfigResult } from "./reply/dispatch-from-config.js";
import { dispatchReplyFromConfig } from "./reply/dispatch-from-config.js";
import {
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
  type ReplyDispatcher,
  type ReplyDispatcherOptions,
  type ReplyDispatcherWithTypingOptions,
} from "./reply/reply-dispatcher.js";
import { startMessageFlow, endMessageFlow } from "../otel-instrumentation.js";

export type DispatchInboundResult = DispatchFromConfigResult;

export async function dispatchInboundMessage(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const finalized = finalizeInboundContext(params.ctx);
  const sessionId = finalized.SessionKey ?? finalized.SenderId ?? "unknown";
  const channel = finalized.Provider ?? finalized.Surface ?? "unknown";

  // Start OpenTelemetry message flow trace
  startMessageFlow(sessionId, channel, finalized.Body);

  try {
    const result = await dispatchReplyFromConfig({
      ctx: finalized,
      cfg: params.cfg,
      dispatcher: params.dispatcher,
      replyOptions: params.replyOptions,
      replyResolver: params.replyResolver,
    });
    endMessageFlow(sessionId, true);
    return result;
  } catch (error) {
    endMessageFlow(sessionId, false, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function dispatchInboundMessageWithBufferedDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherWithTypingOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping(
    params.dispatcherOptions,
  );

  const result = await dispatchInboundMessage({
    ctx: params.ctx,
    cfg: params.cfg,
    dispatcher,
    replyResolver: params.replyResolver,
    replyOptions: {
      ...params.replyOptions,
      ...replyOptions,
    },
  });

  markDispatchIdle();
  return result;
}

export async function dispatchInboundMessageWithDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const dispatcher = createReplyDispatcher(params.dispatcherOptions);
  const result = await dispatchInboundMessage({
    ctx: params.ctx,
    cfg: params.cfg,
    dispatcher,
    replyResolver: params.replyResolver,
    replyOptions: params.replyOptions,
  });
  await dispatcher.waitForIdle();
  return result;
}
