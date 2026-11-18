// One chat: the questions and answers so far, and the box to ask the next (follow-up) question.
// The answer text appears while Claude writes it (streamed); citations come when it is finished.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, BookOpenText, Clock, FileText, Loader2, Search, SearchX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, streamAsk, type Citation, type Message, type StreamProgress } from "@/lib/api";
import { cn } from "@/lib/utils";

const EXAMPLES = [
  "What does error code H99 mean?",
  "f12 op de buitenunit, wat moet ik checken?",
  "Que signifie le code défaut P5 sur l'Alezio ?",
  "Minimum water flow for the 12 kW 3-phase Midea unit?",
];

type Props = {
  conversationId: string | null;
  onConversationStarted: (id: string) => void;
  onAnswered: () => void;
  onLoggedOut: () => void;
};

export function ChatView({ conversationId, onConversationStarted, onAnswered, onLoggedOut }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  // The id of a chat this component just started itself: its messages are already on screen, no need to load them
  const startedHere = useRef<string | null>(null);

  // Load the saved messages when another chat is opened
  useEffect(() => {
    setError(null);
    if (conversationId === null) {
      setMessages([]);
      return;
    }
    if (conversationId === startedHere.current) return;
    let cancelled = false;
    setLoading(true);
    api<{ messages: Message[] }>(`/conversations/${conversationId}`)
      .then((data) => !cancelled && setMessages(data.messages))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) onLoggedOut();
        else if (!cancelled) setError(e.message);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [conversationId, onLoggedOut]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streamText, progress]);

  useEffect(() => {
    textarea.current?.focus();
  }, [conversationId]);

  async function ask(text: string) {
    const q = text.trim();
    if (q === "" || asking) return;
    setAsking(true);
    setError(null);
    setQuestion("");
    setStreamText("");
    setProgress("Searching the manuals…");
    setMessages((m) => [...m, { role: "user", content: q }]);
    try {
      const result = await streamAsk(q, conversationId, {
        onConversation: (id) => {
          if (id !== conversationId) {
            startedHere.current = id;
            onConversationStarted(id);
          }
        },
        onProgress: (event: StreamProgress) => setProgress(progressLabel(event)),
        onDelta: (piece) => {
          setProgress(null);
          setStreamText((t) => t + piece);
        },
        onReset: () => setStreamText(""),
      });
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: result.answer,
          abstained: result.abstained,
          citations: result.citations,
          latencyMs: result.latencyMs,
          costUsd: result.costUsd,
        },
      ]);
      onAnswered();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onLoggedOut();
      setError((e as Error).message);
      setMessages((m) => m.slice(0, -1)); // the question was not answered: put it back in the box
      setQuestion(q);
    } finally {
      setAsking(false);
      setProgress(null);
      setStreamText("");
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      ask(question);
    }
  }

  const empty = messages.length === 0 && !loading && !asking;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 md:py-10">
          {empty && (
            <div className="flex flex-col items-center gap-6 pt-10 text-center md:pt-20">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow">
                <BookOpenText className="size-6" />
              </div>
              <div className="space-y-1">
                <h2 className="text-2xl font-semibold tracking-tight">What do you need to know?</h2>
                <p className="text-sm text-muted-foreground">Ask in English, Dutch or French. Every answer cites the manual and page.</p>
              </div>
              <div className="grid w-full gap-2 sm:grid-cols-2">
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => ask(example)}
                    className="cursor-pointer rounded-xl border bg-card p-3 text-left text-sm transition-colors hover:bg-muted"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          )}

          {loading && (
            <div className="flex justify-center py-10 text-muted-foreground">
              <Loader2 className="animate-spin" />
            </div>
          )}

          {messages.map((message, i) =>
            message.role === "user" ? <UserBubble key={i} text={message.content} /> : <AnswerBlock key={i} message={message} />,
          )}

          {asking && (streamText ? <AnswerBlock message={{ role: "assistant", content: streamText }} streaming /> : <ProgressLine text={progress ?? "Thinking…"} />)}

          {error && <p className="text-sm text-destructive">{error}</p>}
          <div ref={bottom} />
        </div>
      </div>

      <div className="border-t bg-background/80 backdrop-blur">
        <form
          className="mx-auto w-full max-w-3xl p-3 md:p-4"
          onSubmit={(e) => {
            e.preventDefault();
            ask(question);
          }}
        >
          <div className="relative rounded-2xl border bg-card shadow-sm focus-within:ring-2 focus-within:ring-ring/30">
            <Textarea
              ref={textarea}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={onKeyDown}
              maxLength={2000}
              rows={1}
              placeholder={messages.length > 0 ? "Ask a follow-up question…" : "Ask about an error code, a setting, a part…"}
              className="max-h-48 min-h-14 resize-none border-0 bg-transparent py-4 pr-14 shadow-none focus-visible:ring-0"
            />
            <Button type="submit" size="icon" className="absolute right-2 bottom-2 rounded-full" disabled={asking || question.trim() === ""} aria-label="Ask">
              {asking ? <Loader2 className="animate-spin" /> : <ArrowUp />}
            </Button>
          </div>
          <p className="mt-2 text-center text-xs text-muted-foreground">Enter to send · Shift+Enter for a new line</p>
        </form>
      </div>
    </div>
  );
}

function progressLabel(event: StreamProgress): string {
  if (event.type === "searching") return "Searching the manuals…";
  if (event.type === "searching_again") return `Searching again: ${event.query}`;
  return "Reading the sources…";
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm whitespace-pre-wrap text-primary-foreground">{text}</div>
    </div>
  );
}

function ProgressLine({ text }: { text: string }) {
  const Icon = text.startsWith("Searching") ? Search : Loader2;
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Icon className={cn("size-4", Icon === Loader2 && "animate-spin")} />
      <span className="animate-pulse">{text}</span>
    </div>
  );
}

function pages(c: Citation) {
  return c.pageStart === c.pageEnd ? `p. ${c.pageStart}` : `pp. ${c.pageStart}–${c.pageEnd}`;
}

function AnswerBlock({ message, streaming = false }: { message: Extract<Message, { role: "assistant" }>; streaming?: boolean }) {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border bg-card">
        <BookOpenText className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        {message.abstained && (
          <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400">
            <SearchX /> Not in the manuals
          </Badge>
        )}
        <div className="text-sm leading-relaxed whitespace-pre-wrap">
          {message.content}
          {streaming && <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-foreground/60" />}
        </div>
        {!streaming && message.citations && message.citations.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {message.citations.map((c, i) => (
              <Badge key={i} variant="secondary" className="max-w-full font-normal" title={`${c.filename}, ${pages(c)}`}>
                <FileText />
                <span className="truncate">{c.filename.replace(/\.pdf$/i, "")}</span>
                <span className="font-medium">{pages(c)}</span>
              </Badge>
            ))}
          </div>
        )}
        {!streaming && message.latencyMs != null && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="size-3" />
            {(message.latencyMs / 1000).toFixed(1)} s{message.costUsd != null && ` · $${message.costUsd.toFixed(4)}`}
          </div>
        )}
      </div>
    </div>
  );
}
