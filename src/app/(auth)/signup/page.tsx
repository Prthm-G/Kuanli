"use client";

import { Suspense, useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
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
// `useSearchParams` opts the component out of static prerendering
// unless wrapped in Suspense — same pattern as /login.
export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupPageInner />
    </Suspense>
  );
}

function SignupPageInner() {
  const searchParams = useSearchParams();
  const inviteToken = searchParams.get("invite");

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  // --- SECURITY LOCK ---
  // This is a UX convenience only, not the real enforcement — it
  // just avoids showing the form to someone who followed a bare
  // /signup link. The actual invite-only enforcement happens
  // server-side in POST /api/auth/invited-signup, which validates
  // the token before creating any account; public self-serve
  // signup is disabled at the GoTrue level (GOTRUE_DISABLE_SIGNUP=
  // true in docker-compose.yml).
  //
  // Sits BELOW the hooks and redirects from an effect. It used to be an
  // early `return null` above the seven useState calls, which changed the
  // hook count between renders — React throws "Rendered more hooks than
  // during the previous render" the moment `invite` appears or disappears
  // on a mounted component. Navigating during render was the second half
  // of the same bug: render may be invoked speculatively.
  useEffect(() => {
    if (!inviteToken) {
      window.location.href =
        "/login?error=" +
        encodeURIComponent(
          "Signups are strictly invite-only. Please contact your administrator.",
        );
    }
  }, [inviteToken]);

  if (!inviteToken) return null;
  // ---------------------

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }

    setLoading(true);

    const res = await fetch("/api/auth/invited-signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteToken, email, password, fullName }),
    });
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string }
      | null;

    if (!res.ok || !data?.ok) {
      setError(data?.error || "Failed to create account");
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

  if (success) {
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
            <CardTitle className="text-xl text-white">
              Check your email
            </CardTitle>
            <CardDescription className="text-slate-400">
              We&apos;ve sent a confirmation link to{" "}
              <span className="text-white">{email}</span>. Click it to verify
              your account, then you&apos;ll land on the invitation to accept.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href={`/login?invite=${encodeURIComponent(inviteToken)}`}>
              <Button
                variant="outline"
                className="w-full border-border text-slate-400 hover:bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 hover:text-white"
              >
                Back to sign in
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

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
          <CardTitle className="text-xl text-white">
            {inviteToken ? "Create account & join" : "Create account"}
          </CardTitle>
          <CardDescription className="text-slate-400">
            {inviteToken
              ? "Create your account to join your team."
              : "Get started with Kuanli"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSignup} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="fullName" className="text-slate-400">
                Full name
              </Label>
              <Input
                id="fullName"
                type="text"
                placeholder="John Doe"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                className="border-border bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 text-white placeholder:text-slate-400 focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="email" className="text-slate-400">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
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
                placeholder="At least 6 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="border-border bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 text-white placeholder:text-slate-400 focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="confirmPassword" className="text-slate-400">
                Confirm password
              </Label>
              <Input
                id="confirmPassword"
                type="password"
                placeholder="Repeat your password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className="border-border bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 text-white placeholder:text-slate-400 focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? "Creating account..." : "Create account"}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-400">
            Already have an account?{" "}
            <Link
              href={
                inviteToken
                  ? `/login?invite=${encodeURIComponent(inviteToken)}`
                  : "/login"
              }
              className="text-primary hover:text-primary/80"
            >
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
