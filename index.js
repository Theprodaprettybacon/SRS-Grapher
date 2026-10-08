// SRS Log Bot
// Reads the SRS log channels on Discord plus the ORBAT's Event Logs tab, works out the
// activity numbers, and writes them into ONE block on your dashboard tab (AA1:AI36 by default).
// Point your charts at that block. The bot never adds tabs and never touches anything outside it.
//
// Environment variables (set these on Railway):
//   DISCORD_TOKEN          Bot token from the Discord Developer Portal
//   GOOGLE_CREDENTIALS     The whole service account JSON key, pasted as one value
//   TIME_CHANNEL_ID        #recruitment-time-archive
//   ONBOARD_CHANNEL_ID     #recruitment-onboard-archive
//   NUDGE_CHANNEL_ID       #recruitment-nudge-archive
//   DEPARTURE_CHANNEL_ID   #inactivity-resignation-notice
// Optional:
//   DASHBOARD_TAB          Tab the numbers go on (default "Sheet12")
//   DATA_CELL              Top-left cell of the block (default "AA1"); the block is 9 columns x 36 rows
//   SHEET_ID               Defaults to the v2 SRS ORBAT
//   EVENT_RANGE            Where events are read from (default 'Event Logs'!B9:F)
//   BACKFILL_SINCE         Oldest post to read on startup, YYYY-MM-DD (default 2025-12-01)
//   BARE_NUMBER_MEANS      How to read a session length that is just a number under 15,
//                          like "4": "intervals" (4 x 15 min), "hours", or "unknown" (not counted)
//   UPDATE_EVERY_MINUTES   How often the block is rewritten (default 60, on the hour)
//   TIME_ZONE              Override the timezone; by default the sheet's own timezone is used
//   DRY_RUN                Set to 1 to print the block instead of writing it

'use strict';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG = {
  sheetId: process.env.SHEET_ID || '1bYLV-0ddujV1dvWd33C69H290sGTagrSUNlw76nHKqM',
  dashboardTab: process.env.DASHBOARD_TAB || 'Sheet12',
  dataCell: (process.env.DATA_CELL || 'AA1').toUpperCase(),
  eventRange: process.env.EVENT_RANGE || "'Event Logs'!B9:F",
  timeZone: process.env.TIME_ZONE || 'America/Toronto', // replaced at startup with the sheet's timezone unless TIME_ZONE is set
  backfillSince: process.env.BACKFILL_SINCE || '2025-12-01',
  bareNumberMeans: (process.env.BARE_NUMBER_MEANS || 'unknown').toLowerCase(),
  dryRun: process.env.DRY_RUN === '1',
  // The block is rewritten once at startup, then on this schedule. New posts are counted in memory
  // straight away and show up in the sheet at the next update.
  updateEveryMinutes: Math.max(5, parseInt(process.env.UPDATE_EVERY_MINUTES || '60', 10) || 60),
  weekdayWindowDays: 28,
  weeks: 12,
  months: 6,
  channels: {
    time: process.env.TIME_CHANNEL_ID,
    onboard: process.env.ONBOARD_CHANNEL_ID,
    nudge: process.env.NUDGE_CHANNEL_ID,
    departure: process.env.DEPARTURE_CHANNEL_ID,
  },
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

// Date of a post as a Google Sheets date-time number in the sheet's timezone.
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
      warning = `no ${kind === 'onboard' ? 'recruited' : 'nudged'} username found, counted once with the name blank`;
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
// Dates. Everything is counted in whole days, as Google Sheets day numbers.
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const serialToDate = (s) => new Date(Math.round((s - 25569) * DAY_MS));
const dateToSerial = (y, m, d) => Date.UTC(y, m, d) / DAY_MS + 25569;
const dayOfWeek = (day) => serialToDate(day).getUTCDay(); // 0 = Sunday
const weekStartOf = (day) => day - dayOfWeek(day);         // weeks start on Sunday
const monthKeyOf = (day) => { const d = serialToDate(day); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
const round1 = (x) => Math.round(x * 10) / 10;
const weekLabel = (day) => serialToDate(day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const monthLabel = (key) => new Date(Date.UTC(Math.floor(key / 12), key % 12, 1))
  .toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const todaySerial = () => Math.floor(sheetsSerial(new Date()));

// ---------------------------------------------------------------------------
// Posts kept in memory: message ID -> what that post counts as
// ---------------------------------------------------------------------------

const cache = { time: new Map(), onboard: new Map(), nudge: new Map(), departure: new Map() };

// What one post adds to the numbers.
// time: one session { day, name, minutes }; onboard/nudge: one entry per person; departure: one entry.
function recordsFromMessage(kind, message) {
  const { rows, warning } = buildRows(kind, message);
  const records = rows.map((r) => {
    const day = Math.floor(r[0]);
    if (kind === 'time') return { day, name: String(r[1] || '').toLowerCase(), minutes: r[2] === '' ? null : r[2] };
    return { day };
  });
  return { records, warning };
}

function allRecords() {
  const out = {};
  for (const [kind, map] of Object.entries(cache)) out[kind] = [].concat(...map.values());
  return out;
}

// ---------------------------------------------------------------------------
// The block written to the sheet: 9 columns x 36 rows, always the same shape,
// so chart ranges pointing at it never need changing.
// ---------------------------------------------------------------------------

const PERIOD_HEADERS = ['Recruiting hours', 'Active recruiters', 'Events hosted', 'Average attendees', 'Joins', 'Leaves', 'Net change', 'Nudges sent'];

function averageAttendees(events) {
  const counts = events.map((e) => e.attendees).filter((n) => typeof n === 'number');
  return counts.length ? round1(counts.reduce((a, b) => a + b, 0) / counts.length) : 0;
}

function hoursOf(sessions) {
  return round1(sessions.reduce((sum, s) => sum + (s.minutes || 0), 0) / 60);
}

// data = { time, onboard, nudge, departure, events } arrays of records; today = day number
function buildSummary(data, today, updatedText = '', opts = {}) {
  const weeks = opts.weeks || CONFIG.weeks;
  const months = opts.months || CONFIG.months;
  const windowDays = opts.weekdayWindowDays || CONFIG.weekdayWindowDays;
  const W = 9;
  const blank = () => new Array(W).fill('');
  const grid = [];
  const row = (cells) => { const r = blank(); cells.forEach((c, i) => { r[i] = c; }); grid.push(r); };

  row(['SRS activity data, written by the log bot. Do not edit this block.']);
  row(['Last updated', updatedText]);
  row([]);

  // By weekday, last N days including today
  const from = today - windowDays + 1;
  const inWindow = (r) => r.day >= from && r.day <= today;
  row([`By weekday, last ${windowDays} days`]);
  row(['Weekday', 'Recruiting hours', 'Events hosted', 'Average attendees']);
  WEEKDAYS.forEach((name, i) => {
    const t = data.time.filter((r) => inWindow(r) && dayOfWeek(r.day) === i);
    const e = data.events.filter((r) => inWindow(r) && dayOfWeek(r.day) === i);
    row([name, hoursOf(t), e.length, averageAttendees(e)]);
  });
  row([]);

  const periodRow = (label, match) => {
    const t = data.time.filter(match);
    const e = data.events.filter(match);
    const joins = data.onboard.filter(match).length;
    const leaves = data.departure.filter(match).length;
    const active = new Set(t.map((s) => s.name).filter(Boolean)).size;
    row([label, hoursOf(t), active, e.length, averageAttendees(e), joins, leaves, joins - leaves, data.nudge.filter(match).length]);
  };

  // By week, oldest first, current (partial) week last
  row([`By week, last ${weeks} weeks`]);
  row(['Week starting', ...PERIOD_HEADERS]);
  const thisWeek = weekStartOf(today);
  for (let n = weeks - 1; n >= 0; n--) {
    const start = thisWeek - 7 * n;
    periodRow(weekLabel(start), (r) => r.day >= start && r.day < start + 7);
  }
  row([]);

  // By month, oldest first, current (partial) month last
  row([`By month, last ${months} months`]);
  row(['Month', ...PERIOD_HEADERS]);
  const thisMonth = monthKeyOf(today);
  for (let n = months - 1; n >= 0; n--) {
    const key = thisMonth - n;
    periodRow(monthLabel(key), (r) => monthKeyOf(r.day) === key);
  }
  return grid;
}

// ---------------------------------------------------------------------------
// Google Sheets
// ---------------------------------------------------------------------------

let sheets = null;

function a1(tabName, range) {
  return `'${tabName.replace(/'/g, "''")}'!${range}`;
}
function colToNum(col) { return col.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0); }
function numToCol(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function blockRange(rows, cols) {
  const m = CONFIG.dataCell.match(/^([A-Z]+)(\d+)$/);
  if (!m) throw new Error(`DATA_CELL "${CONFIG.dataCell}" should look like AA1`);
  const c0 = colToNum(m[1]); const r0 = +m[2];
  return { c0, r0, c1: c0 + cols - 1, r1: r0 + rows - 1, a1: `${m[1]}${r0}:${numToCol(c0 + cols - 1)}${r0 + rows - 1}` };
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

async function connectSheets() {
  const { google } = require('googleapis');
  if (!process.env.GOOGLE_CREDENTIALS) throw new Error('GOOGLE_CREDENTIALS is not set');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheets = google.sheets({ version: 'v4', auth });

  const meta = await withRetry(
    () => sheets.spreadsheets.get({ spreadsheetId: CONFIG.sheetId, fields: 'properties.timeZone,sheets.properties' }),
    'read sheet settings'
  );
  if (!process.env.TIME_ZONE && meta.data.properties && meta.data.properties.timeZone) CONFIG.timeZone = meta.data.properties.timeZone;

  const tabs = (meta.data.sheets || []).map((s) => s.properties);
  const tab = tabs.find((p) => p.title === CONFIG.dashboardTab);
  if (!tab) throw new Error(`no tab called "${CONFIG.dashboardTab}". Tabs in the sheet: ${tabs.map((p) => p.title).join(', ')}. Set DASHBOARD_TAB.`);

  // Make sure the tab is wide and tall enough for the block (new tabs stop at column Z).
  const b = blockRange(36, 9);
  const grid = tab.gridProperties || {};
  const requests = [];
  if ((grid.columnCount || 26) < b.c1) requests.push({ appendDimension: { sheetId: tab.sheetId, dimension: 'COLUMNS', length: b.c1 - (grid.columnCount || 26) } });
  if ((grid.rowCount || 1000) < b.r1) requests.push({ appendDimension: { sheetId: tab.sheetId, dimension: 'ROWS', length: b.r1 - (grid.rowCount || 1000) } });
  if (requests.length && !CONFIG.dryRun) {
    await withRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId: CONFIG.sheetId, requestBody: { requests } }), 'widen dashboard tab');
  }
  console.log(`[sheets] connected. Writing to ${CONFIG.dashboardTab}!${b.a1}, counting days in ${CONFIG.timeZone}`);
}

// Events come from the ORBAT's Event Logs tab: Username, Event type, Attendees, Date, Notes.
function parseEventRows(rows) {
  const events = [];
  for (const r of rows || []) {
    const host = String(r[0] == null ? '' : r[0]).trim();
    const date = r[3];
    if (!host || date === '' || date == null) continue;
    let day = null;
    if (typeof date === 'number') day = Math.floor(date);
    else {
      const m = String(date).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (m) day = dateToSerial(+m[3], +m[1] - 1, +m[2]);
    }
    if (day == null) continue;
    const a = r[2];
    let attendees = null; // "N/A" or blank is left out of averages
    if (typeof a === 'number') attendees = a;
    else if (/^\s*\d+(\.\d+)?\s*$/.test(String(a == null ? '' : a))) attendees = parseFloat(a);
    events.push({ day, attendees });
  }
  return events;
}

async function readEvents() {
  const res = await withRetry(
    () => sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.sheetId,
      range: CONFIG.eventRange,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER',
    }),
    'read Event Logs'
  );
  return parseEventRows(res.data.values);
}

let writeChain = Promise.resolve();

function writeNow() {
  writeChain = writeChain.then(async () => {
    try {
      const events = await readEvents();
      const now = new Date();
      const stamp = new Intl.DateTimeFormat('en-CA', {
        timeZone: CONFIG.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).format(now).replace(',', '');
      const grid = buildSummary({ ...allRecords(), events }, todaySerial(), `${stamp} (${CONFIG.timeZone})`);
      const b = blockRange(grid.length, grid[0].length);
      if (CONFIG.dryRun) {
        console.log(`[dry run] would write ${CONFIG.dashboardTab}!${b.a1}:`);
        for (const r of grid) console.log('  ' + r.map((c) => (c === '' ? '.' : c)).join(' | '));
        return;
      }
      await withRetry(
        () => sheets.spreadsheets.values.update({
          spreadsheetId: CONFIG.sheetId,
          range: a1(CONFIG.dashboardTab, b.a1),
          valueInputOption: 'RAW',
          requestBody: { values: grid },
        }),
        'write block'
      );
      console.log(`[sheets] updated ${CONFIG.dashboardTab}!${b.a1} (${events.length} events, ${cache.time.size} time logs, ${cache.onboard.size} onboard logs, ${cache.nudge.size} nudge logs, ${cache.departure.size} departures)`);
    } catch (err) {
      console.error('[sheets] could not update the block:', err.message);
    }
  });
  return writeChain;
}

// Rewrite the block every N minutes, lined up with the clock (on the hour for the default 60).
function startSchedule() {
  const everyMs = CONFIG.updateEveryMinutes * 60 * 1000;
  const wait = everyMs - (Date.now() % everyMs);
  setTimeout(() => {
    writeNow();
    setInterval(writeNow, everyMs);
  }, wait);
  console.log(`[bot] the sheet updates every ${CONFIG.updateEveryMinutes} minutes, next in ${Math.round(wait / 60000)} min`);
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

function kindForChannel(channelId) {
  for (const [kind, id] of Object.entries(CONFIG.channels)) if (id && id === channelId) return kind;
  return null;
}

// Add, replace or drop one post. Edits re-read the post, so fixing a typo fixes the numbers.
function handleMessage(message, client) {
  if (!message || !message.channelId) return;
  if (client && client.user && message.author && message.author.id === client.user.id) return;
  const kind = kindForChannel(message.channelId);
  if (!kind) return;
  const { records, warning } = recordsFromMessage(kind, message);
  if (records.length) cache[kind].set(String(message.id), records);
  else cache[kind].delete(String(message.id));
  if (warning) console.warn(`[parse] ${kind}: ${warning} -> ${message.url}`);
}

function handleDelete(message) {
  const kind = message && kindForChannel(message.channelId);
  if (kind) cache[kind].delete(String(message.id));
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
    let before;
    let read = 0;
    for (;;) {
      const batch = await channel.messages.fetch({ limit: 100, before });
      if (!batch.size) break;
      let reachedOld = false;
      for (const msg of batch.values()) {
        if (msg.createdTimestamp < since) { reachedOld = true; continue; }
        read++;
        handleMessage(msg, client);
      }
      before = batch.last().id;
      if (reachedOld || batch.size < 100) break;
    }
    console.log(`[backfill] #${channel.name}: read ${read} posts, ${cache[kind].size} counted as logs`);
  }
}

async function start() {
  const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');
  if (!process.env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is not set');
  await connectSheets();
  if (CONFIG.dryRun) console.log('[dry run] the block will be printed, nothing is written to the sheet');

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Message],
  });

  client.once(Events.ClientReady, async () => {
    console.log(`[discord] logged in as ${client.user.tag}`);
    try {
      await backfill(client);
    } catch (err) {
      console.error('[backfill] failed:', err);
    }
    await writeNow();
    console.log('[bot] watching for new posts');
    startSchedule();
  });

  client.on(Events.MessageCreate, (message) => handleMessage(message, client));
  client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
    try {
      const msg = newMessage.partial ? await newMessage.fetch() : newMessage;
      handleMessage(msg, client);
    } catch (err) {
      console.warn('[discord] could not read an edited message:', err.message);
    }
  });
  client.on(Events.MessageDelete, handleDelete);
  client.on(Events.MessageBulkDelete, (messages) => { for (const m of messages.values()) handleDelete(m); });

  const shutdown = () => { console.log('[bot] shutting down'); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await client.login(process.env.DISCORD_TOKEN);
}

if (require.main === module) {
  start().catch((err) => {
    console.error('[bot] failed to start:', err.message || err);
    process.exit(1);
  });
}

module.exports = {
  parseFields, parseMinutes, splitUsernames, firstUsername, buildRows, sheetsSerial, labelToKey,
  recordsFromMessage, buildSummary, parseEventRows, blockRange, weekStartOf, dayOfWeek, monthKeyOf, dateToSerial, CONFIG,
};
