import path from "node:path";

import type { ChannelPlugin, OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/infra-runtime";

import {
  registerWeixinAccountId,
  loadWeixinAccount,
  saveWeixinAccount,
  listWeixinAccountIds,
  resolveWeixinAccount,
  triggerWeixinChannelReload,
  clearStaleAccountsForUserId,
  DEFAULT_BASE_URL,
} from "./auth/accounts.js";
import type { ResolvedWeixinAccount } from "./auth/accounts.js";
import { notifyStop, notifyStart } from "./api/api.js";
import { assertSessionActive } from "./api/session-guard.js";
import { getContextToken, findAccountIdsByContextToken, restoreContextTokens, clearContextTokensForAccount } from "./messaging/inbound.js";
import { logger } from "./util/logger.js";
import {
  DEFAULT_ILINK_BOT_TYPE,
  startWeixinLoginWithQr,
  waitForWeixinLogin,
  displayQRCode,
} from "./auth/login-qr.js";
import type { WeixinQrStartResult, WeixinQrWaitResult } from "./auth/login-qr.js";
// Lazy-imported inside startAccount to avoid pulling in the monitor -> process-message ->
// command-auth chain during plugin registration, which can re-enter plugin/provider registry
// resolution before the account actually starts.
import { applyWeixinMessageSendingHook, emitWeixinMessageSent } from "./messaging/outbound-hooks.js";
import { sendWeixinMediaFile } from "./messaging/send-media.js";
import { sendMessageWeixin, StreamingMarkdownFilter } from "./messaging/send.js";
import { downloadRemoteImageToTemp } from "./cdn/upload.js";

/** Returns true when mediaUrl refers to a local filesystem path (absolute or relative). */
function isLocalFilePath(mediaUrl: string): boolean {
  // Treat anything without a URL scheme (no "://") as a local path.
  return !mediaUrl.includes("://");
}

function isRemoteUrl(mediaUrl: string): boolean {
  return mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://");
}

const MEDIA_OUTBOUND_TEMP_DIR = path.join(resolvePreferredOpenClawTmpDir(), "weixin/media/outbound-temp");

/** Resolve any local path scheme to an absolute filesystem path. */
function resolveLocalPath(mediaUrl: string): string {
  if (mediaUrl.startsWith("file://")) return new URL(mediaUrl).pathname;
  // Resolve any relative path (./foo, ../foo, .openclaw/foo, foo/bar) against cwd
  if (!path.isAbsolute(mediaUrl)) return path.resolve(mediaUrl);
  return mediaUrl;
}

/**
 * Resolve the effective accountId for an outbound message when the caller
 * did not provide one (e.g. cron delivery without explicit accountId).
 *
 * Priority:
 *   1. Multiple accounts → match via contextToken for the `to` recipient
 *   2. Single account → use it directly
 *   3. No match → throw a descriptive error
 */
function resolveOutboundAccountId(
  cfg: OpenClawConfig,
  to: string,
): string {
  const allIds = listWeixinAccountIds(cfg);

  if (allIds.length === 0) {
    throw new Error(
      `weixin: no accounts registered — run \`openclaw channels login --channel openclaw-weixin\``,
    );
  }

  if (allIds.length === 1) {
    logger.info(`resolveOutboundAccountId: single account, using ${allIds[0]}`);
    return allIds[0];
  }

  // Multiple accounts: find which ones have a contextToken for the recipient.
  const matched = findAccountIdsByContextToken(allIds, to);

  if (matched.length === 1) {
    logger.info(`resolveOutboundAccountId: matched accountId=${matched[0]} for to=${to}`);
    return matched[0];
  }

  if (matched.length > 1) {
    logger.warn(
      `resolveOutboundAccountId: ambiguous — ${matched.length} accounts matched for to=${to}: ${matched.join(", ")}`,
    );
    throw new Error(
      `weixin: ambiguous account for to=${to} ` +
      `(${matched.length} accounts have active sessions with this recipient: ${matched.join(", ")}). ` +
      `Specify accountId in the delivery config to disambiguate.`,
    );
  }

  throw new Error(
    `weixin: cannot determine which account to use for to=${to} ` +
    `(${allIds.length} accounts registered, none has an active session with this recipient). ` +
    `Specify accountId in the delivery config, or ensure the recipient has recently messaged the bot.`,
  );
}

async function sendWeixinOutbound(params: {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  accountId?: string | null;
  contextToken?: string;
}): Promise<{ channel: string; messageId: string }> {
  const account = resolveWeixinAccount(params.cfg, params.accountId);
  const aLog = logger.withAccount(account.accountId);
  assertSessionActive(account.accountId);
  if (!account.configured) {
    aLog.error(`sendWeixinOutbound: account not configured`);
    throw new Error("weixin not configured: please run `openclaw channels login --channel openclaw-weixin`");
  }
  if (!params.contextToken) {
    aLog.warn(`sendWeixinOutbound: contextToken missing for to=${params.to}, sending without context`);
  }
  const f = new StreamingMarkdownFilter();
  const rawText = params.text ?? "";
  let filteredText = f.feed(rawText) + f.flush();

  const sendingResult = await applyWeixinMessageSendingHook({
    to: params.to,
    text: filteredText,
    accountId: account.accountId,
  });
  if (sendingResult.cancelled) {
    aLog.info(`sendWeixinOutbound: cancelled by message_sending hook to=${params.to}`);
    return { channel: "openclaw-weixin", messageId: "" };
  }
  filteredText = sendingResult.text;

  try {
    const result = await sendMessageWeixin({ to: params.to, text: filteredText, opts: {
      baseUrl: account.baseUrl,
      token: account.token,
      contextToken: params.contextToken,
    }});
    emitWeixinMessageSent({ to: params.to, content: filteredText, success: true, accountId: account.accountId });
    return { channel: "openclaw-weixin", messageId: result.messageId };
  } catch (err) {
    emitWeixinMessageSent({ to: params.to, content: filteredText, success: false, error: String(err), accountId: account.accountId });
    throw err;
  }
}

export const weixinPlugin: ChannelPlugin<ResolvedWeixinAccount> = {
  id: "openclaw-weixin",
  meta: {
    id: "openclaw-weixin",
    label: "openclaw-weixin",
    selectionLabel: "openclaw-weixin (long-poll)",
    docsPath: "/channels/openclaw-weixin",
    docsLabel: "openclaw-weixin",
    blurb: "getUpdates long-poll upstream, sendMessage downstream; token auth.",
    order: 75,
  },
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        replyProgressMessages: {
          type: "boolean",
          default: true,
          description: "Send structured tool-call progress messages.",
        },
      },
    },
  },
  capabilities: {
    chatTypes: ["direct"],
    media: true,
    blockStreaming: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: {
      minChars: 200,
      idleMs: 3000,
    },
  },
  messaging: {
    targetResolver: {
      // Weixin user IDs always end with @im.wechat; treat as direct IDs, skip directory lookup.
      looksLikeId: (raw) => raw.endsWith("@im.wechat"),
    },
  },
  agentPrompt: {
    messageToolHints: () => [
      "To send an image or file to the current user, use the message tool with action='send' and set 'media' to a local file path or a remote URL. You do not need to specify 'to' — the current conversation recipient is used automatically.",
      "When the user asks you to find an image from the web, use a web search or browser tool to find a suitable image URL, then send it using the message tool with 'media' set to that HTTPS image URL — do NOT download the image first.",
      "IMPORTANT: When generating or saving a file to send, always use an absolute path (e.g. /tmp/photo.png), never a relative path like ./photo.png. Relative paths cannot be resolved and the file will not be delivered.",
      "IMPORTANT: When creating a cron job (scheduled task) for the current Weixin user, you MUST set delivery.to to the user's Weixin ID (the xxx@im.wechat address from the current conversation) AND set delivery.accountId to the current AccountId. Without an explicit 'to', the cron delivery will fail with 'requires target'. Without an explicit 'accountId', the message may be sent from the wrong bot account. Example: delivery: { mode: 'announce', channel: 'openclaw-weixin', to: '<current_user_id@im.wechat>', accountId: '<current_AccountId>' }.",
      "IMPORTANT: When outputting a MEDIA: directive to send a file, the MEDIA: tag MUST be on its own line — never inline with other text. Correct:\nSome text here\nMEDIA:/path/to/file.mp4\nIncorrect: Some text here MEDIA:/path/to/file.mp4",
    ],
  },
  reload: { configPrefixes: ["channels.openclaw-weixin"] },
  config: {
    listAccountIds: (cfg) => listWeixinAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveWeixinAccount(cfg, accountId),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async (ctx) => {
      const accountId = ctx.accountId || resolveOutboundAccountId(ctx.cfg, ctx.to);
      const result = await sendWeixinOutbound({
        cfg: ctx.cfg,
        to: ctx.to,
        text: ctx.text,
        accountId,
        contextToken: getContextToken(accountId!, ctx.to),
      });
      return result;
    },
    sendMedia: async (ctx) => {
      const accountId = ctx.accountId || resolveOutboundAccountId(ctx.cfg, ctx.to);
      const account = resolveWeixinAccount(ctx.cfg, accountId);
      const aLog = logger.withAccount(account.accountId);
      assertSessionActive(account.accountId);
      if (!account.configured) {
        aLog.error(`sendMedia: account not configured`);
        throw new Error(
          "weixin not configured: please run `openclaw channels login --channel openclaw-weixin`",
        );
      }

      const mediaUrl = ctx.mediaUrl;
      let text = ctx.text ?? "";

      const sendingResult = await applyWeixinMessageSendingHook({
        to: ctx.to,
        text,
        accountId: account.accountId,
        mediaUrl,
      });
      if (sendingResult.cancelled) {
        aLog.info(`sendMedia: cancelled by message_sending hook to=${ctx.to}`);
        return { channel: "openclaw-weixin", messageId: "" };
      }
      text = sendingResult.text;

      if (mediaUrl && (isLocalFilePath(mediaUrl) || isRemoteUrl(mediaUrl))) {
        let filePath: string;
        if (isLocalFilePath(mediaUrl)) {
          filePath = resolveLocalPath(mediaUrl);
          aLog.debug(`sendMedia: uploading local file ${filePath}`);
        } else {
          aLog.debug(`sendMedia: downloading remote mediaUrl=${mediaUrl.slice(0, 80)}...`);
          filePath = await downloadRemoteImageToTemp(mediaUrl, MEDIA_OUTBOUND_TEMP_DIR);
          aLog.debug(`sendMedia: remote image downloaded to ${filePath}`);
        }
        const contextToken = getContextToken(account.accountId, ctx.to);
        try {
          const result = await sendWeixinMediaFile({
            filePath,
            to: ctx.to,
            text,
            opts: { baseUrl: account.baseUrl, token: account.token, contextToken },
            cdnBaseUrl: account.cdnBaseUrl,
          });
          emitWeixinMessageSent({ to: ctx.to, content: text, success: true, accountId: account.accountId });
          return { channel: "openclaw-weixin", messageId: result.messageId };
        } catch (err) {
          emitWeixinMessageSent({ to: ctx.to, content: text, success: false, error: String(err), accountId: account.accountId });
          throw err;
        }
      }

      const contextToken = getContextToken(account.accountId, ctx.to);
      try {
        const result = await sendMessageWeixin({ to: ctx.to, text, opts: {
          baseUrl: account.baseUrl,
          token: account.token,
          contextToken,
        }});
        emitWeixinMessageSent({ to: ctx.to, content: text, success: true, accountId: account.accountId });
        return { channel: "openclaw-weixin", messageId: result.messageId };
      } catch (err) {
        emitWeixinMessageSent({ to: ctx.to, content: text, success: false, error: String(err), accountId: account.accountId });
        throw err;
      }
    },
  },
  status: {
    defaultRuntime: {
      accountId: "",
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    },
    collectStatusIssues: () => [],
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      lastError: snapshot.lastError ?? null,
      lastInboundAt: snapshot.lastInboundAt ?? null,
      lastOutboundAt: snapshot.lastOutboundAt ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      ...runtime,
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  auth: {
    login: async ({ cfg, accountId, verbose, runtime }) => {
      const account = resolveWeixinAccount(cfg, accountId);

      const log = (msg: string) => {
        runtime?.log?.(msg);
      };

      log(`正在启动...`);
      const startResult: WeixinQrStartResult = await startWeixinLoginWithQr({
        accountId: account.accountId,
        apiBaseUrl: account.baseUrl,
        botType: DEFAULT_ILINK_BOT_TYPE,
        verbose: Boolean(verbose),
      });

      if (!startResult.qrcodeUrl) {
        logger.warn(
          `auth.login: failed to get QR code accountId=${account.accountId} message=${startResult.message}`,
        );
        log(startResult.message);
        throw new Error(startResult.message);
      }

      log(`\n用手机微信扫描以下二维码，以继续连接：\n`);
      await displayQRCode(startResult.qrcodeUrl!);

      const loginTimeoutMs = 480_000;
      log(`\n正在等待操作...\n`);

      const waitResult: WeixinQrWaitResult = await waitForWeixinLogin({
        sessionKey: startResult.sessionKey,
        apiBaseUrl: account.baseUrl,
        timeoutMs: loginTimeoutMs,
        verbose: Boolean(verbose),
        botType: DEFAULT_ILINK_BOT_TYPE,
      });

      if (waitResult.connected && waitResult.botToken && waitResult.accountId) {
        try {
          // Normalize the raw ilink_bot_id (e.g. "hex@im.bot") to a filesystem-safe
          // key (e.g. "hex-im-bot") so account files have no special chars.
          const normalizedId = normalizeAccountId(waitResult.accountId);
          saveWeixinAccount(normalizedId, {
            token: waitResult.botToken,
            baseUrl: waitResult.baseUrl,
            userId: waitResult.userId,
          });
          registerWeixinAccountId(normalizedId);
          if (waitResult.userId) {
            clearStaleAccountsForUserId(normalizedId, waitResult.userId, clearContextTokensForAccount);
          }
          void triggerWeixinChannelReload();
          log(`\n已将此 OpenClaw 连接到微信。`);
        } catch (err) {
          logger.error(
            `auth.login: failed to save account data accountId=${waitResult.accountId} err=${String(err)}`,
          );
          log(`⚠️  保存账号数据失败: ${String(err)}`);
        }
      } else if (waitResult.alreadyConnected) {
        // Server confirmed this OpenClaw is already bound to the scanned bot;
        // local credentials are intact, nothing to persist. Exit successfully
        // so that automated installers don't treat re-runs as login failures.
        // The QR poller already wrote the user-facing message to stdout, so
        // we deliberately do NOT echo it again via `log(...)`.
        logger.info(
          `auth.login: bot already connected to this OpenClaw accountId=${account.accountId}`,
        );
      } else {
        logger.warn(
          `auth.login: login did not complete accountId=${account.accountId} message=${waitResult.message}`,
        );
        // log(waitResult.message);
        throw new Error(waitResult.message);
      }
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      logger.debug(`startAccount entry`);
      if (!ctx) {
        logger.warn(`gateway.startAccount: called with undefined ctx, skipping`);
        return;
      }
      const account = ctx.account;
      const aLog = logger.withAccount(account.accountId);
      aLog.debug(`about to call monitorWeixinProvider`);
      restoreContextTokens(account.accountId);
      aLog.info(`starting weixin webhook`);

      ctx.setStatus?.({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
        lastEventAt: Date.now(),
      });

      if (!account.configured) {
        aLog.error(`account not configured`);
        ctx.log?.error?.(
          `[${account.accountId}] weixin not logged in — run: openclaw channels login --channel openclaw-weixin`,
        );
        ctx.setStatus?.({ accountId: account.accountId, running: false });
        throw new Error("weixin not configured: missing token");
      }

      ctx.log?.info?.(`[${account.accountId}] starting weixin provider (${DEFAULT_BASE_URL})`);

      try {
        const resp = await notifyStart({
          baseUrl: account.baseUrl,
          token: account.token,
        });
        if (resp.ret !== undefined && resp.ret !== 0) {
          aLog.warn(`notifyStart: ret=${resp.ret} errmsg=${resp.errmsg ?? ""}`);
        }
      } catch (err) {
        aLog.warn(`notifyStart failed during startup (ignored): ${String(err)}`);
      }

      const logPath = aLog.getLogFilePath();
      ctx.log?.info?.(`[${account.accountId}] weixin logs: ${logPath}`);

      // The gateway injects the channel runtime surface per-call (task-scoped). We require it:
      // it carries reply/routing/session/media/commands helpers used by processOneMessage.
      // Available on hosts >= 2026.2.19 (our peerDependency is >= 2026.3.22).
      if (!ctx.channelRuntime) {
        const msg = `ctx.channelRuntime missing — host too old or plugin SDK contract violated`;
        aLog.error(msg);
        ctx.log?.error?.(`[${account.accountId}] ${msg}`);
        ctx.setStatus?.({ accountId: account.accountId, running: false });
        throw new Error(msg);
      }

      const { monitorWeixinProvider } = await import("./monitor/monitor.js");
      return monitorWeixinProvider({
        baseUrl: account.baseUrl,
        cdnBaseUrl: account.cdnBaseUrl,
        token: account.token,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        channelRuntime: ctx.channelRuntime as unknown as PluginRuntime["channel"],
        abortSignal: ctx.abortSignal,
        setStatus: ctx.setStatus,
      });
    },
    stopAccount: async (ctx) => {
      const account = ctx.account;
      const aLog = logger.withAccount(account.accountId);
      if (!account.configured || !account.token?.trim()) {
        aLog.debug(`gateway.stopAccount: skip notifyStop (not configured or no token)`);
        return;
      }
      try {
        const resp = await notifyStop({
          baseUrl: account.baseUrl,
          token: account.token,
        });
        if (resp.ret !== undefined && resp.ret !== 0) {
          aLog.warn(`notifyStop: ret=${resp.ret} errmsg=${resp.errmsg ?? ""}`);
        }
      } catch (err) {
        aLog.warn(`notifyStop failed during shutdown (ignored): ${String(err)}`);
      }
    },
    loginWithQrStart: async ({ accountId, force, verbose }) => {
      // For re-login: use saved baseUrl from account data; fall back to default for new accounts.
      const savedBaseUrl = accountId ? loadWeixinAccount(accountId)?.baseUrl?.trim() : "";
      const result: WeixinQrStartResult = await startWeixinLoginWithQr({
        accountId: accountId ?? undefined,
        apiBaseUrl: savedBaseUrl || DEFAULT_BASE_URL,
        botType: DEFAULT_ILINK_BOT_TYPE,
        force,
        verbose,
      });
      // Return sessionKey so the client can pass it back in loginWithQrWait.
      return {
        qrDataUrl: result.qrcodeUrl,
        message: result.message,
        sessionKey: result.sessionKey,
      } as { qrDataUrl?: string; message: string };
    },
    loginWithQrWait: async (params) => {
      // sessionKey is forwarded by the client after loginWithQrStart (runtime param extension).
      const sessionKey = (params as { sessionKey?: string }).sessionKey || params.accountId || "";
      const savedBaseUrl = params.accountId
        ? loadWeixinAccount(params.accountId)?.baseUrl?.trim()
        : "";
      const result: WeixinQrWaitResult = await waitForWeixinLogin({
        sessionKey,
        apiBaseUrl: savedBaseUrl || DEFAULT_BASE_URL,
        timeoutMs: params.timeoutMs,
      });

      if (result.connected && result.botToken && result.accountId) {
        try {
          const normalizedId = normalizeAccountId(result.accountId);
          saveWeixinAccount(normalizedId, {
            token: result.botToken,
            baseUrl: result.baseUrl,
            userId: result.userId,
          });
          registerWeixinAccountId(normalizedId);
          if (result.userId) {
            clearStaleAccountsForUserId(normalizedId, result.userId, clearContextTokensForAccount);
          }
          triggerWeixinChannelReload();
          logger.info(`loginWithQrWait: saved account data for accountId=${normalizedId}`);
        } catch (err) {
          logger.error(`loginWithQrWait: failed to save account data err=${String(err)}`);
        }
      }

      return {
        connected: result.connected,
        message: result.message,
        accountId: result.accountId,
      } as { connected: boolean; message: string };
    },
  },
};
