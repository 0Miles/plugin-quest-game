/**
 * Test harness for stage-level integration tests.
 *
 * The quest-game flow code calls Discord via `runtime().botRpc(...)`. We
 * install a fake runtime that:
 *  - assigns predictable, increasing message ids so `state.current.messageId`
 *    is captured deterministically;
 *  - records every RPC call with path + body for assertion;
 *  - returns sensible defaults for the four endpoints stages use:
 *    `messages.send`, `messages.edit`, `messages.delete`, `interactions.followup`.
 *
 * The fake runtime is per-test (each test installs its own to keep
 * the call log isolated).
 */
import type { ComponentContext } from "@karyl-chan/plugin-sdk";
import { createPluginRpc } from "@karyl-chan/plugin-sdk";
import { wireRuntime, type BotRpc, type Logger } from "../flow/runtime.js";
import { onComponent } from "../flow/dispatcher.js";
import {
  getGame,
  removeGame,
  setGame,
  listGames,
} from "../game/store.js";
import { listSignups, removeSignup } from "../flow/signup.js";
import {
  deal,
  newGameState,
  type GameState,
  type Player,
} from "../game/state.js";

export interface RpcCall {
  path: string;
  body: unknown;
}

export interface LogEntry {
  level: "info" | "warn" | "error";
  msg: string;
  meta?: Record<string, unknown>;
}

export interface InstalledHarness {
  calls: RpcCall[];
  logs: LogEntry[];
  /** Pull calls whose `path` matches `pathSubstring` and reset the filter. */
  callsTo: (pathSubstring: string) => RpcCall[];
  /** Pull log entries at a given level (and optionally with a msg substring). */
  logsAt: (level: LogEntry["level"], msgSubstring?: string) => LogEntry[];
  /** Get the most-recent message id the fake handed out, or null. */
  lastMessageId: () => string | null;
  /** Reset the RPC call log mid-test. */
  resetCalls: () => void;
  /** Force subsequent `messages.send` calls to return null (simulate RPC failure). */
  forceSendFailure: (on: boolean) => void;
}

let _msgCounter = 0;

export function installFakeRuntime(): InstalledHarness {
  const calls: RpcCall[] = [];
  const logs: LogEntry[] = [];
  let sendShouldFail = false;

  // Single call tracker. Both the legacy botRpc fake AND the typed
  // facade route through this lambda so `harness.callsTo(...)` keeps
  // matching whether a call site uses runtime().botRpc(...) or
  // runtime().discord.*. messages.send is the only path that needs
  // a non-trivial response (downstream tests read the returned id).
  const callRpc = async (
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    calls.push({ path, body });
    if (path === "/api/plugin/messages.send") {
      if (sendShouldFail) {
        throw new Error("simulated messages.send failure");
      }
      const channelId =
        (body as { channel_id?: string } | undefined)?.channel_id ?? "unknown";
      _msgCounter++;
      return { id: `msg-${_msgCounter}`, channel_id: channelId };
    }
    return { ok: true };
  };
  const botRpc: BotRpc = async (path, body) => {
    try {
      return await callRpc(path, body);
    } catch {
      return null;
    }
  };
  const rpc = createPluginRpc(callRpc);

  const log: Logger = {
    info: (msg, meta) => logs.push({ level: "info", msg, meta }),
    warn: (msg, meta) => logs.push({ level: "warn", msg, meta }),
    error: (msg, meta) => logs.push({ level: "error", msg, meta }),
  };

  wireRuntime({
    botRpc,
    discord: rpc.discord,
    voice: rpc.voice,
    log,
    publicBaseUrl: () => "http://test.local",
  });

  return {
    calls,
    logs,
    callsTo: (sub) => calls.filter((c) => c.path.includes(sub)),
    logsAt: (level, sub) =>
      logs.filter((l) => l.level === level && (!sub || l.msg.includes(sub))),
    lastMessageId: () => (_msgCounter > 0 ? `msg-${_msgCounter}` : null),
    resetCalls: () => {
      calls.length = 0;
      logs.length = 0;
    },
    forceSendFailure: (on) => {
      sendShouldFail = on;
    },
  };
}

/** Wipe in-memory state. Tests use fresh channelIds, but explicit reset
 *  guards against cross-test pollution if a test forgets. */
export function resetWorldState(): void {
  for (const g of listGames()) removeGame(g.channelId);
  for (const s of listSignups()) removeSignup(s.channelId);
}

/** Build a deterministic GameState with given seat positions. */
export function buildGame(opts: {
  channelId?: string;
  guildId?: string;
  hostUserId?: string;
  positions: Player["position"][];
  ladyEnabled?: boolean;
  round?: number;
  leaderIndex?: number;
  ladyHolderIndex?: number | null;
}): GameState {
  const channelId = opts.channelId ?? `c-${Math.floor(Math.random() * 1e9)}`;
  const positions = opts.positions;
  const game = newGameState({
    guildId: opts.guildId ?? "g",
    channelId,
    hostUserId: opts.hostUserId ?? `u0`,
    signups: positions.map((_p, i) => ({
      userId: `u${i}`,
      displayName: `P${i}`,
    })),
    ladyEnabled: opts.ladyEnabled ?? false,
  });
  // Manually seat positions (skip random deal).
  game.players = positions.map((position, i) => ({
    userId: `u${i}`,
    displayName: `P${i}`,
    index: i,
    position,
    lakeTarget: null,
  }));
  game.stage = "playing";
  game.round = opts.round ?? 1;
  game.leaderIndex = opts.leaderIndex ?? 0;
  game.ladyHolderIndex =
    opts.ladyHolderIndex !== undefined
      ? opts.ladyHolderIndex
      : opts.ladyEnabled
        ? (game.leaderIndex + positions.length - 1) % positions.length
        : null;
  setGame(channelId, game);
  return game;
}

/** Build a dealt (random) game without skipping deal(). For tests that
 *  want the full pipeline including shuffling. */
export function buildDealtGame(opts: {
  channelId?: string;
  guildId?: string;
  hostUserId?: string;
  signupSize: number;
  ladyEnabled?: boolean;
}): GameState {
  const channelId = opts.channelId ?? `c-${Math.floor(Math.random() * 1e9)}`;
  const game = newGameState({
    guildId: opts.guildId ?? "g",
    channelId,
    hostUserId: opts.hostUserId ?? `u0`,
    signups: Array.from({ length: opts.signupSize }, (_, i) => ({
      userId: `u${i}`,
      displayName: `P${i}`,
    })),
    ladyEnabled: opts.ladyEnabled ?? false,
  });
  deal(game);
  setGame(channelId, game);
  return game;
}

export type ClickArgs = {
  channelId: string;
  userId: string;
  componentId: string;
  tail?: string;
  userDisplayName?: string;
  guildId?: string;
  capabilities?: string[];
};

/** Build a synthetic ComponentContext matching the SDK's interface. */
export function fakeClickContext(args: ClickArgs): ComponentContext {
  // Component-level RPC stub: matches the harness's runtime fake.
  // Every call records into the per-test `calls` log via the closure
  // already wired by installFakeRuntime — but for synthetic clicks
  // dispatched OUTSIDE that closure (rare), we route through a
  // no-op RpcCaller. Most tests install the runtime first, so ctx
  // calls inherit the same tracker via runtime().botRpc.
  const noopCall = async (_path: string, _body?: unknown): Promise<unknown> =>
    null;
  const rpc = createPluginRpc(noopCall);
  return {
    pluginKey: "karyl-quest-game",
    customId: `kc:karyl-quest-game:${args.componentId}${args.tail ? `:${args.tail}` : ""}`,
    componentId: args.componentId,
    tail: args.tail ?? "",
    guildId: args.guildId ?? "g",
    channelId: args.channelId,
    messageId: "msg-fake",
    interactionToken: `tok-${args.userId}-${Math.random()}`,
    userId: args.userId,
    userDisplayName: args.userDisplayName ?? args.userId,
    voiceChannelId: null,
    capabilities: args.capabilities ?? [],
    hasCapability: (cap) =>
      (args.capabilities ?? []).includes(cap) ||
      (args.capabilities ?? []).includes("admin"),
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    publicBaseUrl: "http://test.local",
    botRpc: async () => null,
    discord: rpc.discord,
    voice: rpc.voice,
  };
}

/** Fire a single click through the dispatcher. Returns the dispatcher's
 *  reply (usually null). */
export async function click(args: ClickArgs): Promise<unknown> {
  return onComponent(fakeClickContext(args), args.componentId);
}

export { getGame };
