// Eval runs started from the web app. An eval takes minutes (one question at a time, ~10 s each), so it runs in the
// background inside the API process and the page polls it. Runs are kept in memory (gone after an API restart);
// every finished run is also saved as a report file in store/eval, like `npm run eval` does.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { evaluateQuestion, type EvalQuestion, type EvalRow } from "./evaluate.js";
import { parseQuestions, summarize, type EvalSummary } from "./summary.js";

export type EvalJob = {
  id: string;
  tenantId: string;
  name: string; // the file name or set name, to recognise the run
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  total: number;
  done: number;
  current: string | null; // the question being answered now
  rows: EvalRow[];
  crashed: { id: string; error: string }[];
  summary: EvalSummary | null; // updated after every question, so the page shows totals while it runs
  settings: { answerModel: string; answerEffort: string; judgeModel: string };
  createdAt: string;
  finishedAt: string | null;
  report: string | null; // the saved report file
  questions: EvalQuestion[];
  cancel: boolean;
};

// Question sets on the server (data/ is the data pack, not in git), offered in the page next to uploading a file
const BUILT_IN_SETS: Record<string, { file: string; label: string }> = {
  "dev-questions": { file: "data/dev-questions.json", label: "Dev questions (data pack)" },
};

export function builtInSets(): { id: string; label: string; questions: number }[] {
  return Object.entries(BUILT_IN_SETS)
    .filter(([, set]) => existsSync(set.file))
    .map(([id, set]) => {
      let questions = 0;
      try {
        questions = parseQuestions(JSON.parse(readFileSync(set.file, "utf8"))).length;
      } catch {
        questions = 0;
      }
      return { id, label: set.label, questions };
    })
    .filter((set) => set.questions > 0);
}

export function loadBuiltInSet(id: string): EvalQuestion[] | null {
  const set = BUILT_IN_SETS[id];
  if (!set || !existsSync(set.file)) return null;
  return parseQuestions(JSON.parse(readFileSync(set.file, "utf8")));
}

const jobs = new Map<string, EvalJob>();
const queue: EvalJob[] = []; // one eval at a time for the whole server: it uses the CPU (embeddings) and the API budget
let running = false;

export function startEval(tenantId: string, name: string, questions: EvalQuestion[]): EvalJob {
  const busy = [...jobs.values()].some((j) => j.tenantId === tenantId && (j.status === "queued" || j.status === "running"));
  if (busy) throw new Error("an eval is already running for this company; wait for it or cancel it");
  const job: EvalJob = {
    id: randomUUID(),
    tenantId,
    name: name.slice(0, 120),
    status: "queued",
    total: questions.length,
    done: 0,
    current: null,
    rows: [],
    crashed: [],
    summary: null,
    settings: { answerModel: config.answerModel, answerEffort: config.answerEffort, judgeModel: config.judgeModel },
    createdAt: new Date().toISOString(),
    finishedAt: null,
    report: null,
    questions,
    cancel: false,
  };
  jobs.set(job.id, job);
  queue.push(job);
  void runQueue();
  return job;
}

async function runQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (let job = queue.shift(); job; job = queue.shift()) await runJob(job);
  } finally {
    running = false;
  }
}

async function runJob(job: EvalJob): Promise<void> {
  if (job.cancel) return finish(job, "cancelled");
  job.status = "running";
  try {
    for (const q of job.questions) {
      if (job.cancel) return finish(job, "cancelled");
      job.current = q.question;
      try {
        job.rows.push(await evaluateQuestion(job.tenantId, q));
      } catch (error) {
        // A crash counts as a wrong answer, like in `npm run eval`
        job.crashed.push({ id: q.id, error: error instanceof Error ? error.message : String(error) });
        console.error(`[eval] ${q.id} failed:`, error);
      }
      job.done++;
      job.summary = summarize(job.rows, job.crashed.map((c) => c.id));
    }
    finish(job, "done");
  } catch (error) {
    console.error("[eval] run failed:", error);
    finish(job, "failed");
  }
}

function finish(job: EvalJob, status: EvalJob["status"]): void {
  job.status = status;
  job.current = null;
  job.finishedAt = new Date().toISOString();
  job.summary = summarize(job.rows, job.crashed.map((c) => c.id));
  if (job.rows.length === 0) return;
  try {
    const dir = join(config.storeDir, "eval");
    mkdirSync(dir, { recursive: true });
    job.report = join(dir, `results-${job.finishedAt.replace(/[:.]/g, "-")}-web.json`);
    const { questions: _q, cancel: _c, ...saved } = job;
    writeFileSync(job.report, JSON.stringify(saved, null, 2));
  } catch (error) {
    console.error("[eval] could not save the report:", error);
  }
}

// What the page gets: everything except the internal fields. The report path stays on the server.
export function publicJob(job: EvalJob, withRows: boolean) {
  const { questions: _q, cancel: _c, tenantId: _t, report, rows, ...rest } = job;
  return { ...rest, saved: report !== null, ...(withRows ? { rows } : {}) };
}

export function findJob(tenantId: string, id: string): EvalJob | null {
  const job = jobs.get(id);
  return job && job.tenantId === tenantId ? job : null;
}

export function listJobs(tenantId: string): EvalJob[] {
  return [...jobs.values()].filter((j) => j.tenantId === tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function cancelJob(job: EvalJob): void {
  if (job.status === "queued" || job.status === "running") job.cancel = true;
}
