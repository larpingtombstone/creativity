require("dotenv").config();
const { Client } = require("discord.js-selfbot-v13");
const { Streamer, prepareStream, playStream, Utils, Encoders } = require("@dank074/discord-video-stream");

// ── Config ──────────────────────────────────────────────────────────────────
const cfg = {
  TOKEN:            process.env.TOKEN,
  GUILD_ID:         process.env.GUILD_ID,
  CHANNEL_ID:       process.env.CHANNEL_ID,
  OWNER_ID:         process.env.OWNER_ID,          // required for commands
  TEXT_CHANNEL_ID:  process.env.TEXT_CHANNEL_ID,   // optional: lock commands to one channel

  // ── Video quality (keep low on Railway 2 GB / 1 vCPU) ──
  WIDTH:            parseInt(process.env.WIDTH)            || 1280,
  HEIGHT:           parseInt(process.env.HEIGHT)           || 720,
  FPS:              parseInt(process.env.FPS)              || 24,
  BITRATE_KBPS:     parseInt(process.env.BITRATE_KBPS)     || 1200,
  BITRATE_MAX_KBPS: parseInt(process.env.BITRATE_MAX_KBPS) || 1800,

  // ── Pre-buffer: seconds after video starts to spin up the next FFmpeg proc.
  //    5 s is safe on 1 vCPU; raise if you still see gaps.
  PREBUFFER_SECS:   parseInt(process.env.PREBUFFER_SECS)   || 5,

  // ── Command prefix ──
  PREFIX: process.env.PREFIX || "!",
};

["TOKEN", "GUILD_ID", "CHANNEL_ID", "OWNER_ID"].forEach(k => {
  if (!cfg[k]) { console.error(`❌ Missing env var: ${k}`); process.exit(1); }
});

// ── 🎬 PLAYLIST ─────────────────────────────────────────────────────────────
const PLAYLIST = [
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_Media_ba7YbGO2aq4_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/g.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_Media_HE0mAgDAx-Q_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_Media_uIyivoWQVjs_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_Media_D50L4EeBHOs_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_The-Vanished-People-IT-S-GOING-DOWN-feat_Media_STiiHsg17Fk_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_Media_kqj7b59D85Y_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_Media_8Cm-7oCq9HA_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_Media_LxVv4QneUuU_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_Media_Soy4jGPHr3g_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_Media_F38EuG2dAyM_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_Media_3iUgKH8c7p4_001_1080p.mp4",
];

if (!PLAYLIST.length) { console.error("❌ PLAYLIST is empty"); process.exit(1); }

// ── Helpers ──────────────────────────────────────────────────────────────────
const client   = new Client({ checkUpdate: false });
const streamer = new Streamer(client);

const log   = msg => console.log(`[${new Date().toISOString()}] ${msg}`);
const sleep = ms  => new Promise(r => setTimeout(r, ms));

function labelOf(url) {
  return decodeURIComponent(url.split("/").pop()).replace(/_/g, " ");
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Railway-optimised shared encoder ─────────────────────────────────────────
// ultrafast + low thread count = keeps CPU under control on 1 vCPU
const encoder = Encoders.software({
  x264: { preset: "ultrafast", tune: "zerolatency", threads: 1 },
  x265: { preset: "ultrafast", tune: "zerolatency", threads: 1 },
});

// ── Stream state (shared between stream loop & command handler) ──────────────
const state = {
  // Shuffled queue of upcoming URLs (rebuilt when exhausted)
  queue:          [],
  // Index into PLAYLIST of what's currently on screen (for !queue display)
  nowPlayingIdx:  -1,
  // Fired to trigger an instant skip — resolved by the stream loop
  skipResolve:    null,
  // Pre-buffered next video slot
  nextVideo:      null,
  // The source URL we want to jump to (set by !play N), null = use queue
  jumpTo:         null,
};

function refillQueue() {
  state.queue = shuffle([...PLAYLIST]);
  log(`📋 Queue reshuffled — ${state.queue.length} items`);
}

function dequeueNext() {
  if (!state.queue.length) refillQueue();
  return state.queue.shift();
}

// ── Build a prepared FFmpeg stream object ─────────────────────────────────────
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

function killVideo(vid) {
  if (!vid) return;
  try { vid.command.kill("SIGKILL"); } catch (_) {}
}

// ── Core stream loop ──────────────────────────────────────────────────────────
async function run() {
  log(`🔗 Joining voice channel ${cfg.CHANNEL_ID}...`);
  await streamer.joinVoice(cfg.GUILD_ID, cfg.CHANNEL_ID);
  log(`✅ Joined`);

  const keepAlive = setInterval(() => {
    try { streamer.signalVideo?.(cfg.GUILD_ID, cfg.CHANNEL_ID, true); } catch (_) {}
  }, 4000);
  streamer._keepAlive = keepAlive;

  refillQueue();

  // Boot up: prepare first two videos
  let current = prepareVideo(dequeueNext());
  let next    = prepareVideo(dequeueNext());

  while (true) {
    log(`▶ Playing: ${current.label}`);
    state.nowPlayingIdx = PLAYLIST.indexOf(current.source);

    // Promise that resolves when a skip is requested
    const skipPromise = new Promise(res => { state.skipResolve = res; });

    // Pre-buffer the video-after-next a few seconds into playback
    let afterNext     = null;
    let prebufTimer   = setTimeout(() => {
      // If a jumpTo was set, honour it; otherwise pull from queue
      const src = state.jumpTo ?? dequeueNext();
      state.jumpTo = null;
      afterNext = prepareVideo(src);
    }, cfg.PREBUFFER_SECS * 1000);

    try {
      // Race: natural end vs skip command
      await Promise.race([
        playStream(current.output, streamer, { type: "go-live" }),
        skipPromise,
      ]);
      log(`⏭ Done/skipped: ${current.label}`);
    } catch (err) {
      log(`⚠ Error playing "${current.label}": ${err.message}`);
      killVideo(current);
    } finally {
      clearTimeout(prebufTimer);
      state.skipResolve = null;
    }

    // On skip: kill the current FFmpeg process immediately
    killVideo(current);

    // Promote next → current
    current = next;

    // If a jumpTo arrived between skip and now, ditch buffered next and use it
    if (state.jumpTo) {
      killVideo(next);
      current = prepareVideo(state.jumpTo);
      state.jumpTo = null;
      next = prepareVideo(dequeueNext());
    } else if (afterNext) {
      next = afterNext;
    } else {
      // Video ended before prebuf timer — prepare synchronously (rare)
      log(`⚡ Short video — preparing next on-demand`);
      next = prepareVideo(dequeueNext());
    }
  }
}

// ── Reconnect wrapper ─────────────────────────────────────────────────────────
async function startStream() {
  let attempt = 0;
  while (true) {
    try {
      attempt = 0;
      await run();
    } catch (err) {
      attempt++;
      const backoff = Math.min(5000 * attempt, 30000);
      log(`⚠ Connection lost (attempt ${attempt}) — retrying in ${backoff / 1000}s: ${err.message}`);
      try { clearInterval(streamer._keepAlive); streamer._keepAlive = null; } catch (_) {}
      try { streamer.stopStream?.(); } catch (_) {}
      await sleep(backoff);
    }
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────
// !next              — skip to next video immediately
// !play <number>     — jump to playlist item by 1-based number
// !queue             — show the upcoming shuffled queue + now playing
// !playlist          — list all videos with their numbers

function isOwner(msg) {
  return msg.author.id === cfg.OWNER_ID;
}

function inAllowedChannel(msg) {
  if (!cfg.TEXT_CHANNEL_ID) return true; // no restriction set
  return msg.channelId === cfg.TEXT_CHANNEL_ID;
}

client.on("messageCreate", async msg => {
  if (!isOwner(msg))           return;
  if (!inAllowedChannel(msg))  return;
  if (!msg.content.startsWith(cfg.PREFIX)) return;

  const [cmd, ...args] = msg.content.slice(cfg.PREFIX.length).trim().split(/\s+/);

  // ── !next ──────────────────────────────────────────────────────────────────
  if (cmd === "next") {
    log(`⏭ Owner requested skip`);
    if (state.skipResolve) {
      state.skipResolve();
    } else {
      await msg.reply("⚠️ Nothing is playing right now.");
      return;
    }
    await msg.reply("⏭ Skipping to next video...");
    return;
  }

  // ── !play <number> ─────────────────────────────────────────────────────────
  if (cmd === "play") {
    const n = parseInt(args[0]);
    if (isNaN(n) || n < 1 || n > PLAYLIST.length) {
      await msg.reply(`❌ Give a number between 1 and ${PLAYLIST.length}. Use \`${cfg.PREFIX}playlist\` to see them.`);
      return;
    }
    const target = PLAYLIST[n - 1];
    state.jumpTo = target;
    log(`🎯 Owner jumped to #${n}: ${labelOf(target)}`);
    if (state.skipResolve) state.skipResolve(); // trigger skip if playing
    await msg.reply(`🎯 Jumping to **#${n}** — ${labelOf(target)}`);
    return;
  }

  // ── !queue ─────────────────────────────────────────────────────────────────
  if (cmd === "queue") {
    const nowIdx  = state.nowPlayingIdx;
    const nowLine = nowIdx >= 0
      ? `▶️ **Now playing (#${nowIdx + 1}):** ${labelOf(PLAYLIST[nowIdx])}\n\n`
      : "";

    const upcoming = state.queue.slice(0, 10);
    const upLines  = upcoming.length
      ? upcoming.map((url, i) => `\`${i + 1}.\` ${labelOf(url)}`).join("\n")
      : "_Queue is empty (reshuffling soon)_";

    await msg.reply(`${nowLine}**Up next (shuffled):**\n${upLines}`);
    return;
  }

  // ── !playlist ──────────────────────────────────────────────────────────────
  if (cmd === "playlist") {
    const nowIdx = state.nowPlayingIdx;
    const lines  = PLAYLIST.map((url, i) => {
      const marker = i === nowIdx ? "▶️" : `\`${i + 1}.\``;
      return `${marker} ${labelOf(url)}`;
    });
    // Discord has a 2000 char limit; chunk if needed
    const chunks = [];
    let chunk    = `**Playlist (${PLAYLIST.length} videos):**\n`;
    for (const line of lines) {
      if (chunk.length + line.length + 1 > 1900) {
        chunks.push(chunk);
        chunk = "";
      }
      chunk += line + "\n";
    }
    if (chunk) chunks.push(chunk);
    for (const c of chunks) await msg.reply(c);
    return;
  }

  // ── !help ──────────────────────────────────────────────────────────────────
  if (cmd === "help") {
    await msg.reply(
      `**Commands (owner only):**\n` +
      `\`${cfg.PREFIX}next\` — skip to next video\n` +
      `\`${cfg.PREFIX}play <number>\` — jump to a specific video\n` +
      `\`${cfg.PREFIX}queue\` — show what's coming up\n` +
      `\`${cfg.PREFIX}playlist\` — list all ${PLAYLIST.length} videos with numbers`
    );
  }
});

// ── Voice follow + kick detection ─────────────────────────────────────────────
client.on("voiceStateUpdate", (oldState, newState) => {
  // Follow owner between channels
  if (newState.member?.id === cfg.OWNER_ID
      && newState.channelId
      && newState.channelId !== cfg.CHANNEL_ID) {
    log(`👤 Following owner to ${newState.channelId}`);
    cfg.CHANNEL_ID = newState.channelId;
  }

  const kicked =
    oldState.channelId === cfg.CHANNEL_ID &&
    !newState.channelId &&
    oldState.member?.id === client.user?.id;

  if (kicked) log(`⚠ Kicked from voice — reconnect loop will rejoin`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
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

// ── Startup ───────────────────────────────────────────────────────────────────
client.on("ready", () => {
  log(`🎮 Logged in as ${client.user.tag}`);
  log(`📋 ${PLAYLIST.length} video(s) in playlist`);
  startStream();
});

log("🚀 Starting...");
client.login(cfg.TOKEN);
