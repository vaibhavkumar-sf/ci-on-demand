/**
 * Zero-dependency tests for the pure half of the run-history table.
 *
 * The invariant that matters most is not how the table looks - it is that every
 * byte OUTSIDE the markers survives a write untouched. A PR description carries
 * the author's words, the AI reviewer's narrative and its diagrams; corrupting
 * any of it is far worse than having no table.
 */

'use strict';

const assert = require('assert');
const H = require('../lib/history.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

const OPTS = {serverUrl: 'https://github.com', repoSlug: 'sourcefuse/rakuten-pms-ui', maxCommits: 20};

const run = (over = {}) => ({
  r: 33851977946, a: 1, c: 'trivy', s: 'success', sha: '4102cf209a0000000000000000000000000000aa',
  at: '2026-09-04T09:12:03Z', d: 94, by: 'github-actions[bot]', ...over,
});

/** Everything outside the block must come back byte-identical. */
function outside(body) {
  return body.replace(H.BLOCK_RE, ' BLOCK ');
}

// -- fixtures ---------------------------------------------------------------

const AI_BODY = [
  '## Description',
  '',
  'Adds the coverage opt-in. Fixes #13638',
  '',
  '## Checklist:',
  '- [x] Performed a self-review',
  '',
  '----AI-description----',
  '',
  '<details open>',
  '<summary><strong>Diagrams</strong></summary>',
  '',
  '```mermaid',
  'graph TD; A-->B;',
  '```',
  '',
  '</details>',
  '',
  '## What this PR does',
  '',
  'It does things.',
  '',
  '<!-- ai-pr-review-runs:start -->',
  '### Review Runs',
  '<!-- ai-pr-review-run:1 {"at":"2026-09-04T09:00:00Z","t":3} -->',
  '<!-- ai-pr-review-runs:end -->',
].join('\n');

// -- tests ------------------------------------------------------------------

test('empty body: block is appended and is the only content', () => {
  const out = H.buildBody('', [run()], OPTS);
  assert.ok(out.includes(H.START_PREFIX), 'start marker missing');
  assert.ok(out.trimEnd().endsWith(H.END_MARKER), 'end marker missing');
  assert.ok(out.includes('| trivy | '), 'row missing');
  assert.ok(out.includes('4102cf2'), 'short sha missing');
});

test('null body does not throw', () => {
  assert.ok(H.buildBody(null, [run()], OPTS).includes(H.END_MARKER));
});

test('AI body: block lands ABOVE the separator, never below', () => {
  const out = H.buildBody(AI_BODY, [run()], OPTS);
  assert.ok(out.indexOf(H.START_PREFIX) < out.indexOf('----AI-description----'),
    'block must sit above the AI separator or the next review deletes it');
  assert.ok(out.indexOf(H.END_MARKER) < out.indexOf('----AI-description----'));
});

test('AI body: the AI half survives byte-for-byte', () => {
  const out = H.buildBody(AI_BODY, [run()], OPTS);
  const tail = out.slice(out.indexOf('----AI-description----'));
  assert.strictEqual(tail, AI_BODY.slice(AI_BODY.indexOf('----AI-description----')));
});

test('AI body: the human half survives byte-for-byte', () => {
  const out = H.buildBody(AI_BODY, [run()], OPTS);
  const head = out.slice(0, out.indexOf(H.START_PREFIX)).trimEnd();
  assert.strictEqual(head, AI_BODY.slice(0, AI_BODY.indexOf('----AI-description----')).trimEnd());
});

test('a separator mentioned mid-sentence is not mistaken for the real one', () => {
  const prose = 'It rebuilds everything above `----AI-description----` and drops the rest.\n';
  const out = H.buildBody(`## Description\n\n${prose}`, [run()], OPTS);
  assert.ok(out.indexOf(prose) < out.indexOf(H.START_PREFIX),
    'the block was spliced into the middle of a sentence');
  assert.ok(out.includes(prose), 'the sentence was broken up');
});

test('a real separator on its own line still wins', () => {
  const out = H.buildBody('## Description\n\nmine\n\n----AI-description----\n\nAI half\n', [run()], OPTS);
  assert.ok(out.indexOf(H.START_PREFIX) < out.indexOf('\n----AI-description----'));
});

test('a body edited in the GitHub web UI (CRLF) still finds the separator', () => {
  // ECMAScript counts \r as a line terminator, so a multiline `$` matches
  // before it. Pinned because it is not true of Python or PCRE, and a rewrite
  // of AI_SEPARATOR_RE that "fixes" the anchor could quietly lose it - the
  // block would then append at the end and the next review would delete it.
  const crlf = AI_BODY.replace(/\n/g, '\r\n');
  assert.ok(H.AI_SEPARATOR_RE.test(crlf), 'separator not found in a CRLF body');
  const out = H.buildBody(crlf, [run()], OPTS);
  assert.ok(out.indexOf(H.START_PREFIX) < out.indexOf('----AI-description----'));
  assert.ok(out.includes('It does things.'), 'the AI half was lost');
});

test('second write replaces in place, adds a row, and touches nothing else', () => {
  const first = H.buildBody(AI_BODY, [run()], OPTS);
  const second = H.buildBody(first, [run(), run({r: 2, s: 'failure', at: '2026-09-04T09:31:00Z'})], OPTS);
  assert.strictEqual(outside(second), outside(first), 'content outside the block changed');
  assert.strictEqual((second.match(/ci-run-history:start/g) || []).length, 1, 'block duplicated');
  assert.ok(second.includes('failure'));
});

test('a block a human moved to the top stays where they moved it', () => {
  const block = H.composeBlock([run()], OPTS);
  const moved = `${block}\n\n## Description\n\nhello\n`;
  const out = H.buildBody(moved, [run(), run({r: 2})], OPTS);
  assert.ok(out.startsWith(H.START_PREFIX), 'block was relocated');
  assert.ok(out.endsWith('## Description\n\nhello\n'));
});

test('stored payload round-trips out of a written body', () => {
  const written = H.buildBody('', [run(), run({r: 2, c: 'npm lint'})], OPTS);
  const back = H.readEntries(written);
  assert.strictEqual(back.length, 2);
  assert.strictEqual(back[0].c, 'trivy');
  assert.strictEqual(back[1].c, 'npm lint');
});

test('an orphan start marker is replaced, not duplicated', () => {
  const orphan = `## Description\n\n${H.START_PREFIX}{"v":1,"runs":[]} -->\n\ntext\n`;
  const out = H.buildBody(orphan, [run()], OPTS);
  assert.strictEqual((out.match(/ci-run-history:start/g) || []).length, 1);
  assert.ok(out.includes('## Description'));
  assert.ok(out.includes('text'));
});

test('a hand-mangled payload is discarded rather than thrown on', () => {
  const broken = `${H.START_PREFIX}{not json -->\ntable\n${H.END_MARKER}`;
  assert.deepStrictEqual(H.readEntries(broken), []);
  assert.ok(H.buildBody(broken, [run()], OPTS).includes('| trivy |'));
});

test('a double hyphen in a commit subject cannot terminate the comment', () => {
  const nasty = run({m: 'fix: drop --code-coverage -- really'});
  const out = H.buildBody('', [nasty], OPTS);
  const marker = out.match(H.START_RE)[0];
  assert.ok(!marker.slice(H.START_PREFIX.length, -3).includes('--'),
    'raw double hyphen survived into the marker; the rest of the body would render as text');
  assert.strictEqual(H.readEntries(out)[0].m, 'fix: drop --code-coverage -- really');
});

test('a pipe in a commit subject cannot break the table', () => {
  const out = H.buildBody('', [run({m: 'feat: a | b', by: 'a|b'})], OPTS);
  const row = out.split('\n').find(l => l.startsWith('| trivy |'));
  assert.strictEqual(row.split(/(?<!\\)\|/).length - 1, 8, 'unescaped pipe added a column');
});

test('commits group newest first, runs chronological inside a commit', () => {
  const out = H.buildBody('', [
    run({r: 1, sha: 'old', at: '2026-09-01T10:00:00Z'}),
    run({r: 2, sha: 'new', at: '2026-09-04T10:00:00Z', c: 'npm lint'}),
    run({r: 3, sha: 'new', at: '2026-09-04T11:00:00Z', c: 'trivy'}),
  ], OPTS);
  assert.ok(out.indexOf('<code>new</code>') < out.indexOf('<code>old</code>'), 'newest commit not first');
  assert.ok(out.indexOf('| npm lint |') < out.indexOf('| trivy |'), 'runs not chronological');
  assert.ok(out.includes('<details open>\n<summary><code>new</code>'), 'newest group not expanded');
  assert.ok(out.includes('<details>\n<summary><code>old</code>'), 'older group not collapsed');
});

test('maxCommits drops the oldest commit and says so', () => {
  const entries = Array.from({length: 5}, (_, i) =>
    run({r: i + 1, sha: `sha${i}`, at: `2026-09-0${i + 1}T10:00:00Z`}));
  const out = H.buildBody('', entries, {...OPTS, maxCommits: 3});
  assert.ok(!out.includes('<code>sha0</code>'), 'oldest commit kept');
  assert.ok(!out.includes('<code>sha1</code>'), 'second-oldest commit kept');
  assert.ok(out.includes('<code>sha4</code>'), 'newest commit dropped');
  assert.ok(out.includes('Older commits trimmed'));
});

test('a body near the limit is trimmed instead of rejected by GitHub', () => {
  const filler = '#'.repeat(H.PR_BODY_MAX_CHARS - 4000);
  const entries = Array.from({length: 40}, (_, i) =>
    run({r: i + 1, sha: `sha${String(i).padStart(3, '0')}`, at: `2026-09-04T10:${String(i).padStart(2, '0')}:00Z`,
      m: 'a fairly long commit subject to make the payload weigh something'}));
  const out = H.buildBody(filler, entries, OPTS);
  assert.ok(out.length <= H.PR_BODY_MAX_CHARS, `body is ${out.length} chars, over the limit`);
  assert.ok(out.startsWith(filler), 'existing body was damaged while trimming');
});

test('mergeEntries: own run beats stored beats reconciled on the same attempt', () => {
  const reconciled = run({s: 'in_progress', d: null, c: 'Trivy Scan'});
  const stored = run({s: 'in_progress', m: 'feat: x'});
  const mine = run({s: 'success', d: 94});
  const merged = H.mergeEntries([reconciled], [stored], [mine]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].s, 'success');
  assert.strictEqual(merged[0].c, 'trivy');
  assert.strictEqual(merged[0].m, 'feat: x', 'a known commit subject was lost');
});

test('mergeEntries: a re-run is a new row, not a replacement', () => {
  const merged = H.mergeEntries([run()], [run({a: 2, s: 'failure'})]);
  assert.strictEqual(merged.length, 2);
});

test('the Started column renders in the configured zone, header and all', () => {
  const out = H.buildBody('', [run({at: '2026-09-04T14:18:22Z'})],
    {...OPTS, timeZone: 'Asia/Kolkata', timeZoneLabel: 'IST'});
  assert.ok(out.includes('Started (IST)'), 'header still says UTC');
  assert.ok(out.includes('2026-09-04 19:48'), 'time not shifted to +05:30');
  // Stored as UTC regardless, so switching zones re-renders old rows too.
  assert.strictEqual(H.readEntries(out)[0].at, '2026-09-04T14:18:22Z');
});

test('an unresolvable zone falls back to UTC instead of throwing', () => {
  assert.strictEqual(H.formatStarted('2026-09-04T14:18:22Z', 'Not/AZone'), '2026-09-04 14:18');
  assert.strictEqual(H.formatStarted('2026-09-04T14:18:22Z'), '2026-09-04 14:18');
});

test('durations read the way a human reads a clock', () => {
  assert.strictEqual(H.formatDuration(9), '9s');
  assert.strictEqual(H.formatDuration(94), '1m 34s');
  assert.strictEqual(H.formatDuration(702), '11m 42s');
  assert.strictEqual(H.formatDuration(3720), '1h 2m');
  assert.strictEqual(H.formatDuration(null), '—');
});

test('a run with no recorded start renders rather than crashing', () => {
  const out = H.buildBody('', [run({at: '', d: null})], OPTS);
  assert.ok(out.includes('| — | — |'));
});

test('every conclusion GitHub can produce has a glyph', () => {
  for (const s of ['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'startup_failure', 'in_progress', 'queued']) {
    assert.ok(H.GLYPHS[s], `no glyph for ${s}`);
  }
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
