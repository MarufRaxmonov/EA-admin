/**
 * Exam Assistant
 * Firebase Realtime Database -> Telegram payment notification
 *
 * Bu kod admin panel yopiq bo‘lsa ham ishlaydi:
 * /users/{uid}/profile/pendingPayment yozuvi "pending" bo‘lganda
 * admin Telegram chatiga xabar yuboradi.
 *
 * Token kodga yozilmaydi. Deploydan oldin:
 *   firebase functions:secrets:set TELEGRAM_BOT_TOKEN
 */

const crypto = require("node:crypto");
const admin = require("firebase-admin");
const { onValueWritten } = require("firebase-functions/v2/database");
const { defineSecret } = require("firebase-functions/params");

admin.initializeApp();

const telegramBotToken = defineSecret("TELEGRAM_BOT_TOKEN");
const TELEGRAM_ADMIN_ID = "8768210639";
const REGION = "us-central1";
const CLAIM_TIMEOUT_MS = 10 * 60 * 1000;

function getDatabase() {
  return admin.database();
}

function escapeTelegramHtml(value) {
  return String(value ?? "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;");
}

function formatMoney(value) {
  return `${Number(value || 0).toLocaleString("ru-RU")} so‘m`;
}

function formatUserName(profile) {
  return `${profile?.first_name || ""} ${profile?.last_name || ""}`.trim() || "Noma’lum foydalanuvchi";
}

function paymentEventKey(uid,payment) {
  return [
    String(uid),
    payment?.timestamp || "",
    payment?.amount || "",
    payment?.questionCount || "",
    payment?.fileName || ""
  ].join("|");
}

function hashKey(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function formatPaymentMessage(uid,profile,payment) {
  const fullName = formatUserName(profile);
  const username = String(profile?.username || "").trim();
  const usernameLine = username ? `\n👤 Username: @${escapeTelegramHtml(username)}` : "";
  const telegramId = profile?.id || uid;
  const timestamp = payment?.timestamp
    ? new Date(payment.timestamp).toLocaleString("uz-UZ",{timeZone:"Asia/Samarkand"})
    : "noma’lum";
  const receiptLine = payment?.receiptImage
    ? "🧾 Chek rasmi: mavjud"
    : "🧾 Chek rasmi: yo‘q";

  return [
    "💳 <b>Yangi to‘lov kelib tushdi</b>",
    "",
    `👤 Foydalanuvchi: <b>${escapeTelegramHtml(fullName)}</b>`,
    usernameLine ? usernameLine.trim() : "",
    `🆔 Telegram ID: <code>${escapeTelegramHtml(telegramId)}</code>`,
    `💰 Summa: <b>${escapeTelegramHtml(formatMoney(payment?.amount))}</b>`,
    `📄 Fayl: ${escapeTelegramHtml(payment?.fileName || "Noma’lum")}`,
    `❓ Savollar soni: ${Number(payment?.questionCount || 0).toLocaleString("ru-RU")}`,
    `🕒 Vaqt: ${escapeTelegramHtml(timestamp)}`,
    receiptLine
  ].filter(Boolean).join("\n");
}

async function sendTelegramMessage(text) {
  const token = telegramBotToken.value();
  const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      chat_id:TELEGRAM_ADMIN_ID,
      text,
      parse_mode:"HTML",
      disable_web_page_preview:true
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(result.description || `Telegram API HTTP ${response.status}`);
  }
}

/**
 * Bir xil pendingPayment update’lari duplicate Telegram xabariga aylanmasligi
 * uchun Realtime Database’da atomic claim ishlatiladi.
 */
async function claimNotification(eventKey,uid,payment) {
  const database = getDatabase();
  const notificationRef = database.ref(`/system/telegramPaymentNotifications/${hashKey(eventKey)}`);
  const now = Date.now();
  let claimed = false;

  const result = await notificationRef.transaction(current => {
    if (current?.status === "sent") return current;
    if (current?.status === "sending" && now - Number(current.startedAt || 0) < CLAIM_TIMEOUT_MS) return current;
    claimed = true;
    return {
      status:"sending",
      uid:String(uid),
      eventKey,
      startedAt:now,
      fileName:String(payment?.fileName || "")
    };
  });

  return { ref:notificationRef, claimed:result.committed && claimed };
}

exports.notifyOnPendingPayment = onValueWritten({
  ref:"/users/{uid}/profile/pendingPayment",
  region:REGION,
  retry:true,
  secrets:[telegramBotToken],
  timeoutSeconds:60
},async event => {
  const before = event.data.before.val();
  const payment = event.data.after.val();
  const uid = String(event.params.uid);

  if (!payment || payment.status !== "pending") return;

  // Pending payment ichidagi boshqa maydonlar o‘zgargan bo‘lsa, qayta xabar yubormaymiz.
  const beforeWasPending = before?.status === "pending";
  if (beforeWasPending && paymentEventKey(uid,before) === paymentEventKey(uid,payment)) return;

  const database = getDatabase();
  const profileSnapshot = await database.ref(`/users/${uid}/profile`).get();
  const profile = profileSnapshot.exists() ? profileSnapshot.val() || {} : {};
  const eventKey = paymentEventKey(uid,payment);
  const claim = await claimNotification(eventKey,uid,payment);

  if (!claim.claimed) return;

  try {
    await sendTelegramMessage(formatPaymentMessage(uid,profile,payment));
    await claim.ref.update({
      status:"sent",
      sentAt:Date.now()
    });
    console.log(`Telegram payment notification sent for user ${uid}.`);
  } catch (error) {
    await claim.ref.update({
      status:"failed",
      failedAt:Date.now(),
      error:String(error?.message || error).slice(0,500)
    });
    throw error;
  }
});