# ci-on-demand

A single composite action for repositories where CI runs **only when asked for** — by adding
a `ci:*` label to a PR — rather than on every push.

It does the two bookkeeping jobs such a setup needs, so they don't get pasted into every
check workflow:

1. **Publishes the check's result as a commit status**, so the PR merge box keeps showing it.
2. **Releases the `ci:*` label** that requested the check, so it can be requested again.

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

`cancelled` is reported as the `error` state, which reads as "did not complete".

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
