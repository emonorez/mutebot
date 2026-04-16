# MuteBot

A Discord bot that lets the community vote to mute a user. When `/mute @user` is called, a 60-second poll runs in the channel. If yes-votes outnumber no-votes, and yes-votes are equal or greater than 3, the target receives the **Muted** role for 15 minutes. Mutes are persisted to SQLite and survive both bot restarts and the target leaving and rejoining the server.

## Requirements

- Node.js 18+
- A Discord bot token with the **Server Members Intent** enabled in the [Developer Portal](https://discord.com/developers/applications)
- Docker + Docker Compose (optional)

## Setup

1. Copy `.env.example` to `.env` and fill in your token:
   ```
   DISCORD_TOKEN=your_bot_token_here
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Run the bot:
   ```
   npm start
   ```

## Docker

```
docker compose up --build
```

The SQLite database is written to `./data/mutes.db` on the host via a volume mount, so it survives container rebuilds.

## Discord configuration

### OAuth2 scopes
Both are required when generating the invite URL:
- `bot`
- `applications.commands` — required for slash command registration

### Bot permissions
| Permission | Why |
|---|---|
| Administrator | Ensures the bot can set permission overwrites on every channel, including private ones |

> If you prefer not to use Administrator, the minimum set is: **Manage Roles**, **Manage Channels**, **Send Messages**, **Embed Links**, **Add Reactions**, **Read Message History**. The bot's role must also sit above the Muted role and the roles of any users it mutes in the server hierarchy.

### Gateway intents
| Intent | Privileged | Why |
|---|---|---|
| `Guilds` | No | Guild, role, and channel cache |
| `GuildMessageReactions` | No | Reaction collector for the vote poll |
| `GuildMembers` | **Yes** | `guildMemberAdd` event and `members.fetch()` |

`GuildMembers` must be explicitly enabled under **Privileged Gateway Intents** in the Developer Portal.

## How it works

### `/mute @user`
1. Immediately rejects bots and self-mutes with an ephemeral reply.
2. Defers the interaction to avoid Discord's 3-second timeout window.
3. Fetches the target member fresh from the API.
4. Looks up the **Muted** role by name; creates it automatically if it doesn't exist (see below).
5. Sends an embed poll and adds 👍 / 👎 reactions. Each user can cast one vote — the first reaction wins, duplicates are ignored.
6. After 60 seconds the collector closes. If yes > no, the mute is applied. Ties and failures send a result message with the final vote count.

### Role hierarchy

Discord enforces a strict hierarchy for role management: a bot can only assign or remove roles that sit **below its own highest role**, and can only do so to members whose highest role is also **below the bot's role**. This applies even with Administrator.

| Role | Who positions it | Where it should sit |
|---|---|---|
| **MuteBot** (the bot's role) | Admin, manually | As high as possible — just below Server Owner. Must be above the highest role of any user you intend to mute. |
| **Muted** | Bot, automatically | Rank 1 (just above @everyone). |

The Muted role does **not** need to be high to be effective. Muting works through channel permission overwrites (deny `SendMessages`, etc.), which apply regardless of role rank. The one exception: if another role on the same channel has an explicit **allow** overwrite for a denied permission, that allow wins — but this is rare in default server setups.

The bot **cannot** move its own role. That step is manual.

### Muted role creation
On first use the bot creates a **Muted** role with no permissions (`#010101`), and iterates every channel to set deny overwrites:

| Channel type | Denied permissions |
|---|---|
| Text, Announcement, Forum | `SendMessages`, `AddReactions`, `SendMessagesInThreads` |
| Voice | `Connect`, `SendMessages` (voice text chat) |
| Stage | `Connect`, `Speak`, `SendMessages` |

Channels created after the role is set up will not have these overwrites automatically — you would need to set them manually or delete the Muted role so the bot recreates it.

### Mute lifecycle
- On mute: the expiry timestamp (`Date.now() + 15 min`) is written to SQLite and a `setTimeout` is scheduled.
- On unmute: the DB entry is deleted first (unconditionally), then the role is removed. If the role removal fails (e.g. the user left the server mid-mute), the DB is still clean.
- On restart: the `ready` event fetches all guild members, finds any with a DB entry, and restores their unmute timers with the correct remaining duration. Entries whose expiry already passed are cleaned up immediately.
- On rejoin: if a muted user leaves and rejoins before the mute expires, `guildMemberAdd` re-applies the role and reschedules the unmute timer for the remaining duration. If the mute already expired while they were gone, the stale DB entry is deleted and the user is not re-muted.

## Project structure

```
mutebot/
├── bot.js            # All bot logic
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── data/             # SQLite database (gitignored, created at runtime)
    └── mutes.db
```
