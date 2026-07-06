# Dev Orchestrator Extension

This Pi extension implements a project-local development governance workflow:

```text
Discuss → Plan → Execute → Verify → Review → Accept → Ship → Finalize
```

## Location

Source of the agent:

```text
/root/pi/.pi/extensions/dev-orchestrator.ts
```

Global Pi extension symlink:

```text
/root/.pi/agent/extensions/dev-orchestrator.ts -> /root/pi/.pi/extensions/dev-orchestrator.ts
```

The extension code is stored under `/root/pi`, while phase artifacts are written to the current Pi working directory:

```text
<project>/.dev-agent/
```

## Commands

```text
/dev-start <goal>     Initialize .dev-agent/ and start discussion
/dev-status           Show current project state
/dev-discuss [notes]  Clarify requirements and update OPEN_QUESTIONS.md
/dev-plan             Generate/update master planning documents
/dev-next [N]         Create phase N, or next phase if N omitted
/dev-run              Execute the current phase
/dev-verify           Verify current phase using diff/tests/lint
/dev-review           Review current phase against plan and acceptance
/dev-block <reason>   Mark current phase blocked and write ISSUE.md
/dev-accept           Document accepted phase and update master context
/dev-ship             Prepare safe git commit/push flow
/dev-finalize         Generate final reports
/dev-screen-status    Show recent parallel screen-run jobs and log paths
/dev-experiment-status Show recent monitored experiment runs and SUMMARY.md paths
/dev-experiments       Refresh .dev-agent/EXPERIMENTS.md from recorded runs
/dev-review-subagent   Launch independent read-only review subagent for current phase
/dev-subagent-status   Show recent subagent runs
```

## Project-local Memory

Each project gets:

```text
.dev-agent/
  GOAL.md
  CONTEXT.md
  MASTER_PLAN.md
  ACCEPTANCE.md
  RISKS.md
  DECISIONS.md
  OPEN_QUESTIONS.md
  STOP_CONDITIONS.md
  STATE.json
  EXPERIMENTS.md
  phases/
    phase-001/
      PLAN.md
      DEVLOG.md
      VERIFY.md
      REVIEW.md
      RESULT.md
      ISSUE.md
  final/
```

## Parallel Screen Runs

The extension registers a model-callable tool named `dev_screen_run`.

Use it when multiple validation commands are independent and safe to run concurrently. It launches each command in a detached GNU screen session and writes project-local artifacts under:

```text
.dev-agent/runs/<run-id>/
  jobs.json
  01-<job>.log
  01-<job>.exitcode
  01-<job>.status
```

Check status with:

```text
/dev-screen-status
/dev-screen-status <run-id>
```

Do not use parallel screen runs for commands that mutate the same files, depend on each other's outputs, require interactive input, require secrets, or need exclusive resources.

Token guidance: screen jobs write full output to disk, so they are token-light until the agent reads logs. Prefer `/dev-screen-status` and only read log tails on failure.

## True Review Subagent MVP

The extension supports an independent read-only review subagent:

```text
/dev-review-subagent
/dev-subagent-status
```

It creates:

```text
.dev-agent/subagents/review-<timestamp>/
  INPUT.md
  OUTPUT.md
  STATUS.json
  agent.log
```

The review subagent runs in a detached screen session with a fresh Pi `--no-session` invocation and read-only-style tools:

```text
read,bash,grep,find,ls
```

It receives a compact context pack in `INPUT.md` instead of inheriting the main conversation. This avoids review context pollution and keeps stable project context in files for better cache behavior. The subagent writes its review to `OUTPUT.md`; the main agent can then decide whether to copy or incorporate it into the official phase `REVIEW.md`.

## Safe Experiment Monitor Subagent

The extension also registers a model-callable tool named `dev_experiment_run`.

This is a safe, narrow subagent pattern for experiments:

- starts one or more read-only/non-source-mutating experiment commands in detached screen jobs
- starts a separate monitor screen session
- polls job status until completion or timeout
- writes `.dev-agent/runs/<run-id>/SUMMARY.md`
- writes `.dev-agent/runs/<run-id>/PROGRESS.md`
- includes failed job log tails in the summary
- records monitor-side progress every 10% by default when a timeout is configured, including elapsed time and estimated remaining time; with no timeout, records periodic runtime checkpoints and ETA as unknown
- writes only under `.dev-agent/runs/<run-id>/`
- does not edit source code, repair failures, commit, or push

Use it when the main agent should continue safe implementation work while long experiments run in the background.

Check experiment state with:

```text
/dev-experiment-status
/dev-experiment-status <run-id>
```

The main agent should later read `SUMMARY.md` and `PROGRESS.md`, then incorporate the result into `DEVLOG.md`, `VERIFY.md`, or the phase report.

For optimization/experiment CLIs that know the true amount of work (dates, actions, windows, shards), prefer real progress reporting every 10% of completed tasks. Each progress log should include current runtime and estimated remaining time. The monitor-side `PROGRESS.md` is a fallback; by default experiments have no timeout, so fallback ETA is `unknown` unless `timeout_seconds` is explicitly set.

Experiment ledger:

```text
.dev-agent/EXPERIMENTS.md
```

This ledger records each launched screen/experiment run, basic job status, exit code, session, log path, monitor status, and summary path. It is refreshed automatically when screen/experiment status commands run and can be refreshed manually with `/dev-experiments`.

## Lossless Speed Pass Before Full Experiments

Before running a full expensive experiment, the agent should do one explicit lossless speed pass. The goal is to reduce wall-clock time without changing research results or semantics.

Safe options to consider:

- reuse existing prepared/local snapshot caches after metadata compatibility checks
- avoid duplicated data loading or duplicated QP setup work
- split independent actions/windows into parallel workers when outputs are deterministic and isolated
- use `dev_screen_run`/screen for independent validation shards
- use `dev_experiment_run` for long read-only experiments that should produce an automatic `SUMMARY.md` while the main agent continues work
- add CLI flags such as `--workers`, `--reuse-existing`, or `--resume` only when they preserve output semantics
- record cache references, worker counts, shard layout, and commands in metadata

Do not apply speedups that change numerical results, alter random seeds, skip validation, relax constraints, change date/action coverage, hide failures, or make stale caches acceptable.

## Safety Behavior

The extension blocks:

- `rm -rf /` and similar destructive commands
- `git reset --hard`
- `git clean ...`
- force push
- reading `.env` via obvious shell commands
- writes/edits to `.env`, `.git/`, `node_modules/`, `.venv/`, `venv/`

During discussion/planning states, write/edit tools are restricted to `.dev-agent/` only.

## Typical Flow

```text
/dev-start Build feature X
/dev-discuss
/dev-plan
# user approves master plan
/dev-next
# user approves phase plan
/dev-run
/dev-verify
/dev-review
/dev-accept
/dev-ship
/dev-next
...
/dev-finalize
```
