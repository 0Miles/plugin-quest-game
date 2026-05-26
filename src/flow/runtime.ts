/**
 * Shared runtime handles for the flow files. Set once at startup by
 * `index.ts` via `wireRuntime`; everywhere else reads `runtime()` to
 * call the bot RPC or log. Splitting this out avoids threading
 * `started` (the SDK's `StartedPlugin`) through every command /
 * component handler signature.
 *
 * `runtime()` throws if accessed before `wireRuntime` — which only
 * matters if you import a flow file at module-init time and try to
 * call out to the bot synchronously. The slash + component handler
 * paths run after start, so they're safe.
 */

import type { Discord, Voice } from "@karyl-chan/plugin-sdk";

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export type BotRpc = (
  path: string,
  body?: unknown,
) => Promise<unknown | null>;

interface Runtime {
  botRpc: BotRpc;
  /** Typed Discord RPC facade (Lockdown L-2). */
  discord: Discord;
  /** Typed Voice RPC facade. */
  voice: Voice;
  log: Logger;
  /**
   * Browser-reachable base URL for this plugin's HTTP surface
   * (e.g. `https://bot.example.com/plugin/karyl-quest-game`). Discord
   * embed thumbnails / images use this — the bot needs a public URL
   * it can fetch from, not the internal http://karyl-plugin-quest-game:3000.
   */
  publicBaseUrl(): string;
}

let active: Runtime | null = null;

/**
 * Hard ceiling on a single bot RPC. The bot↔plugin hop can stall — a
 * Discord rate-limit, a wedged socket, the bot mid-restart — and an
 * `await runtime().botRpc(...)` with no ceiling propagates that stall
 * all the way up: a WebUI `POST /api/game/action` awaiting a stage's
 * `messages.edit` would hang its HTTP response forever, freezing the
 * board's action button.
 *
 * On timeout the call resolves to `null` — the exact value every
 * Discord helper in `flow/discord.ts` already treats as a graceful
 * failure (caller logs + carries on). A genuine rejection from the
 * underlying RPC still propagates unchanged.
 */
export const BOT_RPC_TIMEOUT_MS = 8000;

/** Wrap a `botRpc` so a stalled call resolves to `null` after the ceiling. */
function withRpcTimeout(inner: BotRpc): BotRpc {
  return (path, body) => {
    const call = inner(path, body);
    // The real call may lose the race to the timeout — keep its eventual
    // rejection from surfacing as an unhandled rejection.
    call.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        active?.log.warn("quest-game: bot RPC timed out — treating as failure", {
          path,
          timeoutMs: BOT_RPC_TIMEOUT_MS,
        });
        resolve(null);
      }, BOT_RPC_TIMEOUT_MS);
    });
    return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
  };
}

export function wireRuntime(r: Runtime): void {
  active = { ...r, botRpc: withRpcTimeout(r.botRpc) };
}

export function runtime(): Runtime {
  if (!active) {
    throw new Error("quest-game runtime not wired yet — call wireRuntime first");
  }
  return active;
}
