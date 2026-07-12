require("dotenv").config();
const { Client } = require("discord.js-selfbot-v13");
const { Streamer, prepareStream, playStream, Utils, Encoders } = require("@dank074/discord-video-stream");
const fs   = require("fs");
const path = require("path");

// ── Config ──────────────────────────────────────────────────────────────────
const cfg = {
  TOKEN:            process.env.TOKEN,
  GUILD_ID:         process.env.GUILD_ID,
  CHANNEL_ID:       process.env.CHANNEL_ID,
  OWNER_ID:         process.env.OWNER_ID,
  WIDTH:            parseInt(process.env.WIDTH)            || 1280,
  HEIGHT:           parseInt(process.env.HEIGHT)           || 720,
  FPS:              parseInt(process.env.FPS)              || 24,
  BITRATE_KBPS:     parseInt(process.env.BITRATE_KBPS)     || 1500,
  BITRATE_MAX_KBPS: parseInt(process.env.BITRATE_MAX_KBPS) || 2500,
};

["TOKEN", "GUILD_ID", "CHANNEL_ID"].forEach(k => {
  if (!cfg[k]) { console.error(`❌ Missing env var: ${k}`); process.exit(1); }
});

// ── 🎬 PLAYLIST — add / remove URLs here ───────────────────────────────────
const PLAYLIST = [
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_My-Bread-was-Burnt-to-a-Crisp-Kasane-Tet_Media_YxSS7PkzGrQ_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_Defoko-My-Bread-Was-Burnt-to-a-Crisp-UTA_Media_jRlHeEyxvbE_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/g.mp4",
];
// ───────────────────────────────────────────────────────────────────────────

if (!PLAYLIST.length) {
  console.error("❌ PLAYLIST is empty — add at least one URL"); process.exit(1);
}

// ── Setup ───────────────────────────────────────────────────────────────────
const client   = new Client({ checkUpdate: false });
const streamer = new Streamer(client);

const log   = msg => console.log(`[${new Date().toISOString()}] ${msg}`);
const sleep = ms  => new Promise(r => setTimeout(r, ms));

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

function labelOf(url) {
  return decodeURIComponent(url.split("/").pop());
}

// ── Infinite shuffled queue ─────────────────────────────────────────────────
async function* videoQueue() {
  while (true) {
    const items = shuffle([...PLAYLIST]);
    log(`📋 Playlist shuffled — ${items.length} video(s) queued`);
    for (const url of items) {
      yield { source: url, label: labelOf(url) };
    }
  }
}

// ── Seamless stream loop ────────────────────────────────────────────────────
async function run() {
  log(`🔗 Joining voice channel ${cfg.CHANNEL_ID}...`);
  await streamer.joinVoice(cfg.GUILD_ID, cfg.CHANNEL_ID);
  log(`✅ Joined — streaming ${PLAYLIST.length} video(s) forever.`);

  // Keep Go Live signal alive between videos
  const keepAlive = setInterval(() => {
    try { streamer.signalVideo?.(cfg.GUILD_ID, cfg.CHANNEL_ID, true); } catch (_) {}
  }, 4000);
  streamer._keepAlive = keepAlive;

  const encoder = Encoders.software({
    x264: { preset: "ultrafast" },
    x265: { preset: "ultrafast" },
  });

  for await (const { source, label } of videoQueue()) {
    log(`▶ Playing: ${label}`);
    try {
      const { command, output } = prepareStream(source, {
        encoder,
        width:                       cfg.WIDTH,
        height:                      cfg.HEIGHT,
        frameRate:                   cfg.FPS,
        bitrateVideo:                cfg.BITRATE_KBPS,
        bitrateVideoMax:             cfg.BITRATE_MAX_KBPS,
        videoCodec:                  Utils.normalizeVideoCodec("H264"),
        includeAudio:                true,
        minimizeLatency:             true,
        hardwareAcceleratedDecoding: false,
      });

      command.on("error", err => log(`❌ FFmpeg: ${err.message}`));
      await playStream(output, streamer, { type: "go-live" });
      log(`⏭ Done: ${label}`);
    } catch (err) {
      log(`⚠ Skipping "${label}": ${err.message}`);
    }
    // Zero gap — next video starts immediately
  }
}

// ── Infinite reconnect wrapper ──────────────────────────────────────────────
async function startStream() {
  let attempt = 0;
  while (true) {
    try {
      attempt = 0;
      await run();
    } catch (err) {
      attempt++;
      const backoff = Math.min(5000 * attempt, 30000);
      log(`⚠ Lost connection (attempt ${attempt}) — reconnecting in ${backoff / 1000}s...`);
      try {
        if (streamer._keepAlive) {
          clearInterval(streamer._keepAlive);
          streamer._keepAlive = null;
        }
        streamer.stopStream?.();
      } catch (_) {}
      await sleep(backoff);
    }
  }
}

// ── Discord events ──────────────────────────────────────────────────────────
client.on("ready", () => {
  log(`🎮 Logged in as ${client.user.tag}`);
  log(`📋 Playlist: ${PLAYLIST.length} video(s)`);
  PLAYLIST.forEach((url, i) => log(`   ${i + 1}. ${labelOf(url)}`));
  startStream();
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  if (cfg.OWNER_ID
      && newState.member?.id === cfg.OWNER_ID
      && newState.channelId
      && newState.channelId !== cfg.CHANNEL_ID) {
    log(`👤 Following owner to channel ${newState.channelId}`);
    cfg.CHANNEL_ID = newState.channelId;
  }

  const kicked =
    oldState.channelId === cfg.CHANNEL_ID &&
    newState.channelId !== cfg.CHANNEL_ID &&
    oldState.member?.id === client.user?.id;

  if (kicked) log(`⚠ Kicked from voice — reconnect loop will rejoin`);
});

// ── Graceful shutdown ───────────────────────────────────────────────────────
function shutdown() {
  log("🛑 Shutting down...");
  try { clearInterval(streamer._keepAlive); } catch (_) {}
  try { streamer.stopStream?.(); } catch (_) {}
  try { client.destroy(); } catch (_) {}
  process.exit(0);
}

process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", err => log(`⚠ Unhandled: ${err?.message ?? err}`));
process.on("uncaughtException",  err => { log(`❌ Fatal: ${err?.message ?? err}`); process.exit(1); });

// ── Login ───────────────────────────────────────────────────────────────────
log("🚀 Starting Discord stream bot...");
client.login(cfg.TOKEN);
