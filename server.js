/**
 * RVVIRC Telegram notify service (deploy to Bothost → rvvirc.bothost.tech:3000)
 *
 * Endpoints:
 *   GET  /health
 *   POST /hook              — events from main site (X-Notify-Secret)
 *   POST /telegram/webhook  — Bot updates:
 *       /start phone_<token>  → request_contact → phone-verify
 *       /start <hex>          → telegram-bind (notifications)
 */
require("dotenv").config();

const express = require("express");

const PORT = Number(process.env.PORT) || 3000;
const NOTIFY_SECRET = String(process.env.NOTIFY_SECRET || "").trim();
const BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const ADMIN_CHAT = String(process.env.TELEGRAM_ADMIN_CHAT_ID || "").trim();
const SITE_URL = String(
  process.env.SITE_BY_URL || process.env.SITE_URL || ""
)
  .trim()
  .replace(/\/$/, "");

/** chatId → phone verify token (from /start phone_…) */
const pendingPhone = new Map();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

function checkSecret(req) {
  const h = String(req.get("X-Notify-Secret") || "").trim();
  return Boolean(NOTIFY_SECRET && h && h === NOTIFY_SECRET);
}

async function tgApi(method, payload) {
  if (!BOT_TOKEN) return null;
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("tg", method, res.status, body.slice(0, 200));
  }
  return res;
}

async function tgSend(chatId, text, extra) {
  const body = {
    chat_id: chatId,
    text: String(text).slice(0, 4000),
    disable_web_page_preview: true,
    ...(extra || {}),
  };
  const res = await tgApi("sendMessage", body);
  return Boolean(res && res.ok);
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
  if (type === "application_submitted") {
    return (
      `📝 Новая заявка артиста\n` +
      `${body.name || "—"} · ${body.email || ""}\n` +
      `${body.prospectsText ? body.prospectsText.slice(0, 200) + "…" : ""}\n` +
      `${body.demoUrl || ""}\n${site}/admin`
    );
  }
  if (type === "application_approved") {
    return `✅ Заявка одобрена\n${body.name || "—"} · ${body.email || ""}`;
  }
  if (type === "application_rejected") {
    return (
      `❌ Заявка отклонена\n${body.name || "—"} · ${body.email || ""}\n` +
      `Причина: ${body.reason || "—"}\nПовтор с: ${body.reapplyAt || "—"}`
    );
  }
  return `RVVIRC: ${type}\n${title}${artists}`;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    bot: Boolean(BOT_TOKEN),
    adminChat: Boolean(ADMIN_CHAT),
    siteUrl: Boolean(SITE_URL),
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
    (body.type === "release.approved" ||
      body.type === "release.rejected" ||
      body.type === "application_approved" ||
      body.type === "application_rejected")
  ) {
    jobs.push(tgSend(body.telegramChatId, text));
  }
  await Promise.allSettled(jobs);
  return res.json({ ok: true });
});

async function handlePhoneStart(chatId, token) {
  pendingPhone.set(String(chatId), token);
  await tgSend(
    chatId,
    "Для подтверждения номера нажмите кнопку ниже и разрешите Telegram передать ваш телефон сайту RVVIRC (BY).",
    {
      reply_markup: {
        keyboard: [
          [{ text: "📱 Поделиться номером телефона", request_contact: true }],
        ],
        one_time_keyboard: true,
        resize_keyboard: true,
      },
    }
  );
}

async function handleContact(msg) {
  const chatId = String(msg.chat.id);
  const contact = msg.contact;
  const fromId = msg.from && msg.from.id;
  if (!contact || !contact.phone_number) {
    await tgSend(chatId, "Не получили номер. Нажмите кнопку ещё раз.");
    return;
  }
  if (fromId != null && contact.user_id != null && Number(contact.user_id) !== Number(fromId)) {
    await tgSend(
      chatId,
      "Можно отправить только свой номер (кнопка «Поделиться номером»)."
    );
    return;
  }
  const token = pendingPhone.get(chatId);
  if (!token) {
    await tgSend(
      chatId,
      "Сессия истекла. Вернитесь на by.rvvirc.site → кабинет → «Подтвердить телефон»."
    );
    return;
  }
  if (!SITE_URL || !NOTIFY_SECRET) {
    await tgSend(chatId, "Сервис ещё не настроен (SITE_URL / NOTIFY_SECRET).");
    return;
  }
  const verifyRes = await fetch(`${SITE_URL}/api/internal/phone-verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Notify-Secret": NOTIFY_SECRET,
    },
    body: JSON.stringify({
      token,
      phone: contact.phone_number,
      chatId,
    }),
  });
  pendingPhone.delete(chatId);
  if (verifyRes.ok) {
    await tgSend(chatId, "Готово! Номер принят. Вернитесь на сайт и обновите кабинет.", {
      reply_markup: { remove_keyboard: true },
    });
  } else {
    await tgSend(
      chatId,
      "Не удалось подтвердить (ссылка устарела). Создайте новую в кабинете.",
      { reply_markup: { remove_keyboard: true } }
    );
  }
}

async function handleNotifyBind(chatId, code) {
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
    await tgSend(chatId, "Готово! Telegram привязан к кабинету RVVIRC (уведомления).");
  } else {
    await tgSend(
      chatId,
      "Не удалось привязать код (истёк или уже использован). Создайте новую ссылку в кабинете."
    );
  }
}

app.post("/telegram/webhook", async (req, res) => {
  res.json({ ok: true });
  try {
    const msg = req.body && req.body.message;
    if (!msg || !msg.chat) return;
    const chatId = String(msg.chat.id);

    if (msg.contact) {
      await handleContact(msg);
      return;
    }

    if (!msg.text) return;
    const text = String(msg.text).trim();

    const phoneStart = text.match(
      /^\/start(?:@\w+)?(?:\s+phone_([a-f0-9]{16,64}))$/i
    );
    if (phoneStart) {
      await handlePhoneStart(chatId, phoneStart[1].toLowerCase());
      return;
    }

    const notifyStart = text.match(
      /^\/start(?:@\w+)?(?:\s+([a-f0-9]{16,64}))?$/i
    );
    if (notifyStart) {
      const code = notifyStart[1];
      if (!code) {
        await tgSend(
          chatId,
          "RVVIRC:\n• Подтвердить телефон — кнопка в кабинете на by.rvvirc.site\n• Уведомления — «Подключить Telegram» в кабинете"
        );
        return;
      }
      await handleNotifyBind(chatId, code);
      return;
    }

    await tgSend(
      chatId,
      "RVVIRC: откройте кабинет на by.rvvirc.site и перейдите по ссылке из кнопки."
    );
  } catch (err) {
    console.error("telegram webhook", err);
  }
});

app.listen(PORT, () => {
  console.log(`rvvirc-notify on :${PORT}`);
});
