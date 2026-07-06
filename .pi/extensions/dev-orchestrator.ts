import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEV_DIR = ".dev-agent";
const STATE_FILE = "STATE.json";

const STATUS = {
	UNINITIALIZED: "uninitialized",
	DISCUSSING: "discussing",
	PLANNING: "planning",
	AWAITING_MASTER_APPROVAL: "awaiting_master_plan_approval",
	PHASE_PLANNING: "phase_planning",
	AWAITING_PHASE_APPROVAL: "awaiting_phase_plan_approval",
	EXECUTING: "executing",
	BLOCKED: "blocked",
	VERIFYING: "verifying",
	AWAITING_ACCEPTANCE: "awaiting_user_acceptance",
	READY_TO_SHIP: "ready_to_ship",
	SHIPPING: "shipping",
	COMPLETE: "complete",
} as const;

type DevStatus = (typeof STATUS)[keyof typeof STATUS];

interface DevState {
	schema_version: 1;
	project: string;
	goal_id: string;
	status: DevStatus;
	current_phase: number;
	branch: string | null;
	last_commit: string | null;
	blocked: boolean;
	blocking_reason: string | null;
	accepted_phases: number[];
	pending_artifacts: string[];
	next_action: string;
	updated_at: string;
}

const STOP_CONDITIONS = [
	"Requirements conflict or acceptance criteria are unclear.",
	"The implementation path would break a public API or existing user workflow.",
	"A new large dependency is required.",
	"Large deletion or broad refactor is needed outside the current phase scope.",
	"Tests fail for unclear reasons and fixing them would change the design.",
	"A key assumption in MASTER_PLAN.md is false.",
	"The original user goal must change to complete the work.",
	"The task touches secrets, credentials, permissions, data deletion, or remote execution.",
	"The planned file/module scope is exceeded.",
	"There are multiple reasonable designs with meaningful trade-offs.",
];

const DANGEROUS_BASH_PATTERNS = [
	/rm\s+-rf\s+\//,
	/rm\s+-rf\s+\./,
	/git\s+reset\s+--hard/,
	/git\s+clean\s+-/,
	/git\s+push\b.*--force/,
	/git\s+push\b.*-f\b/,
	/cat\s+\.env\b/,
	/cp\s+\.env\b/,
	/mv\s+\.env\b/,
];

const PROTECTED_WRITE_PATHS = [".env", ".git/", "node_modules/", ".venv/", "venv/"];

function now(): string {
	return new Date().toISOString();
}

function devRoot(cwd: string): string {
	return join(cwd, DEV_DIR);
}

function statePath(cwd: string): string {
	return join(devRoot(cwd), STATE_FILE);
}

function phaseDir(cwd: string, phase: number): string {
	return join(devRoot(cwd), "phases", `phase-${String(phase).padStart(3, "0")}`);
}

function projectName(cwd: string): string {
	return basename(cwd) || "project";
}

function defaultState(cwd: string): DevState {
	return {
		schema_version: 1,
		project: projectName(cwd),
		goal_id: `dev-agent-${randomUUID().slice(0, 8)}`,
		status: STATUS.UNINITIALIZED,
		current_phase: 0,
		branch: null,
		last_commit: null,
		blocked: false,
		blocking_reason: null,
		accepted_phases: [],
		pending_artifacts: [],
		next_action: "start",
		updated_at: now(),
	};
}

async function readText(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

async function readState(cwd: string): Promise<DevState> {
	const raw = await readText(statePath(cwd));
	if (!raw) return defaultState(cwd);
	try {
		return { ...defaultState(cwd), ...(JSON.parse(raw) as Partial<DevState>) };
	} catch {
		return defaultState(cwd);
	}
}

async function writeState(cwd: string, patch: Partial<DevState>): Promise<DevState> {
	await mkdir(devRoot(cwd), { recursive: true });
	const state = { ...(await readState(cwd)), ...patch, updated_at: now() };
	await writeFile(statePath(cwd), `${JSON.stringify(state, null, 2)}\n`, "utf8");
	return state;
}

async function writeIfMissing(path: string, content: string): Promise<void> {
	if (existsSync(path)) return;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
}

function rel(cwd: string, path: string): string {
	return relative(cwd, path) || ".";
}

function phaseRel(phase: number, file: string): string {
	return `${DEV_DIR}/phases/phase-${String(phase).padStart(3, "0")}/${file}`;
}

function runsDir(cwd: string): string {
	return join(devRoot(cwd), "runs");
}

function subagentsDir(cwd: string): string {
	return join(devRoot(cwd), "subagents");
}

function experimentsLedgerPath(cwd: string): string {
	return join(devRoot(cwd), "EXPERIMENTS.md");
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function safeScreenName(value: string): string {
	return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 70) || "job";
}

interface ScreenJobSpec {
	name: string;
	command: string;
	cwd?: string;
}

interface ScreenJobRecord extends ScreenJobSpec {
	session: string;
	log_path: string;
	exit_code_path: string;
	status_path: string;
	started_at: string;
}

interface ExperimentRunOptions {
	name?: string;
	jobs: ScreenJobSpec[];
	poll_interval_seconds?: number;
	timeout_seconds?: number;
	tail_lines_on_failure?: number;
	progress_interval_percent?: number;
}

interface SubagentRecord {
	run_id: string;
	role: string;
	status: string;
	started_at: string;
	finished_at: string | null;
	input_path: string;
	output_path: string;
	log_path: string;
	session: string;
	exit_code: number | null;
	tools: string[];
}

async function screenSessions(): Promise<Set<string>> {
	try {
		const { stdout } = await execFileAsync("screen", ["-ls"], { timeout: 5000 });
		return new Set(
			stdout
				.split("\n")
				.map((line) => line.match(/\t\d+\.([^\s]+)/)?.[1])
				.filter((name): name is string => Boolean(name)),
		);
	} catch {
		return new Set();
	}
}

async function launchScreenBatch(cwd: string, jobs: ScreenJobSpec[]): Promise<{
	run_id: string;
	run_dir: string;
	jobs: ScreenJobRecord[];
}> {
	if (jobs.length === 0) {
		throw new Error("At least one command is required.");
	}
	const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
	const runDir = join(runsDir(cwd), runId);
	await mkdir(runDir, { recursive: true });
	const records: ScreenJobRecord[] = [];

	for (const [index, job] of jobs.entries()) {
		const name = safeScreenName(job.name || `job-${index + 1}`);
		const session = safeScreenName(`dev-${projectName(cwd)}-${runId}-${index + 1}-${name}`);
		const logPath = join(runDir, `${String(index + 1).padStart(2, "0")}-${name}.log`);
		const exitPath = join(runDir, `${String(index + 1).padStart(2, "0")}-${name}.exitcode`);
		const statusPath = join(runDir, `${String(index + 1).padStart(2, "0")}-${name}.status`);
		const jobCwd = resolve(cwd, job.cwd ?? ".");
		const script = [
			"set +e",
			`cd ${shellQuote(jobCwd)}`,
			`printf 'running\\n' > ${shellQuote(statusPath)}`,
			`{ ${job.command}; } > ${shellQuote(logPath)} 2>&1`,
			"code=$?",
			`printf '%s\\n' "$code" > ${shellQuote(exitPath)}`,
			`if [ "$code" -eq 0 ]; then printf 'passed\\n' > ${shellQuote(statusPath)}; else printf 'failed\\n' > ${shellQuote(statusPath)}; fi`,
			"exit $code",
		].join("; ");
		await writeFile(statusPath, "starting\n", "utf8");
		await execFileAsync("screen", ["-dmS", session, "bash", "-lc", script], { timeout: 5000 });
		records.push({
			...job,
			name,
			cwd: jobCwd,
			session,
			log_path: rel(cwd, logPath),
			exit_code_path: rel(cwd, exitPath),
			status_path: rel(cwd, statusPath),
			started_at: now(),
		});
	}

	await writeFile(
		join(runDir, "jobs.json"),
		`${JSON.stringify({ run_id: runId, created_at: now(), jobs: records }, null, 2)}\n`,
		"utf8",
	);
	await refreshExperimentsLedger(cwd);
	return { run_id: runId, run_dir: rel(cwd, runDir), jobs: records };
}

async function summarizeScreenRuns(cwd: string, runId?: string): Promise<string> {
	await refreshExperimentsLedger(cwd);
	const root = runsDir(cwd);
	if (!existsSync(root)) return `No ${DEV_DIR}/runs directory found.`;
	const runIds = runId ? [runId] : (await readdir(root)).sort().slice(-5);
	const active = await screenSessions();
	const lines: string[] = [];
	for (const id of runIds) {
		const jobsPath = join(root, id, "jobs.json");
		const raw = await readText(jobsPath);
		if (!raw) continue;
		const payload = JSON.parse(raw) as { jobs?: ScreenJobRecord[]; experiment?: { name?: string; monitor_session?: string } };
		lines.push(`Run ${id}${payload.experiment?.name ? ` (${payload.experiment.name})` : ""}:`);
		if (payload.experiment?.monitor_session) {
			lines.push(`  monitor=${active.has(payload.experiment.monitor_session) ? "running" : "stopped"}; session=${payload.experiment.monitor_session}`);
		}
		for (const job of payload.jobs ?? []) {
			const status = ((await readText(resolve(cwd, job.status_path))) ?? "unknown").trim();
			const exitCode = ((await readText(resolve(cwd, job.exit_code_path))) ?? "").trim();
			const running = active.has(job.session);
			lines.push(
				`- ${job.name}: ${running ? "running" : status || "unknown"}${exitCode ? ` (exit ${exitCode})` : ""}; log=${job.log_path}; session=${job.session}`,
			);
		}
		const summaryPath = join(root, id, "SUMMARY.md");
		if (existsSync(summaryPath)) lines.push(`  summary=${rel(cwd, summaryPath)}`);
	}
	return lines.length > 0 ? lines.join("\n") : "No matching screen runs found.";
}

async function refreshExperimentsLedger(cwd: string): Promise<string> {
	const root = runsDir(cwd);
	await mkdir(devRoot(cwd), { recursive: true });
	const active = await screenSessions();
	const lines = [
		"# Experiments",
		"",
		"This file is maintained by the Dev Orchestrator. It records launched screen/experiment runs and should be refreshed when run status changes.",
		"",
		`Last refreshed: ${now()}`,
		"",
	];
	if (!existsSync(root)) {
		lines.push("No experiment runs recorded yet.", "");
		await writeFile(experimentsLedgerPath(cwd), lines.join("\n"), "utf8");
		return experimentsLedgerPath(cwd);
	}
	const runIds = (await readdir(root)).sort();
	if (runIds.length === 0) {
		lines.push("No experiment runs recorded yet.", "");
		await writeFile(experimentsLedgerPath(cwd), lines.join("\n"), "utf8");
		return experimentsLedgerPath(cwd);
	}
	for (const id of runIds) {
		const jobsPath = join(root, id, "jobs.json");
		const raw = await readText(jobsPath);
		if (!raw) continue;
		let payload: {
			created_at?: string;
			jobs?: ScreenJobRecord[];
			experiment?: { name?: string; monitor_session?: string; summary_path?: string; timeout_seconds?: number };
		};
		try {
			payload = JSON.parse(raw) as typeof payload;
		} catch (error) {
			lines.push(`## ${id}`, "", `- jobs_json: ${rel(cwd, jobsPath)}`, `- status: invalid jobs.json (${String(error)})`, "");
			continue;
		}
		lines.push(`## ${id}${payload.experiment?.name ? ` — ${payload.experiment.name}` : ""}`, "");
		lines.push(`- created_at: ${payload.created_at ?? "unknown"}`);
		if (payload.experiment?.monitor_session) {
			lines.push(`- monitor: ${active.has(payload.experiment.monitor_session) ? "running" : "stopped"} (${payload.experiment.monitor_session})`);
		}
		if (payload.experiment?.timeout_seconds !== undefined) {
			lines.push(`- timeout_seconds: ${payload.experiment.timeout_seconds}`);
		}
		const summary = payload.experiment?.summary_path ?? rel(cwd, join(root, id, "SUMMARY.md"));
		if (existsSync(resolve(cwd, summary))) lines.push(`- summary: ${summary}`);
		lines.push("", "| Job | Status | Exit | Session | Log |", "|---|---|---:|---|---|");
		for (const job of payload.jobs ?? []) {
			const status = ((await readText(resolve(cwd, job.status_path))) ?? "unknown").trim();
			const exitCode = ((await readText(resolve(cwd, job.exit_code_path))) ?? "").trim();
			const running = active.has(job.session);
			lines.push(
				`| ${job.name} | ${running ? "running" : status || "unknown"} | ${exitCode || ""} | ${job.session} | ${job.log_path} |`,
			);
		}
		lines.push("");
	}
	await writeFile(experimentsLedgerPath(cwd), `${lines.join("\n")}\n`, "utf8");
	return experimentsLedgerPath(cwd);
}

async function launchExperimentRun(cwd: string, options: ExperimentRunOptions): Promise<{
	run_id: string;
	run_dir: string;
	monitor_session: string;
	summary_path: string;
	jobs: ScreenJobRecord[];
}> {
	const result = await launchScreenBatch(cwd, options.jobs);
	const absoluteRunDir = resolve(cwd, result.run_dir);
	const safeName = safeScreenName(options.name ?? "experiment");
	const monitorSession = safeScreenName(`dev-${projectName(cwd)}-${result.run_id}-monitor-${safeName}`);
	const poll = Math.max(1, Math.floor(options.poll_interval_seconds ?? 10));
	const requestedTimeout = Math.floor(options.timeout_seconds ?? 0);
	const timeout = requestedTimeout > 0 ? Math.max(poll, requestedTimeout) : 0;
	const tailLines = Math.max(20, Math.floor(options.tail_lines_on_failure ?? 120));
	const progressInterval = Math.min(100, Math.max(1, Math.floor(options.progress_interval_percent ?? 10)));
	const summaryPath = join(absoluteRunDir, "SUMMARY.md");
	const progressPath = join(absoluteRunDir, "PROGRESS.md");
	const monitorLogPath = join(absoluteRunDir, "monitor.log");
	const monitorScriptPath = join(absoluteRunDir, "monitor.sh");
	const jobsJsonPath = join(absoluteRunDir, "jobs.json");
	const jobList = result.jobs
		.map((job) => `${shellQuote(job.name)}:${shellQuote(resolve(cwd, job.status_path))}:${shellQuote(resolve(cwd, job.exit_code_path))}:${shellQuote(resolve(cwd, job.log_path))}`)
		.join(" ");
	const script = `#!/usr/bin/env bash
set +e
run_id=${shellQuote(result.run_id)}
summary=${shellQuote(summaryPath)}
jobs_json=${shellQuote(jobsJsonPath)}
poll=${poll}
timeout=${timeout}
tail_lines=${tailLines}
progress=${shellQuote(progressPath)}
progress_interval=${progressInterval}
next_progress=$progress_interval
start=$(date +%s)
status="running"
{
  echo "# Experiment Progress"
  echo
  echo "- run_id: $run_id"
  echo "- started_at: $(date -Iseconds)"
  echo "- progress_interval_percent: $progress_interval"
  echo
  echo "| Progress | Elapsed | ETA | Status |"
  echo "|---:|---:|---:|---|"
} > "$progress"
while true; do
  all_done=1
  for item in ${jobList}; do
    IFS=':' read -r name status_path exit_path log_path <<< "$item"
    s="unknown"
    [ -f "$status_path" ] && s=$(cat "$status_path")
    if [ "$s" = "starting" ] || [ "$s" = "running" ]; then all_done=0; fi
  done
  now=$(date +%s)
  elapsed=$((now - start))
  if [ "$timeout" -gt 0 ]; then
    percent=$(( elapsed * 100 / timeout ))
    if [ "$percent" -ge "$next_progress" ]; then
      eta=$(( timeout - elapsed ))
      if [ "$eta" -lt 0 ]; then eta=0; fi
      echo "| ${next_progress}% | ${elapsed}s | ${eta}s | running |" >> "$progress"
      next_progress=$(( next_progress + progress_interval ))
    fi
  elif [ "$elapsed" -ge "$next_progress" ]; then
    echo "| runtime | ${elapsed}s | unknown | running |" >> "$progress"
    next_progress=$(( next_progress + progress_interval ))
  fi
  if [ "$all_done" -eq 1 ]; then status="complete"; break; fi
  if [ "$timeout" -gt 0 ] && [ "$elapsed" -ge "$timeout" ]; then status="timeout"; break; fi
  sleep "$poll"
done
finished=$(date +%s)
elapsed=$((finished - start))
echo "| 100% | ${elapsed}s | 0s | $status |" >> "$progress"
{
  echo "# Experiment Run Summary"
  echo
  echo "- run_id: $run_id"
  echo "- status: $status"
  echo "- finished_at: $(date -Iseconds)"
  echo "- jobs_json: ${rel(cwd, jobsJsonPath)}"
  echo "- progress: ${rel(cwd, progressPath)}"
  echo
  echo "## Jobs"
  echo
  echo "| Job | Status | Exit | Log |"
  echo "|---|---|---:|---|"
  for item in ${jobList}; do
    IFS=':' read -r name status_path exit_path log_path <<< "$item"
    s="unknown"; [ -f "$status_path" ] && s=$(cat "$status_path")
    code=""; [ -f "$exit_path" ] && code=$(cat "$exit_path")
    echo "| $name | $s | \${code:-} | $log_path |"
  done
  echo
  echo "## Failure Log Tails"
  echo
  any_fail=0
  for item in ${jobList}; do
    IFS=':' read -r name status_path exit_path log_path <<< "$item"
    code=""; [ -f "$exit_path" ] && code=$(cat "$exit_path")
    if [ -n "$code" ] && [ "$code" != "0" ]; then
      any_fail=1
      echo "### $name"
      echo
      echo '\`\`\`text'
      tail -n "$tail_lines" "$log_path" 2>/dev/null
      echo '\`\`\`'
      echo
    fi
  done
  if [ "$any_fail" -eq 0 ]; then echo "No failed jobs with non-zero exit codes."; fi
} > "$summary"
`;
	await writeFile(monitorScriptPath, script, "utf8");
	const raw = await readText(jobsJsonPath);
	const payload = raw ? JSON.parse(raw) : { run_id: result.run_id, jobs: result.jobs };
	payload.experiment = {
		name: options.name ?? "experiment",
		monitor_session: monitorSession,
		poll_interval_seconds: poll,
		timeout_seconds: timeout,
		tail_lines_on_failure: tailLines,
		progress_interval_percent: progressInterval,
		summary_path: rel(cwd, summaryPath),
		progress_path: rel(cwd, progressPath),
		monitor_log_path: rel(cwd, monitorLogPath),
	};
	await writeFile(jobsJsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	await execFileAsync("screen", ["-dmS", monitorSession, "bash", "-lc", `bash ${shellQuote(monitorScriptPath)} > ${shellQuote(monitorLogPath)} 2>&1`], { timeout: 5000 });
	await refreshExperimentsLedger(cwd);
	return {
		run_id: result.run_id,
		run_dir: result.run_dir,
		monitor_session: monitorSession,
		summary_path: rel(cwd, summaryPath),
		jobs: result.jobs,
	};
}

async function createReviewSubagentInput(cwd: string, phase: number): Promise<string> {
	const dir = join(subagentsDir(cwd), `review-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
	await mkdir(dir, { recursive: true });
	const inputPath = join(dir, "INPUT.md");
	const diffStat = await execFileAsync("git", ["diff", "--stat"], { cwd }).then((r) => r.stdout).catch((error) => String(error));
	const diffNameOnly = await execFileAsync("git", ["diff", "--name-only"], { cwd }).then((r) => r.stdout).catch(() => "");
	const status = await execFileAsync("git", ["status", "--short"], { cwd }).then((r) => r.stdout).catch(() => "");
	const content = `# Review Subagent Input\n\n## Role\n\nYou are an independent read-only Review Agent. Review the current phase implementation against the phase plan and acceptance criteria. Do not modify source code. Do not commit or push.\n\n## Output Contract\n\nWrite your review in Markdown to stdout. Use this structure:\n\n- Verdict: ACCEPT, ACCEPT_WITH_NOTES, REQUEST_CHANGES, or BLOCKED\n- Blocking findings\n- Non-blocking notes\n- Standards/architecture assessment\n- Spec/acceptance assessment\n- Recommended follow-up\n\n## Inputs To Read\n\nRead these files from the project root as needed:\n\n- .dev-agent/GOAL.md\n- .dev-agent/CONTEXT.md\n- .dev-agent/MASTER_PLAN.md\n- .dev-agent/ACCEPTANCE.md\n- .dev-agent/phases/phase-${String(phase).padStart(3, "0")}/PLAN.md\n- .dev-agent/phases/phase-${String(phase).padStart(3, "0")}/DEVLOG.md\n- .dev-agent/phases/phase-${String(phase).padStart(3, "0")}/VERIFY.md\n- src/portfolio_opt/gamma_baselines.py\n- demo/evaluate_gamma_baselines.py\n- tests/test_gamma_baselines.py\n- tests/test_gamma_baselines_cli.py\n\n## Review Focus\n\n1. Does the implementation satisfy the phase plan?\n2. Does it preserve no-lookahead and train-only selection discipline?\n3. Does it stay within Phase ${phase} scope?\n4. Does it avoid replacing the backtest engine or changing the frozen protocol?\n5. Are tests sufficient for the behavior claimed?\n6. Are there any risks before user acceptance or Phase 5?\n\n## Current Git Status\n\n\`\`\`text\n${status.slice(0, 8000)}\n\`\`\`\n\n## Diff Stat\n\n\`\`\`text\n${diffStat.slice(0, 8000)}\n\`\`\`\n\n## Diff Files\n\n\`\`\`text\n${diffNameOnly.slice(0, 8000)}\n\`\`\`\n`;
	await writeFile(inputPath, content, "utf8");
	return dir;
}

async function launchReviewSubagent(cwd: string, phase: number): Promise<SubagentRecord> {
	const dir = await createReviewSubagentInput(cwd, phase);
	const runId = basename(dir);
	const inputPath = join(dir, "INPUT.md");
	const outputPath = join(dir, "OUTPUT.md");
	const logPath = join(dir, "agent.log");
	const statusPath = join(dir, "STATUS.json");
	const session = safeScreenName(`sub-${runId}`);
	const record: SubagentRecord = {
		run_id: runId,
		role: "review",
		status: "running",
		started_at: now(),
		finished_at: null,
		input_path: rel(cwd, inputPath),
		output_path: rel(cwd, outputPath),
		log_path: rel(cwd, logPath),
		session,
		exit_code: null,
		tools: ["read", "bash", "grep", "find", "ls"],
	};
	await writeFile(statusPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
	const command = [
		`cd ${shellQuote(cwd)}`,
		`pi --no-session --no-prompt-templates --tools read,bash,grep,find,ls -p @${shellQuote(rel(cwd, inputPath))} > ${shellQuote(outputPath)} 2> ${shellQuote(logPath)}`,
		"code=$?",
		`CODE="$code" python - <<'PY'\nimport json\nimport os\nfrom pathlib import Path\np=Path(${JSON.stringify(statusPath)})\ndata=json.loads(p.read_text())\ncode=int(os.environ.get('CODE', '1'))\ndata['status']='complete' if code == 0 else 'failed'\ndata['exit_code']=code\nfrom datetime import datetime, timezone\ndata['finished_at']=datetime.now(timezone.utc).isoformat()\np.write_text(json.dumps(data, indent=2)+'\\n')\nPY`,
		"exit $code",
	].join("; ");
	await execFileAsync("screen", ["-dmS", session, "bash", "-lc", command], { timeout: 5000 });
	return record;
}

async function summarizeSubagents(cwd: string): Promise<string> {
	const root = subagentsDir(cwd);
	if (!existsSync(root)) return `No ${DEV_DIR}/subagents directory found.`;
	const active = await screenSessions();
	const lines: string[] = [];
	for (const name of (await readdir(root)).sort().slice(-10)) {
		const statusPath = join(root, name, "STATUS.json");
		const raw = await readText(statusPath);
		if (!raw) continue;
		const record = JSON.parse(raw) as SubagentRecord;
		lines.push(
			`- ${record.run_id}: role=${record.role}; status=${active.has(record.session) ? "running" : record.status}; exit=${record.exit_code ?? ""}; output=${record.output_path}; log=${record.log_path}`,
		);
	}
	return lines.length > 0 ? lines.join("\n") : "No subagent runs found.";
}

async function ensureScaffold(cwd: string, goal?: string): Promise<DevState> {
	const root = devRoot(cwd);
	await mkdir(join(root, "phases"), { recursive: true });
	await mkdir(join(root, "final"), { recursive: true });

	await writeIfMissing(
		join(root, "README.md"),
		`# Dev Agent Memory\n\nThis directory is maintained by Pi's Dev Orchestrator extension. It is project-local long-term memory for phased development.\n\nThe extension itself lives outside the project, under /root/pi, but this directory belongs to the current project.\n`,
	);
	await writeIfMissing(
		join(root, "GOAL.md"),
		`# Goal\n\n${goal?.trim() || "TBD"}\n\n## Notes\n\n- This goal should be stable. Update it only when the user explicitly changes the target.\n`,
	);
	await writeIfMissing(
		join(root, "CONTEXT.md"),
		`# Context\n\n## Stable Project Facts\n\nTBD.\n\n## Commands\n\nTBD.\n\n## Constraints\n\nTBD.\n\n## Lessons Learned\n\nTBD.\n`,
	);
	await writeIfMissing(
		join(root, "MASTER_PLAN.md"),
		`# Master Plan\n\n## Final Goal\n\nTBD.\n\n## Non-goals\n\nTBD.\n\n## Requirements\n\nTBD.\n\n## Acceptance Criteria\n\nTBD.\n\n## Risks\n\nTBD.\n\n## Assumptions\n\nTBD.\n\n## Phases\n\nTBD.\n\n## Current Status\n\nTBD.\n\n## Change Log\n\nTBD.\n`,
	);
	await writeIfMissing(join(root, "ACCEPTANCE.md"), `# Acceptance Criteria\n\nTBD.\n`);
	await writeIfMissing(join(root, "RISKS.md"), `# Risks\n\nTBD.\n`);
	await writeIfMissing(join(root, "DECISIONS.md"), `# Decisions\n\nTBD.\n`);
	await writeIfMissing(join(root, "OPEN_QUESTIONS.md"), `# Open Questions\n\nTBD.\n`);
	await writeIfMissing(
		join(root, "EXPERIMENTS.md"),
		`# Experiments\n\nThis file is maintained by the Dev Orchestrator. It records launched screen/experiment runs and should be refreshed when run status changes.\n`,
	);
	await writeIfMissing(
		join(root, "STOP_CONDITIONS.md"),
		`# Stop Conditions\n\nIf any of these conditions is hit, stop implementation, write the current phase ISSUE.md, and ask the user before continuing.\n\n${STOP_CONDITIONS.map((condition, index) => `${index + 1}. ${condition}`).join("\n")}\n`,
	);

	const existing = await readState(cwd);
	if (existing.status === STATUS.UNINITIALIZED) {
		return writeState(cwd, {
			status: goal ? STATUS.DISCUSSING : STATUS.UNINITIALIZED,
			next_action: goal ? "dev-discuss" : "dev-start <goal>",
		});
	}
	return existing;
}

async function ensurePhaseFiles(cwd: string, phase: number): Promise<void> {
	const dir = phaseDir(cwd, phase);
	await mkdir(dir, { recursive: true });
	await writeIfMissing(
		join(dir, "PLAN.md"),
		`# Phase ${phase} Plan\n\n## Objective\n\nTBD.\n\n## Inputs\n\n- ${DEV_DIR}/GOAL.md\n- ${DEV_DIR}/CONTEXT.md\n- ${DEV_DIR}/MASTER_PLAN.md\n\n## Scope\n\nTBD.\n\n## Out of Scope\n\nTBD.\n\n## Files Likely To Change\n\nTBD.\n\n## Implementation Steps\n\nTBD.\n\n## Validation Commands\n\nTBD.\n\n## Stop Conditions\n\nUse ${DEV_DIR}/STOP_CONDITIONS.md plus any phase-specific stop conditions.\n\n## Done Criteria\n\nTBD.\n`,
	);
	await writeIfMissing(join(dir, "DEVLOG.md"), `# Phase ${phase} Dev Log\n\nTBD.\n`);
	await writeIfMissing(join(dir, "VERIFY.md"), `# Phase ${phase} Verification\n\nTBD.\n`);
	await writeIfMissing(join(dir, "REVIEW.md"), `# Phase ${phase} Review\n\nTBD.\n`);
	await writeIfMissing(join(dir, "RESULT.md"), `# Phase ${phase} Result\n\nTBD.\n`);
	await writeIfMissing(join(dir, "ISSUE.md"), `# Phase ${phase} Issue\n\nNo blocking issue recorded.\n`);
}

async function readMemorySummary(cwd: string): Promise<string> {
	const files = [
		"GOAL.md",
		"CONTEXT.md",
		"MASTER_PLAN.md",
		"ACCEPTANCE.md",
		"RISKS.md",
		"OPEN_QUESTIONS.md",
		"STOP_CONDITIONS.md",
		"EXPERIMENTS.md",
	];
	const parts: string[] = [];
	for (const file of files) {
		const text = await readText(join(devRoot(cwd), file));
		if (text) parts.push(`## ${DEV_DIR}/${file}\n\n${text.slice(0, 6000)}`);
	}
	return parts.join("\n\n---\n\n");
}

async function readPhasePlan(cwd: string, phase: number): Promise<string> {
	return (await readText(join(phaseDir(cwd, phase), "PLAN.md"))) ?? "No phase plan found.";
}

function sendOrNotify(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): void {
	if (!ctx.isIdle()) {
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		ctx.ui.notify("Dev Orchestrator prompt queued as follow-up.", "info");
		return;
	}
	pi.sendUserMessage(prompt);
}

function setStatusLine(ctx: ExtensionContext, state: DevState): void {
	ctx.ui.setStatus("dev-agent", `dev:${state.current_phase || "-"}:${state.status}`);
}

function isInside(parent: string, child: string): boolean {
	const p = resolve(parent);
	const c = resolve(child);
	return c === p || c.startsWith(`${p}/`);
}

async function notifyState(ctx: ExtensionContext): Promise<void> {
	const state = await readState(ctx.cwd);
	setStatusLine(ctx, state);
	ctx.ui.notify(
		`Dev Agent\nproject: ${state.project}\nphase: ${state.current_phase}\nstatus: ${state.status}\nnext: ${state.next_action}`,
		"info",
	);
}

function discussionPrompt(goalArg: string): string {
	return `You are the Dev Orchestrator discussion agent.\n\nYour job is to clarify the goal, expose ambiguity, identify risks, and update project-local long-term memory under ${DEV_DIR}/.\n\nDo not implement code. Do not edit production/source files.\n\nUser goal/context:\n${goalArg || "Use the existing .dev-agent/GOAL.md."}\n\nSteps:\n1. Read ${DEV_DIR}/GOAL.md, ${DEV_DIR}/CONTEXT.md, ${DEV_DIR}/OPEN_QUESTIONS.md if present.\n2. Ask concise but sharp questions grouped as:\n   - Must Answer\n   - Can Default\n   - Later\n3. Update ${DEV_DIR}/OPEN_QUESTIONS.md with the questions and any answers already known.\n4. If enough information is already available, say so and recommend /dev-plan.\n\nRemember: discussion only; no implementation.`;
}

function masterPlanPrompt(): string {
	return `You are the Dev Orchestrator planning agent.\n\nGenerate/update the project-local planning documents under ${DEV_DIR}/.\n\nRead first:\n- ${DEV_DIR}/GOAL.md\n- ${DEV_DIR}/CONTEXT.md\n- ${DEV_DIR}/OPEN_QUESTIONS.md\n- existing project docs such as AGENTS.md/README.md when useful\n\nWrite/update:\n- ${DEV_DIR}/CONTEXT.md\n- ${DEV_DIR}/MASTER_PLAN.md\n- ${DEV_DIR}/ACCEPTANCE.md\n- ${DEV_DIR}/RISKS.md\n- ${DEV_DIR}/DECISIONS.md if any decisions are established\n\nMASTER_PLAN.md must include:\n- Final Goal\n- Non-goals\n- Current Project Context\n- Requirements\n- Acceptance Criteria\n- Risks\n- Assumptions\n- Phases\n- Current Status\n- Change Log\n\nRules:\n- Do not implement code.\n- Do not assume unresolved must-answer questions are resolved.\n- Keep phases outcome-oriented, not function-by-function micromanagement.\n- End by asking the user to approve the master plan or request changes.`;
}

function phasePlanPrompt(phase: number): string {
	return `You are the Dev Orchestrator phase planning agent.\n\nCreate/update ${phaseRel(phase, "PLAN.md")} for phase ${phase}.\n\nRead:\n- ${DEV_DIR}/GOAL.md\n- ${DEV_DIR}/CONTEXT.md\n- ${DEV_DIR}/MASTER_PLAN.md\n- ${DEV_DIR}/ACCEPTANCE.md\n- ${DEV_DIR}/RISKS.md\n- ${DEV_DIR}/STOP_CONDITIONS.md\n\nThe phase plan must include:\n- Objective\n- Inputs\n- Scope\n- Out of Scope\n- Files Likely To Change\n- Implementation Steps\n- Validation Commands\n- Expected Artifacts\n- Stop Conditions\n- Done Criteria\n\nRules:\n- Do not implement code.\n- Keep this phase small and independently verifiable.\n- Make validation commands concrete for this repo.\n- End by asking the user to approve the phase plan or request changes.`;
}

function executePrompt(phase: number): string {
	return `You are the Dev Orchestrator execution agent for phase ${phase}.\n\nBefore editing, read:\n- ${DEV_DIR}/GOAL.md\n- ${DEV_DIR}/CONTEXT.md\n- ${DEV_DIR}/MASTER_PLAN.md\n- ${DEV_DIR}/ACCEPTANCE.md\n- ${DEV_DIR}/STOP_CONDITIONS.md\n- ${phaseRel(phase, "PLAN.md")}\n\nImplement only phase ${phase}.\n\nRules:\n1. Stay within the phase scope.\n2. Keep changes minimal and local.\n3. Do not change requirements or master plan assumptions while executing.\n4. If a stop condition is triggered, stop, write ${phaseRel(phase, "ISSUE.md")}, summarize the issue, and ask the user.\n5. Run the validation commands from the phase plan when practical.\n6. If multiple validation commands are independent and can safely run concurrently, prefer the dev_screen_run tool to launch them in separate screen sessions. Do not parallelize commands that mutate the same files, depend on each other's outputs, require interactive input, or need exclusive resources.\n7. Before any full expensive experiment, do one explicit lossless speed pass: consider safe cache reuse, deterministic sharding/parallel workers, avoiding duplicate data loads, resume/reuse flags, and screen-managed shards. For long read-only experiments, prefer dev_experiment_run so a monitor writes SUMMARY.md while the main agent can continue safe implementation work. Do not change numerical semantics, random seeds, date/action coverage, constraints, or validation strictness.\n8. Write ${phaseRel(phase, "DEVLOG.md")} with changed files, commands run, screen/experiment run ids and SUMMARY.md paths when used, lossless speed choices when relevant, results, and remaining risks.\n9. Do not commit or push.\n\nAt the end, summarize: changed files, validation run, screen jobs/logs if any, and whether /dev-verify should run next.`;
}

function verifyPrompt(phase: number): string {
	return `You are the Dev Orchestrator verification agent for phase ${phase}.\n\nDo not implement new scope. Minor test-command fixes are okay only if they are clearly local and necessary.\n\nRead:\n- ${phaseRel(phase, "PLAN.md")}\n- ${phaseRel(phase, "DEVLOG.md")}\n- ${DEV_DIR}/ACCEPTANCE.md\n\nCollect and inspect:\n- git status --short\n- git diff --stat\n- git diff\n- validation commands from the phase plan\n\nIf several validation commands are independent, use dev_screen_run to run them in parallel screen sessions, then inspect their logs and exit codes with /dev-screen-status or by reading .dev-agent/runs/<run-id>/.\n\nWrite ${phaseRel(phase, "VERIFY.md")} with:\n- Commands run\n- Results\n- Diff summary\n- Whether done criteria appear satisfied\n- Any blocking/non-blocking issues\n\nDo not commit or push. End with a recommendation: /dev-review or fix first.`;
}

function reviewPrompt(phase: number): string {
	return `You are the Dev Orchestrator reviewer for phase ${phase}.\n\nReview only; do not modify code.\n\nUse a skeptical fresh-context mindset. Compare implementation against:\n- ${DEV_DIR}/GOAL.md\n- ${DEV_DIR}/ACCEPTANCE.md\n- ${phaseRel(phase, "PLAN.md")}\n- ${phaseRel(phase, "VERIFY.md")} if present\n- git diff\n\nCheck:\n1. Correctness\n2. Scope control\n3. Test coverage\n4. Compatibility\n5. Documentation consistency\n6. Hidden risks\n7. Over-engineering\n\nWrite ${phaseRel(phase, "REVIEW.md")} with verdict exactly one of:\n- ACCEPT\n- ACCEPT_WITH_NOTES\n- REQUEST_CHANGES\n- BLOCKED\n\nInclude concrete reasons and required fixes if any. Do not commit or push.`;
}

function acceptPrompt(phase: number): string {
	return `You are the Dev Orchestrator documentation agent for accepting phase ${phase}.\n\nAssume the user has accepted the phase unless they provided revision instructions.\n\nRead:\n- ${phaseRel(phase, "PLAN.md")}\n- ${phaseRel(phase, "DEVLOG.md")}\n- ${phaseRel(phase, "VERIFY.md")}\n- ${phaseRel(phase, "REVIEW.md")}\n- ${DEV_DIR}/MASTER_PLAN.md\n- ${DEV_DIR}/CONTEXT.md\n\nWrite/update:\n- ${phaseRel(phase, "RESULT.md")} with outcome, artifacts, validation, risks, and next recommendations\n- ${DEV_DIR}/MASTER_PLAN.md Current Status and Change Log\n- ${DEV_DIR}/CONTEXT.md with stable new facts only\n- ${DEV_DIR}/DECISIONS.md if decisions were made\n- ${DEV_DIR}/RISKS.md if risks changed\n\nDo not change production code. Do not commit or push. End by saying whether /dev-ship is appropriate.`;
}

function shipPrompt(phase: number): string {
	return `You are the Dev Orchestrator git agent for phase ${phase}.\n\nBefore any commit, check:\n- git status --short\n- git diff --stat\n- ${phaseRel(phase, "REVIEW.md")} has no blocking unresolved issues\n- ${phaseRel(phase, "VERIFY.md")} documents validation\n- no sensitive files are staged (.env, keys, credentials, large data snapshots)\n\nIf checks pass, propose a concise commit message and ask for confirmation before git commit unless the user explicitly requested automatic commit.\n\nDefault: commit only. Do not push unless the user explicitly confirms push.\n\nNever run force push, git reset --hard, or git clean.`;
}

function finalizePrompt(): string {
	return `You are the Dev Orchestrator final documentation agent.\n\nRead all ${DEV_DIR}/ documents and phase results.\n\nWrite/update:\n- ${DEV_DIR}/final/FINAL_REPORT.md\n- ${DEV_DIR}/final/IMPLEMENTATION_SUMMARY.md if useful\n- ${DEV_DIR}/final/USER_GUIDE.md if useful\n\nSummarize:\n- final goal\n- completed phases\n- important decisions\n- validation evidence\n- remaining risks\n- recommended next work\n\nDo not change production code. Do not commit or push.`;
}

export default function devOrchestratorExtension(pi: ExtensionAPI): void {
	pi.registerCommand("dev-start", {
		description: "Initialize project-local .dev-agent memory for a goal",
		handler: async (args, ctx) => {
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /dev-start <goal>", "warning");
				return;
			}
			const state = await ensureScaffold(ctx.cwd, goal);
			setStatusLine(ctx, state);
			ctx.ui.notify(`Initialized ${DEV_DIR}/ in ${ctx.cwd}`, "info");
			sendOrNotify(pi, ctx, discussionPrompt(goal));
		},
	});

	pi.registerCommand("dev-status", {
		description: "Show current Dev Orchestrator project state",
		handler: async (_args, ctx) => {
			await ensureScaffold(ctx.cwd);
			await notifyState(ctx);
		},
	});

	pi.registerCommand("dev-screen-status", {
		description: "Show recent Dev Orchestrator screen-run jobs and log paths",
		handler: async (args, ctx) => {
			const summary = await summarizeScreenRuns(ctx.cwd, args.trim() || undefined);
			ctx.ui.notify(summary, "info");
		},
	});

	pi.registerCommand("dev-experiment-status", {
		description: "Show recent/read-only experiment monitor runs and SUMMARY.md paths",
		handler: async (args, ctx) => {
			const summary = await summarizeScreenRuns(ctx.cwd, args.trim() || undefined);
			ctx.ui.notify(summary, "info");
		},
	});

	pi.registerCommand("dev-experiments", {
		description: "Refresh .dev-agent/EXPERIMENTS.md from recorded screen/experiment runs",
		handler: async (_args, ctx) => {
			const path = await refreshExperimentsLedger(ctx.cwd);
			ctx.ui.notify(`Updated ${rel(ctx.cwd, path)}`, "info");
		},
	});

	pi.registerCommand("dev-review-subagent", {
		description: "Launch an independent read-only review subagent for the current phase",
		handler: async (_args, ctx) => {
			const state = await readState(ctx.cwd);
			if (state.current_phase < 1) {
				ctx.ui.notify("No current phase. Run /dev-next first.", "warning");
				return;
			}
			const record = await launchReviewSubagent(ctx.cwd, state.current_phase);
			ctx.ui.notify(
				`Launched review subagent ${record.run_id}\noutput=${record.output_path}\nstatus=${DEV_DIR}/subagents/${record.run_id}/STATUS.json`,
				"info",
			);
		},
	});

	pi.registerCommand("dev-subagent-status", {
		description: "Show recent Dev Orchestrator subagent runs",
		handler: async (_args, ctx) => {
			ctx.ui.notify(await summarizeSubagents(ctx.cwd), "info");
		},
	});

	pi.registerTool({
		name: "dev_screen_run",
		label: "Dev Screen Run",
		description:
			"Launch independent development/validation commands in parallel GNU screen sessions and record logs under .dev-agent/runs/.",
		promptSnippet: "Run independent validation commands concurrently in screen sessions with project-local logs.",
		promptGuidelines: [
			"Use dev_screen_run only for commands that are independent, non-interactive, and safe to run concurrently.",
			"Do not use dev_screen_run for commands that mutate the same files, depend on each other's outputs, require secrets, or need exclusive resources.",
			"After dev_screen_run, inspect .dev-agent/runs/<run-id>/ status and exit-code files before claiming validation passed; read only log tails unless full logs are necessary.",
		],
		parameters: Type.Object({
			jobs: Type.Array(
				Type.Object({
					name: Type.String({ description: "Short stable job name, e.g. pytest-unit or ruff-touched." }),
					command: Type.String({ description: "Shell command to run from the project root unless cwd is provided." }),
					cwd: Type.Optional(Type.String({ description: "Optional cwd relative to project root." })),
				}),
				{ minItems: 1 },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await launchScreenBatch(ctx.cwd, params.jobs as ScreenJobSpec[]);
			return {
				content: [
					{
						type: "text",
						text: `Launched ${result.jobs.length} screen job(s). Run id: ${result.run_id}\nRun dir: ${result.run_dir}\n\n${result.jobs
							.map((job) => `- ${job.name}: session=${job.session}; log=${job.log_path}; exit=${job.exit_code_path}`)
							.join("\n")}`,
					},
				],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "dev_experiment_run",
		label: "Dev Experiment Run",
		description:
			"Run read-only experiment commands in detached screen jobs with a monitor that writes SUMMARY.md when jobs complete.",
		promptSnippet: "Start read-only experiment jobs and an automatic monitor that writes .dev-agent/runs/<run-id>/SUMMARY.md.",
		promptGuidelines: [
			"Use dev_experiment_run for long experiments or validation shards whose commands are safe, non-interactive, and do not modify source code.",
			"dev_experiment_run is a read-only experiment monitor pattern: it may write only under .dev-agent/runs/<run-id>/ and should not be used for code edits or automatic repairs.",
			"After dev_experiment_run, continue other work if safe, then use /dev-experiment-status or read SUMMARY.md to incorporate results.",
		],
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Experiment name for status display." })),
			jobs: Type.Array(
				Type.Object({
					name: Type.String({ description: "Short stable job name." }),
					command: Type.String({ description: "Read-only/non-source-mutating shell command to run." }),
					cwd: Type.Optional(Type.String({ description: "Optional cwd relative to project root." })),
				}),
				{ minItems: 1 },
			),
			poll_interval_seconds: Type.Optional(Type.Number({ description: "Monitor polling interval; default 10." })),
			timeout_seconds: Type.Optional(Type.Number({ description: "Monitor timeout seconds; <=0 or omitted means no timeout." })),
			tail_lines_on_failure: Type.Optional(Type.Number({ description: "Failure log tail lines in SUMMARY.md; default 120." })),
			progress_interval_percent: Type.Optional(Type.Number({ description: "Monitor writes PROGRESS.md at this percent interval; default 10." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await launchExperimentRun(ctx.cwd, params as ExperimentRunOptions);
			return {
				content: [
					{
						type: "text",
						text: `Launched experiment monitor. Run id: ${result.run_id}\nRun dir: ${result.run_dir}\nMonitor session: ${result.monitor_session}\nSummary path: ${result.summary_path}\n\n${result.jobs
							.map((job) => `- ${job.name}: session=${job.session}; log=${job.log_path}; exit=${job.exit_code_path}`)
							.join("\n")}`,
					},
				],
				details: result,
			};
		},
	});

	pi.registerCommand("dev-discuss", {
		description: "Clarify requirements and update .dev-agent/OPEN_QUESTIONS.md",
		handler: async (args, ctx) => {
			await ensureScaffold(ctx.cwd, args.trim() || undefined);
			const state = await writeState(ctx.cwd, { status: STATUS.DISCUSSING, next_action: "dev-plan" });
			setStatusLine(ctx, state);
			sendOrNotify(pi, ctx, discussionPrompt(args.trim()));
		},
	});

	pi.registerCommand("dev-plan", {
		description: "Generate/update master plan documents under .dev-agent/",
		handler: async (_args, ctx) => {
			await ensureScaffold(ctx.cwd);
			const state = await writeState(ctx.cwd, {
				status: STATUS.PLANNING,
				next_action: "approve master plan, then /dev-next",
			});
			setStatusLine(ctx, state);
			sendOrNotify(pi, ctx, masterPlanPrompt());
			await writeState(ctx.cwd, { status: STATUS.AWAITING_MASTER_APPROVAL });
		},
	});

	pi.registerCommand("dev-next", {
		description: "Create the next phase directory and ask the agent to write its plan",
		handler: async (args, ctx) => {
			await ensureScaffold(ctx.cwd);
			const current = await readState(ctx.cwd);
			const explicit = Number.parseInt(args.trim(), 10);
			const nextPhase = Number.isFinite(explicit) && explicit > 0 ? explicit : current.current_phase + 1;
			await ensurePhaseFiles(ctx.cwd, nextPhase);
			const state = await writeState(ctx.cwd, {
				status: STATUS.PHASE_PLANNING,
				current_phase: nextPhase,
				next_action: "approve phase plan, then /dev-run",
				pending_artifacts: [phaseRel(nextPhase, "PLAN.md")],
			});
			setStatusLine(ctx, state);
			sendOrNotify(pi, ctx, phasePlanPrompt(nextPhase));
			await writeState(ctx.cwd, { status: STATUS.AWAITING_PHASE_APPROVAL });
		},
	});

	pi.registerCommand("dev-run", {
		description: "Execute the current phase according to its PLAN.md",
		handler: async (_args, ctx) => {
			await ensureScaffold(ctx.cwd);
			const current = await readState(ctx.cwd);
			if (current.current_phase < 1) {
				ctx.ui.notify("No current phase. Run /dev-next first.", "warning");
				return;
			}
			await ensurePhaseFiles(ctx.cwd, current.current_phase);
			const state = await writeState(ctx.cwd, {
				status: STATUS.EXECUTING,
				next_action: "dev-verify",
				pending_artifacts: [phaseRel(current.current_phase, "DEVLOG.md")],
			});
			setStatusLine(ctx, state);
			sendOrNotify(pi, ctx, executePrompt(current.current_phase));
		},
	});

	pi.registerCommand("dev-verify", {
		description: "Verify current phase with diff and validation commands",
		handler: async (_args, ctx) => {
			const current = await readState(ctx.cwd);
			if (current.current_phase < 1) {
				ctx.ui.notify("No current phase. Run /dev-next first.", "warning");
				return;
			}
			await ensurePhaseFiles(ctx.cwd, current.current_phase);
			const state = await writeState(ctx.cwd, {
				status: STATUS.VERIFYING,
				next_action: "dev-review",
				pending_artifacts: [phaseRel(current.current_phase, "VERIFY.md")],
			});
			setStatusLine(ctx, state);
			sendOrNotify(pi, ctx, verifyPrompt(current.current_phase));
		},
	});

	pi.registerCommand("dev-review", {
		description: "Review current phase against plan, acceptance, diff, and validation",
		handler: async (_args, ctx) => {
			const current = await readState(ctx.cwd);
			if (current.current_phase < 1) {
				ctx.ui.notify("No current phase. Run /dev-next first.", "warning");
				return;
			}
			await ensurePhaseFiles(ctx.cwd, current.current_phase);
			const state = await writeState(ctx.cwd, {
				status: STATUS.AWAITING_ACCEPTANCE,
				next_action: "dev-accept or revise",
				pending_artifacts: [phaseRel(current.current_phase, "REVIEW.md")],
			});
			setStatusLine(ctx, state);
			sendOrNotify(pi, ctx, reviewPrompt(current.current_phase));
		},
	});

	pi.registerCommand("dev-block", {
		description: "Mark current phase blocked with a reason",
		handler: async (args, ctx) => {
			const reason = args.trim() || "Blocked; user discussion required.";
			const current = await readState(ctx.cwd);
			if (current.current_phase > 0) {
				await ensurePhaseFiles(ctx.cwd, current.current_phase);
				await writeFile(
					join(phaseDir(ctx.cwd, current.current_phase), "ISSUE.md"),
					`# Phase ${current.current_phase} Issue\n\n${reason}\n\nRecorded at: ${now()}\n`,
					"utf8",
				);
			}
			const state = await writeState(ctx.cwd, {
				status: STATUS.BLOCKED,
				blocked: true,
				blocking_reason: reason,
				next_action: "discuss blocking issue with user",
			});
			setStatusLine(ctx, state);
			ctx.ui.notify(`Dev Agent blocked: ${reason}`, "warning");
		},
	});

	pi.registerCommand("dev-accept", {
		description: "Document accepted current phase and update master context",
		handler: async (_args, ctx) => {
			const current = await readState(ctx.cwd);
			if (current.current_phase < 1) {
				ctx.ui.notify("No current phase. Run /dev-next first.", "warning");
				return;
			}
			await ensurePhaseFiles(ctx.cwd, current.current_phase);
			const accepted = [...new Set([...current.accepted_phases, current.current_phase])].sort((a, b) => a - b);
			const state = await writeState(ctx.cwd, {
				status: STATUS.READY_TO_SHIP,
				blocked: false,
				blocking_reason: null,
				accepted_phases: accepted,
				next_action: "dev-ship or dev-next",
				pending_artifacts: [phaseRel(current.current_phase, "RESULT.md")],
			});
			setStatusLine(ctx, state);
			sendOrNotify(pi, ctx, acceptPrompt(current.current_phase));
		},
	});

	pi.registerCommand("dev-ship", {
		description: "Prepare safe git commit/push flow for accepted current phase",
		handler: async (_args, ctx) => {
			const current = await readState(ctx.cwd);
			if (current.current_phase < 1) {
				ctx.ui.notify("No current phase. Run /dev-next first.", "warning");
				return;
			}
			if (current.status !== STATUS.READY_TO_SHIP) {
				const ok = await ctx.ui.confirm(
					"Ship before ready?",
					`Current status is ${current.status}, not ${STATUS.READY_TO_SHIP}. Continue with ship checks anyway?`,
				);
				if (!ok) return;
			}
			const state = await writeState(ctx.cwd, { status: STATUS.SHIPPING, next_action: "commit after checks" });
			setStatusLine(ctx, state);
			sendOrNotify(pi, ctx, shipPrompt(current.current_phase));
		},
	});

	pi.registerCommand("dev-finalize", {
		description: "Generate final Dev Orchestrator report documents",
		handler: async (_args, ctx) => {
			await ensureScaffold(ctx.cwd);
			const state = await writeState(ctx.cwd, { status: STATUS.COMPLETE, next_action: "final review" });
			setStatusLine(ctx, state);
			sendOrNotify(pi, ctx, finalizePrompt());
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!existsSync(devRoot(ctx.cwd))) return;
		const state = await readState(ctx.cwd);
		setStatusLine(ctx, state);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!existsSync(devRoot(ctx.cwd))) return;
		const state = await readState(ctx.cwd);
		const memory = await readMemorySummary(ctx.cwd);
		const phasePlan = state.current_phase > 0 ? await readPhasePlan(ctx.cwd, state.current_phase) : "No active phase.";
		return {
			message: {
				customType: "dev-orchestrator-context",
				display: false,
				content: `[DEV ORCHESTRATOR ACTIVE]\n\nCurrent state:\n${JSON.stringify(state, null, 2)}\n\nCurrent phase plan:\n${phasePlan.slice(0, 6000)}\n\nLong-term memory excerpts:\n${memory.slice(0, 12000)}\n\nRules:\n- ${DEV_DIR}/ belongs to the current project and is the durable project-local memory.\n- The Dev Orchestrator extension code lives outside the project under /root/pi.\n- During discuss/plan/review/finalize phases, do not modify production code.\n- During execution, implement only the current phase.\n- If a stop condition is triggered, stop, write the current phase ISSUE.md, and ask the user.\n- Do not commit or push unless the user explicitly asks through /dev-ship or direct confirmation.
- Before full expensive experiments, perform a lossless speed pass: prefer compatible caches, deterministic parallelism/sharding, dev_experiment_run for read-only monitored experiment shards, and resume/reuse flags that preserve output semantics; record those choices in metadata/docs.`,
			},
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") {
			const command = String((event.input as { command?: unknown }).command ?? "");
			if (DANGEROUS_BASH_PATTERNS.some((pattern) => pattern.test(command))) {
				ctx.ui.notify(`Blocked dangerous command: ${command}`, "warning");
				return { block: true, reason: `Dev Orchestrator blocked dangerous command: ${command}` };
			}
		}

		if (event.toolName === "write" || event.toolName === "edit") {
			const inputPath = String((event.input as { path?: unknown }).path ?? "");
			if (!inputPath) return undefined;
			const absolute = resolve(ctx.cwd, inputPath);
			const relativePath = rel(ctx.cwd, absolute);
			const protectedPath = PROTECTED_WRITE_PATHS.find(
				(path) => relativePath === path || relativePath.startsWith(path) || relativePath.includes(`/${path}`),
			);
			if (protectedPath) {
				ctx.ui.notify(`Blocked write to protected path: ${relativePath}`, "warning");
				return { block: true, reason: `Dev Orchestrator protected path: ${protectedPath}` };
			}

			const state = await readState(ctx.cwd);
			if (
				existsSync(devRoot(ctx.cwd)) &&
				[STATUS.DISCUSSING, STATUS.PLANNING, STATUS.AWAITING_MASTER_APPROVAL, STATUS.PHASE_PLANNING, STATUS.AWAITING_PHASE_APPROVAL].includes(
					state.status,
				) &&
				!isInside(devRoot(ctx.cwd), absolute)
			) {
				return {
					block: true,
					reason: `Dev Orchestrator is in ${state.status}; only ${DEV_DIR}/ documents may be edited.`,
				};
			}
		}

		return undefined;
	});

	// Best-effort self-install when this project-local copy is loaded from /root/pi.
	pi.on("session_start", async () => {
		const globalPath = "/root/.pi/agent/extensions/dev-orchestrator.ts";
		const sourcePath = "/root/pi/.pi/extensions/dev-orchestrator.ts";
		try {
			if (!existsSync(globalPath) && existsSync(sourcePath)) {
				await mkdir(dirname(globalPath), { recursive: true });
				await symlink(sourcePath, globalPath);
			}
		} catch {
			// Ignore: the extension still works when loaded project-locally.
		}
	});
}
