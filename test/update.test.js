/**
 * Tests for the IO half, against a stubbed Octokit. No network.
 *
 * The cases worth pinning are the ones that only happen under load: the AI
 * reviewer rewriting the body in the same window as our write, and a run whose
 * job never started and therefore never wrote a row of its own.
 */

'use strict';

const assert = require('assert');
const {updateRunHistory} = require('../lib/update.js');
const H = require('../lib/history.js');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.stack}`);
    process.exitCode = 1;
  }
}

const core = {info() {}, warning(m) { core.warnings.push(m); }, warnings: []};

function stub({body = '', runs = [], timeline = [], onUpdate} = {}) {
  const state = {body, updates: 0, gets: 0};
  const github = {
    rest: {
      pulls: {
        // One call labels every commit group, including groups rebuilt purely
        // from the API by a run that never wrote a row of its own.
        async listCommits() {
          return {data: [{sha: context.sha, commit: {message: 'feat(ci): a subject\n\nbody'}}]};
        },
        async get() { state.gets++; return {data: {body: state.body}}; },
        async update({body: next}) {
          state.updates++;
          state.body = onUpdate ? onUpdate(next, state.updates) : next;
        },
      },
      actions: {
        async listWorkflowRunsForRepo() { return {data: {workflow_runs: runs}}; },
      },
      issues: {
        // Both actors are github-actions[bot] on a dispatched run, so the
        // timeline is the only place the requester survives.
        async listEventsForTimeline() { return {data: timeline}; },
      },
    },
  };
  return {github, state};
}

const context = {
  repo: {owner: 'sourcefuse', repo: 'rakuten-pms-ui'},
  runId: 111,
  sha: '4102cf209a0b1122334455667788990011223344',
  actor: 'github-actions[bot]',
  serverUrl: 'https://github.com',
  payload: {},
};

const BASE = {
  context, core,
  prNumber: '13640',
  checkName: 'trivy',
  status: 'success',
  startedAt: new Date(Date.now() - 94000).toISOString(),
};

process.env.GITHUB_REF_NAME = 'chore/coverage-opt-in';
process.env.GITHUB_RUN_ATTEMPT = '1';
process.env.GITHUB_TRIGGERING_ACTOR = 'github-actions[bot]';

(async () => {

  await test('writes a row for its own run without needing the API for it', async () => {
    const {github, state} = stub();
    await updateRunHistory({...BASE, github, reconcile: false});
    assert.strictEqual(state.updates, 1);
    const entries = H.readEntries(state.body);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].r, 111);
    assert.strictEqual(entries[0].c, 'trivy');
    assert.strictEqual(entries[0].s, 'success');
    assert.ok(entries[0].d >= 93 && entries[0].d <= 96, `duration was ${entries[0].d}`);
    assert.strictEqual(entries[0].m, 'feat(ci): a subject');
  });

  await test('no pr-number: does nothing at all', async () => {
    const {github, state} = stub();
    await updateRunHistory({...BASE, github, prNumber: ''});
    assert.strictEqual(state.updates, 0);
    assert.strictEqual(state.gets, 0);
  });

  await test('a group rebuilt from the API is still labelled with its subject', async () => {
    const {github, state} = stub({
      runs: [{id: 222, run_attempt: 1, event: 'workflow_dispatch', name: 'AI Code Review',
        status: 'completed', conclusion: 'failure', head_sha: context.sha,
        run_started_at: '2026-09-04T09:00:00Z', updated_at: '2026-09-04T09:00:20Z',
        triggering_actor: {login: 'github-actions[bot]'}}],
    });
    await updateRunHistory({...BASE, github});
    assert.ok(H.readEntries(state.body).every(e => e.m === 'feat(ci): a subject'),
      'a reconciled row was left without a commit subject');
  });

  await test('reconcile records a run whose job never started', async () => {
    const {github, state} = stub({
      runs: [
        {id: 222, run_attempt: 1, event: 'workflow_dispatch', name: 'AI Code Review',
          status: 'completed', conclusion: 'cancelled', head_sha: context.sha,
          run_started_at: null, created_at: '2026-09-04T09:00:00Z', updated_at: '2026-09-04T09:00:20Z',
          triggering_actor: {login: 'github-actions[bot]'}},
        // ci.yml itself must never appear: it is the router, not a check.
        {id: 333, run_attempt: 1, event: 'pull_request', name: 'CI',
          status: 'completed', conclusion: 'success', head_sha: context.sha,
          run_started_at: '2026-09-04T09:00:00Z', updated_at: '2026-09-04T09:00:05Z',
          triggering_actor: {login: 'someone'}},
      ],
    });
    await updateRunHistory({...BASE, github});
    const entries = H.readEntries(state.body);
    assert.strictEqual(entries.length, 2, 'expected our run plus the cancelled one');
    assert.ok(entries.some(e => e.r === 222 && e.s === 'cancelled'), 'cancelled run missing');
    assert.ok(!entries.some(e => e.r === 333), 'ci.yml leaked into the table');
  });

  await test('our own duration is measured from the run start, not the step start', async () => {
    // The env stamp is set by the opening step, several seconds into the job.
    // Reconciled rows use run_started_at, so the local path has to as well or
    // the same check reads shorter when it wrote its own row than when the row
    // had to be reconstructed.
    const startedAt = new Date(Date.now() - 200000).toISOString();   // run start
    const {github, state} = stub({
      runs: [{id: 111, run_attempt: 1, event: 'workflow_dispatch', name: 'Trivy Scan',
        status: 'in_progress', conclusion: null, head_sha: context.sha,
        run_started_at: startedAt, updated_at: new Date().toISOString(),
        triggering_actor: {login: 'github-actions[bot]'}}],
    });
    // Stamp says 10s; the API says 200s. The API must win.
    await updateRunHistory({...BASE, github, startedAt: new Date(Date.now() - 10000).toISOString()});
    const [entry] = H.readEntries(state.body);
    assert.ok(entry.d >= 199 && entry.d <= 202, `duration was ${entry.d}, expected ~200`);
    assert.strictEqual(entry.s, 'success', 'the conclusion must still come from job.status');
  });

  await test('the API never downgrades our own run to in_progress', async () => {
    const {github, state} = stub({
      runs: [{id: 111, run_attempt: 1, event: 'workflow_dispatch', name: 'Trivy Scan',
        status: 'in_progress', conclusion: null, head_sha: context.sha,
        run_started_at: '2026-09-04T09:00:00Z', updated_at: '2026-09-04T09:00:10Z',
        triggering_actor: {login: 'github-actions[bot]'}}],
    });
    await updateRunHistory({...BASE, github});
    const entries = H.readEntries(state.body);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].s, 'success');
    assert.strictEqual(entries[0].c, 'trivy', 'the status context should win over the workflow name');
  });

  await test('a write clobbered by the AI reviewer is retried and lands', async () => {
    const AI = '## Description\n\nmine\n\n----AI-description----\n\nAI narrative\n';
    const {github, state} = stub({
      body: '## Description\n\nmine\n',
      // First write is thrown away, exactly as the reviewer does when it
      // rebuilds the body from a read it took before us.
      onUpdate: (next, n) => (n === 1 ? AI : next),
    });
    await updateRunHistory({...BASE, github, reconcile: false});
    assert.strictEqual(state.updates, 2, 'did not retry');
    const entries = H.readEntries(state.body);
    assert.strictEqual(entries.length, 1);
    assert.ok(state.body.indexOf(H.START_PREFIX) < state.body.indexOf('----AI-description----'));
    assert.ok(state.body.includes('AI narrative'), 'the AI half was destroyed by the retry');
  });

  await test('gives up with a warning rather than looping forever', async () => {
    core.warnings.length = 0;
    const {github, state} = stub({onUpdate: () => '## Description\n\nsomeone else won\n'});
    await updateRunHistory({...BASE, github, reconcile: false});
    assert.strictEqual(state.updates, 2);
    assert.strictEqual(core.warnings.length, 1);
    assert.ok(/could not persist/.test(core.warnings[0]));
  });

  await test('a second run appends rather than replacing', async () => {
    const {github, state} = stub();
    await updateRunHistory({...BASE, github, reconcile: false});
    await updateRunHistory({
      ...BASE, github, reconcile: false,
      context: {...context, runId: 112}, checkName: 'npm lint', status: 'failure',
    });
    const entries = H.readEntries(state.body);
    assert.strictEqual(entries.length, 2);
    assert.deepStrictEqual(entries.map(e => e.s), ['success', 'failure']);
  });

  await test('the requester is the human who added the label, not the bot', async () => {
    const startedAt = new Date(Date.now() - 60000).toISOString();
    const {github, state} = stub({
      runs: [{id: 111, run_attempt: 1, event: 'workflow_dispatch', name: 'Trivy Scan',
        status: 'in_progress', conclusion: null, head_sha: context.sha,
        run_started_at: startedAt, updated_at: new Date().toISOString(),
        triggering_actor: {login: 'github-actions[bot]'}}],
      timeline: [
        {event: 'labeled', label: {name: 'enhancement'}, actor: {login: 'someone-else'},
          created_at: new Date(Date.now() - 70000).toISOString()},
        {event: 'labeled', label: {name: 'ci:trivy'}, actor: {login: 'a-human'},
          created_at: new Date(Date.now() - 65000).toISOString()},
      ],
    });
    await updateRunHistory({...BASE, github});
    assert.strictEqual(H.readEntries(state.body)[0].by, 'a-human');
  });

  await test('a stale label from an hour ago does not steal credit', async () => {
    // An Actions-tab run: no label was added, and GITHUB_TRIGGERING_ACTOR is
    // already the person who pressed the button.
    process.env.GITHUB_TRIGGERING_ACTOR = 'ran-it-by-hand';
    const startedAt = new Date(Date.now() - 60000).toISOString();
    const {github, state} = stub({
      runs: [{id: 111, run_attempt: 1, event: 'workflow_dispatch', name: 'Trivy Scan',
        status: 'in_progress', conclusion: null, head_sha: context.sha,
        run_started_at: startedAt, updated_at: new Date().toISOString(),
        triggering_actor: {login: 'ran-it-by-hand'}}],
      timeline: [{event: 'labeled', label: {name: 'ci:trivy'}, actor: {login: 'a-human'},
        created_at: new Date(Date.now() - 3600000).toISOString()}],
    });
    await updateRunHistory({...BASE, github});
    assert.strictEqual(H.readEntries(state.body)[0].by, 'ran-it-by-hand',
      'an Actions-tab run must keep its own actor');
    process.env.GITHUB_TRIGGERING_ACTOR = 'github-actions[bot]';
  });

  await test('a timeline failure leaves the actor in place', async () => {
    const {github, state} = stub();
    github.rest.issues.listEventsForTimeline = async () => { throw new Error('403'); };
    await updateRunHistory({...BASE, github, reconcile: false});
    assert.strictEqual(H.readEntries(state.body)[0].by, 'github-actions[bot]');
  });

  await test('a reconcile failure does not lose the stored history', async () => {
    const {github, state} = stub();
    github.rest.actions.listWorkflowRunsForRepo = async () => { throw new Error('403'); };
    await updateRunHistory({...BASE, github});
    assert.strictEqual(H.readEntries(state.body).length, 1);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
})();
