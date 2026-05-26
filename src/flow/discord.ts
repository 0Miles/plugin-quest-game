import type {
  APIEmbed,
  MessageActionRow,
  MessageAttachment,
} from "@karyl-chan/plugin-sdk";
import { runtime } from "./runtime.js";

/**
 * Thin typed wrappers over the bot's plugin RPC for the four Discord
 * operations QuestGame uses. The flow files import these instead of
 * calling botRpc directly so a typo in the endpoint path or payload
 * shape is caught at the call site (and so a future RPC name change
 * is a one-file fix).
 *
 * The bot's discord-error normalisation already maps Missing
 * Permissions / Unknown Channel / etc. to honest HTTP statuses;
 * failure here returns null, the caller decides whether that's
 * recoverable.
 */

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  thumbnail?: { url: string };
  image?: { url: string };
  footer?: { text: string };
}

export interface DiscordButton {
  type: 2;
  /** Style: 1 primary / 2 secondary / 3 success / 4 danger / 5 link. */
  style: 1 | 2 | 3 | 4 | 5;
  /** Action buttons carry `custom_id`; link buttons (style 5) carry `url`. */
  custom_id?: string;
  url?: string;
  label: string;
  disabled?: boolean;
}

export interface DiscordActionRow {
  type: 1;
  components: DiscordButton[];
}

export type Components = DiscordActionRow[];

/**
 * Cast our (structurally-correct but not-discriminated-union) row
 * literals to the SDK's strict `MessageActionRow[]` at the boundary
 * where a `CommandReply` / `ComponentReply` slot expects it. The
 * runtime payload is identical — Discord doesn't care about TS's
 * discriminated-union encoding.
 */
export function asMessageRows(rows: Components): MessageActionRow[] {
  return rows as unknown as MessageActionRow[];
}

/**
 * A file the bot should attach to a message. `path` is a path on
 * THIS plugin's own HTTP surface (e.g. `/art/merlin.png`); the bot
 * fetches it over the internal bot↔plugin network and uploads the
 * bytes to Discord as a real attachment. An embed references the
 * file via `image: { url: "attachment://<name>" }`.
 *
 * This is how role-card / MVP-card images render without the plugin
 * needing a Discord-reachable public URL — Discord serves the file
 * from its own CDN once uploaded.
 */
export interface DiscordAttachment {
  /** Attachment filename; must match the `attachment://<name>` ref. */
  name: string;
  /** Leading-slash path on the plugin's HTTP surface. */
  path: string;
}

/**
 * Build the `{ image, attachment }` pair for an admin-uploaded art
 * file (served by web-routes at `/art/<filename>`). The embed sets
 * `image` to `attachment://<filename>`; the message carries the
 * matching attachment so the bot can fetch + upload it. Used by the
 * deal-reveal, ending MVP, and lake embeds.
 */
export function artAttachment(filename: string): {
  image: { url: string };
  attachment: DiscordAttachment;
} {
  return {
    image: { url: `attachment://${filename}` },
    attachment: { name: filename, path: `/art/${filename}` },
  };
}

/**
 * Send a new message to a channel. Returns the message id on success,
 * or null on failure (RPC blip, missing permission). Caller should
 * treat null as "give up gracefully" — it's the SDK contract.
 *
 * Lockdown L-2: routed through the typed `runtime().discord.messages.*`
 * facade. The facade throws BotRpcError on failure; we collapse it to
 * `null` here to preserve every caller's existing graceful-fallback
 * branch.
 */
export async function sendMessage(opts: {
  channelId: string;
  content?: string;
  embeds?: DiscordEmbed[];
  components?: Components;
  attachments?: DiscordAttachment[];
}): Promise<{ id: string; channelId: string } | null> {
  try {
    const res = await runtime().discord.messages.send({
      channelId: opts.channelId,
      content: opts.content,
      embeds: opts.embeds as unknown as APIEmbed[] | undefined,
      components: opts.components
        ? asMessageRows(opts.components)
        : undefined,
      allowedMentions: { users: [], roles: [] },
      ...(opts.attachments && opts.attachments.length > 0
        ? {
            attachments: opts.attachments as unknown as MessageAttachment[],
          }
        : {}),
    });
    return { id: res.id, channelId: res.channel_id };
  } catch (err) {
    runtime().log.warn("quest-game: messages.send failed", {
      err: (err as Error).message,
    });
    return null;
  }
}

/** Patch an existing message in place. */
export async function editMessage(opts: {
  channelId: string;
  messageId: string;
  content?: string;
  embeds?: DiscordEmbed[];
  components?: Components;
}): Promise<boolean> {
  try {
    await runtime().discord.messages.edit({
      channelId: opts.channelId,
      messageId: opts.messageId,
      content: opts.content,
      embeds: opts.embeds as unknown as APIEmbed[] | undefined,
      components: opts.components
        ? asMessageRows(opts.components)
        : undefined,
    });
    return true;
  } catch {
    return false;
  }
}

/** Delete a message (best-effort; missing / already-deleted is fine). */
export async function deleteMessage(opts: {
  channelId: string;
  messageId: string;
}): Promise<void> {
  await runtime()
    .discord.messages.delete({
      channelId: opts.channelId,
      messageId: opts.messageId,
    })
    .catch(() => undefined);
}

/**
 * Reply to a component interaction. The bot already `deferUpdate`d
 * the click, so this PATCHes the original message. Component handlers
 * can also return `{ content?, embeds?, components? }` directly and
 * the SDK does the same thing — use this when you need to edit a
 * DIFFERENT message than the one the button was on.
 */
export async function respondToInteraction(opts: {
  interactionToken: string;
  content?: string;
  embeds?: DiscordEmbed[];
  components?: Components;
}): Promise<boolean> {
  const res = await runtime().botRpc("/api/plugin/interactions.respond", {
    interaction_token: opts.interactionToken,
    content: opts.content,
    embeds: opts.embeds,
    components: opts.components,
  });
  return res !== null;
}

/**
 * Send an ephemeral follow-up to a component interaction. This is the
 * heart of the no-DM design — private reveals (role cards, mission
 * vote confirmations, lake check results) all go through here.
 */
export async function followupEphemeral(opts: {
  interactionToken: string;
  content?: string;
  embeds?: DiscordEmbed[];
  components?: Components;
  attachments?: DiscordAttachment[];
}): Promise<boolean> {
  const res = await runtime().botRpc("/api/plugin/interactions.followup", {
    interaction_token: opts.interactionToken,
    content: opts.content,
    embeds: opts.embeds,
    components: opts.components,
    ephemeral: true,
    ...(opts.attachments && opts.attachments.length > 0
      ? { attachments: opts.attachments }
      : {}),
  });
  return res !== null;
}

