require("dotenv").config();
const { Client } = require("discord.js-selfbot-v13");
const { Streamer, prepareStream, playStream, Utils, Encoders } = require("@dank074/discord-video-stream");
const { createClient } = require("@supabase/supabase-js");
const YTDlpWrap = require("yt-dlp-wrap").default;
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
  MODE:             process.env.MODE                       || "supabase",
  YOUTUBE_URL:      process.env.YOUTUBE_URL                || "",
  SUPABASE_URL:     process.env.SUPABASE_URL               || "",
  SUPABASE_KEY:     process.env.SUPABASE_KEY               || "",
  SUPABASE_BUCKET:  process.env.SUPABASE_BUCKET            || "media",
};

// ── Validate ────────────────────────────────────────────────────────────────
["TOKEN", "GUILD_ID", "CHANNEL_ID"].forEach(k => {
  if (!cfg[k]) { console.error(`❌ Missing env var: ${k}`); process.exit(1); }
});
if (cfg.MODE === "youtube" && !cfg.YOUTUBE_URL) {
  console.error("❌ MODE=youtube but YOUTUBE_URL is not set"); process.exit(1);
}
if (cfg.MODE === "supabase" && (!cfg.SUPABASE_URL || !cfg.SUPABASE_KEY)) {
  console.error("❌ MODE=supabase but SUPABASE_URL or SUPABASE_KEY is missing"); process.exit(1);
}

// ── Setup ───────────────────────────────────────────────────────────────────
const MEDIA_DIR = path.join(__dirname, "media");
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);

const client   = new Client({ checkUpdate: false });
const streamer = new Streamer(client);
const ytdlp    = new YTDlpWrap();
const supabase = cfg.SUPABASE_URL
  ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY)
  : null;

const log   = msg => console.log(`[${new Date().toISOString()}] ${msg}`);
const sleep = ms  => new Promise(r => setTimeout(r, ms));

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

// ── Source: Supabase ────────────────────────────────────────────────────────
async function getSupabaseVideos() {
  log("☁️  Fetching video list from Supabase...");
  const { data, error } = await supabase.storage
    .from(cfg.SUPABASE_BUCKET)
    .list("", { limit: 500, sortBy: { column: "name", order: "asc" } });

  if (error) {
    log(`❌ Supabase error: ${error.message}`);
    return [];
  }

  const exts = [".mp4", ".mkv", ".mov", ".webm", ".avi"];
  const files = data.filter(f => exts.includes(path.extname(f.name).toLowerCase()));

  if (!files.length) {
    log("⚠ No videos found in Supabase bucket");
    return [];
  }

  return files.map(f => {
    const { data: urlData } = supabase.storage
      .from(cfg.SUPABASE_BUCKET)
      .getPublicUrl(f.name);
    return { label: f.name, source: urlData.publicUrl };
  });
}

// ── Source: YouTube ─────────────────────────────────────────────────────────
async function getYouTubeEntries() {
  log("📡 Fetching playlist from YouTube...");
  try {
    const info = await ytdlp.getVideoInfo([
      cfg.YOUTUBE_URL,
      "--flat-playlist",
      "--no-warnings",
    ]);
    if (Array.isArray(info)) {
      log(`📋 Found ${info.length} videos`);
      return info.map(e => e.url || e.webpage_url);
    }
    return [info.webpage_url || cfg.YOUTUBE_URL];
  } catch (err) {
    log(`❌ YouTube fetch failed: ${err.message}`);
    return [];
  }
}

async function resolveYouTubeURL(url) {
  try {
    const result = await ytdlp.execPromise([
      url,
      "-f", "bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      "--get-url",
      "--no-warnings",
    ]);
    return result.trim().split("\n")[0];
  } catch (err) {
    log(`❌ Could not resolve stream URL: ${err.message}`);
    return null;
  }
}

// ── Source: Local ───────────────────────────────────────────────────────────
function getLocalVideos() {
  const exts = [".mp4", ".mkv", ".mov", ".webm", ".avi"];
  return fs.readdirSync(MEDIA_DIR)
    .filter(f => exts.includes(path.extname(f).toLowerCase()))
    .map(f => ({ label: path.basename(f), source: path.join(MEDIA_DIR, f) }));
}

// ── Video queue (infinite generator) ───────────────────────────────────────
async function* videoQueue() {
  while (true) {
    let items = [];

    if (cfg.MODE === "supabase") {
      const videos = await getSupabaseVideos();
      if (!videos.length) { await sleep(15000); continue; }
      items = shuffle(videos);
      log(`☁️  ${items.length} video(s) from Supabase — looping...`);
      for (const item of items) yield item;

    } else if (cfg.MODE === "youtube") {
      const urls = shuffle(await getYouTubeEntries());
      if (!urls.length) { await sleep(15000); continue; }
      for (const url of urls) {
        const source = await resolveYouTubeURL(url);
        if (!source) continue;
        yield { source, label: url };
      }

    } else {
      const videos = shuffle(getLocalVideos());
      if (!videos.length) {
        log("⚠ No videos in /media — waiting 10s...");
        await sleep(10000);
        continue;
      }
      log(`📁 ${videos.length} local video(s) — looping...`);
      for (const item of videos) yield item;
    }
  }
}

// ── Seamless stream loop ────────────────────────────────────────────────────
async function run() {
  log(`🔗 Joining voice channel ${cfg.CHANNEL_ID}...`);
  await streamer.joinVoice(cfg.GUILD_ID, cfg.CHANNEL_ID);
  log(`✅ Joined. Mode: ${cfg.MODE.toUpperCase()} — streaming forever.`);

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
