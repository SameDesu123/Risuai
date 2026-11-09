/**
 * Frontend side of the out-of-memory watchdog (Tauri only, see src-tauri/src/watchdog.rs).
 *
 * The page tells the native side what it is doing: running tasks, recent activity, the loading
 * stage and the JS heap, in a heartbeat every two seconds. When the page or the whole app runs
 * out of memory, the native side writes a report from the last heartbeat and its own memory
 * samples, and the report is shown here on the next page load.
 *
 * Code that may use a lot of memory should run inside `watchdogTrack` (or `watchdogBegin`), so a
 * report can say where the memory ran out.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { get } from "svelte/store";
import { v4 as uuidv4 } from "uuid";
import { changeLanguage, language } from "src/lang";
import { isTauri } from "./platform";
import {
  alertStore,
  DBState,
  LoadingStatusState,
  loadedStore,
  selectedCharID,
} from "./stores.svelte";

export interface WatchdogTaskHandle {
  /** Replaces the detail shown next to the task, e.g. progress */
  update(detail: string): void;
  end(): void;
}

interface WatchdogTask {
  id: number;
  label: string;
  detail?: string;
  startedAt: number;
}

interface WatchdogBreadcrumb {
  at: number;
  message: string;
  /** How many times the same message came in a row */
  count?: number;
  /** Duration, for finished tasks */
  ms?: number;
}

interface WatchdogSnapshot {
  pageId: string;
  pageStartedAt: number;
  at: number;
  rev: number;
  lang?: string;
  visible: boolean;
  loaded: boolean;
  stage: string;
  /** Latest progress message of a long operation (see `alertWait`) */
  progress: { at: number; message: string } | null;
  heap: { used: number; total: number; limit: number } | null;
  lagMs: number;
  maxLagMs: number;
  tasks: Omit<WatchdogTask, "id">[];
  breadcrumbs: WatchdogBreadcrumb[];
  context: {
    characters: number;
    characterIndex: number;
    character?: string;
    chatPage?: number;
    messages?: number;
  } | null;
}

interface WatchdogMemSample {
  at: number;
  nativeRss: number;
  webviewRss: number;
  webviewProcesses: number;
  largestWebviewRss: number;
  systemTotal: number;
  systemAvailable: number;
}

interface WatchdogReport {
  id: string;
  createdAt: number;
  verdict: string;
  likelyOutOfMemory: boolean;
  evidence: string[];
  summary: string;
  trigger: {
    type: string;
    engine?: string;
    kind?: string | null;
    reason?: string | null;
    exitCode?: number | null;
    description?: string | null;
    message?: string;
  };
  nativeAllocFailures: { at?: number; size?: number; operations?: string[] }[];
  file?: string | null;
  session: {
    updatedAt?: number;
    frontend?: Partial<WatchdogSnapshot> | null;
    samples?: WatchdogMemSample[];
    peak?: WatchdogMemSample | null;
    nativeOperations?: { label: string; startedAt: number }[];
  };
}

interface WatchdogStart {
  enabled: boolean;
  reports?: WatchdogReport[];
  directory?: string;
  heartbeatIntervalMs?: number;
}

const MAX_BREADCRUMBS = 50;
const MAX_TEXT = 300;
/** At most one extra heartbeat this often when tasks or activity change */
const IMMEDIATE_HEARTBEAT_MS = 250;
const LONG_TASK_MS = 1000;
const ERROR_DEDUPE_MS = 10_000;

const pageId = uuidv4();
const pageStartedAt = Date.now();
const tasks = new Map<number, WatchdogTask>();
const breadcrumbs: WatchdogBreadcrumb[] = [];
let nextTaskId = 1;
let rev = 0;
let enabled = isTauri;
/** Heartbeats wait until the native side has started this page */
let active = false;
let started: Promise<WatchdogStart | null> | null = null;
let pendingReports: WatchdogReport[] = [];
let heartbeatMs = 2000;
let lastSentAt = 0;
let immediateTimer: ReturnType<typeof setTimeout> | null = null;
let lastTickAt = 0;
let lagMs = 0;
let maxLagMs = 0;
let lagWindowStart = 0;

/** Tasks that were running when an error went through them, for errors caught later on */
const errorTasks = new WeakMap<object, Omit<WatchdogTask, "id">[]>();
let lastFailure: { at: number; tasks: Omit<WatchdogTask, "id">[] } | null =
  null;
let progress: WatchdogSnapshot["progress"] = null;
const reportedErrors = new WeakSet<object>();
const reportedMessages = new Map<string, number>();

const noopHandle: WatchdogTaskHandle = {
  update() {},
  end() {},
};

function clip(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function changed() {
  rev++;
  sendSoon();
}

/** Lists a task as running until `end` is called. Prefer `watchdogTrack` where possible. */
export function watchdogBegin(
  label: string,
  detail?: string,
): WatchdogTaskHandle {
  if (!enabled) {
    return noopHandle;
  }
  const id = nextTaskId++;
  const startedAt = Date.now();
  tasks.set(id, {
    id,
    label: clip(label, 100),
    detail: detail ? clip(detail) : undefined,
    startedAt,
  });
  changed();
  return {
    update(next: string) {
      const task = tasks.get(id);
      if (task) {
        task.detail = clip(next);
        changed();
      }
    },
    end() {
      if (tasks.delete(id)) {
        addBreadcrumb(`Finished: ${label}`, Date.now() - startedAt);
      }
    },
  };
}

/** Runs `fn` as a task, so a report written while it runs can name it. */
export async function watchdogTrack<R>(
  label: string,
  fn: (task: WatchdogTaskHandle) => Promise<R> | R,
  detail?: string,
): Promise<R> {
  if (!enabled) {
    return await fn(noopHandle);
  }
  const task = watchdogBegin(label, detail);
  try {
    return await fn(task);
  } catch (error) {
    noteFailure(error, label);
    throw error;
  } finally {
    task.end();
  }
}

/** Records how far a long operation got. Sent with the next heartbeat. */
export function watchdogProgress(message: string) {
  if (enabled) {
    progress = { at: Date.now(), message: clip(message) };
    rev++;
  }
}

/** Records something that happened, shown as recent activity in reports */
export function watchdogBreadcrumb(message: string) {
  if (enabled) {
    addBreadcrumb(message);
  }
}

function addBreadcrumb(message: string, ms?: number) {
  message = clip(message);
  const last = breadcrumbs[breadcrumbs.length - 1];
  if (last && last.message === message) {
    last.count = (last.count ?? 1) + 1;
    last.at = Date.now();
    last.ms = ms;
  } else {
    breadcrumbs.push({ at: Date.now(), message, ms });
    if (breadcrumbs.length > MAX_BREADCRUMBS) {
      breadcrumbs.shift();
    }
  }
  changed();
}

function runningTasks(): Omit<WatchdogTask, "id">[] {
  return [...tasks.values()].map(({ label, detail, startedAt }) => ({
    label,
    detail,
    startedAt,
  }));
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : "";
}

/** Out-of-memory errors that JavaScript can still catch (V8 and JavaScriptCore) */
export function isOutOfMemoryError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    /out of memory/i.test(message) ||
    /allocation failed/i.test(message) ||
    /could not allocate/i.test(message) ||
    /invalid string length/i.test(message)
  );
}

function noteFailure(error: unknown, label: string) {
  const running = runningTasks();
  if (error && typeof error === "object" && !errorTasks.has(error)) {
    errorTasks.set(error, running);
  }
  lastFailure = { at: Date.now(), tasks: running };
  addBreadcrumb(`Failed: ${label}: ${errorMessage(error)}`);
}

/** Tasks that were running when `error` happened, if it went through a tracked task */
function tasksForError(error: unknown): Omit<WatchdogTask, "id">[] {
  if (error && typeof error === "object" && errorTasks.has(error)) {
    return errorTasks.get(error);
  }
  const running = runningTasks();
  if (running.length > 0) {
    return running;
  }
  if (lastFailure && Date.now() - lastFailure.at < ERROR_DEDUPE_MS) {
    return lastFailure.tasks;
  }
  return [];
}

function describeTasks(list: Omit<WatchdogTask, "id">[], now: number): string {
  return list
    .map((task) => {
      const seconds = Math.max(0, Math.round((now - task.startedAt) / 1000));
      const detail = task.detail ? ` (${task.detail})` : "";
      return `${task.label}${detail}, ${language.watchdog.runningFor(seconds)}`;
    })
    .join(" > ");
}

function describeWhere(
  list: Omit<WatchdogTask, "id">[],
  now: number,
  frontend: Partial<WatchdogSnapshot> | null | undefined,
  nativeOperations: { label: string }[] = [],
): string {
  const parts: string[] = [];
  if (list.length > 0) {
    let tasksText = describeTasks(list, now);
    // Progress that came after the newest task started belongs to it
    const latest = frontend?.progress;
    if (latest && latest.at >= list[list.length - 1].startedAt) {
      tasksText += ` — ${latest.message}`;
    }
    parts.push(tasksText);
  }
  for (const op of nativeOperations.slice(0, 3)) {
    parts.push(language.watchdog.nativeOperation(op.label));
  }
  if (
    parts.length === 0 &&
    frontend &&
    frontend.loaded === false &&
    frontend.stage
  ) {
    parts.push(language.watchdog.loadingStage(frontend.stage));
  }
  if (parts.length === 0) {
    const last = frontend?.breadcrumbs?.[frontend.breadcrumbs.length - 1];
    if (last) {
      parts.push(language.watchdog.afterActivity(last.message));
    }
  }
  return parts.length > 0
    ? parts.join("; ")
    : language.watchdog.unknownLocation;
}

/**
 * For `alertError`: when `error` is an out-of-memory error, saves a report and returns a note
 * that says where it happened. Returns an empty string otherwise.
 */
export function watchdogErrorNote(error: unknown): string {
  if (!enabled || !isOutOfMemoryError(error)) {
    return "";
  }
  const list = tasksForError(error);
  reportJsError(error, list);
  return language.watchdog.jsOomNote(
    describeWhere(list, Date.now(), snapshot()),
  );
}

function reportJsError(error: unknown, list: Omit<WatchdogTask, "id">[]) {
  const message = errorMessage(error);
  const now = Date.now();
  if (error && typeof error === "object") {
    if (reportedErrors.has(error)) {
      return;
    }
    reportedErrors.add(error);
  }
  if (now - (reportedMessages.get(message) ?? 0) < ERROR_DEDUPE_MS) {
    return;
  }
  reportedMessages.set(message, now);
  addBreadcrumb(`Out of memory: ${message}`);
  const stack = error instanceof Error ? error.stack : undefined;
  invoke("watchdog_report_js_error", {
    message,
    stack: stack ?? null,
    snapshot: { ...snapshot(), tasks: list },
  }).catch((e) => console.warn("watchdog: cannot save report", e));
}

function heapUsage(): WatchdogSnapshot["heap"] {
  // Chromium only (WebView2)
  const memory = (
    performance as Performance & {
      memory?: {
        usedJSHeapSize: number;
        totalJSHeapSize: number;
        jsHeapSizeLimit: number;
      };
    }
  ).memory;
  if (!memory) {
    return null;
  }
  return {
    used: memory.usedJSHeapSize,
    total: memory.totalJSHeapSize,
    limit: memory.jsHeapSizeLimit,
  };
}

function appContext(): WatchdogSnapshot["context"] {
  const db = DBState.db;
  if (!db?.characters) {
    return null;
  }
  const characterIndex = get(selectedCharID);
  const character =
    characterIndex >= 0 ? db.characters[characterIndex] : undefined;
  return {
    characters: db.characters.length,
    characterIndex,
    character: character?.name ? clip(character.name, 80) : undefined,
    chatPage: character?.chatPage,
    messages: character?.chats?.[character.chatPage]?.message?.length,
  };
}

function snapshot(): WatchdogSnapshot {
  let context: WatchdogSnapshot["context"] = null;
  try {
    context = appContext();
  } catch {
    // The database may be half loaded
  }
  return {
    pageId,
    pageStartedAt,
    at: Date.now(),
    rev,
    lang: DBState.db?.language,
    visible: document.visibilityState !== "hidden",
    loaded: get(loadedStore),
    stage: LoadingStatusState.text,
    progress,
    heap: heapUsage(),
    lagMs,
    maxLagMs,
    tasks: runningTasks(),
    breadcrumbs,
    context,
  };
}

function send() {
  if (!active) {
    return;
  }
  lastSentAt = Date.now();
  invoke("watchdog_heartbeat", { snapshot: snapshot() }).catch(() => {});
}

function sendSoon() {
  if (!active || immediateTimer) {
    return;
  }
  const wait = Math.max(0, lastSentAt + IMMEDIATE_HEARTBEAT_MS - Date.now());
  immediateTimer = setTimeout(() => {
    immediateTimer = null;
    send();
  }, wait);
}

function heartbeatTick() {
  const now = Date.now();
  // How late this timer fired: a busy main thread shows up here
  if (lastTickAt > 0) {
    lagMs = Math.max(0, now - lastTickAt - heartbeatMs);
    if (now - lagWindowStart > 60_000) {
      lagWindowStart = now;
      maxLagMs = 0;
    }
    maxLagMs = Math.max(maxLagMs, lagMs);
  }
  lastTickAt = now;
  send();
}

/** Starts the watchdog for this page. Call once, before loading the database. */
export function initWatchdog() {
  if (!enabled || started) {
    return;
  }
  started = invoke<WatchdogStart>("watchdog_start", { pageId })
    .then((result) => {
      if (!result?.enabled) {
        enabled = false;
        return null;
      }
      pendingReports = result.reports ?? [];
      heartbeatMs = result.heartbeatIntervalMs ?? heartbeatMs;
      active = true;
      lagWindowStart = Date.now();
      setInterval(heartbeatTick, heartbeatMs);
      heartbeatTick();
      return result;
    })
    .catch((error) => {
      console.warn("watchdog: not available", error);
      enabled = false;
      return null;
    });

  $effect.root(() => {
    $effect(() => {
      const stage = LoadingStatusState.text;
      if (stage) {
        addBreadcrumb(`Loading: ${stage}`);
      }
    });
  });

  let firstSelection = true;
  selectedCharID.subscribe((index) => {
    if (firstSelection) {
      firstSelection = false;
      return;
    }
    let name = "";
    try {
      name = DBState.db?.characters?.[index]?.name ?? "";
    } catch {
      // The database may be half loaded
    }
    addBreadcrumb(
      index >= 0 ? `Opened character #${index} ${name}` : "Closed character",
    );
  });
  loadedStore.subscribe((loaded) => {
    if (loaded) {
      addBreadcrumb("App loaded");
    }
  });

  document.addEventListener("visibilitychange", () => {
    addBreadcrumb(
      document.visibilityState === "hidden" ? "Page hidden" : "Page visible",
    );
    // The native side uses a longer limit for hidden pages, so tell it right away
    send();
  });

  const onError = (error: unknown) => {
    if (isOutOfMemoryError(error)) {
      reportJsError(error, tasksForError(error));
    } else if (error) {
      addBreadcrumb(`Error: ${errorMessage(error)}`);
    }
  };
  window.addEventListener("error", (event) =>
    onError(event.error ?? event.message),
  );
  window.addEventListener("unhandledrejection", (event) =>
    onError(event.reason),
  );

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= LONG_TASK_MS) {
          addBreadcrumb("Page blocked", Math.round(entry.duration));
        }
      }
    }).observe({ type: "longtask", buffered: true });
  } catch {
    // Long tasks are only reported by Chromium
  }

  // A frame (such as a plugin iframe) died but the page is still alive
  listen<WatchdogReport>("watchdog_report", (event) => {
    showReports([event.payload]);
  }).catch(() => {});
}

/** Shows the reports about the previous page or run, if there are any. */
export async function showWatchdogReports() {
  if (!started) {
    return;
  }
  await started;
  const reports = pendingReports;
  pendingReports = [];
  if (reports.length > 0) {
    await showReports(reports);
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 MB";
  }
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** File size for task details */
export function watchdogSize(bytes: number): string {
  return formatBytes(bytes);
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString();
}

function memoryText(report: WatchdogReport): string {
  const t = language.watchdog;
  const parts: string[] = [];
  const heap = report.session.frontend?.heap;
  if (heap && heap.limit > 0) {
    parts.push(
      `${t.jsHeap} ${formatBytes(heap.used)} / ${formatBytes(heap.limit)}`,
    );
  }
  const samples = report.session.samples ?? [];
  const last = samples[samples.length - 1];
  if (last) {
    let app = `${t.appMemory} ${formatBytes(last.nativeRss + last.webviewRss)}`;
    if (last.webviewProcesses > 0) {
      app += ` (${t.webviewMemory} ${formatBytes(last.webviewRss)})`;
    }
    parts.push(app);
    if (last.systemTotal > 0) {
      parts.push(
        `${t.systemAvailable} ${formatBytes(last.systemAvailable)} / ${formatBytes(last.systemTotal)}`,
      );
    }
  }
  const peak = report.session.peak;
  if (peak) {
    parts.push(`${t.peak} ${formatBytes(peak.nativeRss + peak.webviewRss)}`);
  }
  return parts.join(" · ");
}

function contextText(report: WatchdogReport): string {
  const context = report.session.frontend?.context;
  if (!context || context.characterIndex < 0 || !context.character) {
    return "";
  }
  return language.watchdog.contextText(
    context.character,
    context.messages ?? 0,
  );
}

function formatReport(report: WatchdogReport): string {
  const t = language.watchdog;
  const frontend = report.session.frontend;
  const lines: string[] = [
    t.verdicts[report.verdict] ?? t.verdicts.unexpectedTermination,
    "",
  ];

  // A report about the previous run is written on the next start; the black box knows when
  // the run was last alive
  const occurredAt =
    report.trigger.type === "previousRunEnded"
      ? (report.session.updatedAt ?? report.createdAt)
      : report.createdAt;
  // A JS error report carries the tasks from when the error happened
  const where = describeWhere(
    frontend?.tasks ?? [],
    frontend?.at ?? occurredAt,
    frontend,
    report.session.nativeOperations,
  );
  lines.push(`${t.where}: ${where}`);
  lines.push(`${t.when}: ${new Date(occurredAt).toLocaleString()}`);
  const context = contextText(report);
  if (context) {
    lines.push(`${t.context}: ${context}`);
  }
  const memory = memoryText(report);
  if (memory) {
    lines.push(`${t.memory}: ${memory}`);
  }
  if (report.evidence.length > 0) {
    lines.push(
      `${t.evidence}: ${report.evidence.map((code) => t.evidences[code] ?? code).join(", ")}`,
    );
  }
  const trigger = report.trigger;
  if (trigger.type === "renderer") {
    const details = [
      trigger.engine,
      trigger.kind,
      trigger.reason,
      trigger.exitCode,
      trigger.description,
    ]
      .filter((part) => part !== null && part !== undefined && part !== "")
      .join(" ");
    lines.push(`${t.renderer}: ${details}`);
  } else if (trigger.type === "jsError" && trigger.message) {
    lines.push(`${t.error}: ${clip(trigger.message)}`);
  }
  for (const failure of report.nativeAllocFailures.slice(0, 3)) {
    const operations = failure.operations?.length
      ? failure.operations.join(", ")
      : "-";
    lines.push(
      t.nativeAllocFailure(formatBytes(failure.size ?? 0), operations),
    );
  }

  const recent = (frontend?.breadcrumbs ?? []).slice(-8).reverse();
  if (recent.length > 0) {
    lines.push("", `${t.recentActivity}:`);
    for (const crumb of recent) {
      const count = crumb.count && crumb.count > 1 ? ` ×${crumb.count}` : "";
      const ms =
        crumb.ms !== undefined ? ` (${(crumb.ms / 1000).toFixed(1)}s)` : "";
      lines.push(`- ${formatTime(crumb.at)} ${crumb.message}${ms}${count}`);
    }
  }
  if (report.likelyOutOfMemory) {
    lines.push("", t.hint);
  }
  return lines.join("\n");
}

async function waitForAlert(free: boolean) {
  while (
    free
      ? !["none", "toast"].includes(get(alertStore).type)
      : get(alertStore).type !== "none"
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function showReports(reports: WatchdogReport[]) {
  const sorted = [...reports].sort((a, b) => b.createdAt - a.createdAt);
  const newest = sorted[0];
  if (!newest) {
    return;
  }
  // Before the database loads, use the language of the page that wrote the report
  const lang = newest.session.frontend?.lang;
  if (lang && !get(loadedStore)) {
    changeLanguage(lang);
  }
  const t = language.watchdog;
  let msg = `${t.title}\n\n${formatReport(newest)}`;
  if (sorted.length > 1) {
    msg += `\n\n${t.moreReports(sorted.length - 1)}`;
  }
  await waitForAlert(true);
  alertStore.set({
    type: "normal",
    msg,
    submsg: newest.file ? `${t.reportFile}: ${newest.file}` : undefined,
  });
  await waitForAlert(false);
  // Until now a reload shows them again
  await invoke("watchdog_ack_reports", {
    ids: sorted.map((report) => report.id),
  }).catch(() => {});
}
