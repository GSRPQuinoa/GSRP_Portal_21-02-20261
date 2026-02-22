// --- GSRP Portal script.js (Updated: Visual Mentions, No Ping) ---

let currentUser = null;

function showLoginOverlay() {
  document.getElementById("loginOverlay")?.classList.remove("hidden");
}
function hideLoginOverlay() {
  document.getElementById("loginOverlay")?.classList.add("hidden");
}

function getUserHandle(user) {
  if (!user) return "";
  if (
    user.discriminator &&
    String(user.discriminator).trim() &&
    String(user.discriminator) !== "0"
  ) {
    return user.username + "#" + user.discriminator;
  }
  return user.tag || user.username;
}

/* =========================================================
   Discord ID formatting (visual mention, no ping)
   ========================================================= */

const __discordMemberCache = new Map();

function extractDiscordIds(raw) {
  if (!raw) return [];
  const str = String(raw);
  const matches = str.match(/\d{15,20}/g);
  return matches ? Array.from(new Set(matches)) : [];
}

async function fetchMemberDisplayName(id) {
  if (__discordMemberCache.has(id)) return __discordMemberCache.get(id);

  try {
    const res = await fetch(`/api/discord/member/${encodeURIComponent(id)}`, {
      credentials: "include",
    });
    const data = await res.json().catch(() => ({}));
    const name = data && data.ok && data.displayName ? String(data.displayName) : "";
    __discordMemberCache.set(id, name);
    return name;
  } catch (e) {
    __discordMemberCache.set(id, "");
    return "";
  }
}

function wrapNameForLog(name) {
  const n = String(name || "").trim();
  if (!n) return "";
  return n.startsWith("[") ? n : `[${n}]`;
}

function looksLikeDiscordIdField(fieldKey) {
  const k = String(fieldKey || "").toLowerCase();
  return (
    (k.includes("discord") && k.includes("id")) ||
    k.includes("discord_id") ||
    k.includes("discordid")
  );
}

async function formatDiscordIdsInValue(label, value) {
  if (!value) return value;
  if (!looksLikeDiscordIdField(label)) return value;

  const ids = extractDiscordIds(value);
  if (!ids.length) return value;

  let out = String(value);

  for (const id of ids) {
    const nickRaw = await fetchMemberDisplayName(id);
    const nick = wrapNameForLog(nickRaw) || "(Unknown User)";

    // Visual mention included but will NOT ping
    const replacement = `${nick} - (${id}) <@${id}>`;

    out = out.replace(new RegExp(`\\b${id}\\b`, "g"), replacement);
    out = out.replace(new RegExp(`<@!?${id}>`, "g"), replacement);
  }

  return out;
}

/* =========================================================
   Multi-select collapse
   ========================================================= */

function collapseMultiValueFields(entries) {
  const order = [];
  const map = new Map();

  for (const [k, v] of entries) {
    if (!map.has(k)) {
      map.set(k, []);
      order.push(k);
    }
    map.get(k).push(v);
  }

  return order.map((k) => {
    const vals = (map.get(k) || [])
      .map((x) => (x == null ? "" : String(x).trim()))
      .filter(Boolean);

    const joined = vals.length > 1 ? vals.join(", ") : vals[0] || "";
    return [k, joined];
  });
}

/* =========================================================
   Send to Discord
   ========================================================= */

async function sendToDiscord(formName, fields, user, webhook) {
  const blocks = await Promise.all(
    fields.map(async ([k, v]) => {
      const formatted = await formatDiscordIdsInValue(k, v || "");
      const val = (formatted || "").trim() || "*n/a*";
      return `**${k}:**\n${val}`;
    })
  );

  const description = [
    "Georgia State Roleplay. Cuz We Can.",
    "",
    ...blocks,
  ].join("\n\n");

  const payload = {
    username: "Portal Logs",
    allowed_mentions: { parse: [] }, // prevents ALL pings
    embeds: [
      {
        title: formName || "Portal Submission",
        description,
        color: 0xf97316,
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error("Webhook returned " + res.status);
}

