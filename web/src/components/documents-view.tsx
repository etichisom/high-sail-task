// Upload PDFs or a ZIP of PDFs, and see each manual's status while the worker reads it
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { FileArchive, FileText, Loader2, UploadCloud } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ApiError, type DocumentRow, type UploadResult } from "@/lib/api";
import { cn } from "@/lib/utils";

const POLL_MS = 3000;

const STATUS_STYLE: Record<DocumentRow["status"], string> = {
  ready: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  processing: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/20",
  queued: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/20",
  failed: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/20",
};

export function DocumentsView({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [results, setResults] = useState<UploadResult[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(async () => {
    clearTimeout(timer.current);
    try {
      const { documents } = await api<{ documents: DocumentRow[] }>("/documents");
      setDocuments(documents);
      if (documents.some((d) => d.status === "queued" || d.status === "processing")) timer.current = setTimeout(refresh, POLL_MS);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onLoggedOut();
      timer.current = setTimeout(refresh, POLL_MS);
    }
  }, [onLoggedOut]);

  useEffect(() => {
    refresh();
    return () => clearTimeout(timer.current);
  }, [refresh]);

  async function upload(file: File) {
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".pdf") && !lower.endsWith(".zip")) return toast.error("Only .pdf and .zip files are accepted.");
    const form = new FormData();
    form.append("file", file, file.name);
    setUploading(true);
    try {
      const data = await api<{ results: UploadResult[] }>("/documents", { method: "POST", body: form });
      setResults(data.results);
      const queued = data.results.filter((r) => r.status === "queued").length;
      toast.success(queued > 0 ? `${queued} file${queued > 1 ? "s" : ""} queued for reading` : "Already uploaded");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onLoggedOut();
      const body = e instanceof ApiError ? (e.body as { results?: UploadResult[] } | null) : null;
      setResults(body?.results ?? [{ filename: file.name, status: "rejected", reason: (e as Error).message }]);
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
      refresh();
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) upload(file);
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Documents</h2>
        <p className="text-sm text-muted-foreground">Upload PDF manuals or a ZIP of PDFs. They are read in the background.</p>
      </div>

      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        disabled={uploading}
        className={cn(
          "flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-10 text-center transition-colors",
          dragging ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50",
        )}
      >
        {uploading ? <Loader2 className="size-8 animate-spin text-muted-foreground" /> : <UploadCloud className="size-8 text-muted-foreground" />}
        <div className="text-sm font-medium">{uploading ? "Uploading…" : "Drop a PDF or ZIP here, or click to choose"}</div>
        <div className="text-xs text-muted-foreground">Up to 300 MB · a ZIP can hold up to 100 PDFs</div>
        <input
          ref={input}
          type="file"
          accept=".pdf,.zip,application/pdf,application/zip"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }}
        />
      </button>

      {results.length > 0 && (
        <ul className="space-y-1 text-sm">
          {results.map((r, i) => (
            <li key={i} className={cn(r.status === "rejected" ? "text-destructive" : "text-muted-foreground")}>
              <span className="font-medium">{r.filename}</span>: {r.status === "queued" ? "queued for reading" : r.status === "duplicate" ? "already uploaded" : "rejected"}
              {r.reason ? `. ${r.reason}` : ""}
            </li>
          ))}
        </ul>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Your manuals</CardTitle>
          <CardDescription>{documents ? `${documents.length} document${documents.length === 1 ? "" : "s"}` : "Loading…"}</CardDescription>
        </CardHeader>
        <CardContent>
          {documents && documents.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No documents yet. Upload your first manual above.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(documents ?? []).map((doc) => (
                  <TableRow key={doc.id}>
                    <TableCell className="max-w-[18rem]">
                      <div className="flex items-center gap-2">
                        {doc.filename.toLowerCase().endsWith(".zip") ? <FileArchive className="size-4 shrink-0 text-muted-foreground" /> : <FileText className="size-4 shrink-0 text-muted-foreground" />}
                        <span className="truncate" title={doc.filename}>{doc.filename}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={STATUS_STYLE[doc.status]}>
                        {doc.status === "processing" && <Loader2 className="animate-spin" />}
                        {doc.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">
                      {doc.status === "failed" ? <span className="text-destructive">{doc.error}</span> : doc.progress || (doc.status === "ready" && doc.page_count ? `${doc.page_count} page${doc.page_count === 1 ? "" : "s"}` : "")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
