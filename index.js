// SRS Log Bot
// Reads the SRS log channels on Discord and writes one row per log into the
// SRS Activity Dashboard Google Sheet (tabs: Time, Onboards, Nudges, Departures).
//
// Environment variables (set these on Railway, or in your shell):
//   DISCORD_TOKEN          Bot token from the Discord Developer Portal
//   GOOGLE_CREDENTIALS     The whole service account JSON key, pasted as one value
//   TIME_CHANNEL_ID        #recruitment-time-archive
//   ONBOARD_CHANNEL_ID     #recruitment-onboard-archive
//   NUDGE_CHANNEL_ID       #recruitment-nudge-archive
//   DEPARTURE_CHANNEL_ID   #inactivity-resignation-notice
// Optional:
//   SHEET_ID               Defaults to the SRS Activity Dashboard
//   BACKFILL_SINCE         Oldest post to copy on startup, YYYY-MM-DD (default 2025-12-01)
//   BARE_NUMBER_MEANS      How to read a session length that is just a number under 15,
//                          like "4": "intervals" (4 x 15 min), "hours", or "unknown" (left blank)
//   DRY_RUN                Set to 1 to print rows instead of writing them

'use strict';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG = {
  sheetId: process.env.SHEET_ID || '1N_Ux_613Oc8xuENK_aSQUUgm-zh0mTCtCH6UrIn0OeM',
  timeZone: 'America/Toronto',
  backfillSince: process.env.BACKFILL_SINCE || '2025-12-01',
  bareNumberMeans: (process.env.BARE_NUMBER_MEANS || 'unknown').toLowerCase(),
  dryRun: process.env.DRY_RUN === '1',
  flushEveryMs: 5000,
  channels: {
    time: process.env.TIME_CHANNEL_ID,
    onboard: process.env.ONBOARD_CHANNEL_ID,
    nudge: process.env.NUDGE_CHANNEL_ID,
    departure: process.env.DEPARTURE_CHANNEL_ID,
  },
};

// Where each kind of log goes in the sheet. idCol is the Message ID column,
// lastCol is the last column the bot writes (grey formula columns come after it).
const TABS = {
  time: { name: 'Time', lastCol: 'E', idCol: 'E' },           // Timestamp, Recruiter, Minutes, Vouched by, Message ID
  onboard: { name: 'Onboards', lastCol: 'D', idCol: 'D' },    // Timestamp, New member, Recruited by, Message ID
  nudge: { name: 'Nudges', lastCol: 'D', idCol: 'D' },        // Timestamp, Member, Nudged by, Message ID
  departure: { name: 'Departures', lastCol: 'E', idCol: 'E' }, // Timestamp, Member, Rank, Reason, Message ID
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// Turn a template label like "**Username(s) of Person Recruited:**" into a field key.
// Order matters: more specific labels are checked first.
function labelToKey(rawLabel) {
  const l = rawLabel
    .toLowerCase()
    .replace(/\(yes\/no\)/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!l) return null;
  if (l.includes('screenshot')) return 'screenshot';
  if (l.includes('bulk log')) return 'bulk';
  if (l.includes('recruited')) return 'recruited';
  if (l.includes('nudged')) return 'nudged';
  if (l.includes('vouched')) return 'vouchedBy';
  if (l.includes('length of recruiting session') || l === 'session length' || l === 'length') return 'length';
  if (l.includes('time spent recruiting') || l === 'time spent') return 'timeSpent';
  if (l.includes('reason')) return 'reason';
  if (l === 'rank' || l.includes('wing rank')) return 'rank';
  if (l === 'note' || l === 'notes') return 'notes';
  if (l === 'username' || l === 'user name' || l === 'roblox username' || l === 'name') return 'username';
  if (l === 'event type' || l.includes('duration') || l === 'attendees') return 'other';
  return null;
}

// Remove Discord markdown that people put around labels and values.
function stripMarkdown(s) {
  return s
    .replace(/\|\|/g, '')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/(^|\s)[*_](\S)/g, '$1$2')
    .replace(/(\S)[*_](\s|$)/g, '$1$2');
}

// Pull "Label: value" pairs out of a post. A value can sit on the same line as its
// label or on the lines under it (for example a list of usernames in a bulk log).
function parseFields(text) {
  const fields = {};
  let current = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = stripMarkdown(rawLine.replace(/^\s*>+\s?/, '')).trim();
    if (!line) continue;
    const m = line.match(/^([^:：]{1,80}?)\s*[:：]\s*(.*)$/);
    const key = m ? labelToKey(m[1]) : null;
    if (key) {
      current = key;
      if (!(key in fields)) fields[key] = [];
      if (m[2].trim()) fields[key].push(m[2].trim());
    } else if (current) {
      fields[current].push(line);
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = v.join('\n').trim();
  return out;
}

// Everything readable in a message: its text plus any embeds (for logs relayed by another bot).
function messageText(message) {
  const parts = [message.content || ''];
  for (const e of message.embeds || []) {
    if (e.title) parts.push(e.title);
    if (e.description) parts.push(e.description);
    for (const f of e.fields || []) parts.push(`${f.name}: ${f.value}`);
  }
  return parts.join('\n');
}

// Replace <@123> mentions with the person's server nickname or username.
function resolveMentions(value, message) {
  return String(value || '').replace(/<@!?(\d+)>/g, (whole, id) => {
    const member = message && message.mentions && message.mentions.members && message.mentions.members.get(id);
    const user = message && message.mentions && message.mentions.users && message.mentions.users.get(id);
    const name = (member && member.displayName) || (user && (user.globalName || user.username)) || '';
    const clean = name.replace(/[^A-Za-z0-9_]/g, '');
    return clean.length >= 3 ? clean : (user && user.username) || whole;
  });
}

const NOT_NAMES = new Set(['and', 'yes', 'no', 'n/a', 'na', 'none', 'bulk', 'log', 'the', 'with', 'x']);

// Roblox usernames are 3 to 20 letters, digits or underscores, so a list can be
// split on anything else (commas, spaces, new lines, "and", bullets, numbering).
function splitUsernames(value, message) {
  const text = resolveMentions(value, message);
  const names = [];
  const seen = new Set();
  for (let token of text.split(/[\s,;&/|+]+/)) {
    token = token.replace(/^[@\-•*·\d.)\]]+/, '').replace(/[.,!?:)\]]+$/, '').trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(token)) continue;
    if (/^\d+$/.test(token)) continue;
    if (NOT_NAMES.has(token.toLowerCase())) continue;
    const k = token.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    names.push(token);
  }
  return names;
}

// The single name in a "Username:" style field.
function firstUsername(value, message) {
  const list = splitUsernames(value, message);
  if (list.length) return list[0];
  return resolveMentions(value, message).split('\n')[0].trim().slice(0, 50);
}

// Read a session length and return minutes, or null if it can't be read.
// Handles: "1 hour 30 minutes", "1h30m", "1.5 hours", "90 mins", "6 intervals",
// "6 x 15", "1:30", "4:00 PM - 5:30 PM", "4pm to 5:15pm", "75".
function parseMinutes(value, bareNumberMeans = CONFIG.bareNumberMeans) {
  if (value == null) return null;
  const t = String(value).toLowerCase().replace(/,/g, ' ').trim();
  if (!t) return null;

  // Clock range, like 4:00 PM - 5:30 PM. Needs a colon or am/pm so "1-2 hours" isn't read as a range.
  const range = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (range && (range[2] || range[3] || range[5] || range[6])) {
    let [, h1, m1, p1, h2, m2, p2] = range;
    h1 = +h1; h2 = +h2; m1 = +(m1 || 0); m2 = +(m2 || 0);
    if (h1 <= 24 && h2 <= 24 && m1 < 60 && m2 < 60) {
      if (!p1 && p2) p1 = p2;
      if (!p2 && p1) p2 = p1;
      const to24 = (h, p) => (p === 'pm' && h < 12 ? h + 12 : p === 'am' && h === 12 ? 0 : h);
      let start = to24(h1, p1) * 60 + m1;
      let end = to24(h2, p2) * 60 + m2;
      if (end <= start) end += (!p1 && !p2) ? 720 : 1440; // "11:30 - 1:00" or "11pm - 1am"
      const diff = end - start;
      if (diff > 0 && diff <= 12 * 60) return diff;
    }
  }

  // Intervals: "6 intervals", "6x15", "6 x 15 minutes"
  const intervals = t.match(/(\d+(?:\.\d+)?)\s*(?:intervals?|blocks?)\b/) || t.match(/(\d+)\s*[x×*]\s*15\b/);
  if (intervals) return Math.round(parseFloat(intervals[1]) * 15);

  // Hours and minutes written with units
  let total = 0;
  let found = false;
  const h = t.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)(?![a-z])/);
  if (h) { total += parseFloat(h[1]) * 60; found = true; }
  const m = t.match(/(\d+)\s*(?:minutes?|mins?|m)(?![a-z])/);
  if (m) { total += parseInt(m[1], 10); found = true; }
  if (h && !m) {
    const after = t.match(/(?:hours?|hrs?|h)\s*(\d{1,2})\s*$/); // "1h 15", "1 hour 15"
    if (after) total += parseInt(after[1], 10);
  }
  if (found && total > 0) return Math.round(total);

  // Plain H:MM, like 1:30
  const hm = t.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) return +hm[1] * 60 + +hm[2];

  // A bare number
  const bare = t.match(/^(\d+(?:\.\d+)?)$/);
  if (bare) {
    const n = parseFloat(bare[1]);
    if (n >= 15) return Math.round(n);
    if (!Number.isInteger(n)) return Math.round(n * 60); // 1.5 means hours
    if (bareNumberMeans === 'intervals') return n * 15;
    if (bareNumberMeans === 'hours') return n * 60;
    return null;
  }
  return null;
}

// Date of a post as a Google Sheets date-time number in Toronto time.
function sheetsSerial(date, timeZone = CONFIG.timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  const localMs = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return localMs / 86400000 + 25569;
}

// Turn one Discord message into sheet rows for its tab. Returns { rows, warning }.
// A message without a "Username:" line is not a log (chat, staff replies) and gives no rows.
function buildRows(kind, message) {
  const f = parseFields(messageText(message));
  if (!('username' in f)) return { rows: [], warning: null };
  const when = sheetsSerial(message.createdAt);
  const id = String(message.id);
  const poster = firstUsername(f.username, message) || (message.member && message.member.displayName) || (message.author && message.author.username) || '';
  let warning = null;

  if (kind === 'time') {
    let minutes = parseMinutes(f.length);
    if (minutes == null) minutes = parseMinutes(f.timeSpent);
    if (minutes == null) warning = `could not read the session length ("${f.length || f.timeSpent || ''}")`;
    return { rows: [[when, poster, minutes == null ? '' : minutes, firstUsername(f.vouchedBy || '', message), id]], warning };
  }

  if (kind === 'onboard' || kind === 'nudge') {
    const people = splitUsernames(kind === 'onboard' ? f.recruited : f.nudged, message);
    if (!people.length) {
      warning = `no ${kind === 'onboard' ? 'recruited' : 'nudged'} username found, logged one row with the name blank`;
      return { rows: [[when, '', poster, id]], warning };
    }
    return { rows: people.map((p) => [when, p, poster, id]), warning };
  }

  if (kind === 'departure') {
    return { rows: [[when, poster, (f.rank || '').split('\n')[0].slice(0, 60), (f.reason || '').slice(0, 500), id]], warning };
  }

  return { rows: [], warning: null };
}

// ---------------------------------------------------------------------------
// Google Sheets
// ---------------------------------------------------------------------------

let sheets = null;
const loggedIds = { time: new Set(), onboard: new Set(), nudge: new Set(), departure: new Set() };
const queues = { time: [], onboard: [], nudge: [], departure: [] };

async function connectSheets() {
  const { google } = require('googleapis');
  if (!process.env.GOOGLE_CREDENTIALS) throw new Error('GOOGLE_CREDENTIALS is not set');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheets = google.sheets({ version: 'v4', auth });
}

async function withRetry(fn, label) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = err.code || (err.response && err.response.status);
      const retryable = code === 429 || code >= 500 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      if (!retryable || attempt >= 6) throw err;
      const wait = Math.min(60000, 2000 * 2 ** (attempt - 1));
      console.warn(`[sheets] ${label} failed (${code}), retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// Read the Message IDs already in each tab so restarts and backfills never double-log.
async function loadLoggedIds() {
  for (const [kind, tab] of Object.entries(TABS)) {
    const res = await withRetry(
      () => sheets.spreadsheets.values.get({ spreadsheetId: CONFIG.sheetId, range: `${tab.name}!${tab.idCol}2:${tab.idCol}` }),
      `read ${tab.name} IDs`
    );
    for (const row of res.data.values || []) if (row[0]) loggedIds[kind].add(String(row[0]));
    console.log(`[sheets] ${tab.name}: ${loggedIds[kind].size} posts already logged`);
  }
}

async function flush() {
  for (const [kind, tab] of Object.entries(TABS)) {
    if (!queues[kind].length) continue;
    const rows = queues[kind].splice(0, queues[kind].length);
    if (CONFIG.dryRun) {
      for (const r of rows) console.log(`[dry run] ${tab.name}:`, JSON.stringify(r));
      continue;
    }
    try {
      await withRetry(
        () => sheets.spreadsheets.values.append({
          spreadsheetId: CONFIG.sheetId,
          range: `${tab.name}!A:${tab.lastCol}`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: rows },
        }),
        `append to ${tab.name}`
      );
      console.log(`[sheets] wrote ${rows.length} row(s) to ${tab.name}`);
    } catch (err) {
      // Put the rows back so they are retried on the next flush.
      queues[kind].unshift(...rows);
      console.error(`[sheets] could not write to ${tab.name}:`, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

function kindForChannel(channelId) {
  for (const [kind, id] of Object.entries(CONFIG.channels)) if (id && id === channelId) return kind;
  return null;
}

function handleMessage(message, client) {
  if (!message || !message.channelId) return;
  if (client && client.user && message.author && message.author.id === client.user.id) return;
  const kind = kindForChannel(message.channelId);
  if (!kind) return;
  if (loggedIds[kind].has(String(message.id))) return;

  const { rows, warning } = buildRows(kind, message);
  if (!rows.length) return;
  loggedIds[kind].add(String(message.id));
  queues[kind].push(...rows);
  if (warning) console.warn(`[parse] ${TABS[kind].name}: ${warning} -> ${message.url}`);
}

async function backfill(client) {
  const since = new Date(`${CONFIG.backfillSince}T00:00:00Z`).getTime();
  for (const [kind, channelId] of Object.entries(CONFIG.channels)) {
    if (!channelId) { console.warn(`[backfill] no channel ID set for ${kind}, skipping`); continue; }
    let channel;
    try {
      channel = await client.channels.fetch(channelId);
    } catch (err) {
      console.error(`[backfill] cannot open channel ${channelId} (${kind}): ${err.message}`);
      continue;
    }
    const collected = [];
    let before;
    for (;;) {
      const batch = await channel.messages.fetch({ limit: 100, before });
      if (!batch.size) break;
      let reachedOld = false;
      for (const msg of batch.values()) {
        if (msg.createdTimestamp < since) { reachedOld = true; continue; }
        collected.push(msg);
      }
      before = batch.last().id;
      if (reachedOld || batch.size < 100) break;
    }
    collected.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const startCount = queues[kind].length;
    for (const msg of collected) handleMessage(msg, client);
    console.log(`[backfill] #${channel.name}: read ${collected.length} posts, queued ${queues[kind].length - startCount} new row(s)`);
    await flush();
  }
}

async function start() {
  const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');
  if (!process.env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is not set');

  if (!CONFIG.dryRun) {
    await connectSheets();
    await loadLoggedIds();
  } else {
    console.log('[dry run] rows will be printed, nothing is written to the sheet');
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Message],
  });

  client.once(Events.ClientReady, async () => {
    console.log(`[discord] logged in as ${client.user.tag}`);
    try {
      await backfill(client);
      console.log('[backfill] done, now watching for new posts');
    } catch (err) {
      console.error('[backfill] failed:', err);
    }
    setInterval(() => flush().catch((e) => console.error('[sheets] flush failed:', e)), CONFIG.flushEveryMs);
  });

  client.on(Events.MessageCreate, (message) => handleMessage(message, client));

  // A post edited into the right format before it was logged gets logged then.
  client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
    try {
      const msg = newMessage.partial ? await newMessage.fetch() : newMessage;
      handleMessage(msg, client);
    } catch (err) {
      console.warn('[discord] could not read an edited message:', err.message);
    }
  });

  const shutdown = async () => {
    console.log('[bot] shutting down, writing anything still queued');
    await flush().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await client.login(process.env.DISCORD_TOKEN);
}

if (require.main === module) {
  start().catch((err) => {
    console.error('[bot] failed to start:', err);
    process.exit(1);
  });
}

module.exports = { parseFields, parseMinutes, splitUsernames, firstUsername, buildRows, sheetsSerial, labelToKey };
