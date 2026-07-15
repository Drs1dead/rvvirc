/**
 * RVVIRC Telegram notify service (deploy to Bothost → rvvirc.bothost.tech:3000)
 *
 * Endpoints:
 *   GET  /health
 *   POST /hook              — events from main site (X-Notify-Secret)
 *   POST /telegram/webhook  — Telegram Bot updates (/start <code>)
 */
require("dotenv").config();

const express = require("express");

const PORT = Number(process.env.PORT) || 3000;
const NOTIFY_SECRET = String(process.env.NOTIFY_SECRET || "").trim();
const BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const ADMIN_CHAT = String(process.env.TELEGRAM_ADMIN_CHAT_ID || "").trim();
const SITE_URL = String(process.env.SITE_URL || "")
  .trim()
  .replace(/\/$/, "");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

function checkSecret(req) {
  const h = String(req.get("X-Notify-Secret") || "").trim();
  return Boolean(NOTIFY_SECRET && h && h === NOTIFY_SECRET);
}

async function tgSend(chatId, text) {
  if (!BOT_TOKEN || !chatId) return false;
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: String(text).slice(0, 4000),
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("tg send", res.status, body.slice(0, 200));
  }
  return res.ok;
}

function formatEvent(body) {
  const type = body.type || "event";
  const title = body.title || "Релиз";
  const artists = body.artists ? ` — ${body.artists}` : "";
  const site = body.siteUrl || "";
  if (type === "release.moderation") {
    return `🆕 На модерацию\n${title}${artists}\n#${body.releaseId || "?"} · ${body.ownerEmail || ""}\n${site}/admin`;
  }
  if (type === "release.approved") {
    return `✅ Опубликован\n${title}${artists}\n#${body.releaseId || "?"}\n${site}`;
  }
  if (type === "release.rejected") {
    return `❌ Отклонён\n${title}${artists}\nПричина: ${body.reason || "—"}\n#${body.releaseId || "?"}`;
  }
  return `RVVIRC: ${type}\n${title}${artists}`;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    bot: Boolean(BOT_TOKEN),
    adminChat: Boolean(ADMIN_CHAT),
  });
});

app.post("/hook", async (req, res) => {
  if (!checkSecret(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const body = req.body || {};
  const text = formatEvent(body);

  const jobs = [];
  if (ADMIN_CHAT) jobs.push(tgSend(ADMIN_CHAT, text));
  if (
    body.telegramChatId &&
    String(body.telegramChatId) !== String(ADMIN_CHAT) &&
    (body.type === "release.approved" || body.type === "release.rejected")
  ) {
    jobs.push(tgSend(body.telegramChatId, text));
  }
  await Promise.allSettled(jobs);
  return res.json({ ok: true });
});

app.post("/telegram/webhook", async (req, res) => {
  res.json({ ok: true });
  try {
    const msg = req.body && req.body.message;
    if (!msg || !msg.text || !msg.chat) return;
    const text = String(msg.text).trim();
    const chatId = String(msg.chat.id);
    const m = text.match(/^\/start(?:@\w+)?(?:\s+([a-f0-9]{16,64}))?$/i);
    if (!m) {
      await tgSend(
        chatId,
        "RVVIRC: откройте кабинет → «Подключить Telegram», затем нажмите Start по ссылке."
      );
      return;
    }
    const code = m[1];
    if (!code) {
      await tgSend(
        chatId,
        "Чтобы привязать аккаунт, нажмите ссылку из кабинета RVVIRC (с кодом)."
      );
      return;
    }
    if (!SITE_URL || !NOTIFY_SECRET) {
      await tgSend(chatId, "Сервис ещё не настроен (SITE_URL / NOTIFY_SECRET).");
      return;
    }
    const bindRes = await fetch(`${SITE_URL}/api/internal/telegram-bind`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Notify-Secret": NOTIFY_SECRET,
      },
      body: JSON.stringify({ code, chatId }),
    });
    if (bindRes.ok) {
      await tgSend(chatId, "Готово! Telegram привязан к кабинету RVVIRC.");
    } else {
      await tgSend(
        chatId,
        "Не удалось привязать код (истёк или уже использован). Создайте новую ссылку в кабинете."
      );
    }
  } catch (err) {
    console.error("telegram webhook", err);
  }
});

app.listen(PORT, () => {
  console.log(`rvvirc-notify on :${PORT}`);
});
