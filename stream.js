require("dotenv").config();
const { Client } = require("discord.js-selfbot-v13");
const { Streamer, prepareStream, playStream, Utils, Encoders } = require("@dank074/discord-video-stream");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const cfg = {
  TOKEN:            process.env.TOKEN,
  GUILD_ID:         process.env.GUILD_ID,
  CHANNEL_ID:       process.env.CHANNEL_ID,
  OWNER_ID:         process.env.OWNER_ID,
  PREFIX:           process.env.PREFIX || "!",

  WIDTH:            parseInt(process.env.WIDTH)            || 1920,
  HEIGHT:           parseInt(process.env.HEIGHT)           || 1080,
  FPS:              parseInt(process.env.FPS)              || 30,
  BITRATE_KBPS:     parseInt(process.env.BITRATE_KBPS)     || 2500,
  BITRATE_MAX_KBPS: parseInt(process.env.BITRATE_MAX_KBPS) || 3500,
  PRESET:           process.env.PRESET || "veryfast",
};

for (const key of ["TOKEN", "GUILD_ID", "CHANNEL_ID", "OWNER_ID"]) {
  if (!cfg[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Playlist
// ─────────────────────────────────────────────────────────────────────────────
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

if (!PLAYLIST.length) {
  console.error("PLAYLIST is empty — add at least one URL");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Client / Streamer setup
// ─────────────────────────────────────────────────────────────────────────────
const client   = new Client({ checkUpdate: false });
const streamer = new Streamer(client);

const log   = msg => console.log(`[${new Date().toISOString()}] ${msg}`);
const sleep = ms  => new Promise(resolve => setTimeout(resolve, ms));

const labelOf = url => decodeURIComponent(url.split("/").pop()).replace(/_/g, " ");

function shuffle(arr) {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function buildEncoder() {
  return Encoders.software({
    x264: { preset: cfg.PRESET, tune: "zerolatency", threads: 1 },
    x265: { preset: cfg.PRESET, tune: "zerolatency", threads: 1 },
  });
}

let encoder = buildEncoder();

// ─────────────────────────────────────────────────────────────────────────────
// Concat playlist file
//
// A single ffmpeg process plays every video back to back with zero gap and
// zero re-negotiation of Go Live. "-stream_loop -1" makes ffmpeg loop the
// whole list on its own, so playStream() only runs once per session.
// ─────────────────────────────────────────────────────────────────────────────
const CONCAT_PATH = path.join(os.tmpdir(), "stream_playlist.txt");

function writeConcatFile(order) {
  const lines = order.map(url => `file ${url}`).join("\n");
  fs.writeFileSync(CONCAT_PATH, lines, "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime state
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  order:          [],
  currentCommand: null,
  restartResolve: null,
  pendingJump:    null,
  sessionStart:   null,
};

function buildOrderStartingAt(startUrl) {
  const rest = shuffle(PLAYLIST.filter(u => u !== startUrl));
  return startUrl ? [startUrl, ...rest] : shuffle([...PLAYLIST]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream session — one continuous ffmpeg process per session
// ─────────────────────────────────────────────────────────────────────────────
async function streamSession(startUrl) {
  state.order = buildOrderStartingAt(startUrl);
  writeConcatFile(state.order);
  state.sessionStart = Date.now();

  log(`Session start — ${state.order.length} video(s), leading with: ${labelOf(state.order[0])}`);
  log(`Encoding: ${cfg.WIDTH}x${cfg.HEIGHT}@${cfg.FPS}fps, ${cfg.BITRATE_KBPS}-${cfg.BITRATE_MAX_KBPS}kbps, preset ${cfg.PRESET}`);

  const { command, output } = prepareStream(CONCAT_PATH, {
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
      "-f", "concat",
      "-safe", "0",
      "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
      "-stream_loop", "-1",
    ],
  });

  command.on("error", err => {
    const msg = err?.message || String(err);
    if (!msg.includes("SIGKILL") && !msg.includes("killed")) {
      log(`ffmpeg error: ${msg}`);
    }
  });

  state.currentCommand = command;

  const restartPromise = new Promise(resolve => { state.restartResolve = resolve; });
  await Promise.race([
    playStream(output, streamer, { type: "go-live" }),
    restartPromise,
  ]);

  try { command.kill("SIGKILL"); } catch (_) {}
  state.currentCommand = null;
  state.restartResolve = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main loop — only re-enters on manual skip/jump or disconnect
// ─────────────────────────────────────────────────────────────────────────────
async function run() {
  log(`Joining voice channel ${cfg.CHANNEL_ID}`);
  await streamer.joinVoice(cfg.GUILD_ID, cfg.CHANNEL_ID);
  log("Joined voice channel");

  const keepAlive = setInterval(() => {
    try { streamer.signalVideo?.(cfg.GUILD_ID, cfg.CHANNEL_ID, true); } catch (_) {}
  }, 4000);
  streamer._keepAlive = keepAlive;

  let nextStart = null;
  while (true) {
    await streamSession(nextStart);
    nextStart = state.pendingJump;
    state.pendingJump = null;
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
      log(`Connection lost (attempt ${attempt}) — retrying in ${backoff / 1000}s: ${err.message}`);
      try { clearInterval(streamer._keepAlive); streamer._keepAlive = null; } catch (_) {}
      try { streamer.stopStream?.(); } catch (_) {}
      await sleep(backoff);
    }
  }
}

function forceRestart(jumpUrl) {
  if (!state.restartResolve) return false;
  state.pendingJump = jumpUrl || null;
  try { state.currentCommand?.kill("SIGKILL"); } catch (_) {}
  state.restartResolve();
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands — owner only, any channel
// ─────────────────────────────────────────────────────────────────────────────
const isOwner = msg => msg.author.id === cfg.OWNER_ID;

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

client.on("messageCreate", async msg => {
  if (!isOwner(msg)) return;
  if (!msg.content.startsWith(cfg.PREFIX)) return;

  const [cmd, ...args] = msg.content.slice(cfg.PREFIX.length).trim().split(/\s+/);

  switch (cmd) {
    case "next": {
      if (forceRestart(null)) await msg.reply("Skipping and reshuffling playlist.");
      else await msg.reply("Nothing is playing right now.");
      break;
    }

    case "play": {
      const n = parseInt(args[0]);
      if (isNaN(n) || n < 1 || n > PLAYLIST.length) {
        await msg.reply(`Pick a number between 1 and ${PLAYLIST.length}. Use ${cfg.PREFIX}playlist to see them.`);
        break;
      }
      const url = PLAYLIST[n - 1];
      forceRestart(url);
      await msg.reply(`Jumping to #${n} — ${labelOf(url)}`);
      break;
    }

    case "queue": {
      const lines = state.order.slice(0, 10).map((url, i) => `${i + 1}. ${labelOf(url)}`);
      await msg.reply(`Current play order:\n${lines.join("\n") || "building..."}`);
      break;
    }

    case "playlist": {
      const lines  = PLAYLIST.map((url, i) => `${i + 1}. ${labelOf(url)}`);
      const chunks = [];
      let chunk    = `Playlist (${PLAYLIST.length} videos):\n`;
      for (const line of lines) {
        if (chunk.length + line.length + 1 > 1900) { chunks.push(chunk); chunk = ""; }
        chunk += line + "\n";
      }
      if (chunk) chunks.push(chunk);
      for (const c of chunks) await msg.reply(c);
      break;
    }

    case "status": {
      const uptime = state.sessionStart ? formatUptime(Date.now() - state.sessionStart) : "n/a";
      await msg.reply(
        `Session uptime: ${uptime}\n` +
        `Resolution: ${cfg.WIDTH}x${cfg.HEIGHT} @ ${cfg.FPS}fps\n` +
        `Bitrate: ${cfg.BITRATE_KBPS}-${cfg.BITRATE_MAX_KBPS} kbps\n` +
        `Preset: ${cfg.PRESET}\n` +
        `Videos in playlist: ${PLAYLIST.length}\n` +
        `Voice channel: ${cfg.CHANNEL_ID}`
      );
      break;
    }

    case "bitrate": {
      const kbps = parseInt(args[0]);
      if (isNaN(kbps) || kbps < 300 || kbps > 8000) {
        await msg.reply("Usage: !bitrate <300-8000>");
        break;
      }
      cfg.BITRATE_KBPS = kbps;
      cfg.BITRATE_MAX_KBPS = Math.round(kbps * 1.4);
      const currentUrl = state.order[0] || null;
      forceRestart(currentUrl);
      await msg.reply(`Bitrate set to ${cfg.BITRATE_KBPS}-${cfg.BITRATE_MAX_KBPS} kbps. Restarting stream to apply.`);
      break;
    }

    case "resolution": {
      const match = (args[0] || "").match(/^(\d+)x(\d+)$/i);
      if (!match) {
        await msg.reply("Usage: !resolution <width>x<height>, e.g. !resolution 1920x1080");
        break;
      }
      cfg.WIDTH  = parseInt(match[1]);
      cfg.HEIGHT = parseInt(match[2]);
      const currentUrl = state.order[0] || null;
      forceRestart(currentUrl);
      await msg.reply(`Resolution set to ${cfg.WIDTH}x${cfg.HEIGHT}. Restarting stream to apply.`);
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
      const currentUrl = state.order[0] || null;
      forceRestart(currentUrl);
      await msg.reply(`Encoder preset set to ${p}. Restarting stream to apply.`);
      break;
    }

    case "help": {
      await msg.reply(
        "Commands (owner only):\n" +
        `${cfg.PREFIX}next - skip and reshuffle\n` +
        `${cfg.PREFIX}play <number> - jump to a specific video\n` +
        `${cfg.PREFIX}queue - show current play order\n` +
        `${cfg.PREFIX}playlist - list all videos with numbers\n` +
        `${cfg.PREFIX}status - show stream stats\n` +
        `${cfg.PREFIX}bitrate <kbps> - change bitrate (300-8000)\n` +
        `${cfg.PREFIX}resolution <WxH> - change resolution, e.g. 1920x1080\n` +
        `${cfg.PREFIX}preset <name> - change encoder preset (ultrafast..medium)`
      );
      break;
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Voice state — follow owner, detect kicks
// ─────────────────────────────────────────────────────────────────────────────
client.on("voiceStateUpdate", (oldState, newState) => {
  if (newState.member?.id === cfg.OWNER_ID
      && newState.channelId
      && newState.channelId !== cfg.CHANNEL_ID) {
    log(`Following owner to channel ${newState.channelId}`);
    cfg.CHANNEL_ID = newState.channelId;
  }

  const kicked =
    oldState.channelId === cfg.CHANNEL_ID &&
    !newState.channelId &&
    oldState.member?.id === client.user?.id;

  if (kicked) log("Kicked from voice channel — reconnect loop will rejoin");
});

// ─────────────────────────────────────────────────────────────────────────────
// Shutdown
// ─────────────────────────────────────────────────────────────────────────────
function shutdown() {
  log("Shutting down");
  try { clearInterval(streamer._keepAlive); } catch (_) {}
  try { state.currentCommand?.kill("SIGKILL"); } catch (_) {}
  try { streamer.stopStream?.(); } catch (_) {}
  try { fs.unlinkSync(CONCAT_PATH); } catch (_) {}
  try { client.destroy(); } catch (_) {}
  process.exit(0);
}

process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", err => log(`Unhandled rejection: ${err?.message ?? err}`));
process.on("uncaughtException",  err => { log(`Fatal error: ${err?.message}`); process.exit(1); });

// ─────────────────────────────────────────────────────────────────────────────
// Login
// ─────────────────────────────────────────────────────────────────────────────
client.on("ready", () => {
  log(`Logged in as ${client.user.tag}`);
  log(`${PLAYLIST.length} video(s) in playlist`);
  startStream();
});

log("Starting Discord stream bot");
client.login(cfg.TOKEN);
