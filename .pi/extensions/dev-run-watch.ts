import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

type RunState = "missing" | "running" | "complete" | "unknown";

type JobInfo = {
	name?: string;
	exit_code_path?: string;
	status_path?: string;
};

type JobsJson = {
	run_id?: string;
	owner_session_id?: string;
	jobs?: JobInfo[];
};

type RunSnapshot = {
	runId: string;
	path: string;
	ownerSessionId?: string;
	state: RunState;
	exitCodes: number[];
	summaryPath?: string;
	progressPath?: string;
	runningJobs: string[];
	jobCount: number;
	mtimeMs: number;
};

const POLL_INTERVAL_MS = 10_000;
const MAX_RECENT_COMPLETIONS = 5;

function safeRead(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function parseExitCode(path: string): number | undefined {
	const raw = safeRead(path)?.trim();
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function listRunDirectories(runsRoot: string): string[] {
	if (!existsSync(runsRoot)) return [];
	try {
		return readdirSync(runsRoot)
			.map((name) => join(runsRoot, name))
			.filter((path) => {
				try {
					return statSync(path).isDirectory();
				} catch {
					return false;
				}
			});
	} catch {
		return [];
	}
}

function readJobsJson(runPath: string): JobsJson | undefined {
	const raw = safeRead(join(runPath, "jobs.json"));
	if (!raw) return undefined;
	try {
		return JSON.parse(raw) as JobsJson;
	} catch {
		return undefined;
	}
}

function resolveRunFile(cwd: string, runPath: string, filePath: string | undefined): string | undefined {
	if (!filePath) return undefined;
	if (filePath.startsWith("/")) return filePath;
	const fromCwd = join(cwd, filePath);
	if (existsSync(fromCwd)) return fromCwd;
	return join(runPath, filePath);
}

function snapshotRun(cwd: string, runPath: string): RunSnapshot {
	const runId = runPath.split("/").filter(Boolean).at(-1) ?? runPath;
	const files = (() => {
		try {
			return readdirSync(runPath);
		} catch {
			return [] as string[];
		}
	})();
	const jobsJson = readJobsJson(runPath);
	const jobs = jobsJson?.jobs ?? [];
	const exitCodes: number[] = [];
	const runningJobs: string[] = [];

	if (jobs.length > 0) {
		for (const [index, job] of jobs.entries()) {
			const label = job.name ?? `job-${index + 1}`;
			const statusPath = resolveRunFile(cwd, runPath, job.status_path);
			const exitCodePath = resolveRunFile(cwd, runPath, job.exit_code_path);
			const status = statusPath ? safeRead(statusPath)?.trim().toLowerCase() : undefined;
			const exitCode = exitCodePath ? parseExitCode(exitCodePath) : undefined;
			if (exitCode !== undefined) exitCodes.push(exitCode);
			if (status === "running" || exitCode === undefined) runningJobs.push(label);
		}
	} else {
		for (const file of files.filter((name) => name.endsWith(".exitcode"))) {
			const exitCode = parseExitCode(join(runPath, file));
			if (exitCode !== undefined) exitCodes.push(exitCode);
		}
		for (const file of files.filter((name) => name.endsWith(".status") || name === "status")) {
			const status = safeRead(join(runPath, file))?.trim().toLowerCase();
			if (status === "running") runningJobs.push(file.replace(/\.status$/, ""));
		}
	}

	const summaryPath = ["SUMMARY.md", "SUMMARY.txt", "PHASE4_FULL_SUMMARY.md"]
		.map((name) => join(runPath, name))
		.find((path) => existsSync(path));
	const progressPath = ["PROGRESS.md", "PROGRESS.txt", "PROGRESS.log"]
		.map((name) => join(runPath, name))
		.find((path) => existsSync(path));
	const mtimeMs = (() => {
		try {
			return statSync(runPath).mtimeMs;
		} catch {
			return 0;
		}
	})();

	let state: RunState = "unknown";
	if (!existsSync(runPath)) {
		state = "missing";
	} else if (runningJobs.length > 0) {
		state = "running";
	} else if (jobs.length > 0 && exitCodes.length >= jobs.length) {
		state = "complete";
	} else if (jobs.length === 0 && exitCodes.length > 0) {
		state = "complete";
	} else if (jobs.length === 0 && summaryPath && runningJobs.length === 0) {
		state = "complete";
	}

	return {
		runId,
		path: runPath,
		ownerSessionId: jobsJson?.owner_session_id,
		state,
		exitCodes,
		summaryPath,
		progressPath,
		runningJobs,
		jobCount: jobs.length,
		mtimeMs,
	};
}

function formatPath(cwd: string, path: string | undefined): string | undefined {
	if (!path) return undefined;
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") ? rel : path;
}

function completionPrompt(cwd: string, snapshot: RunSnapshot): string {
	const exitStatus = snapshot.exitCodes.length === 0
		? "unknown"
		: snapshot.exitCodes.every((code) => code === 0)
			? "success"
			: "failed";
	const summaryPath = formatPath(cwd, snapshot.summaryPath) ?? "<missing SUMMARY.md>";
	const progressPath = formatPath(cwd, snapshot.progressPath);
	const exitCodes = snapshot.exitCodes.length > 0 ? snapshot.exitCodes.join(",") : "unknown";
	const extra = progressPath ? `\nprogress: ${progressPath}` : "";
	return `[dev-run-watch] Background run completed.\n\nrun_id: ${snapshot.runId}\nstatus: ${exitStatus}\nexit_codes: ${exitCodes}\nsummary: ${summaryPath}${extra}\n\nPlease inspect only the summary/exit-code metadata first. Do not read full logs unless the summary indicates failure and a small tail is needed.`;
}

function completionNotification(snapshot: RunSnapshot): string {
	const ok = snapshot.exitCodes.length > 0 && snapshot.exitCodes.every((code) => code === 0);
	const status = ok ? "success" : snapshot.exitCodes.length > 0 ? "failed" : "complete";
	return `dev-run-watch: ${snapshot.runId} ${status}`;
}

export default function (pi: ExtensionAPI) {
	let interval: ReturnType<typeof setInterval> | undefined;
	let cwd = "";
	let runsRoot = "";
	let autoPrompt = true;
	let enabled = true;
	let guidanceEnabled = true;
	const knownComplete = new Set<string>();
	const notified = new Set<string>();
	let recentCompletions: RunSnapshot[] = [];
	let ownerSessionId: string | undefined;

	function isOwnedByCurrentSession(snapshot: RunSnapshot): boolean {
		return snapshot.ownerSessionId === ownerSessionId;
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!enabled) {
			ctx.ui.setStatus("dev-run-watch", ctx.ui.theme.fg("dim", "runs: off"));
			return;
		}
		const snapshots = listRunDirectories(runsRoot).map((path) => snapshotRun(cwd, path));
		const running = snapshots.filter((snapshot) => snapshot.state === "running" && isOwnedByCurrentSession(snapshot));
		const label = running.length > 0
			? ctx.ui.theme.fg("accent", `runs: ${running.length} running`)
			: ctx.ui.theme.fg("dim", "runs: idle");
		ctx.ui.setStatus("dev-run-watch", label);
	}

	function scan(ctx: ExtensionContext, notify: boolean) {
		if (!enabled) return;
		const snapshots = listRunDirectories(runsRoot).map((path) => snapshotRun(cwd, path));
		for (const snapshot of snapshots) {
			if (!isOwnedByCurrentSession(snapshot)) continue;
			if (snapshot.state !== "complete") continue;
			if (knownComplete.has(snapshot.runId) || notified.has(snapshot.runId)) continue;

			notified.add(snapshot.runId);
			recentCompletions = [snapshot, ...recentCompletions].slice(0, MAX_RECENT_COMPLETIONS);
			if (!notify) continue;

			const ok = snapshot.exitCodes.length > 0 && snapshot.exitCodes.every((code) => code === 0);
			ctx.ui.notify(completionNotification(snapshot), ok ? "info" : "warning");
			if (autoPrompt) {
				const message = completionPrompt(cwd, snapshot);
				if (ctx.isIdle()) {
					pi.sendUserMessage(message);
				} else {
					pi.sendUserMessage(message, { deliverAs: "followUp" });
				}
			}
		}
		updateStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		runsRoot = join(cwd, ".dev-agent", "runs");
		ownerSessionId = ctx.sessionManager.getSessionId();
		knownComplete.clear();
		notified.clear();
		recentCompletions = [];

		for (const runPath of listRunDirectories(runsRoot)) {
			const snapshot = snapshotRun(cwd, runPath);
			if (snapshot.state === "complete") knownComplete.add(snapshot.runId);
		}

		updateStatus(ctx);
		if (interval) clearInterval(interval);
		interval = setInterval(() => scan(ctx, true), POLL_INTERVAL_MS);
		interval.unref?.();
	});

	pi.on("session_shutdown", async () => {
		if (interval) clearInterval(interval);
		interval = undefined;
	});

	pi.on("before_agent_start", async (event) => {
		if (!guidanceEnabled || !enabled || !autoPrompt) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\nDev run watch guidance:\n- For commands that may exceed normal bash timeouts, run expensive experiments, full test suites, long Python demos, or multi-shard validation, prefer dev_screen_run or dev_experiment_run instead of foreground bash.\n- Use dev_experiment_run for read-only long experiments; use dev_screen_run for independent non-interactive validation jobs.\n- Keep foreground bash for quick inspection and short commands only.\n- Background runs launched by this session under .dev-agent/runs are monitored by dev-run-watch; when they finish, it will send a low-token follow-up containing only run_id, exit codes, and SUMMARY/PROGRESS paths.\n- After launching a background run, do not repeatedly poll while it is active. Continue safe work or wait for the dev-run-watch completion follow-up.\n- After a background completion prompt, inspect SUMMARY.md and exit-code metadata first; do not read full logs unless a small failure tail is needed. Check status manually only when explicitly asked, no safe work remains, or a notification appears missed.`,
		};
	});

	pi.registerCommand("run-watch", {
		description: "Monitor .dev-agent/runs completions with low-token follow-up prompts",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command === "off") {
				enabled = false;
				ctx.ui.setStatus("dev-run-watch", ctx.ui.theme.fg("dim", "runs: off"));
				ctx.ui.notify("dev-run-watch disabled", "info");
				return;
			}
			if (command === "on") {
				enabled = true;
				scan(ctx, false);
				ctx.ui.notify("dev-run-watch enabled", "info");
				return;
			}
			if (command === "auto off" || command === "auto-off") {
				autoPrompt = false;
				ctx.ui.notify("dev-run-watch auto follow-up prompts disabled", "info");
				return;
			}
			if (command === "auto on" || command === "auto-on") {
				autoPrompt = true;
				ctx.ui.notify("dev-run-watch auto follow-up prompts enabled", "info");
				return;
			}
			if (command === "guidance off" || command === "guidance-off") {
				guidanceEnabled = false;
				ctx.ui.notify("dev-run-watch long-run guidance disabled", "info");
				return;
			}
			if (command === "guidance on" || command === "guidance-on") {
				guidanceEnabled = true;
				ctx.ui.notify("dev-run-watch long-run guidance enabled", "info");
				return;
			}
			if (command === "scan") {
				scan(ctx, true);
				ctx.ui.notify("dev-run-watch scan complete", "info");
				return;
			}

			const snapshots = listRunDirectories(runsRoot)
				.map((path) => snapshotRun(cwd, path))
				.filter((snapshot) => isOwnedByCurrentSession(snapshot))
				.sort((a, b) => b.mtimeMs - a.mtimeMs);
			const running = snapshots.filter((snapshot) => snapshot.state === "running");
			const lines = [
				`dev-run-watch: ${enabled ? "on" : "off"}; autoPrompt=${autoPrompt ? "on" : "off"}; guidance=${guidanceEnabled ? "on" : "off"}`,
				`runs root: ${formatPath(cwd, runsRoot)}`,
				`running: ${running.length}`,
				...running.slice(0, 5).map((snapshot) => `- ${snapshot.runId}: ${snapshot.runningJobs.join(", ") || "running"}`),
				`recent completions: ${recentCompletions.length}`,
				...recentCompletions.map((snapshot) => `- ${snapshot.runId}: exit_codes=${snapshot.exitCodes.join(",") || "unknown"}; summary=${formatPath(cwd, snapshot.summaryPath) ?? "missing"}`),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
