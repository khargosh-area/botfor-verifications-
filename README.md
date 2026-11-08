# Rabbit Launcher Verification Bot

Discord account linking and live rank verification for Rabbit Launcher.

## Rank rules

- **Owner:** configured Discord user ID; red badge only, no extra perks.
- **Partner:** member has the configured Partner role.
- **Booster:** Discord reports an active server boost through the member's `premium_since` field. A manually assigned Booster role is not enough.
- **Normal:** everyone else.

Partner is checked before Booster, so an approved Partner who also boosts receives the Partner badge.

## Requirements

- Node.js 20+
- A Discord application and bot added to your server
- Discord OAuth2 redirect URL configured to exactly match `OAUTH_REDIRECT_URI`
- Enable the **Server Members Intent** in Discord Developer Portal → Bot → Privileged Gateway Intents
- Bot invited with `bot` and `applications.commands` scopes and permission to view the server

## Setup

1. Copy `.env.example` to `.env` and fill in the values.
2. Run `npm install`.
3. Run `npm start`.

The service creates its SQLite database at `DATABASE_PATH` (default: `./data/rabbit-ranks.sqlite`). Ensure hosting provides a persistent disk for this path; otherwise links are lost when the instance is replaced.

## Environment

See [.env.example](.env.example). Never commit `.env`, bot tokens, client secrets, or API keys.

## API

### Connect Discord

The launcher generates and persists a random account ID (at least 16 URL-safe characters), then opens:

`GET /connect/{accountId}`

The player authorizes Discord. The OAuth callback stores the Discord user ID against that launcher account ID. OAuth state is HMAC-signed and expires after 10 minutes.

### Read rank

`GET /api/rank/{accountId}`

Example response:

```json
{ "rank": "normal", "color": "#FFFFFF", "badge": "white", "linked": false }
```

The API fetches the member from the configured guild on every lookup, so a removed boost or role is reflected on the next lookup. Cache results in the launcher briefly (for example 60 seconds) to avoid excessive requests.

### Unlink

`POST /api/unlink/{accountId}`

Removes the link when the player chooses Disconnect Discord.

## Important integration notes

- This is the **backend/bot scaffold**. The Android launcher still needs a Connect Discord screen, account-ID generation/storage, API calls, and in-game nametag rendering.
- Use a cryptographically random per-install/account ID; do not use a Minecraft username as the account ID.
- The account ID is a bearer-style identifier: keep it private and do not expose it in screenshots or public logs.
- The rank endpoint does not accept a rank name from the client. The server decides rank from live Discord guild membership.
- The Discord bot token and OAuth client secret stay on the server. Never put them in the Android APK.
- A client-side nametag mod only renders badges for players whose rank data it can obtain. Showing badges to every viewer on a multiplayer server requires server-side integration or compatible clients.
- Do not grant Owner perks. The Owner mapping only returns the red badge.
