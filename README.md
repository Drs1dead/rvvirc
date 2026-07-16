# RVVIRC Notify (Telegram)

Мини-сервис для Bothost: домен **rvvirc.bothost.tech**, порт приложения **3000**.

## Env

Скопируй `.env.example` → `.env`:

- `NOTIFY_SECRET` — тот же, что на сайте (`NOTIFY_SECRET`)
- `TELEGRAM_BOT_TOKEN` — от @BotFather
- `TELEGRAM_ADMIN_CHAT_ID` — твой chat id (можно узнать через @userinfobot)
- `SITE_URL` — например `https://by.rvvirc.site` (куда слать bind / support reply)

## Поддержка (почта + сайт)

Сайт шлёт `support.site_message` / `support.email_message` на `/hook`.
Бот рассылает админу (`TELEGRAM_ADMIN_CHAT_ID`) и агентам из `agentChatIds`.

Инвайт агента: `t.me/BOT?start=support_<token>` (создаётся в админке сайта).

Инлайн: **Ответить** → следующее сообщение → SMTP через сайт; **Закрыть** → статус closed.

## Запуск локально

```bash
npm install
npm start
```

## Webhook бота

После деплоя на Bothost:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://rvvirc.bothost.tech/telegram/webhook"
```

## Сайт (.env на VPS)

```env
NOTIFY_URL=https://rvvirc.bothost.tech
NOTIFY_SECRET=...тот же...
TELEGRAM_BOT_USERNAME=YourBotName
```
