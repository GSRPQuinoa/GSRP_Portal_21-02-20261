require("dotenv").config();

const express = require("express");
const path = require("path");
const cookieSession = require("cookie-session");
const { Pool } = require("pg");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));

// =====================
// SESSION
// =====================
app.use(
  cookieSession({
    name: "gsrp_session",
    secret: process.env.SESSION_SECRET || "change-me",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  })
);

// =====================
// DATABASE
// =====================
const sslEnabled = String(process.env.DATABASE_SSL || "true").toLowerCase() === "true";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslEnabled ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id BIGSERIAL PRIMARY KEY,
      userId TEXT NOT NULL,
      username TEXT,
      displayName TEXT,
      formType TEXT NOT NULL,
      fieldsJson JSONB NOT NULL,
      createdAt TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);
}

// =====================
// STATIC FILES (/public)
// =====================
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// =====================
// DISCORD OAUTH CONFIG
// =====================
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;

// comma-separated role IDs allowed to use portal (optional)
const ALLOWED_ROLE_IDS = (process.env.DISCORD_ALLOWED_ROLE_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// comma-separated role IDs considered admin (optional)
const ADMIN_ROLE_IDS = (process.env.DISCORD_ADMIN_ROLE_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function hasAnyRole(memberRoles, requiredRoles) {
  if (!requiredRoles || requiredRoles.length === 0) return true;
  const set = new Set(memberRoles || []);
  return requiredRoles.some((r) => set.has(r));
}

// =====================
// AUTH HELPERS
// =====================
function requireLogin(req, res, next) {
  if (!req.session || !req.session.user) return res.status(401).json({ ok: false, error: "Not logged in" });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user) return res.status(401).json({ ok: false, error: "Not logged in" });
  if (!req.session.user.isAdmin) return res.status(403).json({ ok: false, error: "Forbidden" });
  next();
}

// =====================
// DISCORD MEMBER LOOKUP (For Form Nickname Display)
// =====================
app.get("/api/discord/member/:id", requireLogin, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    if (!/^\d{15,20}$/.test(id)) {
      return res.json({ ok: false });
    }

    const r = await fetch(
      `https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members/${id}`,
      {
        headers: {
          Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
        },
      }
    );

    if (!r.ok) {
      return res.json({ ok: true, displayName: "" });
    }

    const member = await r.json();

    const displayName =
      member.nick ||
      member.user?.global_name ||
      member.user?.username ||
      "";

    res.json({ ok: true, displayName });
  } catch (e) {
    console.error("Member lookup error:", e);
    res.json({ ok: true, displayName: "" });
  }
});


// =====================
// DISCORD OAUTH ROUTES
// =====================
app.get("/api/login", (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify guilds.members.read",
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    client_secret: DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: DISCORD_REDIRECT_URI,
  });

  const r = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function discordGet(url, accessToken) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

app.get("/api/callback", async (req, res) => {
  try {
    const code = String(req.query.code || "");
    if (!code) return res.status(400).send("Missing code");

    const token = await exchangeCodeForToken(code);
    const accessToken = token.access_token;

    const user = await discordGet("https://discord.com/api/users/@me", accessToken);

    // Requires guilds.members.read + your bot must be in the guild
    const member = await discordGet(
      `https://discord.com/api/users/@me/guilds/${encodeURIComponent(DISCORD_GUILD_ID)}/member`,
      accessToken
    );

    const roles = member.roles || [];
    if (!hasAnyRole(roles, ALLOWED_ROLE_IDS)) {
      req.session = null;
      return res.redirect("/unauthorized.html");
    }

    const isAdmin = hasAnyRole(roles, ADMIN_ROLE_IDS);

    req.session.user = {
      id: user.id,
      username: user.username,
      displayName: member.nick || user.global_name || user.username,
      roles,
      isAdmin,
    };

    res.redirect("/");
  } catch (e) {
    console.error("OAuth error:", e);
    req.session = null;
    res.status(500).send("Login failed. Check server logs.");
  }
});

app.get("/api/logout", (req, res) => {
  req.session = null;
  res.redirect("/");
});

app.get("/api/me", (req, res) => {
  res.json({ ok: true, user: (req.session && req.session.user) || null });
});

// =====================
// LOG STORAGE
// =====================
app.post("/api/logs/store", requireLogin, async (req, res) => {
  try {
    const { formType, fields } = req.body || {};
    if (!formType) return res.status(400).json({ ok: false, error: "Missing formType" });

    const u = req.session.user;
    await pool.query(
      `INSERT INTO logs (userId, username, displayName, formType, fieldsJson)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [u.id, u.username, u.displayName, formType, JSON.stringify(fields || {})]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("store log error:", e);
    res.status(500).json({ ok: false, error: "Failed to store log" });
  }
});

// =====================
// ADMIN ENDPOINTS
// =====================
app.get("/api/admin/logs/summary", requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT userId, MAX(username) AS username, MAX(displayName) AS displayName,
              formType, COUNT(*)::int AS count
       FROM logs
       WHERE archived = FALSE
       GROUP BY userId, formType`
    );
    res.json({ ok: true, rows: r.rows });
  } catch (e) {
    console.error("summary error:", e);
    res.status(500).json({ ok: false, error: "Failed summary" });
  }
});

app.get("/api/admin/logs/user/:userId", requireAdmin, async (req, res) => {
  try {
    const userId = String(req.params.userId || "");
    const r = await pool.query(
      `SELECT id, userId, formType, fieldsJson, createdAt
       FROM logs
       WHERE archived = FALSE AND userId = $1
       ORDER BY createdAt DESC
       LIMIT 200`,
      [userId]
    );
    res.json({ ok: true, logs: r.rows });
  } catch (e) {
    console.error("user logs error:", e);
    res.status(500).json({ ok: false, error: "Failed user logs" });
  }
});

app.post("/api/admin/logs/reset", requireAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE logs SET archived = TRUE WHERE archived = FALSE`);
    res.json({ ok: true });
  } catch (e) {
    console.error("reset error:", e);
    res.status(500).json({ ok: false, error: "Failed reset" });
  }
});

// =====================
// START
// =====================
const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`Listening on ${PORT}`)))
  .catch((err) => {
    console.error("DB init failed:", err);
    process.exit(1);
  });
