require("dotenv").config();
const { Client } = require("discord.js-selfbot-v13");
const { Streamer, prepareStream, playStream, Utils, Encoders } = require("@dank074/discord-video-stream");

// ── Config ────────────────────────────────────────────────────────────────────
const cfg = {
  TOKEN:            process.env.TOKEN,
  GUILD_ID:         process.env.GUILD_ID,
  CHANNEL_ID:       process.env.CHANNEL_ID,
  OWNER_ID:         process.env.OWNER_ID,
  TEXT_CHANNEL_ID:  process.env.TEXT_CHANNEL_ID,  // optional: lock commands to one channel
  WIDTH:            parseInt(process.env.WIDTH)            || 1280,
  HEIGHT:           parseInt(process.env.HEIGHT)           || 720,
  FPS:              parseInt(process.env.FPS)              || 24,
  BITRATE_KBPS:     parseInt(process.env.BITRATE_KBPS)     || 1200,
  BITRATE_MAX_KBPS: parseInt(process.env.BITRATE_MAX_KBPS) || 1800,
  PREFIX:           process.env.PREFIX || "!",
};

["TOKEN", "GUILD_ID", "CHANNEL_ID", "OWNER_ID"].forEach(k => {
  if (!cfg[k]) { console.error(`❌ Missing env var: ${k}`); process.exit(1); }
});

// ── Playlist ──────────────────────────────────────────────────────────────────
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
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video's/YTSave_YouTube_Media_3iUgKH8c7p4_001_1080p.mp4"
];

if (!PLAYLIST.length) { console.error("❌ PLAYLIST is empty"); process.exit(1); }

// ── Setup ─────────────────────────────────────────────────────────────────────
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

// Single encoder instance — never recreated
const encoder = Encoders.software({
  x264: { preset: "ultrafast", tune: "zerolatency", threads: 1 },
  x265: { preset: "ultrafast", tune: "zerolatency", threads: 1 },
});

// ── Queue state ───────────────────────────────────────────────────────────────
const state = {
  shuffledQueue:   [],   // upcoming URLs in shuffled order
  nowPlayingIdx:   -1,   // index in PLAYLIST of current video
  currentCommand:  null, // ffmpeg command currently running (so we can kill it)
  skipResolve:     null, // call this to trigger an instant skip
  jumpTo:          null, // set to a PLAYLIST url to jump there on next skip
};

function refillQueue() {
  state.shuffledQueue = shuffle([...PLAYLIST]);
  log(`📋 Queue reshuffled — ${state.shuffledQueue.length} items`);
}

function dequeueNext() {
  if (!state.shuffledQueue.length) refillQueue();
  return state.shuffledQueue.shift();
}

// ── Prepare ONE video (no lookahead — one FFmpeg at a time) ──────────────────
function prepareVideo(source) {
  const label = labelOf(source);
  log(`🎬 Preparing: ${label}`);
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
  command.on("error", err => {
    // Suppress "killed" errors from intentional SIGKILL on skip
    if (!err.message.includes("SIGKILL") && !err.message.includes("killed")) {
      log(`❌ FFmpeg [${label}]: ${err.message}`);
    }
  });
  state.currentCommand = command;
  return { command, output, label, source };
}

// ── Stream loop ───────────────────────────────────────────────────────────────
async function run() {
  log(`🔗 Joining voice channel ${cfg.CHANNEL_ID}...`);
  await streamer.joinVoice(cfg.GUILD_ID, cfg.CHANNEL_ID);
  log(`✅ Joined`);

  const keepAlive = setInterval(() => {
    try { streamer.signalVideo?.(cfg.GUILD_ID, cfg.CHANNEL_ID, true); } catch (_) {}
  }, 4000);
  streamer._keepAlive = keepAlive;

  refillQueue();

  while (true) {
    // Determine what to play next
    const source = state.jumpTo ?? dequeueNext();
    state.jumpTo = null;

    // Prepare and play — one FFmpeg process at a time
    const vid = prepareVideo(source);
    state.nowPlayingIdx = PLAYLIST.indexOf(source);
    log(`▶ Playing: ${vid.label}`);

    // Create a skip promise so commands can interrupt playStream
    const skipPromise = new Promise(res => { state.skipResolve = res; });

    try {
      await Promise.race([
        playStream(vid.output, streamer, { type: "go-live" }),
        skipPromise,
      ]);
      log(`⏭ Finished: ${vid.label}`);
    } catch (err) {
      if (!err.message?.includes("SIGKILL") && !err.message?.includes("killed")) {
        log(`⚠ Error: ${err.message}`);
      }
    } finally {
      state.skipResolve = null;
      // Always kill FFmpeg before starting the next one
      try { vid.command.kill("SIGKILL"); } catch (_) {}
      state.currentCommand = null;
      // Brief pause so the OS fully releases the process before we spawn a new one
      await sleep(300);
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
      log(`⚠ Lost connection (attempt ${attempt}) — retrying in ${backoff / 1000}s: ${err.message}`);
      try { clearInterval(streamer._keepAlive); streamer._keepAlive = null; } catch (_) {}
      try { streamer.stopStream?.(); } catch (_) {}
      await sleep(backoff);
    }
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────
function isOwner(msg)          { return msg.author.id === cfg.OWNER_ID; }
function inAllowedChannel(msg) {
  return !cfg.TEXT_CHANNEL_ID || msg.channelId === cfg.TEXT_CHANNEL_ID;
}

function doSkip() {
  if (state.skipResolve) {
    // Kill FFmpeg right now so there's no wait for playStream to notice
    try { state.currentCommand?.kill("SIGKILL"); } catch (_) {}
    state.skipResolve();
    return true;
  }
  return false;
}

client.on("messageCreate", async msg => {
  if (!isOwner(msg) || !inAllowedChannel(msg)) return;
  if (!msg.content.startsWith(cfg.PREFIX)) return;

  const [cmd, ...args] = msg.content.slice(cfg.PREFIX.length).trim().split(/\s+/);

  // !next
  if (cmd === "next") {
    if (doSkip()) {
      await msg.reply("⏭ Skipping...");
    } else {
      await msg.reply("⚠️ Nothing is playing right now.");
    }
    return;
  }

  // !play <number>
  if (cmd === "play") {
    const n = parseInt(args[0]);
    if (isNaN(n) || n < 1 || n > PLAYLIST.length) {
      await msg.reply(`❌ Pick a number between 1–${PLAYLIST.length}. Use \`${cfg.PREFIX}playlist\` to see them.`);
      return;
    }
    state.jumpTo = PLAYLIST[n - 1];
    doSkip();
    await msg.reply(`🎯 Jumping to **#${n}** — ${labelOf(PLAYLIST[n - 1])}`);
    return;
  }

  // !queue
  if (cmd === "queue") {
    const nowIdx  = state.nowPlayingIdx;
    const nowLine = nowIdx >= 0
      ? `▶️ **Now playing (#${nowIdx + 1}):** ${labelOf(PLAYLIST[nowIdx])}\n\n`
      : "";
    const upcoming = state.shuffledQueue.slice(0, 10);
    const upLines  = upcoming.length
      ? upcoming.map((url, i) => `\`${i + 1}.\` ${labelOf(url)}`).join("\n")
      : "_Queue empty — reshuffling soon_";
    await msg.reply(`${nowLine}**Up next:**\n${upLines}`);
    return;
  }

  // !playlist
  if (cmd === "playlist") {
    const nowIdx = state.nowPlayingIdx;
    const lines  = PLAYLIST.map((url, i) =>
      `${i === nowIdx ? "▶️" : `\`${i + 1}.\``} ${labelOf(url)}`
    );
    const chunks = [];
    let chunk    = `**Playlist (${PLAYLIST.length} videos):**\n`;
    for (const line of lines) {
      if (chunk.length + line.length + 1 > 1900) { chunks.push(chunk); chunk = ""; }
      chunk += line + "\n";
    }
    if (chunk) chunks.push(chunk);
    for (const c of chunks) await msg.reply(c);
    return;
  }

  // !help
  if (cmd === "help") {
    await msg.reply(
      `**Commands (owner only):**\n` +
      `\`${cfg.PREFIX}next\` — skip to next video\n` +
      `\`${cfg.PREFIX}play <number>\` — jump to a specific video\n` +
      `\`${cfg.PREFIX}queue\` — show upcoming videos\n` +
      `\`${cfg.PREFIX}playlist\` — list all ${PLAYLIST.length} videos with numbers`
    );
  }
});

// ── Voice follow + kick detection ─────────────────────────────────────────────
client.on("voiceStateUpdate", (oldState, newState) => {
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

// ── Shutdown ──────────────────────────────────────────────────────────────────
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
process.on("uncaughtException",  err => { log(`❌ Fatal: ${err?.message}`); process.exit(1); });

// ── Login ─────────────────────────────────────────────────────────────────────
client.on("ready", () => {
  log(`🎮 Logged in as ${client.user.tag}`);
  log(`📋 ${PLAYLIST.length} video(s) in playlist`);
  startStream();
});

log("🚀 Starting...");
client.login(cfg.TOKEN);
And improve the code nor the autoplay because its restream ( unstream and stream again )  and discord don't like that.
