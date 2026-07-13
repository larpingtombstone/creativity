require("dotenv").config();
const { Client } = require("discord.js-selfbot-v13");
const { Streamer, prepareStream, playStream, Utils, Encoders } = require("@dank074/discord-video-stream");
const path = require("path");

// -- Config --------------------------------------------------------------------
const cfg = {
  TOKEN:            process.env.TOKEN,
  GUILD_ID:         process.env.GUILD_ID,
  CHANNEL_ID:       process.env.CHANNEL_ID,
  OWNER_ID:         process.env.OWNER_ID,
  TEXT_CHANNEL_ID:  process.env.TEXT_CHANNEL_ID,
  PREFIX:           process.env.PREFIX || "!",
  WIDTH:            parseInt(process.env.WIDTH)            || 1920,
  HEIGHT:           parseInt(process.env.HEIGHT)           || 1080,
  FPS:              parseInt(process.env.FPS)              || 30,
  BITRATE_KBPS:     parseInt(process.env.BITRATE_KBPS)     || 2500,
  BITRATE_MAX_KBPS: parseInt(process.env.BITRATE_MAX_KBPS) || 3500,
  PRESET:           process.env.PRESET                     || "veryfast",
};

for (const key of ["TOKEN", "GUILD_ID", "CHANNEL_ID", "OWNER_ID", "TEXT_CHANNEL_ID"]) {
  if (!cfg[key]) {
    console.error(`[ERROR] Missing env var: ${key}`);
    process.exit(1);
  }
}

// -- Playlist ------------------------------------------------------------------
const PLAYLIST = [
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video%27s/YTSave_YouTube_Media_ba7YbGO2aq4_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video%27s/g.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video%27s/YTSave_YouTube_Media_HE0mAgDAx-Q_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video%27s/YTSave_YouTube_Media_uIyivoWQVjs_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video%27s/YTSave_YouTube_Media_D50L4EeBHOs_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video%27s/YTSave_YouTube_The-Vanished-People-IT-S-GOING-DOWN-feat_Media_STiiHsg17Fk_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video%27s/YTSave_YouTube_Media_kqj7b59D85Y_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video%27s/YTSave_YouTube_Media_8Cm-7oCq9HA_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video%27s/YTSave_YouTube_Media_LxVv4QneUuU_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video%27s/YTSave_YouTube_Media_Soy4jGPHr3g_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video%27s/YTSave_YouTube_Media_F38EuG2dAyM_001_1080p.mp4",
  "https://loowdhvbbhfjcpixsvxt.supabase.co/storage/v1/object/public/Video%27s/YTSave_YouTube_Media_3iUgKH8c7p4_001_1080p.mp4",
];

if (!PLAYLIST.length) {
  console.error("[ERROR] PLAYLIST is empty");
  process.exit(1);
}

// -- Setup ---------------------------------------------------------------------
const client   = new Client({ checkUpdate: false });
const streamer = new Streamer(client);

const log   = msg => console.log(`[${new Date().toISOString()}] ${msg}`);
const sleep = ms  => new Promise(r => setTimeout(r, ms));
const labelOf = url => decodeURIComponent(url.split("/").pop()).replace(/_/g, " ");

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildEncoder() {
  return Encoders.software({
    x264: { preset: cfg.PRESET, tune: "zerolatency", threads: 1 },
    x265: { preset: cfg.PRESET, tune: "zerolatency", threads: 1 },
  });
}

let encoder = buildEncoder();

// -- State ---------------------------------------------------------------------
const state = {
  queue:          [],
  currentUrl:     null,
  currentCommand: null,
  sessionStart:   null,
  sessionResolve: null,
};

function fillQueue() {
  state.queue = shuffle([...PLAYLIST]);
  log(`[INFO] Queue refreshed and shuffled with ${state.queue.length} videos`);
}

// -- Stream session ------------------------------------------------------------
async function streamVideo(videoUrl) {
  state.currentUrl = videoUrl;
  state.sessionStart = Date.now();

  log(`[PLAYING] ${labelOf(videoUrl)}`);
  log(`[SETTINGS] ${cfg.WIDTH}x${cfg.HEIGHT}@${cfg.FPS}fps | ${cfg.BITRATE_KBPS}-${cfg.BITRATE_MAX_KBPS}kbps | preset: ${cfg.PRESET}`);

  const { command, output } = prepareStream(videoUrl, {
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
    customInputOptions: [
      "-protocol_whitelist", "file,http,https,tcp,tls,crypto"
    ]
  });

  state.currentCommand = command;

  const sessionPromise = new Promise(resolve => {
    state.sessionResolve = resolve;
  });

  command.on("end", () => {
    log(`[FINISHED] ${labelOf(videoUrl)}`);
    if (state.sessionResolve) state.sessionResolve();
  });

  command.on("error", err => {
    const m = err?.message || String(err);
    if (!m.includes("SIGKILL") && !m.includes("killed")) {
      log(`[ERROR] FFmpeg: ${m}`);
    }
    if (state.sessionResolve) state.sessionResolve();
  });

  // Run the stream and race it against an internal completion signal
  await Promise.race([
    playStream(output, streamer, { type: "go-live" }),
    sessionPromise
  ]);

  // Clean up references for this video
  try { command.kill("SIGKILL"); } catch (_) {}
  state.currentCommand = null;
  state.sessionResolve = null;
  state.currentUrl = null;
}

// -- Main loop -----------------------------------------------------------------
async function run() {
  log(`[INFO] Joining voice channel ${cfg.CHANNEL_ID}...`);
  await streamer.joinVoice(cfg.GUILD_ID, cfg.CHANNEL_ID);
  log(`[SUCCESS] Joined voice channel`);

  const keepAlive = setInterval(() => {
    try { streamer.signalVideo?.(cfg.GUILD_ID, cfg.CHANNEL_ID, true); } catch (_) {}
  }, 4000);
  streamer._keepAlive = keepAlive;

  while (true) {
    if (!state.queue.length) {
      fillQueue();
    }
    const nextVideo = state.queue.shift();
    await streamVideo(nextVideo);
    await sleep(1000); // Small cooldown buffer between streams
  }
}

async function startStream() {
  let attempt = 0;
  while (true) {
    try {
      attempt = 0;
      await run();
    } catch (err) {
      attempt++;
      const backoff = Math.min(5000 * attempt, 30000);
      log(`[WARN] Lost connection (attempt ${attempt}) - retrying in ${backoff / 1000}s: ${err.message}`);
      try { clearInterval(streamer._keepAlive); streamer._keepAlive = null; } catch (_) {}
      try { streamer.stopStream?.(); } catch (_) {}
      await sleep(backoff);
    }
  }
}

function interruptCurrentVideo() {
  if (state.sessionResolve) {
    try { state.currentCommand?.kill("SIGKILL"); } catch (_) {}
    state.sessionResolve();
    return true;
  }
  return false;
}

// -- Commands ------------------------------------------------------------------
function isOwner(msg) { return msg.author.id === cfg.OWNER_ID; }
function inAllowedChannel(msg) {
  if (!msg.guild) return false; 
  return msg.channelId === cfg.TEXT_CHANNEL_ID;
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m ${s % 60}s`;
}

client.on("messageCreate", async msg => {
  if (!isOwner(msg) || !inAllowedChannel(msg)) return;
  if (!msg.content.startsWith(cfg.PREFIX)) return;

  const [cmd, ...args] = msg.content.slice(cfg.PREFIX.length).trim().split(/\s+/);

  switch (cmd) {

    case "next": {
      if (interruptCurrentVideo()) {
        log("[CMD] Skip triggered by owner");
      } else {
        log("[WARN] Skip requested but nothing is currently playing");
      }
      break;
    }

    case "play": {
      const n = parseInt(args[0]);
      if (isNaN(n) || n < 1 || n > PLAYLIST.length) {
        await msg.reply(`Pick a number 1-${PLAYLIST.length}. Use ${cfg.PREFIX}playlist to see options in your logs.`);
        break;
      }
      const url = PLAYLIST[n - 1];
      
      // Inject selected video directly to the front of the queue and skip current
      state.queue.unshift(url);
      interruptCurrentVideo();
      
      await msg.reply(`Jumping to video #${n}`);
      log(`[CMD] Owner jumped to #${n} - ${labelOf(url)}`);
      break;
    }

    case "queue": {
      log(`[QUEUE] Next up (${state.queue.length} videos):`);
      state.queue.forEach((url, i) => log(`  ${i + 1}. ${labelOf(url)}`));
      break;
    }

    case "playlist": {
      log(`[PLAYLIST] Full roster (${PLAYLIST.length} videos):`);
      PLAYLIST.forEach((url, i) => log(`  ${i + 1}. ${labelOf(url)}`));
      break;
    }

    case "status": {
      const uptime = state.sessionStart ? formatUptime(Date.now() - state.sessionStart) : "n/a";
      const currentTrack = state.currentUrl ? labelOf(state.currentUrl) : "None";
      await msg.reply(
        `Uptime: ${uptime}\n` +
        `Playing: ${currentTrack}\n` +
        `Resolution: ${cfg.WIDTH}x${cfg.HEIGHT} @ ${cfg.FPS}fps\n` +
        `Bitrate: ${cfg.BITRATE_KBPS}-${cfg.BITRATE_MAX_KBPS} kbps\n` +
        `Preset: ${cfg.PRESET}\n` +
        `Total Playlist Tracks: ${PLAYLIST.length}`
      );
      break;
    }

    case "bitrate": {
      const kbps = parseInt(args[0]);
      if (isNaN(kbps) || kbps < 300 || kbps > 8000) {
        await msg.reply("Usage: !bitrate <300-8000>");
        break;
      }
      cfg.BITRATE_KBPS     = kbps;
      cfg.BITRATE_MAX_KBPS = Math.round(kbps * 1.4);
      
      if (state.currentUrl) state.queue.unshift(state.currentUrl);
      interruptCurrentVideo();
      
      await msg.reply(`Bitrate adjusted to ${cfg.BITRATE_KBPS}-${cfg.BITRATE_MAX_KBPS} kbps. Restarting stream...`);
      break;
    }

    case "resolution": {
      const match = (args[0] || "").match(/^(\d+)x(\d+)$/i);
      if (!match) {
        await msg.reply("Usage: !resolution <WxH> e.g. !resolution 1280x720");
        break;
      }
      cfg.WIDTH  = parseInt(match[1]);
      cfg.HEIGHT = parseInt(match[2]);
      
      if (state.currentUrl) state.queue.unshift(state.currentUrl);
      interruptCurrentVideo();
      
      await msg.reply(`Resolution adjusted to ${cfg.WIDTH}x${cfg.HEIGHT}. Restarting stream...`);
      break;
    }

    case "preset": {
      const valid = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium"];
      const p = (args[0] || "").toLowerCase();
      if (!valid.includes(p)) {
        await msg.reply(`Usage: !preset <${valid.join("|")}>`);
        break;
      }
      cfg.PRESET = p;
      encoder = buildEncoder();
      
      if (state.currentUrl) state.queue.unshift(state.currentUrl);
      interruptCurrentVideo();
      
      await msg.reply(`Preset adjusted to ${p}. Restarting stream...`);
      break;
    }

    case "help": {
      await msg.reply(
        `**Commands (owner only):**\n` +
        `\`${cfg.PREFIX}next\` - Skip current video\n` +
        `\`${cfg.PREFIX}play <n>\` - Jump to video #n\n` +
        `\`${cfg.PREFIX}queue\` - Print queue order to console\n` +
        `\`${cfg.PREFIX}playlist\` - Print full playlist to console\n` +
        `\`${cfg.PREFIX}status\` - Check stream statistics\n` +
        `\`${cfg.PREFIX}bitrate <kbps>\` - Change dynamic bitrate (300-8000)\n` +
        `\`${cfg.PREFIX}resolution <WxH>\` - Set canvas resolution\n` +
        `\`${cfg.PREFIX}preset <type>\` - Set optimization preset`
      );
      break;
    }
  }
});

// -- Voice events --------------------------------------------------------------
client.on("voiceStateUpdate", (oldState, newState) => {
  if (newState.member?.id === cfg.OWNER_ID
      && newState.channelId
      && newState.channelId !== cfg.CHANNEL_ID) {
    log(`[INFO] Following owner to channel ${newState.channelId}`);
    cfg.CHANNEL_ID = newState.channelId;
  }
  const kicked =
    oldState.channelId === cfg.CHANNEL_ID &&
    !newState.channelId &&
    oldState.member?.id === client.user?.id;
  if (kicked) log(`[WARN] Disconnected from voice - automated reconnect handler active`);
});

// -- Shutdown ------------------------------------------------------------------
function shutdown() {
  log("[INFO] Shutting down cleanly...");
  try { clearInterval(streamer._keepAlive); } catch (_) {}
  try { state.currentCommand?.kill("SIGKILL"); } catch (_) {}
  try { streamer.stopStream?.(); } catch (_) {}
  try { client.destroy(); } catch (_) {}
  process.exit(0);
}

process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", err => log(`[WARN] Unhandled rejection: ${err?.message ?? err}`));
process.on("uncaughtException",  err => { log(`[FATAL] Uncaught exception: ${err?.message}`); process.exit(1); });

// -- Login ---------------------------------------------------------------------
client.on("ready", () => {
  log(`[INFO] Logged in as ${client.user.tag}`);
  log(`[INFO] Loaded ${PLAYLIST.length} videos`);
  startStream();
});

log("[INFO] Initializing Discord stream client...");
client.login(cfg.TOKEN);
    
