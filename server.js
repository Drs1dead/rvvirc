/**
 * RVVIRC Telegram notify service (deploy to Bothost → rvvirc.bothost.tech:3000)
 *
 * Endpoints:
 *   GET  /health
 *   POST /hook              — events from main site (X-Notify-Secret)
 *   POST /telegram/webhook  — Bot updates:
 *       /start phone_<token>     → request_contact → phone-verify
 *       /start support_<token>   → support agent bind
 *       /start <hex>             → telegram-bind (notifications)
 *       callback reply:/close:   → inline support actions
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
/** chatId → { ticketId } awaiting reply text */
const pendingSupportReply = new Map();

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

async function tgAnswerCallback(id, text) {
  await tgApi("answerCallbackQuery", {
    callback_query_id: id,
    text: text ? String(text).slice(0, 200) : undefined,
  });
}

function siteInternal(path, payload) {
  return fetch(`${SITE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Notify-Secret": NOTIFY_SECRET,
    },
    body: JSON.stringify(payload),
  });
}

function supportKeyboard(ticketId) {
  return {
    inline_keyboard: [
      [
        { text: "Ответить", callback_data: `reply:${ticketId}` },
        { text: "Закрыть", callback_data: `close:${ticketId}` },
      ],
    ],
  };
}

function formatSupportTicket(body) {
  const src =
    body.source === "email"
      ? `✉️ ${body.mailboxAddress || "почта"}`
      : "📩 Сайт";
  const from = body.fromName
    ? `${body.fromName} <${body.fromEmail || ""}>`
    : body.fromEmail || "—";
  const subject = body.subject || "—";
  const text = (body.body || "").slice(0, 1200);
  return (
    `${src}\n` +
    `Тикет #${body.ticketId || "?"}\n` +
    `От: ${from}\n` +
    `Тема: ${subject}\n\n` +
    `${text}`
  );
}

function formatEvent(body) {
  const type = body.type || "event";
  const title = body.title || "Релиз";
  const artists = body.artists ? ` — ${body.artists}` : "";
  const site = body.siteUrl || "";
  if (type === "support.site_message" || type === "support.email_message") {
    return formatSupportTicket(body);
  }
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

function collectSupportChats(body) {
  const set = new Set();
  if (ADMIN_CHAT) set.add(String(ADMIN_CHAT));
  const agents = Array.isArray(body.agentChatIds) ? body.agentChatIds : [];
  for (const id of agents) {
    if (id) set.add(String(id));
  }
  return [...set];
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
  const isSupport =
    body.type === "support.site_message" || body.type === "support.email_message";

  const jobs = [];
  if (isSupport) {
    const chats = collectSupportChats(body);
    const extra = body.ticketId
      ? { reply_markup: supportKeyboard(body.ticketId) }
      : undefined;
    for (const chatId of chats) {
      jobs.push(tgSend(chatId, text, extra));
    }
  } else {
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
  const verifyRes = await siteInternal("/api/internal/phone-verify", {
    token,
    phone: contact.phone_number,
    chatId,
  });
  pendingPhone.delete(chatId);
  if (verifyRes.ok) {
    await tgSend(chatId, "Готово! Номер принят. Вернитесь на сайт и обновите кабинет.", {
      reply_markup: { remove_keyboard: true },
    });
  } else {
    let detail =
      "Не удалось подтвердить (ссылка устарела). Создайте новую в кабинете.";
    try {
      const body = await verifyRes.json();
      if (body && body.error === "phone_limit") {
        detail =
          "Этот номер уже привязан к 2 аккаунтам RVVIRC — больше нельзя. Используйте другой номер или войдите в один из существующих аккаунтов.";
      }
    } catch {
      /* keep default */
    }
    await tgSend(chatId, detail, {
      reply_markup: { remove_keyboard: true },
    });
  }
}

async function handleNotifyBind(chatId, code) {
  if (!SITE_URL || !NOTIFY_SECRET) {
    await tgSend(chatId, "Сервис ещё не настроен (SITE_URL / NOTIFY_SECRET).");
    return;
  }
  const bindRes = await siteInternal("/api/internal/telegram-bind", {
    code,
    chatId,
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

async function handleSupportBind(chatId, token) {
  if (!SITE_URL || !NOTIFY_SECRET) {
    await tgSend(chatId, "Сервис ещё не настроен (SITE_URL / NOTIFY_SECRET).");
    return;
  }
  const res = await siteInternal("/api/internal/support-agent-bind", {
    token,
    chatId,
  });
  if (res.ok) {
    await tgSend(
      chatId,
      "Готово! Вы подключены как агент поддержки RVVIRC. Новые обращения с сайта и почты будут приходить сюда."
    );
  } else {
    await tgSend(
      chatId,
      "Не удалось принять инвайт (ссылка недействительна или уже использована). Попросите новую в админке."
    );
  }
}

async function handleSupportReplyText(chatId, text) {
  const pending = pendingSupportReply.get(String(chatId));
  if (!pending) return false;
  pendingSupportReply.delete(String(chatId));
  if (!SITE_URL || !NOTIFY_SECRET) {
    await tgSend(chatId, "Сервис ещё не настроен.");
    return true;
  }
  const res = await siteInternal("/api/internal/support-reply", {
    ticketId: pending.ticketId,
    body: text,
    chatId,
  });
  if (res.ok) {
    await tgSend(chatId, `✅ Ответ отправлен (тикет #${pending.ticketId}).`);
  } else {
    let detail = "Не удалось отправить ответ.";
    try {
      const body = await res.json();
      if (body && body.error === "smtp_failed") {
        detail = `SMTP ошибка: ${body.message || "проверьте ящик в админке"}`;
      } else if (body && body.error === "ticket_closed") {
        detail = "Тикет уже закрыт.";
      }
    } catch {
      /* keep */
    }
    await tgSend(chatId, detail);
  }
  return true;
}

async function handleCallbackQuery(cq) {
  const data = String((cq && cq.data) || "");
  const chatId = cq.message && cq.message.chat ? String(cq.message.chat.id) : null;
  const cbId = cq.id;
  if (!chatId) {
    await tgAnswerCallback(cbId);
    return;
  }

  const replyM = data.match(/^reply:(\d+)$/);
  if (replyM) {
    const ticketId = Number(replyM[1]);
    pendingSupportReply.set(chatId, { ticketId });
    await tgAnswerCallback(cbId, "Введите текст ответа");
    await tgSend(
      chatId,
      `✏️ Напишите ответ на тикет #${ticketId} следующим сообщением (или /cancel).`
    );
    return;
  }

  const closeM = data.match(/^close:(\d+)$/);
  if (closeM) {
    const ticketId = Number(closeM[1]);
    if (!SITE_URL || !NOTIFY_SECRET) {
      await tgAnswerCallback(cbId, "Не настроено");
      return;
    }
    const res = await siteInternal("/api/internal/support-close", { ticketId });
    if (res.ok) {
      await tgAnswerCallback(cbId, "Закрыто");
      await tgSend(chatId, `🗂 Тикет #${ticketId} закрыт.`);
    } else {
      await tgAnswerCallback(cbId, "Ошибка");
      await tgSend(chatId, `Не удалось закрыть тикет #${ticketId}.`);
    }
    return;
  }

  await tgAnswerCallback(cbId);
}

app.post("/telegram/webhook", async (req, res) => {
  res.json({ ok: true });
  try {
    const cq = req.body && req.body.callback_query;
    if (cq) {
      await handleCallbackQuery(cq);
      return;
    }

    const msg = req.body && req.body.message;
    if (!msg || !msg.chat) return;
    const chatId = String(msg.chat.id);

    if (msg.contact) {
      await handleContact(msg);
      return;
    }

    if (!msg.text) return;
    const text = String(msg.text).trim();

    if (text === "/cancel") {
      pendingSupportReply.delete(chatId);
      await tgSend(chatId, "Отменено.");
      return;
    }

    if (await handleSupportReplyText(chatId, text)) {
      return;
    }

    const phoneStart = text.match(
      /^\/start(?:@\w+)?(?:\s+phone_([a-f0-9]{16,64}))$/i
    );
    if (phoneStart) {
      await handlePhoneStart(chatId, phoneStart[1].toLowerCase());
      return;
    }

    const supportStart = text.match(
      /^\/start(?:@\w+)?(?:\s+support_([a-f0-9]{16,64}))$/i
    );
    if (supportStart) {
      await handleSupportBind(chatId, supportStart[1].toLowerCase());
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
          "RVVIRC:\n• Подтвердить телефон — кнопка в кабинете на by.rvvirc.site\n• Уведомления — «Подключить Telegram» в кабинете\n• Поддержка — инвайт из админки «Почта / поддержка»"
        );
        return;
      }
      await handleNotifyBind(chatId, code);
      return;
    }

    await tgSend(
      chatId,
      "RVVIRC: откройте кабинет на by.rvvirc.site или используйте инвайт поддержки из админки."
    );
  } catch (err) {
    console.error("telegram webhook", err);
  }
});

app.listen(PORT, () => {
  console.log(`rvvirc-notify on :${PORT}`);
});
