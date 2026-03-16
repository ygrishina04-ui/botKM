require("dotenv").config();

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { google } = require("googleapis");

/*
====================================
ENV DIAGNOSTICS
====================================
*/

function maskValue(value, visibleStart = 4, visibleEnd = 4) {
  if (!value) return "(empty)";
  const str = String(value);
  if (str.length <= visibleStart + visibleEnd) return str;
  return `${str.slice(0, visibleStart)}...${str.slice(-visibleEnd)}`;
}

function logEnvDiagnostics() {
  const envMap = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    WEBHOOK_URL: process.env.WEBHOOK_URL,
    YOUR_ID: process.env.YOUR_ID,
    SHEET_ID: process.env.SHEET_ID,
    SHEET_NAME: process.env.SHEET_NAME,
    GOOGLE_CLIENT_EMAIL: process.env.GOOGLE_CLIENT_EMAIL,
    GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY,
    PORT: process.env.PORT
  };

  console.log("========== ENV DIAGNOSTICS ==========");

  for (const [key, value] of Object.entries(envMap)) {
    const exists = value !== undefined && value !== null && String(value).trim() !== "";

    const safeValue =
      key === "BOT_TOKEN"
        ? exists
          ? maskValue(value, 8, 6)
          : "(empty)"
        : key === "GOOGLE_PRIVATE_KEY"
        ? exists
          ? `[present, length=${String(value).length}]`
          : "(empty)"
        : exists
        ? String(value)
        : "(empty)";

    console.log(`${key}: ${exists ? "FOUND" : "MISSING"} -> ${safeValue}`);
  }

  console.log("=====================================");
}

logEnvDiagnostics();

/*
====================================
CONFIG
====================================
*/

const TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 8080;
const YOUR_ID_RAW = process.env.YOUR_ID;
const YOUR_ID = Number(YOUR_ID_RAW);
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Sheet1";

const missingVars = [];

if (!TOKEN || !String(TOKEN).trim()) missingVars.push("BOT_TOKEN");
if (!WEBHOOK_URL || !String(WEBHOOK_URL).trim()) missingVars.push("WEBHOOK_URL");
if (!YOUR_ID_RAW || !String(YOUR_ID_RAW).trim()) missingVars.push("YOUR_ID");
if (!SHEET_ID || !String(SHEET_ID).trim()) missingVars.push("SHEET_ID");

if (missingVars.length) {
  console.error("Missing required env vars:", missingVars.join(", "));
  throw new Error(`Missing required env vars: ${missingVars.join(", ")}`);
}

if (Number.isNaN(YOUR_ID)) {
  console.error("YOUR_ID is present but is not a valid number:", YOUR_ID_RAW);
  throw new Error("YOUR_ID must be a valid number");
}

const bot = new TelegramBot(TOKEN);
const app = express();
app.use(express.json());

/*
====================================
GOOGLE SHEETS AUTH
====================================
*/

if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
  console.warn("Google Sheets credentials are not fully set.");
  console.warn("GOOGLE_CLIENT_EMAIL present:", !!process.env.GOOGLE_CLIENT_EMAIL);
  console.warn("GOOGLE_PRIVATE_KEY present:", !!process.env.GOOGLE_PRIVATE_KEY);
}

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY
      ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n")
      : undefined
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const sheets = google.sheets({ version: "v4", auth });

/*
====================================
TABLE STRUCTURE
====================================

A = company
B = manager_name (optional)
C = manager_id
D = last_order_date
E = last_request_date
F = status
G = sent_at
H = level
I = comment
J = commented_at
K = alert_message_id
L = prompt_message_id
*/

const COL = {
  company: 0,
  managerName: 1,
  managerId: 2,
  lastOrderDate: 3,
  lastRequestDate: 4,
  status: 5,
  sentAt: 6,
  level: 7,
  comment: 8,
  commentedAt: 9,
  alertMessageId: 10,
  promptMessageId: 11
};

/*
====================================
IN-MEMORY PENDING COMMENTS
====================================
*/

const pendingComments = {};

/*
====================================
HELPERS
====================================
*/

function parseDate(value) {
  if (!value) return null;

  if (value instanceof Date && !isNaN(value.getTime())) return value;

  if (typeof value === "number") {
    const date = new Date(Math.round((value - 25569) * 86400 * 1000));
    return isNaN(date.getTime()) ? null : date;
  }

  const str = String(value).trim();

  const ruMatch = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (ruMatch) {
    const [, d, m, y] = ruMatch;
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    return isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(str);
  return isNaN(date.getTime()) ? null : date;
}

function formatDate(date) {
  if (!date) return "—";
  return date.toLocaleDateString("ru-RU");
}

function daysDiff(date) {
  const now = new Date();
  const diff = now - date;
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function getLevelByDays(days) {
  if (days >= 35) {
    return {
      level: "🚨 КРИТИЧНО",
      recommendation: "Свяжись с клиентом срочно. Высокий риск потери клиента."
    };
  }

  if (days >= 30) {
    return {
      level: "🔴 LOST",
      recommendation: "Клиент в зоне потери. Требуется активная работа."
    };
  }

  return null;
}

function colLetter(colIndexZeroBased) {
  let dividend = colIndexZeroBased + 1;
  let columnName = "";

  while (dividend > 0) {
    const modulo = (dividend - 1) % 26;
    columnName = String.fromCharCode(65 + modulo) + columnName;
    dividend = Math.floor((dividend - modulo) / 26);
  }

  return columnName;
}

async function getSheetRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:L`
  });

  return res.data.values || [];
}

async function updateCell(rowNumber, colIndexZeroBased, value) {
  const column = colLetter(colIndexZeroBased);

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!${column}${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[value]]
    }
  });
}

async function updateRowFields(rowNumber, fields) {
  const updates = Object.entries(fields);

  for (const [colIndex, value] of updates) {
    await updateCell(rowNumber, Number(colIndex), value);
  }
}

async function sendMessageWithButtons(chatId, text, company) {
  return bot.sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Связался", callback_data: `contacted|${company}` },
          { text: "⚠ Нерегулярный", callback_data: `irregular|${company}` }
        ]
      ]
    }
  });
}

async function safeDeleteMessage(chatId, messageId) {
  if (!chatId || !messageId) return;

  try {
    await bot.deleteMessage(chatId, String(messageId));
  } catch (e) {
    console.log("Delete message skipped:", e?.response?.body || e.message);
  }
}

async function answerCallback(callbackId, text) {
  try {
    await bot.answerCallbackQuery(callbackId, { text });
  } catch (e) {
    console.log("answerCallback error:", e?.response?.body || e.message);
  }
}

function buildClientMessage(company, orderDate, requestDate, orderDays, requestDays, levelData, effectiveDays) {
  return `${levelData.level}
Клиент: ${company}

Последний заказ: ${formatDate(orderDate)} (${orderDays} дн.)
Последний запрос: ${formatDate(requestDate)} (${requestDays} дн.)

Фактически без активности: ${effectiveDays} дн.

Рекомендация: ${levelData.recommendation}`;
}

/*
====================================
CHECK CLIENTS
====================================
Уведомление уходит только если:
- дата последнего заказа старше 30 дней
- дата последнего запроса старше 30 дней
*/

async function checkClients() {
  const rows = await getSheetRows();

  if (!rows.length) {
    console.log("No rows found in sheet");
    return;
  }

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    const company = row[COL.company];
    const managerId = row[COL.managerId];
    const lastOrderRaw = row[COL.lastOrderDate];
    const lastRequestRaw = row[COL.lastRequestDate];
    const existingAlertMessageId = row[COL.alertMessageId];

    if (!company || !managerId) continue;

    if (existingAlertMessageId) continue;

    const lastOrderDate = parseDate(lastOrderRaw);
    const lastRequestDate = parseDate(lastRequestRaw);

    if (!lastOrderDate || !lastRequestDate) continue;

    const orderDays = daysDiff(lastOrderDate);
    const requestDays = daysDiff(lastRequestDate);

    if (orderDays < 30 || requestDays < 30) continue;

    const effectiveDays = Math.min(orderDays, requestDays);
    const levelData = getLevelByDays(effectiveDays);

    if (!levelData) continue;

    const message = buildClientMessage(
      company,
      lastOrderDate,
      lastRequestDate,
      orderDays,
      requestDays,
      levelData,
      effectiveDays
    );

    try {
      const sent = await sendMessageWithButtons(managerId, message, company);

      const rowNumber = i + 1;

      await updateRowFields(rowNumber, {
        [COL.sentAt]: new Date().toLocaleString("ru-RU"),
        [COL.level]: levelData.level,
        [COL.alertMessageId]: sent.message_id,
        [COL.promptMessageId]: "",
        [COL.comment]: "",
        [COL.commentedAt]: ""
      });

      console.log(`Alert sent for company: ${company}`);
    } catch (e) {
      console.log(`Error sending alert for ${company}:`, e?.response?.body || e.message);
    }
  }
}

/*
====================================
START COMMENT FLOW
====================================
*/

async function startCommentFlow(chatId, company, action, callbackMessageId) {
  const rows = await getSheetRows();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    if (row[COL.company] === company) {
      const rowNumber = i + 1;
      const statusText = action === "contacted" ? "Связался" : "Нерегулярный";

      await updateRowFields(rowNumber, {
        [COL.status]: statusText
      });

      const prompt = await bot.sendMessage(
        chatId,
        `✍️ Добавь комментарий по клиенту "${company}" одним сообщением.\n\nПосле комментария уведомление будет убрано из чата.`
      );

      pendingComments[chatId] = {
        company,
        action,
        rowIndex: i,
        rowNumber,
        alertMessageId: callbackMessageId,
        promptMessageId: prompt.message_id
      };

      await updateCell(rowNumber, COL.promptMessageId, prompt.message_id);

      return true;
    }
  }

  return false;
}

/*
====================================
SAVE COMMENT + CLEANUP
====================================
*/

async function saveCommentAndCleanup(chatId, commentText, managerCommentMessageId) {
  const pending = pendingComments[chatId];
  if (!pending) return false;

  const { company, action, rowNumber, alertMessageId, promptMessageId } = pending;
  const finalStatus = action === "contacted" ? "Связался" : "Нерегулярный";

  await updateRowFields(rowNumber, {
    [COL.status]: finalStatus,
    [COL.comment]: commentText,
    [COL.commentedAt]: new Date().toLocaleString("ru-RU"),
    [COL.alertMessageId]: "",
    [COL.promptMessageId]: ""
  });

  await safeDeleteMessage(chatId, alertMessageId);
  await safeDeleteMessage(chatId, promptMessageId);
  await safeDeleteMessage(chatId, managerCommentMessageId);

  delete pendingComments[chatId];

  return {
    company,
    status: finalStatus,
    comment: commentText
  };
}

/*
====================================
WEEKLY REPORT
====================================
*/

async function weeklyReport() {
  const rows = await getSheetRows();
  if (!rows.length) return;

  let risk = 0;
  let lost = 0;
  let critical = 0;
  let withComment = 0;
  let withoutComment = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const level = row[COL.level] || "";
    const comment = row[COL.comment] || "";
    const alertMessageId = row[COL.alertMessageId] || "";

    if (level.includes("РИСК")) risk++;
    else if (level.includes("LOST")) lost++;
    else if (level.includes("КРИТИЧНО")) critical++;

    if (comment) withComment++;
    if (alertMessageId) withoutComment++;
  }

  const report = `📊 Недельный отчет

🟡 Риск: ${risk}
🔴 LOST: ${lost}
🚨 Критично: ${critical}

✅ С комментарием: ${withComment}
⏳ Без комментария: ${withoutComment}`;

  await bot.sendMessage(YOUR_ID, report);
}

/*
====================================
WEBHOOK
====================================
*/

app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;

    if (update.callback_query) {
      const callback = update.callback_query;
      const [action, company] = String(callback.data || "").split("|");

      if (!action || !company) {
        await answerCallback(callback.id, "Некорректные данные");
        return res.sendStatus(200);
      }

      const chatId = callback.message.chat.id;
      const callbackMessageId = callback.message.message_id;

      const ok = await startCommentFlow(chatId, company, action, callbackMessageId);

      if (ok) {
        await answerCallback(callback.id, "Статус принят, жду комментарий");
      } else {
        await answerCallback(callback.id, "Клиент не найден в таблице");
      }

      return res.sendStatus(200);
    }

    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const text = update.message.text.trim();
      const messageId = update.message.message_id;

      if (pendingComments[chatId]) {
        const result = await saveCommentAndCleanup(chatId, text, messageId);

        if (result) {
          await bot.sendMessage(
            YOUR_ID,
            `📝 Новый комментарий

Клиент: ${result.company}
Статус: ${result.status}
Комментарий: ${result.comment}`
          );
        }

        return res.sendStatus(200);
      }

      if (text === "/start") {
        await bot.sendMessage(chatId, "Бот Внимание на клиента активен ✅");
      }

      if (text === "/check") {
        await checkClients();
        await bot.sendMessage(chatId, "Проверка клиентов выполнена ✅");
      }

      if (text === "/weekly") {
        await weeklyReport();
        await bot.sendMessage(chatId, "Недельный отчет отправлен ✅");
      }

      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e?.response?.body || e.message || e);
    return res.sendStatus(200);
  }
});

/*
====================================
SYSTEM ROUTES
====================================
*/

app.get("/", (req, res) => {
  res.send("Client Attention Bot is running");
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.get("/run-check", async (req, res) => {
  try {
    await checkClients();
    res.send("checkClients done");
  } catch (e) {
    console.error("run-check error:", e?.response?.body || e.message || e);
    res.status(500).send("Error in checkClients");
  }
});

app.get("/run-weekly", async (req, res) => {
  try {
    await weeklyReport();
    res.send("weeklyReport done");
  } catch (e) {
    console.error("run-weekly error:", e?.response?.body || e.message || e);
    res.status(500).send("Error in weeklyReport");
  }
});

/*
====================================
START SERVER + SET WEBHOOK
====================================
*/

async function start() {
  app.listen(PORT, "0.0.0.0", async () => {
    console.log(`Server listening on ${PORT}`);

    const webhook = `${WEBHOOK_URL}/webhook/${TOKEN}`;
    console.log("Setting webhook to:", webhook);

    await bot.setWebHook(webhook);

    console.log("Webhook set successfully");
  });
}

start().catch((e) => {
  console.error("Start error:", e?.response?.body || e.message || e);
});
