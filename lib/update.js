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

/** One call, and only for a commit whose subject we have not stored yet. */
async function commitSubject({github, context, core, sha, entries}) {
  if (!sha) return '';
  const known = entries.find(entry => shortSha(entry.sha) === shortSha(sha) && entry.m);
  if (known) return known.m;
  try {
    const {data} = await github.rest.repos.getCommit({...context.repo, ref: sha});
    return (data.commit?.message || '').split('\n')[0].slice(0, 72);
  } catch (e) {
    core.info(`could not read the subject of ${sha}: ${e.message}`);
    return '';
  }
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
}) {
  const pull_number = Number(prNumber);
  if (!Number.isInteger(pull_number) || pull_number <= 0) {
    core.info('no pr-number given - skipping the run-history table');
    return;
  }

  const now = new Date();
  const mine = ownEntry({context, checkName, status, startedAt, now});
  const branch = context.payload.pull_request?.head?.ref || process.env.GITHUB_REF_NAME || '';

  let reconciled = [];
  if (reconcile && branch) {
    try {
      reconciled = await reconcileEntries({github, context, core, branch});
    } catch (e) {
      core.info(`reconcile skipped: ${e.message}`);   // the stored payload still carries history
    }
  }

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

    const subject = await commitSubject({github, context, core, sha: mine.sha, entries});
    if (subject) {
      entries = entries.map(entry =>
        (shortSha(entry.sha) === shortSha(mine.sha) ? {...entry, m: subject} : entry));
    }

    const next = buildBody(body, entries, {serverUrl, repoSlug, maxCommits});
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

module.exports = {updateRunHistory, ownEntry, reconcileEntries, commitSubject};
