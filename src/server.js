require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const Database = require("better-sqlite3");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const required = ["DISCORD_BOT_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_GUILD_ID", "OAUTH_REDIRECT_URI", "STATE_SECRET"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}
if (process.env.STATE_SECRET.length < 32) {
  console.error("STATE_SECRET must be at least 32 characters.");
  process.exit(1);
}

const PORT = Number(process.env.PORT || 3000);
const PARTNER_ROLE_ID = process.env.PARTNER_ROLE_ID || "";
const OWNER_DISCORD_USER_ID = process.env.OWNER_DISCORD_USER_ID || "";
const databasePath = process.env.DATABASE_PATH || "./data/rabbit-ranks.sqlite";
fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS links (
    account_id TEXT PRIMARY KEY,
    discord_user_id TEXT NOT NULL UNIQUE,
    linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "8kb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: "draft-7", legacyHeaders: false }));

function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", process.env.STATE_SECRET).update(body).digest("base64url");
  return body + "." + sig;
}
function verifyState(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac("sha256", process.env.STATE_SECRET).update(parts[0]).digest();
  let supplied;
  try { supplied = Buffer.from(parts[1], "base64url"); } catch { return null; }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!data.accountId || !data.exp || data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}
function validAccountId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{16,80}$/.test(value);
}
function rankFor(member) {
  if (OWNER_DISCORD_USER_ID && member.id === OWNER_DISCORD_USER_ID) {
    return { rank: "owner", color: "#FF0000", badge: "red" };
  }
  if (PARTNER_ROLE_ID && member.roles.cache.has(PARTNER_ROLE_ID)) {
    return { rank: "partner", color: "#55E6E6", badge: "aqua" };
  }
  if (member.premiumSince) {
    return { rank: "booster", color: "#FF69B4", badge: "pink" };
  }
  return { rank: "normal", color: "#FFFFFF", badge: "white" };
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "rabbit-launcher-verification" }));

app.get("/connect/:accountId", (req, res) => {
  const accountId = req.params.accountId;
  if (!validAccountId(accountId)) return res.status(400).send("Invalid launcher account ID.");
  const state = signState({ accountId, exp: Date.now() + 10 * 60 * 1000, nonce: crypto.randomUUID() });
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.OAUTH_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
    state,
  });
  res.redirect("https://discord.com/oauth2/authorize?" + params.toString());
});

app.get("/oauth/callback", async (req, res) => {
  const state = verifyState(req.query.state);
  if (!state || typeof req.query.code !== "string") return res.status(400).send("Link expired or invalid. Return to Rabbit Launcher and try again.");
  try {
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: req.query.code,
        redirect_uri: process.env.OAUTH_REDIRECT_URI,
      }),
    });
    if (!tokenResponse.ok) throw new Error("Discord token exchange failed");
    const token = await tokenResponse.json();
    const userResponse = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!userResponse.ok) throw new Error("Discord account lookup failed");
    const user = await userResponse.json();

    db.prepare("DELETE FROM links WHERE discord_user_id = ? AND account_id != ?").run(user.id, state.accountId);
    db.prepare(`INSERT INTO links (account_id, discord_user_id) VALUES (?, ?)
      ON CONFLICT(account_id) DO UPDATE SET discord_user_id = excluded.discord_user_id, linked_at = CURRENT_TIMESTAMP`)
      .run(state.accountId, user.id);

    res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rabbit Launcher linked</title></head><body style="font-family:system-ui;background:#101014;color:#fff;display:grid;place-items:center;min-height:90vh"><main style="max-width:440px;padding:28px;text-align:center"><h1>Discord connected!</h1><p>Your Discord account <b>${escapeHtml(user.username)}</b> is now linked to Rabbit Launcher.</p><p>You can return to the launcher. Your rank badge will refresh automatically.</p></main></body></html>`);
  } catch (error) {
    console.error("OAuth callback error:", error.message);
    res.status(502).send("Could not finish Discord linking. Please try again.");
  }
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

app.get("/api/rank/:accountId", async (req, res) => {
  const accountId = req.params.accountId;
  if (!validAccountId(accountId)) return res.status(400).json({ error: "invalid_account_id" });
  const link = db.prepare("SELECT discord_user_id FROM links WHERE account_id = ?").get(accountId);
  if (!link) return res.json({ rank: "normal", color: "#FFFFFF", badge: "white", linked: false });
  try {
    const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
    const member = await guild.members.fetch({ user: link.discord_user_id, force: true });
    return res.json({ ...rankFor(member), linked: true, checkedAt: new Date().toISOString() });
  } catch (error) {
    if (error.code === 10007 || error.code === 10013) {
      db.prepare("DELETE FROM links WHERE account_id = ?").run(accountId);
      return res.json({ rank: "normal", color: "#FFFFFF", badge: "white", linked: false });
    }
    console.error("Rank lookup error:", error.message);
    return res.status(503).json({ error: "rank_temporarily_unavailable" });
  }
});

app.post("/api/unlink/:accountId", (req, res) => {
  const accountId = req.params.accountId;
  if (!validAccountId(accountId)) return res.status(400).json({ error: "invalid_account_id" });
  db.prepare("DELETE FROM links WHERE account_id = ?").run(accountId);
  res.json({ ok: true });
});

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName("rank").setDescription("Check your Rabbit Launcher rank."),
    new SlashCommandBuilder().setName("rank-help").setDescription("Explain Rabbit Launcher rank badges."),
  ].map((command) => command.toJSON());
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID), { body: commands });
}

client.once("ready", async () => {
  console.log(`Discord bot ready as ${client.user.tag}`);
  try { await registerCommands(); console.log("Guild slash commands registered."); }
  catch (error) { console.error("Could not register slash commands:", error.message); }
});
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "rank-help") {
    return interaction.reply({ ephemeral: true, content: "Link Discord in Rabbit Launcher to sync your badge. Real server boosters get 🩷 Booster; approved Partner role gets 🩵 Partner; everyone else gets ⚪ Normal. Owner is a red badge only." });
  }
  if (interaction.commandName === "rank") {
    return interaction.reply({ ephemeral: true, content: "Open Rabbit Launcher → Settings → Connect Discord to link your account and view your verified rank." });
  }
});

const server = app.listen(PORT, () => console.log(`HTTP server listening on :${PORT}`));
client.login(process.env.DISCORD_BOT_TOKEN).catch((error) => {
  console.error("Discord login failed:", error.message);
  process.exit(1);
});

function shutdown() {
  server.close();
  client.destroy();
  db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
