require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const cron = require('node-cron');

console.log('=== BOT VERSION 2026-03-17 CLIENT-ATTENTION FINAL VLADIVOSTOK ===');

// ======================
// ENV
// ======================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SHEET_RANGE = process.env.GOOGLE_SHEET_RANGE || 'Лист1!A:L';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const USE_POLLING = (process.env.USE_POLLING || 'true').toLowerCase() === 'true';

if (!TELEGRAM_BOT_TOKEN) throw new Error('Не задан TELEGRAM_BOT_TOKEN');
if (!GOOGLE_CLIENT_EMAIL) throw new Error('Не задан GOOGLE_CLIENT_EMAIL');
if (!GOOGLE_PRIVATE_KEY) throw new Error('Не задан GOOGLE_PRIVATE_KEY');
if (!GOOGLE_SHEET_ID) throw new Error('Не задан GOOGLE_SHEET_ID');

// ======================
// BOT
// ======================
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  polling: USE_POLLING,
});

// userId -> { rowNumber, company, chatId, messageId, promptMessageId }
const pendingComments = new Map();

// ======================
// GOOGLE AUTH
// ======================
function getGoogleAuth() {
  let privateKey = GOOGLE_PRIVATE_KEY.trim();

  if (
    (privateKey.startsWith('"') && privateKey.endsWith('"')) ||
    (privateKey.startsWith("'") && privateKey.endsWith("'"))
  ) {
    privateKey = privateKey.slice(1, -1);
  }

  privateKey = privateKey.replace(/\\n/g, '\n');

  return new google.auth.JWT({
    email: GOOGLE_CLIENT_EMAIL,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheets() {
  const auth = getGoogleAuth();
  await auth.authorize();

  return google.sheets({
    version: 'v4',
    auth,
  });
}

// ======================
// HELPERS
// ======================
function parseDate(dateStr) {
  if (!dateStr) return null;

  const value = String(dateStr).trim();
  if (!value) return null;

  let match = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (match) {
    const [, dd, mm, yyyy] = match;
    const date = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
    return isNaN(date.getTime()) ? null : date;
  }

  match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const [, yyyy, mm, dd] = match;
    const date = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
    return isNaN(date.getTime()) ? null : date;
  }

  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function daysBetween(fromDate, toDate) {
  const d1 = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
  const d2 = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate());
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((d2 - d1) / msPerDay);
}

function getLatestActivityDate(lastOrderDate, lastRequestDate) {
  const dates = [lastOrderDate, lastRequestDate].filter(Boolean);
  if (!dates.length) return null;
  return new Date(Math.max(...dates.map((d) => d.getTime())));
}

function normalizeTelegramId(rawValue) {
  let value = String(rawValue || '').trim();
  value = value.replace(/\.0$/, '');
  return value;
}

function shortCompanyName(name) {
  const value = String(name || '').trim();
  if (!value) return 'Клиент';

  return value
    .replace(/^ООО\s+/i, '')
    .replace(/^ИП\s+/i, '')
    .replace(/^АО\s+/i, '')
    .replace(/^ЗАО\s+/i, '')
    .replace(/^ПАО\s+/i, '')
    .replace(/^["«]/, '')
    .replace(/["»]$/, '')
    .trim();
}

function isSameDate(dateA, dateB) {
  if (!dateA || !dateB) return false;

  return (
    dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate()
  );
}

function addCount(map, key, value = 1) {
  map.set(key, (map.get(key) || 0) + value);
}

function formatManagerStats(title, statsMap) {
  const entries = [...statsMap.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'));
  if (!entries.length) {
    return `${title}:\n• Нет`;
  }

  return `${title}:\n${entries.map(([manager, count]) => `• ${manager} — ${count}`).join('\n')}`;
}

async function safeSend(chatId, text, options = {}) {
  const message = String(text || '').trim();
  if (!message) return null;

  const MAX_LENGTH = 4000;

  if (message.length <= MAX_LENGTH) {
    return await bot.sendMessage(chatId, message, options);
  }

  let lastMessage = null;
  for (let i = 0; i < message.length; i += MAX_LENGTH) {
    const part = message.slice(i, i + MAX_LENGTH);
    lastMessage = await bot.sendMessage(chatId, part, i === 0 ? options : {});
  }

  return lastMessage;
}

// ======================
// SHEETS
// ======================
async function loadClientsFromSheet() {
  const sheets = await getSheets();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: GOOGLE_SHEET_RANGE,
  });

  return response.data.values || [];
}

async function updateClientRow(rowNumber, updates) {
  const sheets = await getSheets();

  const columns = {
    status: 'G',
    notificationDate: 'I',
    comment: 'J',
    reactionDate: 'K',
    nextCheckDate: 'L',
  };

  for (const [key, col] of Object.entries(columns)) {
    if (updates[key] !== undefined) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: `${col}${rowNumber}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[updates[key]]],
        },
      });
    }
  }
}

// ======================
// MESSAGE BUILDING
// ======================
function buildClientMessage(company, lastOrderDateStr, daysWithoutActivity) {
  let priority = '';
  let recommendation = '';

  if (daysWithoutActivity >= 55) {
    priority = '🚨 КРИТИЧНО';
    recommendation = 'Свяжись с клиентом срочно. Высокий риск потери клиента.';
  } else if (daysWithoutActivity >= 45) {
    priority = '⚠️ ВАЖНО';
    recommendation = 'Нужно связаться с клиентом в ближайшее время.';
  } else {
    priority = '📌 ВНИМАНИЕ';
    recommendation = 'Рекомендуется проверить клиента и напомнить о себе.';
  }

  return `${priority}
Клиент - ${company}
Последний заказ: ${lastOrderDateStr || '-'}
Прошло: ${daysWithoutActivity} дней без заказа

Рекомендации: ${recommendation}`;
}

// ======================
// REPORTS
// ======================
function buildLeaderReport(rows, reportDate) {
  const dataRows = rows.slice(1);

  let contactedTotal = 0;
  let notReactedTotal = 0;

  const contactedByManager = new Map();
  const notReactedByManager = new Map();

  for (const row of dataRows) {
    const manager = (row[1] || 'Без менеджера').toString().trim();
    const notificationDateStr = (row[8] || '').toString().trim();
    const reactionDateStr = (row[10] || '').toString().trim();

    const notificationDate = parseDate(notificationDateStr);
    const reactionDate = parseDate(reactionDateStr);

    const notifiedToday = notificationDate && isSameDate(notificationDate, reportDate);
    const reactedToday = reactionDate && isSameDate(reactionDate, reportDate);

    if (reactedToday) {
      contactedTotal++;
      addCount(contactedByManager, manager);
    }

    if (notifiedToday && !reactedToday) {
      notReactedTotal++;
      addCount(notReactedByManager, manager);
    }
  }

  return `📊 Ежедневный отчет по клиентам

Связались: ${contactedTotal}
Не отреагировали: ${notReactedTotal}

${formatManagerStats('Связались', contactedByManager)}

${formatManagerStats('Не отреагировали', notReactedByManager)}`;
}

async function sendLeaderReport() {
  if (!ADMIN_CHAT_ID) return;

  const rows = await loadClientsFromSheet();
  if (!rows || rows.length < 2) {
    await safeSend(ADMIN_CHAT_ID, '📊 Ежедневный отчет: в таблице нет данных.');
    return;
  }

  const today = new Date();
  const reportText = buildLeaderReport(rows, today);
  await safeSend(ADMIN_CHAT_ID, reportText);
}

// ======================
// CORE LOGIC
// ======================
async function sendCriticalClients(triggerChatId = null) {
  const rows = await loadClientsFromSheet();

  if (!rows || rows.length < 2) {
    if (triggerChatId) {
      await safeSend(triggerChatId, 'В таблице нет данных для проверки.');
    }
    return;
  }

  const dataRows = rows.slice(1);
  const today = new Date();

  let sentCount = 0;
  let skippedNoTelegramId = 0;
  let failedCount = 0;
  let skippedAlreadySentToday = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];

    const company = (row[0] || '').toString().trim();
    const manager = (row[1] || '').toString().trim();
    const managerTelegramId = normalizeTelegramId(row[2]);
    const lastOrderDateStr = (row[3] || '').toString().trim();
    const lastRequestDateStr = (row[4] || '').toString().trim();
    const status = (row[6] || '').toString().trim();
    const notificationDateStr = (row[8] || '').toString().trim();
    const nextCheckDateStr = (row[11] || '').toString().trim();

    if (!company) continue;

    if (!managerTelegramId || !/^\d+$/.test(managerTelegramId)) {
      skippedNoTelegramId++;
      continue;
    }

    const lastOrderDate = parseDate(lastOrderDateStr);
    const lastRequestDate = parseDate(lastRequestDateStr);
    const notificationDate = parseDate(notificationDateStr);
    const nextCheckDate = parseDate(nextCheckDateStr);

    if (status.toLowerCase() === 'связался' && nextCheckDate && nextCheckDate > today) {
      continue;
    }

    if (notificationDate && isSameDate(notificationDate, today)) {
      skippedAlreadySentToday++;
      continue;
    }

    const latestActivityDate = getLatestActivityDate(lastOrderDate, lastRequestDate);
    if (!latestActivityDate) continue;

    const daysWithoutActivity = daysBetween(latestActivityDate, today);

    if (daysWithoutActivity < 25) {
      continue;
    }

    const text = buildClientMessage(company, lastOrderDateStr, daysWithoutActivity);

    try {
      await bot.sendMessage(managerTelegramId, text, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: 'Связался',
                callback_data: `contacted_${i + 2}`,
              },
            ],
          ],
        },
      });

      await updateClientRow(i + 2, {
        notificationDate: formatDate(today),
      });

      sentCount++;
    } catch (error) {
      failedCount++;
      console.error(
        `Не удалось отправить менеджеру ${manager} (${managerTelegramId}) по клиенту ${company}:`,
        error.response?.body || error.message || error
      );
    }
  }

  if (triggerChatId) {
    await safeSend(
      triggerChatId,
      `Проверка завершена.
Отправлено: ${sentCount}
Уже было сегодня: ${skippedAlreadySentToday}
Без ID: ${skippedNoTelegramId}
Ошибок: ${failedCount}`
    );
  }
}

// ======================
// COMMANDS
// ======================
bot.onText(/\/start/, async (msg) => {
  await safeSend(
    msg.chat.id,
    `Бот активен.

Команды:
/testmessage — тестовое сообщение
/testsheet — тест чтения таблицы
/check — ручная рассылка менеджерам
/report — отчет руководителю за сегодня
/sendtest — тест отправки в ADMIN_CHAT_ID
/myid — показать твой Telegram ID`
  );
});

bot.onText(/\/myid/, async (msg) => {
  await safeSend(msg.chat.id, `Твой Telegram ID: ${msg.chat.id}`);
});

bot.onText(/\/testmessage/, async (msg) => {
  try {
    await safeSend(msg.chat.id, 'Тестовое сообщение: бот работает.');
  } catch (error) {
    console.error('Ошибка в /testmessage:', error);
    await safeSend(msg.chat.id, `Ошибка: ${error.message}`);
  }
});

bot.onText(/\/testsheet/, async (msg) => {
  try {
    const rows = await loadClientsFromSheet();

    const preview = rows
      .slice(0, 5)
      .map((row, index) => `${index + 1}: ${row.join(' | ')}`)
      .join('\n');

    await safeSend(
      msg.chat.id,
      `Таблица читается.
Строк: ${rows.length}

${preview || 'Нет данных'}`
    );
  } catch (error) {
    console.error('Ошибка в /testsheet:', error);
    await safeSend(msg.chat.id, `Ошибка чтения таблицы: ${error.message}`);
  }
});

bot.onText(/\/check/, async (msg) => {
  try {
    await safeSend(msg.chat.id, 'Запускаю рассылку уведомлений менеджерам...');
    await sendCriticalClients(msg.chat.id);
  } catch (error) {
    console.error('Ошибка в /check:', error);
    await safeSend(msg.chat.id, `Ошибка проверки: ${error.message}`);
  }
});

bot.onText(/\/report/, async (msg) => {
  try {
    const rows = await loadClientsFromSheet();
    if (!rows || rows.length < 2) {
      return await safeSend(msg.chat.id, 'В таблице нет данных для отчета.');
    }

    const text = buildLeaderReport(rows, new Date());
    await safeSend(msg.chat.id, text);
  } catch (error) {
    console.error('Ошибка в /report:', error);
    await safeSend(msg.chat.id, `Ошибка отчета: ${error.message}`);
  }
});

bot.onText(/\/sendtest/, async (msg) => {
  try {
    if (!ADMIN_CHAT_ID) {
      return await safeSend(msg.chat.id, 'Не задан ADMIN_CHAT_ID в Railway Variables.');
    }

    await safeSend(ADMIN_CHAT_ID, 'Ручная тестовая рассылка сработала.');
    await safeSend(msg.chat.id, 'Тестовая отправка выполнена.');
  } catch (error) {
    console.error('Ошибка в /sendtest:', error);
    await safeSend(msg.chat.id, `Ошибка: ${error.message}`);
  }
});

// ======================
// CALLBACK
// ======================
bot.on('callback_query', async (query) => {
  try {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;
    const userId = query.from.id;

    if (!data || !data.startsWith('contacted_')) {
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const rowNumber = Number(data.replace('contacted_', ''));
    if (!rowNumber) {
      await bot.answerCallbackQuery(query.id, {
        text: 'Не удалось определить строку клиента',
      });
      return;
    }

    const rows = await loadClientsFromSheet();
    const row = rows[rowNumber - 1] || [];
    const company = (row[0] || '').toString().trim() || 'Без названия';

    await bot.answerCallbackQuery(query.id, {
      text: 'Напиши комментарий по клиенту',
    });

    const promptMessage = await safeSend(chatId, `Напиши комментарий по клиенту ${company}:`);

    pendingComments.set(userId, {
      rowNumber,
      company,
      chatId,
      messageId,
      promptMessageId: promptMessage?.message_id,
    });
  } catch (error) {
    console.error('Ошибка callback_query:', error);

    try {
      await bot.answerCallbackQuery(query.id, {
        text: 'Ошибка обработки кнопки',
      });
    } catch (_) {}
  }
});

// ======================
// COMMENT SAVE
// ======================
bot.on('message', async (msg) => {
  try {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text) return;
    if (text.startsWith('/')) return;

    const pending = pendingComments.get(userId);
    if (!pending) return;

    const today = new Date();
    const reactionDate = formatDate(today);
    const nextCheckDate = formatDate(addDays(today, 25));
    const companyShort = shortCompanyName(pending.company);

    await updateClientRow(pending.rowNumber, {
      status: 'Связался',
      comment: text,
      reactionDate,
      nextCheckDate,
    });

    try {
      await bot.deleteMessage(pending.chatId, String(pending.messageId));
    } catch (e) {
      console.error('Не удалось удалить карточку:', e.message);
    }

    if (pending.promptMessageId) {
      try {
        await bot.deleteMessage(pending.chatId, String(pending.promptMessageId));
      } catch (e) {
        console.error('Не удалось удалить prompt:', e.message);
      }
    }

    await safeSend(
      chatId,
      `✅ ${companyShort} — отмечен
Следующая проверка: ${nextCheckDate}`
    );

    pendingComments.delete(userId);
  } catch (error) {
    console.error('Ошибка обработки комментария:', error);
    await safeSend(msg.chat.id, `Ошибка сохранения комментария: ${error.message}`);
  }
});

// ======================
// CRON
// ======================
cron.schedule(
  '0 11 * * 1,3,5',
  async () => {
    console.log('=== CRON: плановая проверка клиентов ===');

    try {
      await sendCriticalClients(ADMIN_CHAT_ID || null);
      await sendLeaderReport();
    } catch (error) {
      console.error('Ошибка плановой проверки:', error);

      if (ADMIN_CHAT_ID) {
        try {
          await safeSend(ADMIN_CHAT_ID, `Ошибка плановой проверки: ${error.message}`);
        } catch (e) {
          console.error('Не удалось отправить ошибку админу:', e.message);
        }
      }
    }
  },
  {
    timezone: 'Asia/Vladivostok',
  }
);

// ======================
// ERRORS
// ======================
bot.on('polling_error', (error) => {
  console.error('Polling error:', error?.message || error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

console.log('Бот запущен');
