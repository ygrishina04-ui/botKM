require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const cron = require('node-cron');

console.log('=== BOT VERSION 2026-03-17 CLIENT-ATTENTION ===');

// ======================
// ENV
// ======================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SHEET_RANGE = process.env.GOOGLE_SHEET_RANGE || 'Лист1!A:Z';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// Включи true, если бот работает через polling
const USE_POLLING = (process.env.USE_POLLING || 'true').toLowerCase() === 'true';

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error('Не задан TELEGRAM_BOT_TOKEN');
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  polling: USE_POLLING,
});

// ======================
// GOOGLE AUTH
// ======================
function getGoogleAuth() {
  if (!GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) {
    throw new Error('Не заданы GOOGLE_CLIENT_EMAIL или GOOGLE_PRIVATE_KEY');
  }

  let privateKey = GOOGLE_PRIVATE_KEY.trim();

  // Убираем внешние кавычки, если случайно вставились
  if (
    (privateKey.startsWith('"') && privateKey.endsWith('"')) ||
    (privateKey.startsWith("'") && privateKey.endsWith("'"))
  ) {
    privateKey = privateKey.slice(1, -1);
  }

  // Превращаем \n в реальные переносы строк
  privateKey = privateKey.replace(/\\n/g, '\n');

  return new google.auth.JWT({
    email: GOOGLE_CLIENT_EMAIL,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
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
// LOAD DATA FROM SHEET
// ======================
async function loadClientsFromSheet() {
  const sheets = await getSheets();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: GOOGLE_SHEET_RANGE,
  });

  return response.data.values || [];
}

// ======================
// CHECK CLIENTS
// ======================
// Логика сейчас универсальная:
// - берет строки из таблицы
// - показывает клиентов, где в строке встречается "да", "attention", "внимание", "просрочка", "риск"
// Позже подстроим точно под твою структуру таблицы.
async function checkClients() {
  try {
    const rows = await loadClientsFromSheet();

    if (!rows || rows.length === 0) {
      return 'Таблица пустая или данные не найдены.';
    }

    if (rows.length === 1) {
      return 'В таблице только заголовок, строк для проверки нет.';
    }

    const headers = rows[0];
    const dataRows = rows.slice(1);

    const alerts = [];

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];

      const joined = row.join(' | ').toLowerCase();

      const isAttentionRow =
        joined.includes('да') ||
        joined.includes('attention') ||
        joined.includes('внимание') ||
        joined.includes('просрочка') ||
        joined.includes('риск');

      if (isAttentionRow) {
        const clientName = row[0] || `Клиент ${i + 1}`;
        const manager = row[1] || '-';
        const comment = row[2] || '-';

        alerts.push(
          `• ${clientName}\nМенеджер: ${manager}\nКомментарий: ${comment}`
        );
      }
    }

    if (alerts.length === 0) {
      return `Проверка завершена.\nПотенциально проблемных клиентов не найдено.\n\nВсего строк проверено: ${dataRows.length}`;
    }

    return `Клиенты, требующие внимания:\n\n${alerts.join('\n\n')}`;
  } catch (error) {
    console.error('Error in checkClients:', error);
    throw error;
  }
}

// ======================
// SAFE SEND
// ======================
async function safeSend(chatId, text) {
  const message = String(text || '').trim();

  if (!message) return;

  // Telegram ограничивает длину сообщения
  const MAX_LENGTH = 4000;

  if (message.length <= MAX_LENGTH) {
    await bot.sendMessage(chatId, message);
    return;
  }

  for (let i = 0; i < message.length; i += MAX_LENGTH) {
    await bot.sendMessage(chatId, message.slice(i, i + MAX_LENGTH));
  }
}

// ======================
// COMMANDS
// ======================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  await safeSend(
    chatId,
    `Бот активен.

Команды:
/ testmessage — тест отправки сообщения
/ testsheet — тест чтения Google Sheets
/ check — ручная проверка клиентов`.replace('/ ', '/')
  );
});

bot.onText(/\/testmessage/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    await safeSend(chatId, 'Тестовое сообщение: бот работает.');
  } catch (error) {
    console.error('Ошибка в /testmessage:', error);
    await safeSend(chatId, `Ошибка: ${error.message}`);
  }
});

bot.onText(/\/testsheet/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const rows = await loadClientsFromSheet();

    const preview = rows
      .slice(0, 5)
      .map((row, index) => `${index + 1}: ${row.join(' | ')}`)
      .join('\n');

    await safeSend(
      chatId,
      `Таблица читается.
Строк: ${rows.length}

${preview || 'Нет данных'}`
    );
  } catch (error) {
    console.error('Ошибка в /testsheet:', error);
    await safeSend(chatId, `Ошибка чтения таблицы: ${error.message}`);
  }
});

bot.onText(/\/check/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    await safeSend(chatId, 'Запускаю ручную проверку клиентов...');
    const result = await checkClients();
    await safeSend(chatId, result || 'Проверка завершена.');
  } catch (error) {
    console.error('Ошибка в /check:', error);
    await safeSend(chatId, `Ошибка проверки: ${error.message}`);
  }
});

// ======================
// OPTIONAL: MANUAL SEND TO ADMIN
// ======================
bot.onText(/\/sendtest/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    if (!ADMIN_CHAT_ID) {
      return await safeSend(chatId, 'Не задан ADMIN_CHAT_ID в Railway Variables.');
    }

    await safeSend(ADMIN_CHAT_ID, 'Ручная тестовая рассылка сработала.');
    await safeSend(chatId, 'Тестовая отправка выполнена.');
  } catch (error) {
    console.error('Ошибка в /sendtest:', error);
    await safeSend(chatId, `Ошибка: ${error.message}`);
  }
});

// ======================
// CRON
// ======================
// Каждый день в 09:00 по серверному времени Railway
// Для Европы удобнее потом настроить серверную TZ или сместить время вручную
cron.schedule('0 9 * * *', async () => {
  console.log('=== CRON: плановая проверка клиентов ===');

  if (!ADMIN_CHAT_ID) {
    console.log('ADMIN_CHAT_ID не задан, cron-уведомление пропущено');
    return;
  }

  try {
    const result = await checkClients();
    await safeSend(ADMIN_CHAT_ID, `Плановая проверка:\n\n${result}`);
  } catch (error) {
    console.error('Ошибка плановой проверки:', error);

    try {
      await safeSend(
        ADMIN_CHAT_ID,
        `Ошибка плановой проверки: ${error.message}`
      );
    } catch (sendError) {
      console.error('Не удалось отправить сообщение об ошибке:', sendError);
    }
  }
});

// ======================
// GENERAL ERROR HANDLERS
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
