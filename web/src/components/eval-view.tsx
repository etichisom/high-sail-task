// Run the evaluation from the app: pick a question set on the server or upload a JSON file
// (same format as dev-questions.json), then watch the score, citations, abstention, latency and cost come in.
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, CircleSlash, Download, FileJson, FlaskConical, Loader2, Minus, Play, Square, UploadCloud, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ApiError, postJson } from "@/lib/api";
import { cn } from "@/lib/utils";

type Count = { count: number; total: number };
type Summary = {
  questions: number;
  crashed: string[];
  correct: Count;
  partial: Count;
  answerableCorrect: Count;
  retrievalRecall: Count;
  citationExact: Count;
  citationNear: Count;
  languageMatch: Count;
  numbersExact: Count;
  abstention: { accuracy: Count; precision: Count; recall: Count; hallucinated: number; falseAbstain: number };
  latencyMs: { p50: number; p95: number; max: number; avg: number };
  timeSplitMs: { search: number; rerank: number; claude: number; claudeTurns: number };
  tokens: { input: number; output: number };
  cost: { perQuestionUsd: number; answersUsd: number; judgeUsd: number; totalUsd: number };
};
type Row = {
  id: string;
  question: string;
  answerable: boolean;
  abstained: boolean;
  abstainedCorrectly: boolean;
  retrievalHit: boolean | null;
  citationHit: boolean | null;
  citationNear: boolean | null;
  verdict: "correct" | "partial" | "wrong";
  numbersFound: { found: number; total: number } | null;
  judgeReason: string;
  answer: string;
  citations: { filename: string; pageStart: number; pageEnd: number }[];
  searches: string[];
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  answerCostUsd: number | null;
  judgeCostUsd: number | null;
};
type Run = {
  id: string;
  name: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  total: number;
  done: number;
  current: string | null;
  crashed: { id: string; error: string }[];
  summary: Summary | null;
  settings: { answerModel: string; answerEffort: string; judgeModel: string };
  createdAt: string;
  finishedAt: string | null;
  rows?: Row[];
};
type QuestionSet = { id: string; label: string; questions: number };

const POLL_MS = 2000;
// Rough numbers from earlier runs, shown before starting: ~10 s and ~$0.004 per question (answer + Sonnet judge)
const SECONDS_PER_QUESTION = 10;
const USD_PER_QUESTION = 0.004;

const pct = (c: Count) => (c.total === 0 ? "–" : `${Math.round((100 * c.count) / c.total)}%`);
const frac = (c: Count) => (c.total === 0 ? "not applicable" : `${c.count} of ${c.total}`);
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const usd = (n: number, digits = 4) => `$${n.toFixed(digits)}`;

export function EvalView({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [sets, setSets] = useState<QuestionSet[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<Run | null>(null);
  const [upload, setUpload] = useState<{ name: string; questions: unknown[] } | null>(null);
  const [starting, setStarting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handle = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) onLoggedOut();
      else toast.error((e as Error).message);
    },
    [onLoggedOut],
  );

  const loadList = useCallback(async () => {
    try {
      const data = await api<{ runs: Run[]; sets: QuestionSet[] }>("/evals");
      setRuns(data.runs);
      setSets(data.sets);
      return data.runs;
    } catch (e) {
      handle(e);
      return [];
    }
  }, [handle]);

  // Keep the open run fresh while it is going
  const poll = useCallback(
    async (id: string) => {
      clearTimeout(timer.current);
      try {
        const run = await api<Run>(`/evals/${id}`);
        setSelected(run);
        if (run.status === "queued" || run.status === "running") timer.current = setTimeout(() => poll(id), POLL_MS);
        else loadList();
      } catch (e) {
        handle(e);
      }
    },
    [handle, loadList],
  );

  useEffect(() => {
    loadList().then((list) => {
      const active = list.find((r) => r.status === "running" || r.status === "queued") ?? list[0];
      if (active) poll(active.id);
    });
    return () => clearTimeout(timer.current);
  }, [loadList, poll]);

  async function readFile(file: File) {
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : data?.questions;
      if (!Array.isArray(list) || list.length === 0) throw new Error("the file must be a JSON list of questions");
      setUpload({ name: file.name, questions: list });
    } catch (e) {
      toast.error(`${file.name}: ${(e as Error).message}`);
    } finally {
      if (input.current) input.current.value = "";
    }
  }

  async function start(body: { set: string } | { name: string; questions: unknown[] }) {
    setStarting(true);
    try {
      const run = await postJson<Run>("/evals", body);
      toast.success(`Eval started: ${run.total} questions`);
      setUpload(null);
      setSelected(run);
      loadList();
      poll(run.id);
    } catch (e) {
      handle(e);
    } finally {
      setStarting(false);
    }
  }

  async function cancel(run: Run) {
    try {
      await postJson(`/evals/${run.id}/cancel`, {});
      toast.info("Stopping after the current question…");
      poll(run.id);
    } catch (e) {
      handle(e);
    }
  }

  function download(run: Run) {
    const blob = new Blob([JSON.stringify(run, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `eval-${run.name.replace(/[^\w.-]+/g, "_")}-${(run.finishedAt ?? run.createdAt).slice(0, 19).replace(/[:T]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const busy = runs.some((r) => r.status === "running" || r.status === "queued");

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-8">
      <div>
        <h2 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <FlaskConical className="size-6" /> Evaluation
        </h2>
        <p className="text-sm text-muted-foreground">
          Runs every question through the real pipeline, grades the answer against the reference (Claude Sonnet as judge), and
          measures citations, abstention, latency and cost.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Question sets on the server</CardTitle>
            <CardDescription>The sets that came with the data pack.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {sets.length === 0 && <p className="text-sm text-muted-foreground">No sets found in data/. Upload a file instead.</p>}
            {sets.map((set) => (
              <div key={set.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{set.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {set.questions} questions · ~{Math.ceil((set.questions * SECONDS_PER_QUESTION) / 60)} min · ~{usd(set.questions * USD_PER_QUESTION, 2)}
                  </div>
                </div>
                <Button size="sm" disabled={busy || starting} onClick={() => start({ set: set.id })}>
                  <Play /> Run
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Upload your own questions</CardTitle>
            <CardDescription>
              A JSON list like <code className="text-xs">dev-questions.json</code>: <code className="text-xs">question</code>,{" "}
              <code className="text-xs">answerable</code>, <code className="text-xs">reference_answer</code>, optional{" "}
              <code className="text-xs">id</code> and <code className="text-xs">sources</code> (doc + pages).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {upload ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <div className="flex min-w-0 items-center gap-2">
                  <FileJson className="size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{upload.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {upload.questions.length} questions · ~{Math.ceil((upload.questions.length * SECONDS_PER_QUESTION) / 60)} min · ~
                      {usd(upload.questions.length * USD_PER_QUESTION, 2)}
                    </div>
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button size="icon-sm" variant="ghost" onClick={() => setUpload(null)} aria-label="Remove file">
                    <X />
                  </Button>
                  <Button size="sm" disabled={busy || starting} onClick={() => start({ name: upload.name, questions: upload.questions })}>
                    {starting ? <Loader2 className="animate-spin" /> : <Play />} Run
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => input.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  const f = e.dataTransfer.files[0];
                  if (f) readFile(f);
                }}
                className={cn(
                  "flex w-full cursor-pointer flex-col items-center gap-1.5 rounded-xl border-2 border-dashed p-6 text-center transition-colors",
                  dragging ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50",
                )}
              >
                <UploadCloud className="size-6 text-muted-foreground" />
                <span className="text-sm font-medium">Drop a .json file or click to choose</span>
              </button>
            )}
            <input
              ref={input}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) readFile(f);
              }}
            />
            {busy && <p className="text-xs text-muted-foreground">An eval is running. Start the next one when it is done.</p>}
          </CardContent>
        </Card>
      </div>

      {runs.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {runs.map((run) => (
            <Button key={run.id} size="sm" variant={selected?.id === run.id ? "default" : "outline"} onClick={() => poll(run.id)}>
              {run.name} · {new Date(run.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              {run.summary && run.status === "done" && ` · ${pct(run.summary.correct)}`}
            </Button>
          ))}
        </div>
      )}

      {selected && <RunReport run={selected} onCancel={() => cancel(selected)} onDownload={() => download(selected)} />}
    </div>
  );
}

function RunReport({ run, onCancel, onDownload }: { run: Run; onCancel: () => void; onDownload: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const s = run.summary;
  const active = run.status === "running" || run.status === "queued";
  const percentDone = run.total ? Math.round((100 * run.done) / run.total) : 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              {run.name}
              <StatusBadge status={run.status} />
            </CardTitle>
            <CardDescription>
              {run.done} of {run.total} questions · answers {run.settings.answerModel} (effort {run.settings.answerEffort}) · judge{" "}
              {run.settings.judgeModel}
            </CardDescription>
          </div>
          <div className="flex gap-2">
            {active && (
              <Button size="sm" variant="outline" onClick={onCancel}>
                <Square /> Stop
              </Button>
            )}
            {!active && (
              <Button size="sm" variant="outline" onClick={onDownload}>
                <Download /> Download report
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className={cn("h-full rounded-full bg-primary transition-all", active && "animate-pulse")} style={{ width: `${percentDone}%` }} />
          </div>
          {run.current && (
            <p className="flex items-center gap-2 truncate text-xs text-muted-foreground">
              <Loader2 className="size-3 shrink-0 animate-spin" /> {run.current}
            </p>
          )}
        </CardContent>
      </Card>

      {s && s.questions > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Correct answers" value={pct(s.correct)} detail={`${frac(s.correct)} · ${s.partial.count} partial`} highlight />
            <Stat label="Search found the page" value={pct(s.retrievalRecall)} detail={`retrieval recall · ${frac(s.retrievalRecall)}`} />
            <Stat label="Cited the right page" value={pct(s.citationExact)} detail={`${frac(s.citationExact)} · ±1 page ${pct(s.citationNear)}`} />
            <Stat label="Abstention correct" value={pct(s.abstention.accuracy)} detail={`${s.abstention.hallucinated} hallucinated · ${s.abstention.falseAbstain} wrongly abstained`} />
            <Stat label="Latency p50 / p95" value={`${sec(s.latencyMs.p50)} / ${sec(s.latencyMs.p95)}`} detail={`max ${sec(s.latencyMs.max)}`} />
            <Stat label="Cost per question" value={usd(s.cost.perQuestionUsd, 5)} detail={`${s.tokens.input.toLocaleString()} in + ${s.tokens.output.toLocaleString()} out tokens`} />
            <Stat label="Whole run cost" value={usd(s.cost.totalUsd)} detail={`answers ${usd(s.cost.answersUsd)} + judge ${usd(s.cost.judgeUsd)}`} />
            <Stat label="Numbers in answers" value={pct(s.numbersExact)} detail={`exact check · ${frac(s.numbersExact)} reference values`} />
          </div>
          <Card>
            <CardContent className="grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
              <Line label="Time per question (avg)" value={`search ${sec(s.timeSplitMs.search)} · reranker ${sec(s.timeSplitMs.rerank)} · Claude ${sec(s.timeSplitMs.claude)} (${s.timeSplitMs.claudeTurns.toFixed(1)} turns)`} />
              <Line label="Abstention precision / recall" value={`${frac(s.abstention.precision)} / ${frac(s.abstention.recall)}`} />
              <Line label="Answerable questions correct" value={frac(s.answerableCorrect)} />
              {s.languageMatch && <Line label="Answered in the question's language" value={`${frac(s.languageMatch)} (${pct(s.languageMatch)})`} />}
              <Line label="Crashed (counted wrong)" value={s.crashed.length ? s.crashed.join(", ") : "none"} />
            </CardContent>
          </Card>
        </>
      )}

      {run.rows && run.rows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Per question</CardTitle>
            <CardDescription>Click a row to see the answer and the judge's reason.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-6" />
                  <TableHead>ID</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead className="text-center">Search</TableHead>
                  <TableHead className="text-center">Cited</TableHead>
                  <TableHead className="text-center">Abstain</TableHead>
                  <TableHead className="text-right">Time</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead>Question</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {run.rows.map((row) => (
                  <Fragment key={row.id}>
                    <TableRow className="cursor-pointer" onClick={() => setOpen(open === row.id ? null : row.id)}>
                      <TableCell>{open === row.id ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</TableCell>
                      <TableCell className="font-mono text-xs">{row.id}</TableCell>
                      <TableCell>
                        <Grade verdict={row.verdict} />
                      </TableCell>
                      <TableCell className="text-center">
                        <Mark value={row.retrievalHit} />
                      </TableCell>
                      <TableCell className="text-center">
                        <Mark value={row.citationHit} near={row.citationNear} />
                      </TableCell>
                      <TableCell className="text-center">
                        <Mark value={row.abstainedCorrectly} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{sec(row.latencyMs)}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.answerCostUsd == null ? "?" : usd(row.answerCostUsd, 5)}</TableCell>
                      <TableCell className="max-w-[22rem] truncate" title={row.question}>
                        {row.question}
                      </TableCell>
                    </TableRow>
                    {open === row.id && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={9} className="bg-muted/40 whitespace-normal">
                          <div className="space-y-2 py-2 text-sm">
                            <p>
                              <span className="font-medium">Judge: </span>
                              {row.judgeReason}
                            </p>
                            <p className="whitespace-pre-wrap">
                              <span className="font-medium">{row.abstained ? "Abstained: " : "Answer: "}</span>
                              {row.answer}
                            </p>
                            {row.citations.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {row.citations.map((c, i) => (
                                  <Badge key={i} variant="secondary" className="font-normal">
                                    {c.filename} p. {c.pageStart === c.pageEnd ? c.pageStart : `${c.pageStart}–${c.pageEnd}`}
                                  </Badge>
                                ))}
                              </div>
                            )}
                            <p className="text-xs text-muted-foreground">
                              {row.numbersFound && `Reference numbers in the answer: ${row.numbersFound.found}/${row.numbersFound.total} · `}
                              {row.searches.length > 0 && `Searched again: ${row.searches.join(" | ")} · `}
                              {row.inputTokens.toLocaleString()} in + {row.outputTokens.toLocaleString()} out tokens
                              {row.judgeCostUsd ? ` · judge ${usd(row.judgeCostUsd, 5)}` : ""}
                            </p>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
            {run.crashed.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm text-destructive">
                {run.crashed.map((c) => (
                  <li key={c.id}>
                    {c.id}: crashed ({c.error}), counted as wrong
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, detail, highlight = false }: { label: string; value: string; detail: string; highlight?: boolean }) {
  return (
    <Card className={cn("gap-1 py-4", highlight && "border-primary/40 bg-primary/5")}>
      <CardContent className="space-y-1 px-4">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </CardContent>
    </Card>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b py-1.5 last:border-0 sm:[&:nth-last-child(2)]:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: Run["status"] }) {
  const style: Record<Run["status"], string> = {
    queued: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    running: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
    done: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    failed: "bg-red-500/15 text-red-700 dark:text-red-400",
    cancelled: "bg-muted text-muted-foreground",
  };
  return (
    <Badge variant="outline" className={cn("border-transparent", style[status])}>
      {status === "running" && <Loader2 className="animate-spin" />}
      {status}
    </Badge>
  );
}

function Grade({ verdict }: { verdict: Row["verdict"] }) {
  if (verdict === "correct")
    return (
      <Badge variant="outline" className="border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
        <Check /> correct
      </Badge>
    );
  if (verdict === "partial")
    return (
      <Badge variant="outline" className="border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400">
        <Minus /> partial
      </Badge>
    );
  return (
    <Badge variant="outline" className="border-transparent bg-red-500/15 text-red-700 dark:text-red-400">
      <X /> wrong
    </Badge>
  );
}

function Mark({ value, near }: { value: boolean | null; near?: boolean | null }) {
  if (value === null) return <CircleSlash className="mx-auto size-4 text-muted-foreground/50" aria-label="not applicable" />;
  if (value) return <Check className="mx-auto size-4 text-emerald-600" aria-label="yes" />;
  if (near) return <span className="text-xs text-amber-600" title="right document, 1 page off">±1</span>;
  return <X className="mx-auto size-4 text-red-600" aria-label="no" />;
}
