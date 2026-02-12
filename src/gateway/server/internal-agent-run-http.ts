import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveEffectiveMessagesConfig, resolveIdentityName } from "../../agents/identity.js";
import { injectTimestamp, timestampOptsFromConfig } from "../server-methods/agent-timestamp.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import {
  extractShortModelName,
  type ResponsePrefixContext,
} from "../../auto-reply/reply/response-prefix-template.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { loadConfig } from "../../config/config.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { readJsonBody } from "../hooks.js";
import {
  loadSessionEntry,
  readSessionMessages,
  transcriptToOpenAIMessages,
} from "../session-utils.js";

const INTERNAL_AGENT_RUN_PATH = "/_openclaw/internal/agent-run";
const INTERNAL_SECRET_HEADER = "x-openclaw-internal-secret";
const MAX_BODY_BYTES = 256 * 1024;

export type InternalAgentRunContextRef = {
  addChatRun:
    | ((sessionId: string, entry: { sessionKey: string; clientRunId: string }) => void)
    | null;
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/**
 * Handles POST /_openclaw/internal/agent-run for the AGL bridge.
 * Runs the Pi agent and returns the combined reply text so the bridge can
 * complete the rollout. Requires X-OpenClaw-Internal-Secret when
 * gateway.agl.internalAgentRunSecret is set.
 */
export async function handleInternalAgentRunRequest(
  req: IncomingMessage,
  res: ServerResponse,
  contextRef: InternalAgentRunContextRef,
): Promise<boolean> {
  const url = req.url ?? "/";
  const pathname = url.split("?")[0];
  if (pathname !== INTERNAL_AGENT_RUN_PATH) {
    return false;
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
    return true;
  }

  const cfg = loadConfig();
  const secret = cfg.gateway?.agl?.internalAgentRunSecret?.trim();
  if (secret) {
    const provided = req.headers[INTERNAL_SECRET_HEADER];
    const match = typeof provided === "string" && provided.trim() === secret;
    if (!match) {
      res.statusCode = 401;
      sendJson(res, 401, { ok: false, error: "Unauthorized" });
      return true;
    }
  }

  const bodyResult = await readJsonBody(req, MAX_BODY_BYTES);
  if (!bodyResult.ok) {
    const status = bodyResult.error === "payload too large" ? 413 : 400;
    sendJson(res, status, { ok: false, error: bodyResult.error });
    return true;
  }
  const body =
    typeof bodyResult.value === "object" && bodyResult.value !== null ? bodyResult.value : {};
  const sessionKey =
    typeof (body as Record<string, unknown>).sessionKey === "string"
      ? ((body as Record<string, unknown>).sessionKey as string)
      : "";
  const message =
    typeof (body as Record<string, unknown>).message === "string"
      ? ((body as Record<string, unknown>).message as string)
      : "";
  const clientRunId =
    typeof (body as Record<string, unknown>).idempotencyKey === "string"
      ? ((body as Record<string, unknown>).idempotencyKey as string)
      : `internal-${Date.now()}`;

  if (!sessionKey || !message.trim()) {
    sendJson(res, 400, { ok: false, error: "sessionKey and message required" });
    return true;
  }

  const addChatRun = contextRef.addChatRun;
  if (!addChatRun) {
    sendJson(res, 503, { ok: false, error: "Gateway not ready" });
    return true;
  }

  const { cfg: sessionCfg, storePath, entry } = loadSessionEntry(sessionKey);
  const sessionId = entry?.sessionId ?? clientRunId;
  addChatRun(sessionId, { sessionKey, clientRunId });

  const messagesBeforeRun = readSessionMessages(sessionId, storePath, entry?.sessionFile);
  const messageCountBeforeRun = messagesBeforeRun.length;

  const stampedMessage = injectTimestamp(message.trim(), timestampOptsFromConfig(sessionCfg));
  const ctx: MsgContext = {
    Body: message.trim(),
    BodyForAgent: stampedMessage,
    BodyForCommands: message.trim(),
    RawBody: message.trim(),
    CommandBody: message.trim(),
    SessionKey: sessionKey,
    Provider: INTERNAL_MESSAGE_CHANNEL,
    Surface: INTERNAL_MESSAGE_CHANNEL,
    OriginatingChannel: INTERNAL_MESSAGE_CHANNEL,
    ChatType: "direct",
    CommandAuthorized: true,
    MessageSid: clientRunId,
    SenderId: undefined,
    SenderName: undefined,
    SenderUsername: undefined,
  };

  const agentId = resolveSessionAgentId({ sessionKey, config: sessionCfg });
  let prefixContext: ResponsePrefixContext = {
    identityName: resolveIdentityName(sessionCfg, agentId),
  };
  const finalReplyParts: string[] = [];
  const dispatcher = createReplyDispatcher({
    responsePrefix: resolveEffectiveMessagesConfig(sessionCfg, agentId).responsePrefix,
    responsePrefixContextProvider: () => prefixContext,
    onError: () => {},
    deliver: async (payload, info) => {
      if (info.kind !== "final") return;
      const text = payload.text?.trim() ?? "";
      if (text) finalReplyParts.push(text);
    },
  });

  try {
    await dispatchInboundMessage({
      ctx,
      cfg: sessionCfg,
      dispatcher,
      replyOptions: {
        runId: clientRunId,
        disableBlockStreaming: true,
        onModelSelected: (ctx) => {
          prefixContext.provider = ctx.provider;
          prefixContext.model = extractShortModelName(ctx.model);
          prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
          prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
        },
      },
    });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }

  const responseText = finalReplyParts
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();

  let messages: { role: string; content: string }[] = [];
  try {
    const { storePath: storePathAfter, entry: latestEntry } = loadSessionEntry(sessionKey);
    const latestSessionId = latestEntry?.sessionId ?? sessionId;
    const messagesAfterRun = readSessionMessages(
      latestSessionId,
      storePathAfter,
      latestEntry?.sessionFile,
    );
    const delta = messagesAfterRun.slice(messageCountBeforeRun);
    messages = transcriptToOpenAIMessages(delta);
  } catch {
    /* non-fatal */
  }

  sendJson(res, 200, {
    ok: true,
    responseText,
    runId: clientRunId,
    messages,
  });
  return true;
}
