require("dotenv").config();
const { Client } = require("discord.js-selfbot-v13");
const { Streamer, prepareStream, playStream, Utils, Encoders } = require("@dank074/discord-video-stream");

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

  // How many seconds before a video ends to start pre-buffering the next one.
  // Lower = faster transition but more overlap. 5s is a safe sweet spot.
  PREBUFFER_SECS: parseInt(process.env.PREBUFFER_SECS) || 5,
};

["TOKEN", "GUILD_ID", "CHANNEL_ID"].forEach(k => {
  if (!cfg[k]) { console.error(`❌ Missing env var: ${k}`); process.exit(1); }
});

// ── 🎬 PLAYLIST — add / remove URLs here ───────────────────────────────────
const PLAYLIST = [
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_Media_ba7YbGO2aq4_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/g.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_Media_HE0mAgDAx-Q_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_Media_uIyivoWQVjs_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_Media_D50L4EeBHOs_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_The-Vanished-People-IT-S-GOING-DOWN-feat_Media_STiiHsg17Fk_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_Media_V4elF7---KQ_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_Media_kqj7b59D85Y_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_Media_8Cm-7oCq9HA_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_Media_LxVv4QneUuU_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_Media_Soy4jGPHr3g_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_Media_F38EuG2dAyM_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_Media_3iUgKH8c7p4_001_1080p.mp4",
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

// ── Shared encoder (reused across all videos) ───────────────────────────────
const encoder = Encoders.software({
  x264: { preset: "ultrafast" },
  x265: { preset: "ultrafast" },
});

// ── Pre-buffer a single video — returns { command, output, label } ──────────
function prepareVideo(source) {
  const label = labelOf(source);
  log(`🔄 Pre-buffering: ${label}`);
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
  command.on("error", err => log(`❌ FFmpeg [${label}]: ${err.message}`));
  return { command, output, label, source };
}

// ── Infinite shuffled queue ─────────────────────────────────────────────────
function* urlQueue() {
  while (true) {
    const items = shuffle([...PLAYLIST]);
    log(`📋 Playlist shuffled — ${items.length} video(s) queued`);
    yield* items;
  }
}

// ── Core stream loop with instant pre-buffered transitions ──────────────────
async function run() {
  log(`🔗 Joining voice channel ${cfg.CHANNEL_ID}...`);
  await streamer.joinVoice(cfg.GUILD_ID, cfg.CHANNEL_ID);
  log(`✅ Joined — streaming ${PLAYLIST.length} video(s) forever.`);

  // Keep Go Live signal alive between videos
  const keepAlive = setInterval(() => {
    try { streamer.signalVideo?.(cfg.GUILD_ID, cfg.CHANNEL_ID, true); } catch (_) {}
  }, 4000);
  streamer._keepAlive = keepAlive;

  const queue = urlQueue();

  // Prepare the very first video immediately
  let current = prepareVideo(queue.next().value);
  // Pre-buffer the second video right away so it's ready when video 1 ends
  let next    = prepareVideo(queue.next().value);

  while (true) {
    log(`▶ Playing: ${current.label}`);

    // Schedule pre-buffer of the video AFTER next, PREBUFFER_SECS before current ends.
    // We track when current started so we can time it correctly.
    let afterNext = null;
    let prebufferTimer = null;

    // playStream resolves when the current video finishes.
    // We race it with a timer that fires PREBUFFER_SECS before the expected end
    // to kick off the video-after-next. Since we don't know video duration up front,
    // we instead start preparing it a fixed delay after playback begins — this is
    // fine because FFmpeg on the NEXT video will be fully spun up long before we need it.
    prebufferTimer = setTimeout(() => {
      const upcoming = queue.next().value;
      afterNext = prepareVideo(upcoming);
    }, cfg.PREBUFFER_SECS * 1000);

    try {
      await playStream(current.output, streamer, { type: "go-live" });
      log(`⏭ Done: ${current.label}`);
    } catch (err) {
      log(`⚠ Skipping "${current.label}": ${err.message}`);
      // Kill the ffmpeg process cleanly if playback errored
      try { current.command.kill("SIGKILL"); } catch (_) {}
    } finally {
      clearTimeout(prebufferTimer);
    }

    // Instant hand-off — `next` is already buffered and ready
    current = next;

    // If afterNext is already prepared (prebuffer timer fired), use it.
    // If not (video was very short), prepare it now — slight delay but no crash.
    if (afterNext) {
      next = afterNext;
    } else {
      log(`⚡ Video was shorter than PREBUFFER_SECS — preparing next synchronously`);
      next = prepareVideo(queue.next().value);
    }
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
