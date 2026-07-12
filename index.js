require("dotenv").config();
const { Client } = require("discord.js-selfbot-v13");
const { Streamer, StreamOutput, getInputMetadata, inputHasAudio } = require("@dank074/discord-video-stream");
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

// ── Validate env ────────────────────────────────────────────────────────────
["TOKEN", "GUILD_ID", "CHANNEL_ID"].forEach(k => {
  if (!cfg[k]) { console.error(`Missing env var: ${k}`); process.exit(1); }
});

// ── Setup ───────────────────────────────────────────────────────────────────
const MEDIA_DIR = path.join(__dirname, "media");
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);

const client  = new Client({ checkUpdate: false });
const streamer = new Streamer(client);

// ── Helpers ─────────────────────────────────────────────────────────────────
const log   = msg => console.log(`[${new Date().toISOString()}] ${msg}`);
const sleep = ms  => new Promise(r => setTimeout(r, ms));

function getVideos() {
  const exts = [".mp4", ".mkv", ".mov", ".webm", ".avi"];
  return fs.readdirSync(MEDIA_DIR)
    .filter(f => exts.includes(path.extname(f).toLowerCase()))
    .map(f => path.join(MEDIA_DIR, f));
}

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

async function* videoQueue() {
  while (true) {
    const videos = shuffle(getVideos());
    if (!videos.length) {
      log("No videos found in /media — waiting 10s...");
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
      const conn = await streamer.createStream({
        width:        cfg.WIDTH,
        height:       cfg.HEIGHT,
        fps:          cfg.FPS,
        bitrateKbps:  cfg.BITRATE_KBPS,
        videoCodec:   "H264",
        readAtNativeFps: true,
        rtcpSenderReportEnabled: true,
      });

      const meta = await getInputMetadata(file);
      await StreamOutput(conn).playStream(file, inputHasAudio(meta), false);
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

// ── Discord events ──────────────────────────────────────────────────────────
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
    log("Kicked from voice channel — reconnecting in 5s...");
    try { streamer.stopStream(); } catch (_) {}
  }
});

// ── Graceful shutdown ───────────────────────────────────────────────────────
process.on("SIGINT",  () => { log("Shutting down..."); streamer.stopStream(); client.destroy(); process.exit(0); });
process.on("SIGTERM", () => { log("Shutting down..."); streamer.stopStream(); client.destroy(); process.exit(0); });

process.on("unhandledRejection", err => {
  log(`Unhandled rejection: ${err?.message ?? err}`);
});

// ── Login ───────────────────────────────────────────────────────────────────
client.login(cfg.TOKEN);
