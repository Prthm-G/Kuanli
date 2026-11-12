"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { createClient } from "@/lib/supabase/client";
import { loginEmailFor } from "@/lib/auth/username";
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

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // A username maps to its internal login email; an email passes through.
    const email = loginEmailFor(username);
    if (!email) {
      setError("Enter your username");
      return;
    }
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(
        /invalid login credentials/i.test(error.message)
          ? "Wrong username or password"
          : /banned/i.test(error.message)
            ? "This login has been removed. Ask your admin."
            : error.message,
      );
      setLoading(false);
      return;
    }

    // Middleware sends a one-time password login on to /set-password.
    router.push("/dashboard");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-black px-4">
      <Card className="w-full max-w-md border-slate-700/50 bg-slate-900/80 backdrop-blur-xl shadow-2xl text-slate-100">
        <CardHeader className="items-center text-center">
          <div className="mb-6 flex justify-center">
            <Image
                src="/kuanli_logo.png"
                alt="Kuanli CRM"
                width={64}
                height={64}
                priority
                className="h-16 w-16 object-contain drop-shadow-2xl"
              />
          </div>
          <CardTitle className="text-xl text-white">Welcome back</CardTitle>
          <CardDescription className="text-slate-400">
            Sign in with your username
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="username" className="text-slate-400">
                Username
              </Label>
              <Input
                id="username"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="e.g. riya"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                className="border-border bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 text-white placeholder:text-slate-400 focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="password" className="text-slate-400">
                Password
              </Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                placeholder="Password or one-time password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="border-border bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 text-white placeholder:text-slate-400 focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? "Signing in..." : "Sign in"}
            </Button>

            <p className="text-center text-xs text-slate-500">
              Forgot your password? Ask your admin for a new one-time
              password.
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
