> [!IMPORTANT]
> **This repository has moved to [karyl-chan/plugin-quest-game](https://github.com/karyl-chan/plugin-quest-game).**
> The new location is the source of truth; this fork is archived and no longer maintained.
>
> Update your remote:
> ```
> git remote set-url origin https://github.com/karyl-chan/plugin-quest-game.git
> ```

# @karyl-chan/plugin-quest-game

Board-game plugin for karyl-chan: an interactive team-deduction quest
game (good team vs hidden-evil team) played entirely with shared
embeds and ephemeral player views — no DMs required. Each player's
private knowledge (role, faction-mates, vote tallies) is delivered
through ephemeral interaction replies; the public message just shows
the current stage and the shared buttons.

Standalone because it carries non-trivial in-memory game state
(per-channel sessions, role assignments, mission history, NPC
timers) and its own admin WebUI for game listing / force-stop.

## `/quest-game`

| Sub-command | What it does |
|---|---|
| `start [options]` | Open signup in the current channel. See [start options](#start-options). |
| `stop` | Cancel signup or end the current game in this channel (also strips active stage buttons). |
| `card` | Re-show the caller's role card ephemerally. |
| `status [public?]` | Show the current game state. Public flag posts a non-ephemeral summary. |
| `manage` | Get a private link to the admin WebUI (requires `plugin:karyl-quest-game:manage`, or bot owner / admin). |
| `webui` | Get a link to the in-game per-player WebUI for the current game. |
| `manual` | List rules and role descriptions. |

### Start options

| Option | Type | Effect |
|---|---|---|
| `npc` | integer | Number of NPC players to fill in (lets a game run with fewer humans; NPCs play automatically through `src/npc/`). |
| `morgana` | bool | Enable the Morgana role. |
| `percival` | bool | Enable the Percival role. |
| `mordred` | bool | Enable the Mordred role. |
| `oberon` | bool | Enable the Oberon role. |
| `lake` | bool | Enable the Lady of the Lake mechanic. |

Defaults are taken from `DEFAULT_ROLE_TOGGLES` in `src/game/roles.ts`.
Role compositions per player count come from
`rolesForPlayerCount(...)` in the same file.

## Game flow

1. **Signup.** `/quest-game start` posts a signup embed with join /
   leave buttons. Players click to opt in; an organizer (start
   caller) presses Begin once the player count is satisfied. NPCs are
   added immediately if requested.
2. **Deal.** Each player privately reveals their role and (where the
   rules grant it) their team-mates through an ephemeral component
   reply.
3. **Stages.** The game loops through mission rounds: leader appoints
   a team → public vote on the team → secret mission resolution by
   the chosen team → win counter updated. The current stage is
   rendered on a single public message that is edited in place;
   active buttons live on that message.
4. **Endgame.** Three mission wins for either team triggers the end;
   if good wins, the evil assassin gets a final guess at Merlin.

State lives in `src/game/store.ts` as a per-channel keyed map. One
channel runs at most one game at a time; `withChannelLock(...)`
serialises concurrent button clicks per channel.

## WebUI

Two surfaces, both reached through the bot's reverse proxy at
`<WEB_BASE_URL>/plugin/karyl-quest-game/`:

- **Per-player view** (`/quest-game webui` and the link embedded in
  the deal-reveal card) — shows the player's role / faction view /
  mission history; tokens are session-scoped and verified offline
  with the bot's Ed25519 public key (SDK's `verifyPluginSession`).
- **Manage view** (`/quest-game manage`) — list active games across
  guilds, force-stop a game. Gated by the
  `plugin:karyl-quest-game:manage` capability (bot owners and `admin`
  capability holders are exempt).

`QUEST_GAME_PUBLIC_URL` is an optional fallback for direct-access
debugging (re-add a `ports:` mapping in docker-compose and set the
env var). In production the bot's `WEB_BASE_URL` provides the
`publicBaseUrl` automatically; leave `QUEST_GAME_PUBLIC_URL` unset.

## Runtime dependencies

- The bot's component-dispatch path (`kc:karyl-quest-game:<action>`
  custom ids) for every in-game button — needs a bot recent enough
  to provide it.
- `messages.send` / `messages.edit` / `messages.delete` to maintain
  the shared stage message.
- `interactions.respond` / `interactions.followup` for ephemeral
  player replies.
- `QUEST_GAME_ART_DIR` volume for role-card art (defaults handled by
  `src/art.ts`).

No audio / native dependencies — the runtime image is plain Node.

## Scripts

| Script | Description |
|---|---|
| `pnpm dev` | Build the WebUI, then run the server with `tsx watch`. |
| `pnpm build` | Build the WebUI and compile the server to `dist/`. |
| `pnpm start` | Run the compiled `dist/index.js`. |
| `pnpm test` | Run the vitest suite (engine, flow, NPC). |
| `pnpm typecheck` | Type-check without emitting. |
| `pnpm simulate` | Run end-to-end game scenarios from `scripts/scenarios/`. |

## Setup

1. Bring the bot up first (creates the `karyl-chan-net` network).
   An admin runs
   `POST /api/plugins/setup-secret { pluginKey: "karyl-quest-game" }`
   and puts the returned cleartext in the plugin's
   `KARYL_PLUGIN_SETUP_SECRET` env var.
2. Build and run with the included `Dockerfile`, attached to the
   `karyl-chan-net` network. The container needs a writable
   `/app/data/art` volume for role-card art.

On startup the plugin registers with the bot, gets a token, a
dispatch HMAC key, and the JWT verify public key, and starts a ~30 s
heartbeat. The bot then registers the `/quest-game` command with
Discord.
