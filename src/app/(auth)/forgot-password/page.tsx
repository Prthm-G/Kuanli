import Link from "next/link";
import { ArrowLeft, KeyRound } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Logins are usernames now, with no mailbox behind them, so a reset
// can't be emailed. An admin issues a new one-time password from
// Settings → Members instead.
export default function ForgotPasswordPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-black px-4">
      <Card className="w-full max-w-md border-slate-700/50 bg-slate-900/80 backdrop-blur-xl shadow-2xl text-slate-100">
        <CardHeader className="items-center text-center">
          <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-primary/10">
            <KeyRound className="size-6 text-primary" />
          </div>
          <CardTitle className="text-xl text-white">Forgot your password?</CardTitle>
          <CardDescription className="text-slate-400">
            Ask your admin for a new one-time password. They can issue one
            from Settings → Members. You&apos;ll choose a new password when you
            sign in with it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Link
            href="/login"
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80"
          >
            <ArrowLeft className="size-4" />
            Back to sign in
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
