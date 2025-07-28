const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

const settingsPath = "./settings.json";
let userSettings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath)) : {};

function saveSettings() {
  fs.writeFileSync(settingsPath, JSON.stringify(userSettings, null, 2));
}

function parseCommand(text) {
  const parts = text.trim().split(" ");
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);
  return { command, args };
}

function parseDeleteTime(setting) {
  if (!setting || setting === "never") return null;
  const unit = setting.slice(-1);
  const value = parseInt(setting.slice(0, -1));
  if (isNaN(value)) return null;
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: return null;
  }
}

async function handleCommand(from, command, args, sock) {
  if (!userSettings[from]) {
    userSettings[from] = { quality: "high", deleteAfter: "7d", platforms: ["facebook", "youtube", "instagram", "tiktok"] };
  }
  const settings = userSettings[from];
  switch (command) {
    case "/help":
      return await sock.sendMessage(from, {
        text: `🧠 *Bot Commands*:
/help
/quality [low|medium|high]
/delete after [1h|1d|7d|never]
/settings`
      });
    case "/quality":
      if (!["low", "medium", "high"].includes(args[0])) return await sock.sendMessage(from, { text: "❌ Usage: /quality low|medium|high" });
      settings.quality = args[0]; saveSettings();
      return await sock.sendMessage(from, { text: `✅ Quality set to *${args[0]}*` });
    case "/delete":
      if (args[0] !== "after" || !args[1]) return await sock.sendMessage(from, { text: "❌ Usage: /delete after 1h|1d|7d|never" });
      settings.deleteAfter = args[1]; saveSettings();
      return await sock.sendMessage(from, { text: `🗑️ Auto-delete set to *${args[1]}*` });
    case "/settings":
      return await sock.sendMessage(from, {
        text: `⚙️ *Your Settings*:
🎞️ Quality: ${settings.quality}
🕒 Delete: ${settings.deleteAfter}
📺 Platforms: ${settings.platforms.join(", ")}`
      });
    default:
      return await sock.sendMessage(from, { text: "❓ Unknown command. Try /help" });
  }
}

if (!fs.existsSync('./auth')) fs.mkdirSync('./auth');

async function startSock() {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const sock = makeWASocket({ version, auth: state, printQRInTerminal: false });

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("QR: https://api.qrserver.com/v1/create-qr-code/?data=" + encodeURIComponent(qr));
    }
    if (connection === 'close') {
      if ((lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut) startSock();
    } else if (connection === 'open') {
      console.log("✅ Bot is online");
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
    const lowerText = text.toLowerCase();

    if (text.startsWith("/")) {
      const { command, args } = parseCommand(text);
      await handleCommand(from, command, args, sock);
      return;
    }

    let platform = null;
    if (lowerText.includes("facebook.com")) platform = "facebook";
    else if (lowerText.includes("youtube.com") || lowerText.includes("youtu.be")) platform = "youtube";
    else if (lowerText.includes("instagram.com")) platform = "instagram";
    else if (lowerText.includes("tiktok.com")) platform = "tiktok";

    if (platform) {
      const fileName = `video_${Date.now()}.mp4`;
      const userQuality = userSettings[from]?.quality || "high";
      let format = "best";

      if (userQuality === "low") format = "worst[ext=mp4]";
      else if (userQuality === "medium") format = "best[height<=480][ext=mp4]";
      else format = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]";

      exec(`yt-dlp -f "${format}" -o "${fileName}" "${text}"`, async (err) => {
        if (err) {
          console.error("❌ Download error:", err);
          return await sock.sendMessage(from, { text: `❌ Failed to download ${platform} video.` });
        }

        if (fs.existsSync(fileName)) {
          const videoBuffer = fs.readFileSync(fileName);
          await sock.sendMessage(from, { video: videoBuffer, caption: `✅ Here's your ${platform} video!` });

          const delay = parseDeleteTime(userSettings[from]?.deleteAfter);
          if (delay) {
            setTimeout(() => {
              if (fs.existsSync(fileName)) fs.unlinkSync(fileName);
              console.log(`🗑️ Deleted ${fileName}`);
            }, delay);
          }
        }
      });
    }
  });
}

startSock().catch(console.error);
