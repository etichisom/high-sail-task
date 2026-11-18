// Talking to the API (src/api/server.ts). The session cookie is sent automatically (same origin).

export type User = { email: string; company: string };

export type Citation = { filename: string; pageStart: number; pageEnd: number };

export type Answer = {
  answer: string;
  abstained: boolean;
  citations: Citation[];
  latencyMs: number | null;
  costUsd: number | null;
};

export type Message =
  | { role: "user"; content: string }
  | ({ role: "assistant"; content: string } & Partial<Omit<Answer, "answer">>);

export type ConversationSummary = { id: string; title: string; updatedAt: string };

export type DocumentRow = {
  id: string;
  filename: string;
  status: "queued" | "processing" | "ready" | "failed";
  progress: string | null;
  error: string | null;
  page_count: number | null;
  created_at: string;
};

export type UploadResult = { filename: string; status: "queued" | "duplicate" | "rejected"; reason?: string };

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...options });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error ?? `request failed (${res.status})`;
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}

export const postJson = <T>(path: string, data: unknown) =>
  api<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

export type StreamProgress =
  | { type: "searching" }
  | { type: "searching_again"; query: string }
  | { type: "thinking" };

export type StreamHandlers = {
  onConversation?: (id: string) => void;
  onProgress?: (event: StreamProgress) => void;
  onDelta?: (text: string) => void;
  onReset?: () => void;
};

// POST /ask/stream, read as Server-Sent Events ("event: x\ndata: {...}\n\n").
// EventSource cannot POST, so the stream is read by hand. Returns the finished answer.
export async function streamAsk(
  question: string,
  conversationId: string | null,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<Answer & { conversationId: string | null }> {
  const res = await fetch("/ask/stream", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(conversationId ? { question, conversationId } : { question }),
    signal,
  });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    throw new ApiError(res.status, (body as { error?: string } | null)?.error ?? `request failed (${res.status})`, body);
  }
  if (!res.body) throw new Error("this browser cannot read the answer as it arrives");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: (Answer & { conversationId: string | null }) | null = null;

  const handleBlock = (block: string) => {
    let name = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length === 0) return;
    const payload = JSON.parse(data.join("\n"));
    if (name === "conversation") handlers.onConversation?.(payload.id);
    else if (name === "progress") handlers.onProgress?.(payload);
    else if (name === "delta") handlers.onDelta?.(payload.text);
    else if (name === "reset") handlers.onReset?.();
    else if (name === "answer") final = payload;
    else if (name === "error") throw new Error(payload.error);
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      handleBlock(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim() !== "") handleBlock(buffer);
  if (!final) throw new Error("the connection ended before the answer arrived");
  return final;
}
