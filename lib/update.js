/**
 * The IO half of the run-history table: gather this run's facts, merge them
 * with what the body already stores, optionally reconcile against the Actions
 * API, and write the body back.
 *
 * Every failure in here is a warning, never a failure. The commit status has
 * already been published by the time this runs; a broken table must never be
 * the reason `trivy` goes red.
 */

'use strict';

const {readEntries, mergeEntries, buildBody, STORED_SHA_LENGTH} = require('./history.js');

/** mergeEntries stores 12 characters; the local context and the API both hand
 *  over 40. Compare normalised or nothing ever matches. */
const shortSha = sha => String(sha || '').slice(0, STORED_SHA_LENGTH);

/** Only the on-demand checks. `ci.yml` runs on `pull_request`, so filtering on
 *  the dispatch event excludes the router without naming a single workflow -
 *  which also means a renamed check keeps its history. */
const DISPATCH_EVENT = 'workflow_dispatch';

/** This run, entirely from the local context. No API call is needed for the row
 *  the running job is itself producing. */
function ownEntry({context, checkName, status, startedAt, now}) {
  const startedMs = Date.parse(startedAt);
  const duration = Number.isNaN(startedMs) ? null : Math.round((now.getTime() - startedMs) / 1000);
  return {
    r: context.runId,
    a: Number(process.env.GITHUB_RUN_ATTEMPT || '1'),
    c: checkName,
    s: status,
    sha: context.payload.pull_request?.head?.sha || context.sha,
    at: Number.isNaN(startedMs) ? now.toISOString() : new Date(startedMs).toISOString(),
    d: duration,
    by: process.env.GITHUB_TRIGGERING_ACTOR || context.actor || '',
  };
}

/**
 * Rows the local context cannot produce: a run whose job never started (queued
 * when `ci.yml` cancelled it, or `startup_failure`), and a row lost because two
 * checks finished in the same second and one read-modify-write overwrote the
 * other. Weakest source in the merge - the API still calls the current run
 * `in_progress`.
 */
async function reconcileEntries({github, context, core, branch}) {
  const {data} = await github.rest.actions.listWorkflowRunsForRepo({
    ...context.repo,
    branch,
    per_page: 100,
  });
  const entries = [];
  for (const run of data.workflow_runs || []) {
    if (run.event !== DISPATCH_EVENT) continue;
    const started = run.run_started_at || run.created_at;
    const finished = run.updated_at;
    const startedMs = Date.parse(started);
    const finishedMs = Date.parse(finished);
    entries.push({
      r: run.id,
      a: run.run_attempt || 1,
      // The workflow's display name, not the status context - a run that never
      // reached its own step never told us the context it would have used.
      c: run.name,
      s: run.conclusion || run.status,
      sha: run.head_sha,
      at: Number.isNaN(startedMs) ? '' : new Date(startedMs).toISOString(),
      d: run.conclusion && !Number.isNaN(startedMs) && !Number.isNaN(finishedMs)
        ? Math.round((finishedMs - startedMs) / 1000)
        : null,
      by: run.triggering_actor?.login || run.actor?.login || '',
    });
  }
  core.info(`reconciled ${entries.length} dispatched run(s) on ${branch}`);
  return entries;
}

/**
 * Subjects for every commit in the PR, in one call.
 *
 * Was a per-commit `repos.getCommit` for our own SHA only, which left a group
 * reconstructed purely from the API with a bare SHA for a heading - visibly
 * different from the rows written in-process, for no reason. Same call count,
 * every group labelled.
 */
async function commitSubjects({github, context, core, pull_number}) {
  const subjects = new Map();
  try {
    const {data} = await github.rest.pulls.listCommits({
      ...context.repo, pull_number, per_page: 100,
    });
    for (const commit of data) {
      subjects.set(shortSha(commit.sha), (commit.commit?.message || '').split('\n')[0].slice(0, 72));
    }
  } catch (e) {
    core.info(`could not read commit subjects: ${e.message}`);   // headings fall back to the SHA
  }
  return subjects;
}

/**
 * Who actually asked for this check.
 *
 * `github.actor` and `triggering_actor` are BOTH github-actions[bot] on a
 * label-driven run, because ci.yml dispatches with GITHUB_TOKEN - so the column
 * would read "github-actions[bot]" for every row and carry no information. The
 * person is only known to ci.yml, from its own `labeled` event.
 *
 * The issue timeline is the one place that survives: it keeps the `labeled`
 * event with its actor even after ci.yml removes the label seconds later. So
 * take the newest `ci:*` label addition at or just before this run was created.
 *
 * Passing the login as a dispatch input would be exact rather than inferred,
 * and was rejected: a dispatch carrying an input the target workflow does not
 * declare fails with 422, so every already-open PR would break until it was
 * updated from the default branch.
 *
 * `WINDOW_MS` keeps an Actions-tab run from stealing credit from an unrelated
 * label added earlier - there, `triggering_actor` is already the real person.
 */
const LABEL_WINDOW_MS = 10 * 60 * 1000;

/** Every `ci:*` label addition on the PR, as {at, login}. Fetched once and
 *  matched against each row, so a row reconciliation had to rebuild is
 *  attributed exactly like one written in-process. */
async function labelEvents({github, context, core, pull_number}) {
  try {
    const {data} = await github.rest.issues.listEventsForTimeline({
      ...context.repo, issue_number: pull_number, per_page: 100,
    });
    return data
      .filter(e => e.event === 'labeled' && e.label?.name?.startsWith('ci:') && e.actor?.login)
      .map(e => ({at: Date.parse(e.created_at), login: e.actor.login}))
      .filter(e => !Number.isNaN(e.at));
  } catch (e) {
    core.info(`could not read the timeline: ${e.message}`);   // column falls back to the actor
    return [];
  }
}

/** The newest `ci:*` label added just before this run started. */
function requestedBy(events, runStartedAt, fallback) {
  const startedMs = Date.parse(runStartedAt);
  if (Number.isNaN(startedMs) || !events.length) return fallback;
  let best = null;
  for (const event of events) {
    // A little slack forward: the label is logged moments before the run exists.
    if (event.at > startedMs + 60000) continue;
    if (startedMs - event.at > LABEL_WINDOW_MS) continue;
    if (!best || event.at > best.at) best = event;
  }
  return best ? best.login : fallback;
}

async function updateRunHistory({
  github,
  context,
  core,
  prNumber,
  checkName,
  status,
  startedAt,
  reconcile = true,
  maxCommits = 20,
  timeZone = 'UTC',
  timeZoneLabel = '',
}) {
  const pull_number = Number(prNumber);
  if (!Number.isInteger(pull_number) || pull_number <= 0) {
    core.info('no pr-number given - skipping the run-history table');
    return;
  }

  const now = new Date();
  let mine = ownEntry({context, checkName, status, startedAt, now});
  const branch = context.payload.pull_request?.head?.ref || process.env.GITHUB_REF_NAME || '';

  let reconciled = [];
  if (reconcile && branch) {
    try {
      reconciled = await reconcileEntries({github, context, core, branch});
    } catch (e) {
      core.info(`reconcile skipped: ${e.message}`);   // the stored payload still carries history
    }
  }

  // Prefer the run's own start over the env stamp. The stamp is set by the
  // OPENING ci-on-demand step, which is several seconds into the job - after
  // the runner is claimed and after GitHub has downloaded this action - so it
  // measured a `pr checks` job at 3s that the Actions UI called 12s, and it
  // disagreed with every row reconciliation had to reconstruct. `run_started_at`
  // is what the UI shows, so the two paths now agree.
  const fromApi = reconciled.find(entry => entry.r === mine.r && entry.a === mine.a);
  if (fromApi?.at) {
    const startedMs = Date.parse(fromApi.at);
    mine = {...mine, at: fromApi.at, d: Math.round((now.getTime() - startedMs) / 1000)};
  }

  const events = await labelEvents({github, context, core, pull_number});
  mine = {...mine, by: requestedBy(events, mine.at, mine.by)};
  reconciled = reconciled.map(entry => ({...entry, by: requestedBy(events, entry.at, entry.by)}));

  const serverUrl = context.serverUrl;
  const repoSlug = `${context.repo.owner}/${context.repo.repo}`;

  // Two attempts. Between the read and the write another check - or the AI
  // reviewer, which rewrites the whole body - can land, and the loser of that
  // race silently loses its row. Re-reading and rebuilding recovers it.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const {data: pr} = await github.rest.pulls.get({...context.repo, pull_number});
    const body = pr.body || '';

    const stored = readEntries(body);
    let entries = mergeEntries(reconciled, stored, [mine]);

    const subjects = await commitSubjects({github, context, core, pull_number});
    entries = entries.map(entry => {
      const subject = subjects.get(shortSha(entry.sha));
      // A stored subject wins for a commit that has since been rebased away.
      return subject ? {...entry, m: subject} : entry;
    });

    const next = buildBody(body, entries, {
      serverUrl, repoSlug, maxCommits, timeZone, timeZoneLabel: timeZoneLabel || timeZone,
    });
    if (next === body) {
      core.info('run history already up to date');
      return;
    }

    await github.rest.pulls.update({...context.repo, pull_number, body: next});

    // Verify rather than assume: a write lost to the AI reviewer rewriting the
    // body in the same window is invisible otherwise. Read the payload back
    // rather than grepping the rendered table.
    const {data: after} = await github.rest.pulls.get({...context.repo, pull_number});
    const landed = readEntries(after.body || '')
      .some(entry => entry.r === mine.r && entry.a === mine.a && entry.s === mine.s);
    if (landed) {
      core.info(`run history updated (${entries.length} run(s) recorded)`);
      return;
    }
    core.info(`run-history write ${attempt} was overwritten - retrying`);
  }
  core.warning('could not persist the run-history table after 2 attempts');
}

module.exports = {updateRunHistory, ownEntry, reconcileEntries, commitSubjects, labelEvents, requestedBy};
