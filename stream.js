// Must be first — sets FFmpeg path before any other module loads
const ffmpegStatic = require("ffmpeg-static");
const ffmpegPath = ffmpegStatic || "ffmpeg";
process.env.FFMPEG_PATH = ffmpegPath;
process.env.FFMPEG_BINARY = ffmpegPath;

require("dotenv").config();
const { Client } = require("discord.js-selfbot-v13");
const { Streamer, prepareStream, playStream, Utils, Encoders } = require("@dank074/discord-video-stream");
const fs   = require("fs");
const path = require("path");

// ── Config ──────────────────────────────────────────────────────────────────
const cfg = {
  TOKEN:        process.env.TOKEN,
  GUILD_ID:     process.env.GUILD_ID,
  CHANNEL_ID:   process.env.CHANNEL_ID,
  WIDTH:        parseInt(process.env.WIDTH)        || 1280,
  HEIGHT:       parseInt(process.env.HEIGHT)       || 720,
  FPS:          parseInt(process.env.FPS)          || 30,
  BITRATE_KBPS: parseInt(process.env.BITRATE_KBPS) || 3000,
};

["TOKEN", "GUILD_ID", "CHANNEL_ID"].forEach(k => {
  if (!cfg[k]) { console.error(`Missing env var: ${k}`); process.exit(1); }
});

// ── Setup ───────────────────────────────────────────────────────────────────
const MEDIA_DIR = path.join(__dirname, "media");
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);

const client   = new Client({ checkUpdate: false });
const streamer = new Streamer(client);

const log   = msg => console.log(`[${new Date().toISOString()}] ${msg}`);
const sleep = ms  => new Promise(r => setTimeout(r, ms));

log(`FFmpeg resolved to: ${ffmpegPath}`);

// ── Sanitize file path for FFmpeg (escape special chars) ────────────────────
function safePath(filePath) {
  // Pass via fs.createReadStream to avoid FFmpeg misreading special chars
  return fs.createReadStream(filePath);
}

// ── Media queue ─────────────────────────────────────────────────────────────
function getVideos() {
  const exts = [".mp4", ".mkv", ".mov", ".webm", ".avi"];
  return fs.readdirSync(MEDIA_DIR)
    .filter(f => exts.includes(path.extname(f).toLowerCase()))
    .map(f => path.join(MEDIA_DIR, f));
}

async function* videoQueue() {
  while (true) {
    const videos = [...getVideos()].sort(() => Math.random() - 0.5);
    if (!videos.length) {
      log("No videos in /media — waiting 10s...");
      await sleep(10000);
      continue;
    }
    for (const v of videos) yield v;
  }
}

// ── Stream loop ─────────────────────────────────────────────────────────────
async function run() {
  log(`Joining voice channel ${cfg.CHANNEL_ID}...`);
  await streamer.joinVoice(cfg.GUILD_ID, cfg.CHANNEL_ID);
  log("Joined. Starting playback loop...");

  for await (const file of videoQueue()) {
    log(`Now playing: ${path.basename(file)}`);
    try {
      const encoder = Encoders.software({
        x264: { preset: "superfast" },
      });

      // Use readable stream to avoid FFmpeg choking on special chars in filename
      const input = safePath(file);

      const { command, output } = prepareStream(input, {
        encoder,
        height:          cfg.HEIGHT,
        frameRate:       cfg.FPS,
        bitrateVideo:    cfg.BITRATE_KBPS,
        bitrateVideoMax: cfg.BITRATE_KBPS * 2,
        videoCodec:      Utils.normalizeVideoCodec("H264"),
        ffmpegPath:      ffmpegPath,
      });

      command.on("error",  err => log(`FFmpeg error: ${err.message}`));
      command.on("start",  cmd => log(`FFmpeg started`));
      command.on("stderr", line => { if (line.includes("Error")) log(`FFmpeg: ${line}`); });

      await playStream(output, streamer, { type: "go-live" });
      log(`Finished: ${path.basename(file)}`);
    } catch (err) {
      log(`Error on "${path.basename(file)}": ${err.message} — skipping`);
      await sleep(2000);
    }
  }
}

// ── Reconnect wrapper ───────────────────────────────────────────────────────
async function start() {
  while (true) {
    try {
      await run();
    } catch (err) {
      log(`Lost connection: ${err.message}`);
      log("Reconnecting in 5s...");
      try { streamer.stopStream(); } catch (_) {}
      await sleep(5000);
    }
  }
}

// ── Events ──────────────────────────────────────────────────────────────────
client.on("ready", () => {
  log(`Logged in as ${client.user.tag}`);
  start();
});

client.on("voiceStateUpdate", (oldState, newState) => {
  const kicked =
    oldState.channelId === cfg.CHANNEL_ID &&
    newState.channelId !== cfg.CHANNEL_ID &&
    oldState.member?.id === client.user?.id;
  if (kicked) {
    log("Kicked from voice — reconnecting in 5s...");
    try { streamer.stopStream(); } catch (_) {}
  }
});

process.on("SIGINT",  () => { streamer.stopStream(); client.destroy(); process.exit(0); });
process.on("SIGTERM", () => { streamer.stopStream(); client.destroy(); process.exit(0); });
process.on("unhandledRejection", err => log(`Unhandled: ${err?.message ?? err}`));

client.login(cfg.TOKEN);
