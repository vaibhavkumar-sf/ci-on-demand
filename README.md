# ci-on-demand

A single composite action for repositories where CI runs **only when asked for** — by adding
a `ci:*` label to a PR — rather than on every push.

It does the two bookkeeping jobs such a setup needs, so they don't get pasted into every
check workflow:

1. **Publishes the check's result as a commit status**, so the PR merge box keeps showing it.
2. **Releases the `ci:*` label** that requested the check, so it can be requested again.
3. **Keeps a run-history table in the PR description**, because a commit status remembers
   only the latest result.

## Why a commit status

The PR merge box draws **one run per workflow: the most recently created**. An earlier run's
check rows are not collapsed — they are not drawn at all, and the newer run's *skipped*
placeholder takes the row. So requesting a second check erases the first one's result from
the box even though it passed.

A commit status belongs to no workflow run and no check suite, so nothing can hide it. That
is why a code-scanning row always persists in that box while workflow rows come and go.

Publish under the **bare** name your branch protection requires (`trivy`, `npm lint`), and
the required check is satisfied directly.

## Why the label is released here

GitHub bills **every job a whole minute**, however short. A dedicated "remove the label" job
spends a minute doing about six seconds of work. Releasing it in the check's own first step
costs nothing.

## Usage

Call it twice per job — first with no `status`, last with `status` under `if: always()`.

```yaml
jobs:
  trivy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      statuses: write   # the merge-box row
      issues: write     # releases its own trigger label
    steps:
      - uses: vaibhavkumar-sf/ci-on-demand@v1
        with: {context: trivy, label: Trivy scan}

      # ... the check's real steps ...

      - uses: vaibhavkumar-sf/ci-on-demand@v1
        if: always()
        with: {context: trivy, label: Trivy scan, status: '${{ job.status }}'}
```

### Inputs

| Input | Required | Default | Meaning |
|---|---|---|---|
| `context` | yes | — | The row name in the merge box. Use the bare name any required status check is configured with. |
| `label` | no | `context` | Human name used in the status description. |
| `status` | no | `''` | Empty reports *pending*. Pass `${{ job.status }}` to report the result. |
| `consume-label` | no | `true` | Release the `ci:*` label. Set `false` on the second and later calls in a job that reports more than one context. |
| `pr-number` | no | `''` | PR whose description carries the run-history table. **Empty turns the table off**, so existing callers are unaffected. |
| `history` | no | `true` | Maintain the table. Needs `pull-requests: write` and a `pr-number`. |
| `history-reconcile` | no | `true` | Also read the branch's dispatched runs from the Actions API. One extra REST call. |
| `history-max-commits` | no | `20` | How many commits the table keeps. |

`cancelled` is reported as the `error` state, which reads as "did not complete".

## The run-history table

A commit status holds exactly **one state per context per SHA**. Re-request a check, or push
a commit, and the previous result is gone from the PR — there is no record that `ci:verify`
passed twice and failed once, or that `trivy` took 90s yesterday and four minutes today.

Pass `pr-number` and the closing call maintains a table in the PR description instead:

```yaml
      - uses: vaibhavkumar-sf/ci-on-demand@v1
        if: always()
        with:
          context: trivy
          label: Trivy scan
          status: '${{ job.status }}'
          pr-number: ${{ inputs.pr_number }}   # a dispatched run has no pull_request payload
```

The job also needs `pull-requests: write`.

```markdown
### CI run history

<details open><summary><code>4102cf2</code> — feat(ci): opt-in coverage · 3 runs</summary>

| Check | Result | Started (UTC) | Took | # | Requested by | Logs |
| --- | --- | --- | --- | --- | --- | --- |
| npm lint | ✅ success | 2026-09-04 09:12 | 11m 42s | 1 | github-actions[bot] | [run](…) |
| trivy | ❌ failure | 2026-09-04 09:12 | 1m 34s | 1 | github-actions[bot] | [run](…) |
| trivy | ✅ success | 2026-09-04 09:31 | 1m 29s | 2 | a-human | [run](…) |

</details>
```

### Why it is written from this step

The same reason the label is released here: **GitHub rounds every job up to a whole minute**.
A workflow that existed only to write this table would bill a full minute per check. This
step is already running, already has an authenticated Octokit, and already knows the job's
result — the table costs two REST calls inside a job you have already paid for.

### Where the data comes from

Mostly not the API. The run writing the row *is* the run being described, so its status, SHA,
attempt, actor and run id come from `context`, and its start time from an env var the opening
call exported. Older rows travel in a JSON payload inside the start marker — **the PR body is
the store**, and rendered markdown is never parsed back into data.

The job needs **`actions: read`** for that, on top of `pull-requests: write` — a
`permissions:` block sets every scope it does not name to `none`, so omitting it makes the
call 403 with `Resource not accessible by integration`, silently.

`history-reconcile` adds one `listWorkflowRunsForRepo` call, filtered to
`event == workflow_dispatch` so the dispatcher workflow never appears in its own table. It
covers the two cases the local context cannot: a row lost when two checks finished in the
same second and read-modify-wrote the same body, and a run whose job never started at all
(cancelled while queued, `startup_failure`).

### Where the block sits, and how it survives other writers

Delimited by `<!-- ci-run-history:start … -->` and `<!-- ci-run-history:end -->`, and **not
one byte outside those markers is ever read or modified**. Placement, in order: replace in
place if the markers exist (so a block someone moved stays moved) → otherwise insert
immediately *above* an `----AI-description----` separator **on a line of its own** →
otherwise append. The line anchor is not cosmetic: a description that *mentions* the
separator in prose would otherwise have the table spliced into the middle of a sentence.

That middle rule matters if you also run
[`ai-pr-review-action`](https://github.com/vaibhavkumar-sf/ai-pr-review-action): it rebuilds
the whole body as `everything-before-the-separator + its own sections` and **drops whatever
followed**. A table appended to the bottom would be deleted by the next review. Above the
separator it is in the half that action preserves verbatim.

Writers still race. Because the payload is re-read and re-merged on every write, a lost
update self-heals on the next one, and the write is verified and retried once. Failures are
warnings: the commit status is published *before* the table, so a broken table can never turn
a check red.

Two hazards handled in code, worth knowing if you edit it:

- A `--` anywhere in the payload would terminate the HTML comment and render the rest of the
  description as visible text. Every run of hyphens is escaped to `\u002d`.
- A `|` in a commit subject or a login would add a column. Both are escaped.

### Reporting two contexts from one job

Bundling checks into one job saves a billed minute. Report each one separately, and let the
second call skip the label release:

```yaml
      - uses: vaibhavkumar-sf/ci-on-demand@v1
        with: {context: 'pr checks'}
      - uses: vaibhavkumar-sf/ci-on-demand@v1
        with: {context: trivy, label: Trivy scan, consume-label: 'false'}
```

To keep the two results independent, give the bundled step `continue-on-error: true` and pass
its `steps.<id>.outcome` as `status` instead of `job.status`.

## Releasing

`v1` is a moving tag — consumers pin `@v1` and pick fixes up automatically:

```sh
git tag -a v1.0.1 -m v1.0.1 && git push origin v1.0.1
git tag -f v1     -m v1     && git push -f origin v1
```

Do not cut a `v1.0.1` without also moving `v1`, or nobody sees the fix.

Run `npm test` first — it is plain `node`, no dependencies, and covers the body splice, the
marker escaping, the trimming and the retry.

Consumers pinning a **SHA** rather than `@v1` (which is what a security review will ask for)
need the new commit SHA. `v1` is an *annotated* tag, so resolve it with
`gh api repos/vaibhavkumar-sf/ci-on-demand/commits/v1 --jq .sha` — the SHA under
`git/ref/tags/v1` is the tag object and will not resolve as a `uses:` ref.

**Never put a `${{ }}` expression in this file's `description:` fields**, not even inside
backticks. GitHub evaluates action metadata as a template, so prose mentioning
`job.status` in an expression fails the whole action with "Unrecognized named-value".

## Adopting the whole pattern

1. Create the `ci:*` labels in the repository.
2. Add a `ci.yml` dispatcher: `on: pull_request: [labeled]`, one job per check, each gated on
   its label name and calling the check as a reusable workflow.
3. Add the two `uses:` steps above to each check workflow.

Two traps worth knowing:

- **Never put `concurrency:` at workflow level** in a check workflow. The group is claimed
  when a run is *created*, before any job `if:` is evaluated, so a run whose jobs will all
  skip still cancels the check that is already running. Put it on the job.
- **`workflow_dispatch` cannot replace this.** A PR's status-check rollup contains only runs
  triggered by `pull_request` / `pull_request_target`; dispatched runs are invisible to the
  merge box *and* to branch protection.

Verify changes with `gh pr checks <n>` or `gh api repos/O/R/commits/<sha>/status`, never with
`commits/{sha}/check-runs` — that lists check runs the PR does not count.
