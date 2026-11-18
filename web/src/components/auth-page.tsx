// Log in or create an account (sign-up creates a new company and its first user)
import { useState, type FormEvent } from "react";
import { BookOpenText, Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { postJson, type User } from "@/lib/api";

export function AuthPage({ onLoggedIn }: { onLoggedIn: (user: User) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signup = mode === "signup";

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (signup && password.length < 8) return setError("Choose a password of at least 8 characters.");
    setBusy(true);
    try {
      const user = signup
        ? await postJson<User>("/auth/signup", { company: company.trim(), email: email.trim(), password })
        : await postJson<User>("/auth/login", { email: email.trim(), password });
      onLoggedIn(user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-gradient-to-b from-muted/60 to-background p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <BookOpenText className="size-5" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Ask the Manual</h1>
          <p className="text-sm text-muted-foreground">Answers from your heat pump manuals, with page citations.</p>
        </div>

        <Card>
          <CardHeader>
            <Tabs value={mode} onValueChange={(v) => { setMode(v as "login" | "signup"); setError(null); }}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="login">Log in</TabsTrigger>
                <TabsTrigger value="signup">Create account</TabsTrigger>
              </TabsList>
            </Tabs>
            <CardTitle className="pt-3">{signup ? "Create your account" : "Welcome back"}</CardTitle>
            <CardDescription>
              {signup ? "This creates a new company. Its manuals stay private to it." : "Log in to your company's manuals."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-4">
              {signup && (
                <div className="space-y-2">
                  <Label htmlFor="company">Company</Label>
                  <Input id="company" value={company} onChange={(e) => setCompany(e.target.value)} autoComplete="organization" placeholder="Acme Installations" required />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" placeholder="you@company.com" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={signup ? "new-password" : "current-password"}
                  placeholder={signup ? "At least 8 characters" : ""}
                  required
                />
              </div>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" className="w-full" disabled={busy}>
                {busy && <Loader2 className="animate-spin" />}
                {signup ? "Create account" : "Log in"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
