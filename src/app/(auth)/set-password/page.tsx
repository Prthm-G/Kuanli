"use client";

// First sign-in with a one-time password lands here (middleware keeps
// the member on this page until it succeeds). They choose their own
// password; from then on they sign in with username + that password.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/username";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function SetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don't match");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/auth/set-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        setError(payload.error || "Could not save your password");
        return;
      }
      // Pick up the cleared flag in the session before moving on.
      await supabase.auth.refreshSession();
      router.replace("/dashboard");
      router.refresh();
    } catch {
      setError("Could not reach the server");
    } finally {
      setSaving(false);
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    router.replace("/login");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-black px-4">
      <Card className="w-full max-w-md border-slate-700/50 bg-slate-900/80 backdrop-blur-xl shadow-2xl text-slate-100">
        <CardHeader className="items-center text-center">
          <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-primary/10">
            <KeyRound className="size-6 text-primary" />
          </div>
          <CardTitle className="text-xl text-white">Choose your password</CardTitle>
          <CardDescription className="text-slate-400">
            You signed in with a one-time password. Pick your own to finish
            setting up. You&apos;ll use it with your username from now on.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="new-password" className="text-slate-400">
                New password
              </Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={MIN_PASSWORD_LENGTH}
                required
                className="border-slate-700 bg-slate-800 text-white placeholder:text-slate-500 focus-visible:border-primary focus-visible:ring-primary/20"
              />
              <p className="text-xs text-slate-500">
                At least {MIN_PASSWORD_LENGTH} characters.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="confirm-password" className="text-slate-400">
                Confirm password
              </Label>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                className="border-slate-700 bg-slate-800 text-white placeholder:text-slate-500 focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>
            <Button
              type="submit"
              disabled={saving}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save and continue"
              )}
            </Button>
            <button
              type="button"
              onClick={signOut}
              className="text-center text-xs text-slate-500 hover:text-slate-300"
            >
              Sign out
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
