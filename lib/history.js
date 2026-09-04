/**
 * The CI run-history table that lives in the PR description.
 *
 * ## Why it is here and not in a workflow of its own
 *
 * A commit status holds exactly ONE state per context per SHA, so the moment a
 * check is re-requested - or a push moves the head SHA - the previous result is
 * gone from the PR. This module keeps the record. It runs inside the closing
 * `ci-on-demand` call, which is already the last step of every on-demand check,
 * because GitHub rounds EVERY job up to a whole minute: a job that existed only
 * to write this table would cost a full billed minute per check.
 *
 * ## Where the data comes from
 *
 * Mostly not the API. The run writing the row is the run being described, so
 * its status, SHA, attempt, actor and run id all come from the local context,
 * and its start time from an env var the opening call exported. Older rows are
 * carried in a JSON payload inside the start marker - the PR body IS the store,
 * the same technique ai-pr-review-action uses. Rendered markdown is never
 * parsed back into data.
 *
 * One API call reconciles: it heals a row lost when two checks finished in the
 * same second and read-modify-wrote the same body, and it picks up a run that
 * never got to write at all (cancelled while queued, or startup_failure).
 *
 * ## Where the block sits, and why not at the bottom
 *
 * ai-pr-review-action's writePRDescription rebuilds the whole body as
 * `body.substring(0, indexOf(AI_SEPARATOR)) + AI section + its own runs region`
 * and DROPS everything after. A table appended to the end of the body is
 * therefore deleted by the next `ci:review`. So the block is inserted at the
 * tail of the human-written half, immediately above that separator.
 */

'use strict';

const START_PREFIX = '<!-- ci-run-history:start ';
const END_MARKER = '<!-- ci-run-history:end -->';
/** Non-greedy to the first `-->`; safe because encodeMarkerJson escapes every
 *  `--` in the payload, so no interior sequence can terminate the comment. */
const START_RE = /<!-- ci-run-history:start [\s\S]*?-->/;
const BLOCK_RE = /<!-- ci-run-history:start [\s\S]*?-->[\s\S]*?<!-- ci-run-history:end -->/;

/** The separator ai-pr-review-action writes; everything before it is treated by
 *  that action as the untouchable human description, which is where we belong.
 *
 *  Anchored to a whole line, because a PR description may *mention* the
 *  separator in prose - this feature's own PR did - and splicing the table into
 *  the middle of a sentence is worse than not finding a separator at all. That
 *  action writes it on a line of its own, so the anchor costs nothing. */
const AI_SEPARATOR = '----AI-description----';
const AI_SEPARATOR_RE = /^-{4}AI-description-{4}[ \t]*$/m;

const PR_BODY_MAX_CHARS = 65536;
const PR_BODY_SAFETY_MARGIN = 1024;

const HEADING = '### 🧾 CI run history';

const GLYPHS = {
  success: '✅',
  failure: '❌',
  cancelled: '⚠️',
  skipped: '⏭️',
  timed_out: '⏱️',
  startup_failure: '💥',
  action_required: '🙋',
  neutral: '➖',
  stale: '🗑️',
  in_progress: '🔄',
  queued: '🕒',
  requested: '🕒',
  waiting: '🕒',
  pending: '🕒',
};

/**
 * A double hyphen terminates an HTML comment. If one reached the marker GitHub
 * would render the whole rest of the body as visible text, so it can never be
 * allowed through - no matter what a commit subject contains.
 */
function encodeMarkerJson(payload) {
  return JSON.stringify(payload).replace(/-{2,}/g, m => '\\u002d'.repeat(m.length));
}

/** One run. Keys are short because the payload competes with the AI narrative,
 *  the diagrams and the human description for the same 65,536 characters. */
function entryKey(entry) {
  return `${entry.r}#${entry.a || 1}`;
}

/** The commit column shows 7; 12 is already far past any collision this repo
 *  will ever see, and storing 40 costs 2.8 KB per hundred runs. */
const STORED_SHA_LENGTH = 12;
/** Omitted from the payload and restored on read - it is who requested all but
 *  a handful of runs, since a label-driven dispatch is made by the bot. */
const DEFAULT_ACTOR = 'github-actions[bot]';

/** Drops everything that has a default. A hundred runs is ~10 KB this way and
 *  ~15 KB without, which is the difference between fitting beside a diagram
 *  and being trimmed away. */
function compact(entry) {
  const out = {r: entry.r, c: entry.c, s: entry.s, sha: String(entry.sha || '').slice(0, STORED_SHA_LENGTH), at: entry.at};
  if (entry.w) out.w = 1;
  if (entry.a && entry.a !== 1) out.a = entry.a;
  if (entry.d !== null && entry.d !== undefined) out.d = entry.d;
  if (entry.by && entry.by !== DEFAULT_ACTOR) out.by = entry.by;
  if (entry.m) out.m = entry.m;
  return out;
}

function expand(entry) {
  return {
    a: 1,
    d: null,
    by: DEFAULT_ACTOR,
    ...entry,
    sha: String(entry.sha || '').slice(0, STORED_SHA_LENGTH),
  };
}

/** Reads the stored runs out of a body. Tolerates a start marker whose end
 *  marker was deleted by hand - the payload is still recoverable from it. */
function readEntries(body) {
  const match = (body || '').match(START_RE);
  if (!match) return [];
  const json = match[0].slice(START_PREFIX.length, -'-->'.length).trim();
  try {
    const payload = JSON.parse(json);
    return Array.isArray(payload?.runs) ? payload.runs.map(expand) : [];
  } catch {
    return [];   // hand-mangled marker: start over rather than throw
  }
}

/**
 * Merges run lists, earlier arguments losing to later ones on the same
 * `runId#attempt`. Call order is: stored (weakest), reconciled, own run.
 *
 * Reconciled beats stored because the API is authoritative once a run has
 * FINISHED, and the row that run wrote for itself was necessarily written
 * before it finished - `now` at that moment misses the post-job teardown, so a
 * 61s run recorded itself as 52s. The next check to write corrects it.
 *
 * The running check still beats both: the API calls it `in_progress` at the
 * instant we ask, and only `job.status` knows how it ended.
 *
 * `w` marks a name taken from the workflow (`Trivy Scan`) rather than the
 * status context (`trivy`) - a reconstructed row is all the API can offer, but
 * it must never overwrite the real context a row already carries.
 */
function mergeEntries(...lists) {
  const byKey = new Map();
  for (const list of lists) {
    for (const entry of list || []) {
      if (!entry || entry.r === undefined) continue;
      const key = entryKey(entry);
      // Keep a known commit subject when the newer source has none.
      const previous = byKey.get(key);
      const next = expand(entry);
      if (!previous) {
        byKey.set(key, next);
        continue;
      }
      const merged = {...previous, ...next, m: next.m || previous.m};
      // Keep a real status context over a workflow name, and CLEAR the flag
      // while doing it. Leaving it set made the row look reconstructed again,
      // so the write after next saw `w` on both sides, took neither branch, and
      // let the workflow name through - the context survived two writes and
      // degraded on the third.
      if (next.w && previous.c) {
        // A name the API reconstructed NEVER renames a row that already has
        // one. Deliberately not conditioned on the previous row's flag: rows
        // written before this rule exist with the flag set beside a perfectly
        // good context, and a rule that trusted the flag would rename exactly
        // those. Same name in, same name out, so this costs nothing when the
        // previous name was reconstructed too.
        merged.c = previous.c;
        if (!previous.w) delete merged.w;
      } else if (!next.w) {
        delete merged.w;
      }
      byKey.set(key, merged);
    }
  }
  return [...byKey.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * `YYYY-MM-DD HH:MM` in the configured zone. Everything is STORED as UTC ISO,
 * so changing the zone re-renders history that is already in the body rather
 * than stranding old rows in the old zone.
 *
 * Falls back to UTC if the runner's ICU cannot resolve the zone - a table in
 * the wrong hour is better than no table, and this must never throw.
 */
function formatStarted(iso, timeZone) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  if (!timeZone || timeZone === 'UTC') return date.toISOString().slice(0, 16).replace('T', ' ');
  try {
    // en-CA gives ISO-ordered parts, so no reassembly by hand.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date).replace(',', '');
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** GitHub renders a pipe inside a table cell as a column break. */
function cell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Groups runs by commit, newest commit first, chronological within a commit. */
function groupByCommit(entries) {
  const groups = new Map();
  for (const entry of entries) {
    // Normalised, because the API hands back 40 characters and the stored
    // payload keeps 12 - ungrouped, one commit would render as two.
    const sha = String(entry.sha || '').slice(0, STORED_SHA_LENGTH) || 'unknown';
    if (!groups.has(sha)) groups.set(sha, {sha, subject: '', runs: []});
    const group = groups.get(sha);
    group.runs.push(entry);
    if (entry.m && !group.subject) group.subject = entry.m;
  }
  const list = [...groups.values()];
  for (const group of list) {
    group.runs.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    group.latest = group.runs[group.runs.length - 1]?.at || '';
  }
  return list.sort((a, b) => String(b.latest).localeCompare(String(a.latest)));
}

function renderGroup(group, {serverUrl, repoSlug, timeZone, timeZoneLabel}, isNewest) {
  // How many times this check has run on this commit - NOT GitHub's
  // `run_attempt`, which only moves when somebody presses "Re-run jobs" on an
  // existing run. Re-requesting a check here dispatches a brand new run, so
  // `run_attempt` is structurally 1 forever and the column said nothing. A
  // genuine GitHub re-run is still worth seeing, so it is appended when it
  // happens.
  const seen = new Map();
  const rows = group.runs.map(run => {
    const nth = (seen.get(run.c) || 0) + 1;
    seen.set(run.c, nth);
    const attempt = (run.a || 1) > 1 ? `${nth} ↻${run.a}` : String(nth);
    const glyph = GLYPHS[run.s] || '❔';
    const logs = run.r ? `[run](${serverUrl}/${repoSlug}/actions/runs/${run.r})` : '—';
    return `| ${cell(run.c)} | ${glyph} ${cell(run.s)} | ${formatStarted(run.at, timeZone)} | `
      + `${formatDuration(run.d)} | ${attempt} | ${cell(run.by)} | ${logs} |`;
  });
  const short = String(group.sha).slice(0, 7);
  const subject = group.subject ? ` — ${cell(group.subject)}` : '';
  const count = `${group.runs.length} run${group.runs.length === 1 ? '' : 's'}`;
  return [
    `<details${isNewest ? ' open' : ''}>`,
    `<summary><code>${short}</code>${subject} · ${count}</summary>`,
    '',
    `| Check | Result | Started (${timeZoneLabel || 'UTC'}) | Took | # | Requested by | Logs |`,
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '</details>',
  ].join('\n');
}

/** The visible half of the block. The marker carrying the data is added by
 *  `composeBlock`, so this stays a pure render of already-merged entries. */
function renderTable(entries, options) {
  const {trimmed} = options;
  const groups = groupByCommit(entries);
  const parts = [HEADING, ''];
  groups.forEach((group, i) => {
    parts.push(renderGroup(group, options, i === 0));
  });
  if (trimmed) {
    parts.push('');
    parts.push(`<sub>Older commits trimmed to fit GitHub's ${PR_BODY_MAX_CHARS}-character description limit.</sub>`);
  }
  return parts.join('\n');
}

function composeBlock(entries, options) {
  const payload = encodeMarkerJson({v: 1, runs: entries.map(compact)});
  return `${START_PREFIX}${payload} -->\n${renderTable(entries, options)}\n${END_MARKER}`;
}

/**
 * Puts the block into a body without touching one byte outside it.
 *
 * 1. Both markers present -> replace in place, so a block a human moved stays
 *    where they moved it.
 * 2. A start marker with no end (hand-edited) -> drop the orphan, then fall
 *    through, rather than leaving a second copy behind.
 * 3. `----AI-description----` present -> insert immediately above it. Below it
 *    is the AI's territory and gets rebuilt from scratch every review.
 * 4. Otherwise -> append.
 */
function spliceBlock(body, block) {
  const original = body || '';
  if (BLOCK_RE.test(original)) {
    return original.replace(BLOCK_RE, block);
  }
  const withoutOrphan = original.replace(START_RE, '').replace(END_MARKER, '');
  const separatorMatch = withoutOrphan.match(AI_SEPARATOR_RE);
  const separatorIndex = separatorMatch ? separatorMatch.index : -1;
  if (separatorIndex >= 0) {
    const head = withoutOrphan.slice(0, separatorIndex).trimEnd();
    const tail = withoutOrphan.slice(separatorIndex);
    return `${head}\n\n${block}\n\n${tail}`;
  }
  return `${withoutOrphan.trimEnd()}\n\n${block}\n`;
}

/**
 * The whole pure transformation: existing body + merged runs -> new body,
 * trimmed to fit. Exported on its own so it can be tested without a network.
 *
 * Trimming drops the OLDEST commit group from both the render and the stored
 * payload, because a payload that no longer fits is a payload that will never
 * be written back.
 */
function buildBody(body, entries, options) {
  let kept = entries.slice();
  const maxCommits = options.maxCommits || 20;

  let commits = groupByCommit(kept).length;
  let trimmed = false;
  while (commits > maxCommits) {
    kept = dropOldestCommit(kept);
    commits = groupByCommit(kept).length;
    trimmed = true;
  }

  let next = spliceBlock(body, composeBlock(kept, {...options, trimmed}));
  while (next.length > PR_BODY_MAX_CHARS - PR_BODY_SAFETY_MARGIN && groupByCommit(kept).length > 1) {
    kept = dropOldestCommit(kept);
    trimmed = true;
    next = spliceBlock(body, composeBlock(kept, {...options, trimmed}));
  }
  return next;
}

function dropOldestCommit(entries) {
  const groups = groupByCommit(entries);
  const oldest = groups[groups.length - 1];
  if (!oldest) return entries;
  return entries.filter(entry =>
    (String(entry.sha || '').slice(0, STORED_SHA_LENGTH) || 'unknown') !== oldest.sha);
}

module.exports = {
  START_PREFIX,
  END_MARKER,
  START_RE,
  BLOCK_RE,
  AI_SEPARATOR,
  AI_SEPARATOR_RE,
  PR_BODY_MAX_CHARS,
  PR_BODY_SAFETY_MARGIN,
  GLYPHS,
  DEFAULT_ACTOR,
  STORED_SHA_LENGTH,
  encodeMarkerJson,
  compact,
  expand,
  readEntries,
  mergeEntries,
  formatDuration,
  formatStarted,
  groupByCommit,
  renderTable,
  composeBlock,
  spliceBlock,
  buildBody,
};
