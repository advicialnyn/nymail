/**
 * TempMail -> Telegram  (NO domain, NO KV) — single-file Cloudflare Worker
 * Powered by mail.tm (https://mail.tm). Mail.gw also works: set MAIL_API=https://api.mail.gw
 *
 * How it works
 *  - The bot creates real mailboxes on mail.tm (/new). A cron trigger polls them every
 *    minute and posts new emails (text, code, attachments) to your Telegram channel.
 *  - No database: the list of active addresses is kept in ONE pinned message in your
 *    private chat with the bot ("tempmail state"). Do not delete or unpin it.
 *  - Mailbox passwords are derived from your BOT_TOKEN, so nothing else is stored.
 *
 * VARIABLES (Worker -> Settings -> Variables and Secrets)
 *   Secrets : BOT_TOKEN, WEBHOOK_SECRET (letters/numbers/_/- only)
 *   Text    : CHANNEL_ID  e.g. -1001234567890 (bot must be admin of the channel)
 *             OWNER_ID    your numeric Telegram user id (only you can use the bot)
 *             MAIL_API    optional, default https://api.mail.tm
 *
 * After deploy:  open  https://<your-worker>.workers.dev/setup?key=<WEBHOOK_SECRET>
 * A Cron Trigger (every minute) is REQUIRED — it is what checks for new mail.
 */

const MAX_ADDRESSES = 10; // Cloudflare free plan allows 50 subrequests per run
const MAX_ATTACHMENTS = 5;
const MAX_ATTACH_BYTES = 20 * 1024 * 1024;
const RAND_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";
const NAME_RE = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/;
const STATE_HEAD = "📦 tempmail state — do not delete or unpin this message";

let SUB = 0; // subrequest counter (used to stay inside the per-run limit)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fx = (url, opts) => {
  SUB++;
  return fetch(url, opts);
};
const json = (o) => new Response(JSON.stringify(o, null, 2), { headers: { "content-type": "application/json" } });

const providerHost = (env) => new URL(env.MAIL_API || "https://api.mail.tm").hostname.replace(/^api\./, "");
const helpText = (env) => `📬 <b>Temp Mail Bot</b>

/new — random address
/new <code>name</code> — custom name
/new <code>2h</code> or <code>name 1d</code> — auto-delete after 30m / 2h / 1d
/list — active addresses (with 🗑 buttons)
/delete <code>name</code> — delete one address
/deleteall — delete all temp addresses
/domains — available domains
/check — check for new mail right now

New emails are posted to your channel within about a minute.
⚠️ Addresses are on shared public domains — don't use them for anything important.

Powered by <a href="https://${providerHost(env)}">${providerHost(env)}</a>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/setup") return setup(url, env);

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json().catch(() => null);
      if (update) ctx.waitUntil(handleUpdate(update, env).catch((e) => console.error("update", e)));
      return new Response("ok");
    }

    return new Response("tempmail (mail.tm) worker is running");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(poll(env).catch((e) => console.error("poll", e)));
  },
};

/* ------------------------------ setup ------------------------------ */

async function setup(url, env) {
  if (!env.WEBHOOK_SECRET || url.searchParams.get("key") !== env.WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const missing = ["BOT_TOKEN", "WEBHOOK_SECRET", "CHANNEL_ID", "OWNER_ID"].filter((k) => !env[k]);
  if (missing.length) return json({ ok: false, missing_variables: missing });

  const webhook = await tg(env, "setWebhook", {
    url: `${url.origin}/webhook`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
  });
  const commands = await tg(env, "setMyCommands", {
    commands: [
      { command: "new", description: "Create a temp address (optional: name, 2h)" },
      { command: "list", description: "List / delete active addresses" },
      { command: "delete", description: "Delete one address" },
      { command: "deleteall", description: "Delete all temp addresses" },
      { command: "domains", description: "Available domains" },
      { command: "check", description: "Check for new mail now" },
      { command: "help", description: "Help" },
    ],
  });
  const channel = await send(env, env.CHANNEL_ID, "✅ Temp mail bot connected. New emails will appear here.");
  const owner = await tg(env, "getChat", { chat_id: env.OWNER_ID });

  let domains;
  try {
    domains = await getDomains(env);
  } catch (e) {
    domains = "ERROR: " + e.message;
  }

  return json({
    webhook: webhook.ok ? "ok" : webhook.description,
    commands: commands.ok ? "ok" : commands.description,
    channel_post: channel.ok ? "ok" : channel.description,
    owner_chat: owner.ok ? "ok" : `${owner.description} — open your bot in Telegram and press Start`,
    mail_api_domains: domains,
    note: "Cron trigger (every minute) must be enabled, otherwise no mail is checked.",
  });
}

/* ------------------------------ Telegram ------------------------------ */

async function tg(env, method, payload) {
  const r = await fx(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!data.ok) console.error("telegram", method, JSON.stringify(data));
  return data;
}

async function tgDoc(env, chat, blob, filename, caption) {
  const fd = new FormData();
  fd.append("chat_id", String(chat));
  fd.append("document", blob, filename);
  if (caption) fd.append("caption", caption.slice(0, 1000));
  const r = await fx(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
  if (!r.ok) console.error("sendDocument failed", r.status, await r.text());
  return r.ok;
}

const send = (env, chat, text, extra = {}) =>
  tg(env, "sendMessage", { chat_id: chat, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });

const edit = (env, chat, mid, text, markup) =>
  tg(env, "editMessageText", {
    chat_id: chat,
    message_id: mid,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(markup ? { reply_markup: markup } : {}),
  });

const kb = (rows) => ({
  inline_keyboard: rows.map((row) => row.map(([text, data]) => ({ text, callback_data: data }))),
});

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function fmtLeft(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function randomName() {
  const a = new Uint8Array(10);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => RAND_CHARS[x % RAND_CHARS.length]).join("");
}

/* -------------- state: one pinned message in the owner's chat -------------- */

async function loadState(env) {
  const r = await tg(env, "getChat", { chat_id: env.OWNER_ID });
  const pm = r.ok && r.result && r.result.pinned_message;
  if (!pm || !pm.text || !pm.text.startsWith(STATE_HEAD)) return { mid: 0, items: [] };
  const items = pm.text
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split("|"))
    .filter((p) => p[0].includes("@"))
    .map((p) => ({ address: p[0].toLowerCase(), expiry: Number(p[1]) || 0 }));
  return { mid: pm.message_id, items };
}

async function saveState(env, st) {
  const text = STATE_HEAD + "\n" + st.items.map((i) => `${i.address}|${i.expiry}`).join("\n");
  if (st.mid) {
    const r = await tg(env, "editMessageText", { chat_id: env.OWNER_ID, message_id: st.mid, text });
    if (r.ok || /not modified/i.test(r.description || "")) return;
  }
  const m = await tg(env, "sendMessage", { chat_id: env.OWNER_ID, text, disable_notification: true });
  if (!m.ok) throw new Error("Could not save state — open the bot chat and press Start");
  st.mid = m.result.message_id;
  await tg(env, "pinChatMessage", { chat_id: env.OWNER_ID, message_id: st.mid, disable_notification: true });
}

/* ------------------------------- mail.tm API ------------------------------- */

const apiBase = (env) => (env.MAIL_API || "https://api.mail.tm").replace(/\/$/, "");
const members = (d) => (Array.isArray(d) ? d : (d && d["hydra:member"]) || []);

async function mt(env, path, o = {}, retried = false) {
  await sleep(110); // stay well under the 8 requests/second limit
  const headers = { Accept: "application/ld+json", ...(o.headers || {}) };
  if (o.body) headers["Content-Type"] = "application/json";
  if (o.token) headers.Authorization = "Bearer " + o.token;
  const r = await fx(apiBase(env) + path, {
    method: o.method || "GET",
    headers,
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  if (r.status === 429 && !retried) {
    await sleep(1200);
    return mt(env, path, o, true);
  }
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { ok: r.ok, status: r.status, data };
}

async function passFor(env, address) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.BOT_TOKEN + ":mailpw"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(address)));
  return btoa(String.fromCharCode(...sig)).replace(/[+/=]/g, "").slice(0, 32);
}

async function getDomains(env) {
  const r = await mt(env, "/domains?page=1");
  if (!r.ok) throw new Error(`domains request failed (HTTP ${r.status})`);
  return members(r.data)
    .filter((d) => d.isActive !== false && !d.isPrivate)
    .map((d) => d.domain);
}

async function createAccount(env, address) {
  const r = await mt(env, "/accounts", { method: "POST", body: { address, password: await passFor(env, address) } });
  if (!r.ok) {
    const why = (r.data && (r.data["hydra:description"] || r.data.detail || r.data.message)) || `HTTP ${r.status}`;
    throw new Error(r.status === 429 ? "Rate limited by mail service — try again in a few seconds" : `Mail service refused: ${why}`);
  }
}

async function login(env, address) {
  const r = await mt(env, "/token", { method: "POST", body: { address, password: await passFor(env, address) } });
  if (!r.ok || !r.data || !r.data.token) {
    const e = new Error(`login failed (HTTP ${r.status})`);
    e.status = r.status;
    throw e;
  }
  return r.data; // { id, token }
}

async function destroy(env, address) {
  let auth;
  try {
    auth = await login(env, address);
  } catch (e) {
    if (e.status === 401 || e.status === 404) return; // already gone
    throw e;
  }
  const r = await mt(env, `/accounts/${auth.id}`, { method: "DELETE", token: auth.token });
  if (!r.ok && r.status !== 404) throw new Error(`delete failed (HTTP ${r.status})`);
}

async function markSeen(env, token, id) {
  let r = await mt(env, `/messages/${id}`, {
    method: "PATCH",
    token,
    headers: { "Content-Type": "application/merge-patch+json" },
  });
  if (!r.ok && (r.status === 415 || r.status === 400)) {
    r = await mt(env, `/messages/${id}`, { method: "PATCH", token, body: {} });
  }
  return r.ok;
}

/* ------------------------------- polling ------------------------------- */

async function poll(env) {
  SUB = 0;
  const st = await loadState(env);
  const result = { boxes: st.items.length, forwarded: 0, errors: [] };
  if (!st.items.length) return result;

  const now = Date.now();
  const gone = new Set();

  for (const it of st.items) {
    if (SUB > 36) break; // leave the rest for the next run

    if (it.expiry && it.expiry < now) {
      await destroy(env, it.address).catch((e) => console.error("expire", it.address, e.message));
      gone.add(it.address);
      continue;
    }

    try {
      const auth = await login(env, it.address);
      const list = await mt(env, "/messages?page=1", { token: auth.token });
      if (!list.ok) throw new Error(`messages request failed (HTTP ${list.status})`);
      const unseen = members(list.data).filter((m) => !m.seen).reverse(); // oldest first
      for (const sm of unseen) {
        if (SUB > 36) break;
        await forward(env, auth, sm);
        result.forwarded++;
      }
    } catch (e) {
      console.error("poll", it.address, e.message);
      result.errors.push(`${it.address}: ${e.message}`);
      if (e.status === 401) {
        gone.add(it.address);
        await send(env, env.OWNER_ID, `⚠️ Mailbox <code>${esc(it.address)}</code> no longer exists on the mail service — removed from your list.`);
      }
    }
  }

  if (gone.size) {
    const fresh = await loadState(env); // re-read so we don't overwrite a concurrent /new
    fresh.items = fresh.items.filter((i) => !gone.has(i.address));
    await saveState(env, fresh);
  }
  return result;
}

async function forward(env, auth, sm) {
  const d = await mt(env, `/messages/${sm.id}`, { token: auth.token });
  if (!d.ok) throw new Error(`message request failed (HTTP ${d.status})`);
  const m = d.data;

  const fo = m.from || sm.from || {};
  const from = (fo.name ? `${fo.name} <${fo.address}>` : fo.address || "unknown").slice(0, 200);
  const subject = (m.subject || sm.subject || "(no subject)").slice(0, 300);
  const to = ((m.to && m.to[0] && m.to[0].address) || (sm.to && sm.to[0] && sm.to[0].address) || "").toLowerCase();
  const html = Array.isArray(m.html) ? m.html.join("\n") : m.html || "";
  const text = ((m.text && m.text.trim()) || (html ? htmlToText(html) : "")).replace(/\r/g, "").trim() || "(empty body)";
  const code = findCode(subject + "\n" + text);

  const atts = (m.attachments || []).filter((a) => !a.related);
  const sendable = atts.filter((a) => (a.size || 0) <= MAX_ATTACH_BYTES).slice(0, MAX_ATTACHMENTS);
  const skipped = atts.filter((a) => !sendable.includes(a));

  const head = [
    "📩 <b>New email</b>",
    `<b>To:</b> <code>${esc(to)}</code>`,
    `<b>From:</b> ${esc(from)}`,
    `<b>Subject:</b> ${esc(subject)}`,
  ];
  if (code) head.push(`🔑 <b>Code:</b> <code>${esc(code)}</code>`);
  if (atts.length) head.push(`📎 <b>Attachments:</b> ${esc(atts.map((a) => a.filename || "file").join(", ").slice(0, 200))}`);
  if (skipped.length) head.push(`⚠️ Not forwarded (too big / limit): ${esc(skipped.map((a) => a.filename || "file").join(", ").slice(0, 150))}`);

  const build = (b) => head.join("\n") + "\n\n" + esc(b);
  let body = text.slice(0, 3000);
  let truncated = text.length > body.length;
  let msg = build(body);
  while (msg.length > 3900) {
    body = body.slice(0, Math.floor(body.length * 0.85));
    truncated = true;
    msg = build(body);
  }
  if (truncated) msg += "\n\n… (truncated — full original attached below)";

  const sent = await send(env, env.CHANNEL_ID, msg);
  if (!sent.ok) throw new Error("telegram: " + (sent.description || "could not post to channel"));

  // attachments
  for (const a of sendable) {
    try {
      await sleep(110);
      const url = /^https?:/.test(a.downloadUrl) ? a.downloadUrl : apiBase(env) + a.downloadUrl;
      const r = await fx(url, { headers: { Authorization: "Bearer " + auth.token } });
      if (r.ok) await tgDoc(env, env.CHANNEL_ID, await r.blob(), a.filename || "file", `📎 ${a.filename || "attachment"}`);
    } catch (e) {
      console.error("attachment", e.message);
    }
  }

  // full original for long messages
  if (truncated) {
    const s = await mt(env, `/sources/${sm.id}`, { token: auth.token });
    if (s.ok && s.data && s.data.data) {
      await tgDoc(env, env.CHANNEL_ID, new Blob([s.data.data], { type: "message/rfc822" }), `mail-${Date.now()}.eml`, "📎 Original message (.eml)");
    }
  }

  // mark as read only after it reached Telegram (so a failure retries next minute)
  if (!(await markSeen(env, auth.token, sm.id)) && !(await markSeen(env, auth.token, sm.id))) {
    console.error("could not mark message as read — it may be forwarded again", sm.id);
  }
}

function findCode(t) {
  const m =
    t.match(/(?:code|otp|pin|passcode|verification|verify|token)\D{0,40}?(\d{4,8})\b/i) ||
    t.match(/\b(\d{4,8})\b\D{0,20}(?:is your|is the)/i);
  return m ? m[1] : "";
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
      .replace(/<a\s[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
        const t = inner.replace(/<[^>]+>/g, "").trim();
        return t && t !== href ? `${t} (${href})` : href;
      })
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, "\n")
      .replace(/<\/td>/gi, " ")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(s) {
  const map = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", zwnj: "", zwj: "" };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(n);
      } catch {
        return "";
      }
    }
    const k = e.toLowerCase();
    return k in map ? map[k] : m;
  });
}

/* ------------------------------ bot commands ------------------------------ */

async function handleUpdate(u, env) {
  if (u.callback_query) return handleCallback(u.callback_query, env);

  const m = u.message;
  if (!m || !m.text) return;
  const chat = m.chat.id;
  if (String(m.from.id) !== String(env.OWNER_ID)) {
    return void (await send(env, chat, "🔒 This is a private bot."));
  }

  const [cmdRaw, ...args] = m.text.trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@.*$/, "");

  try {
    switch (cmd) {
      case "/start":
      case "/help":
        await send(env, chat, helpText(env));
        break;
      case "/new":
        await cmdNew(env, chat, args);
        break;
      case "/list": {
        const v = renderList((await loadState(env)).items);
        await send(env, chat, v.text, v.markup ? { reply_markup: v.markup } : {});
        break;
      }
      case "/delete":
      case "/del":
        await cmdDelete(env, chat, args[0]);
        break;
      case "/deleteall":
        await send(env, chat, "⚠️ Delete <b>all</b> temp addresses?", {
          reply_markup: kb([[["Yes, delete all", "delall:x"], ["Cancel", "cancel:x"]]]),
        });
        break;
      case "/domains": {
        const d = await getDomains(env);
        await send(env, chat, d.length ? "🌐 <b>Available domains</b>\n" + d.map((x) => `• <code>${esc(x)}</code>`).join("\n") + "\n\nUse <code>/new name@domain</code>" : "No active domains right now.");
        break;
      }
      case "/check": {
        const r = await poll(env);
        await send(
          env,
          chat,
          `✅ Checked ${r.boxes} mailbox(es) — forwarded ${r.forwarded} new email(s).` +
            (r.errors.length ? "\n⚠️ " + r.errors.map(esc).join("\n⚠️ ") : "")
        );
        break;
      }
      default:
        await send(env, chat, "Unknown command. Try /help");
    }
  } catch (e) {
    await send(env, chat, "⚠️ " + esc(e.message));
  }
}

async function cmdNew(env, chat, args) {
  let local = "";
  let domain = "";
  let ttl = 0;
  for (const a of args) {
    const t = a.match(/^(\d+)([mhd])$/i);
    if (t) ttl = Number(t[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[t[2].toLowerCase()];
    else [local, domain = ""] = a.toLowerCase().split("@");
  }
  if (local && !NAME_RE.test(local)) {
    return void (await send(env, chat, "❌ Name must be 3–32 chars: a-z, 0-9, dot, dash, underscore."));
  }

  const st = await loadState(env);
  if (st.items.length >= MAX_ADDRESSES) {
    return void (await send(env, chat, `❌ Limit is ${MAX_ADDRESSES} addresses. Delete some with /list.`));
  }

  const domains = await getDomains(env);
  if (!domains.length) throw new Error("No active mail domains right now, try again later.");
  if (domain && !domains.includes(domain)) {
    return void (await send(env, chat, `❌ Unknown domain. Available: ${domains.map((d) => "<code>" + esc(d) + "</code>").join(", ")}`));
  }

  const address = `${local || randomName()}@${domain || domains[0]}`;
  if (st.items.some((i) => i.address === address)) {
    return void (await send(env, chat, `❌ <code>${esc(address)}</code> already exists.`));
  }

  await createAccount(env, address);
  const expiry = ttl ? Date.now() + ttl : 0;
  st.items.push({ address, expiry });
  await saveState(env, st);

  await send(
    env,
    chat,
    `✅ <b>New address</b>\n<code>${esc(address)}</code>\n` +
      (expiry ? `⏳ auto-deletes in ${fmtLeft(ttl)}` : "♾ no expiry — delete it when done") +
      "\n📬 Emails show up in your channel within ~1 minute.",
    { reply_markup: kb([[["🗑 Delete", "d:" + address]]]) }
  );
}

async function removeAddress(env, address) {
  const st = await loadState(env);
  const item = st.items.find((i) => i.address === address);
  if (!item) return { found: false };
  let warn = "";
  try {
    await destroy(env, address);
  } catch (e) {
    warn = e.message;
  }
  st.items = st.items.filter((i) => i.address !== address);
  await saveState(env, st);
  return { found: true, warn };
}

async function cmdDelete(env, chat, arg) {
  if (!arg) return void (await send(env, chat, "Usage: /delete <code>name</code> (or full address)"));
  const q = arg.toLowerCase();
  const st = await loadState(env);
  const item = st.items.find((x) => x.address === q || x.address.split("@")[0] === q);
  if (!item) return void (await send(env, chat, "❌ Not found. See /list"));
  const r = await removeAddress(env, item.address);
  await send(env, chat, `🗑 Deleted <code>${esc(item.address)}</code>` + (r.warn ? `\n(mail service said: ${esc(r.warn)})` : ""));
}

function renderList(items) {
  const now = Date.now();
  const live = items.filter((i) => !i.expiry || i.expiry > now);
  if (!live.length) return { text: "📭 No active addresses.\nCreate one with /new" };
  const lines = live.map(
    (r, i) => `${i + 1}. <code>${esc(r.address)}</code>` + (r.expiry ? ` — ⏳ ${fmtLeft(r.expiry - now)}` : "")
  );
  return {
    text: `📋 <b>Active addresses (${live.length})</b>\n\n${lines.join("\n")}\n\nTap to delete:`,
    markup: kb(live.map((r) => [[`🗑 ${r.address}`, "dl:" + r.address]])),
  };
}

async function handleCallback(q, env) {
  await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
  if (String(q.from.id) !== String(env.OWNER_ID) || !q.message) return;

  const chat = q.message.chat.id;
  const mid = q.message.message_id;
  const parts = String(q.data).split(":");
  const action = parts[0];
  const arg = parts.slice(1).join(":");

  try {
    if (action === "d") {
      const r = await removeAddress(env, arg);
      await edit(env, chat, mid, r.found ? `🗑 Deleted <code>${esc(arg)}</code>` : "Already deleted.");
    } else if (action === "dl") {
      await removeAddress(env, arg);
      const v = renderList((await loadState(env)).items);
      await edit(env, chat, mid, v.text, v.markup);
    } else if (action === "delall") {
      const st = await loadState(env);
      for (const it of st.items) await destroy(env, it.address).catch(() => {});
      const n = st.items.length;
      st.items = [];
      await saveState(env, st);
      await edit(env, chat, mid, `🗑 Deleted ${n} address(es).`);
    } else if (action === "cancel") {
      await edit(env, chat, mid, "Cancelled.");
    }
  } catch (e) {
    await send(env, chat, "⚠️ " + esc(e.message));
  }
}
