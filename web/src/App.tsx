// The whole web app: the login page, or the workspace (chats on the left, chat or documents on the right)
import { useCallback, useEffect, useState } from "react";
import { BookOpenText, FileText, Loader2, LogOut, Menu, MessageSquarePlus, MessagesSquare, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { AuthPage } from "@/components/auth-page";
import { ChatView } from "@/components/chat-view";
import { DocumentsView } from "@/components/documents-view";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Toaster } from "@/components/ui/sonner";
import { api, ApiError, postJson, type ConversationSummary, type User } from "@/lib/api";
import { cn } from "@/lib/utils";

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined); // undefined = still checking the cookie

  useEffect(() => {
    api<User>("/me").then(setUser, () => setUser(null));
  }, []);

  return (
    <>
      {user === undefined ? (
        <div className="flex min-h-svh items-center justify-center text-muted-foreground">
          <Loader2 className="animate-spin" />
        </div>
      ) : user === null ? (
        <AuthPage onLoggedIn={setUser} />
      ) : (
        <Workspace user={user} onLoggedOut={() => setUser(null)} />
      )}
      <Toaster position="top-center" />
    </>
  );
}

function Workspace({ user, onLoggedOut }: { user: User; onLoggedOut: () => void }) {
  const [view, setView] = useState<"chat" | "documents">("chat");
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false); // the sidebar on small screens

  const loggedOut = useCallback(() => {
    toast.info("Please log in again.");
    onLoggedOut();
  }, [onLoggedOut]);

  const loadConversations = useCallback(async () => {
    try {
      const data = await api<{ conversations: ConversationSummary[] }>("/conversations");
      setConversations(data.conversations);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) loggedOut();
    }
  }, [loggedOut]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  function open(id: string | null) {
    setCurrent(id);
    setView("chat");
    setMenuOpen(false);
  }

  async function remove(id: string) {
    try {
      await api(`/conversations/${id}`, { method: "DELETE" });
      if (current === id) setCurrent(null);
      setConversations((list) => list.filter((c) => c.id !== id));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function logOut() {
    try {
      await postJson("/auth/logout", {});
    } finally {
      onLoggedOut();
    }
  }

  const sidebar = (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <BookOpenText className="size-4" />
        </div>
        <span className="font-semibold tracking-tight">Ask the Manual</span>
        <Button variant="ghost" size="icon" className="ml-auto md:hidden" onClick={() => setMenuOpen(false)} aria-label="Close menu">
          <X />
        </Button>
      </div>

      <Button className="justify-start" onClick={() => open(null)}>
        <MessageSquarePlus /> New chat
      </Button>
      <Button variant={view === "documents" ? "secondary" : "ghost"} className="justify-start" onClick={() => { setView("documents"); setMenuOpen(false); }}>
        <FileText /> Documents
      </Button>

      <div className="mt-3 flex items-center gap-2 px-2 text-xs font-medium text-muted-foreground">
        <MessagesSquare className="size-3.5" /> Chats
      </div>
      <nav className="-mx-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1">
        {conversations.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">Your questions will be saved here.</p>}
        {conversations.map((c) => (
          <div
            key={c.id}
            className={cn(
              "group flex items-center rounded-lg text-sm transition-colors hover:bg-sidebar-accent",
              view === "chat" && current === c.id && "bg-sidebar-accent font-medium",
            )}
          >
            <button type="button" className="min-w-0 flex-1 cursor-pointer truncate px-2 py-2 text-left" onClick={() => open(c.id)} title={c.title}>
              {c.title}
            </button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => remove(c.id)}
              aria-label="Delete chat"
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </nav>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="flex cursor-pointer items-center gap-2 rounded-lg p-2 text-left hover:bg-sidebar-accent">
            <Avatar className="size-8">
              <AvatarFallback className="bg-primary/10 text-xs font-medium">{user.email.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 text-sm leading-tight">
              <div className="truncate font-medium">{user.company}</div>
              <div className="truncate text-xs text-muted-foreground">{user.email}</div>
            </div>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-56">
          <DropdownMenuLabel className="truncate">{user.email}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={logOut}>
            <LogOut /> Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
    <div className="flex h-svh overflow-hidden bg-background">
      <aside className="hidden w-72 shrink-0 border-r bg-sidebar md:block">{sidebar}</aside>

      {menuOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMenuOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 border-r bg-sidebar shadow-xl">{sidebar}</aside>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center gap-2 border-b px-3 md:hidden">
          <Button variant="ghost" size="icon" onClick={() => setMenuOpen(true)} aria-label="Open menu">
            <Menu />
          </Button>
          <span className="truncate text-sm font-medium">
            {view === "documents" ? "Documents" : (conversations.find((c) => c.id === current)?.title ?? "New chat")}
          </span>
        </header>
        <div className="min-h-0 flex-1">
          {view === "documents" ? (
            <div className="h-full overflow-y-auto">
              <DocumentsView onLoggedOut={loggedOut} />
            </div>
          ) : (
            <ChatView
              conversationId={current}
              onConversationStarted={(id) => {
                setCurrent(id);
                loadConversations();
              }}
              onAnswered={loadConversations}
              onLoggedOut={loggedOut}
            />
          )}
        </div>
      </main>
    </div>
  );
}
