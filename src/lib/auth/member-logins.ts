// ============================================================
// Member logins: add a member by username, reset a password.
// Server-only. Takes the service-role client so tests can pass a fake.
//
// Adding a member
//   GoTrue creates the auth user with a one-time password and
//   must_change_password. Its insert trigger (handle_new_user) gives
//   every new user a personal account + owner profile; we move that
//   profile into the caller's account with the chosen role and drop
//   the empty personal account, the same end state redeem_invitation
//   produced. The service role is not `authenticated`, so the profile
//   privilege guard (migration 050) lets it write account_id/role.
//
// Re-adding a removed member
//   Removal deletes the profile and bans the login, but keeps the auth
//   user (deleting it would cascade into their chats and contacts). So
//   when the username already exists and has no profile, we unban that
//   same login, give it a new one-time password and a fresh profile.
//   Their old history stays attached to the same user id.
// ============================================================

import { randomInt } from "node:crypto";
import type { SupabaseClient, User } from "@supabase/supabase-js";

import type { AccountRole } from "./roles";
import { emailToUsername, usernameToEmail } from "./username";

export type MemberRole = Exclude<AccountRole, "owner">;

export class MemberLoginError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 500,
  ) {
    super(message);
    this.name = "MemberLoginError";
  }
}

// No 0/o, 1/l/i: the password is read off a phone screen and typed.
const OTP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const OTP_LENGTH = 10;

/** A fresh one-time password: 10 characters, about 49 bits. */
export function generateOneTimePassword(): string {
  let out = "";
  for (let i = 0; i < OTP_LENGTH; i++) {
    out += OTP_ALPHABET[randomInt(OTP_ALPHABET.length)];
  }
  return out;
}

export interface IssuedLogin {
  userId: string;
  /** Username, or the email for a member who still signs in with one. */
  login: string;
  password: string;
  /** True when a removed member's old login was brought back. */
  restored?: boolean;
}

const BAN_FOREVER = "876000h"; // the same ~100 years the remove route uses

async function findUserByEmail(
  admin: SupabaseClient,
  email: string,
): Promise<User | null> {
  const target = email.toLowerCase();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) throw new MemberLoginError("Failed to look up the username", 500);
    const hit = data.users.find((u) => u.email?.toLowerCase() === target);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

/** Auth email for every user id, for showing usernames in the roster. */
export async function loginEmailsById(
  admin: SupabaseClient,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) throw new MemberLoginError("Failed to load logins", 500);
    for (const u of data.users) if (u.email) out.set(u.id, u.email);
    if (data.users.length < 200) break;
  }
  return out;
}

export async function addMember(
  admin: SupabaseClient,
  input: {
    accountId: string;
    username: string;
    fullName: string;
    role: MemberRole;
  },
): Promise<IssuedLogin> {
  const email = usernameToEmail(input.username);
  const password = generateOneTimePassword();

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: input.fullName },
    app_metadata: { must_change_password: true },
  });

  if (error) {
    if (error.code === "email_exists" || /already been registered/i.test(error.message)) {
      return restoreRemovedMember(admin, { ...input, email, password });
    }
    console.error("[member-logins] createUser failed:", error);
    throw new MemberLoginError("Failed to create the login", 500);
  }

  const userId = data.user.id;
  try {
    await placeNewProfile(admin, userId, { ...input, email });
  } catch (err) {
    // Nothing references a user this new, so deleting it is clean.
    await admin.auth.admin.deleteUser(userId).catch((e: unknown) =>
      console.error("[member-logins] cleanup deleteUser failed:", userId, e),
    );
    throw err;
  }
  return { userId, login: input.username, password };
}

async function placeNewProfile(
  admin: SupabaseClient,
  userId: string,
  input: { accountId: string; fullName: string; role: MemberRole; email: string },
): Promise<void> {
  const { data: existing, error: readErr } = await admin
    .from("profiles")
    .select("account_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (readErr) throw new MemberLoginError("Failed to set up the member", 500);

  if (!existing) {
    // handle_new_user swallows its own errors, so the profile can be missing.
    await insertProfile(admin, userId, input);
    return;
  }

  const personalAccountId = (existing as { account_id: string }).account_id;
  const { error: moveErr } = await admin
    .from("profiles")
    .update({
      account_id: input.accountId,
      account_role: input.role,
      full_name: input.fullName,
    })
    .eq("user_id", userId);
  if (moveErr) throw new MemberLoginError("Failed to set up the member", 500);

  if (personalAccountId && personalAccountId !== input.accountId) {
    const { error: dropErr } = await admin
      .from("accounts")
      .delete()
      .eq("id", personalAccountId)
      .eq("owner_user_id", userId);
    if (dropErr) {
      // The member is in place; an empty personal account left behind is
      // harmless, so log it rather than fail the whole add.
      console.error("[member-logins] could not drop personal account:", personalAccountId, dropErr);
    }
  }
}

async function insertProfile(
  admin: SupabaseClient,
  userId: string,
  input: { accountId: string; fullName: string; role: MemberRole; email: string },
): Promise<void> {
  const { error } = await admin.from("profiles").insert({
    user_id: userId,
    full_name: input.fullName,
    email: input.email,
    account_id: input.accountId,
    account_role: input.role,
  });
  if (error) throw new MemberLoginError("Failed to set up the member", 500);
}

async function restoreRemovedMember(
  admin: SupabaseClient,
  input: {
    accountId: string;
    username: string;
    fullName: string;
    role: MemberRole;
    email: string;
    password: string;
  },
): Promise<IssuedLogin> {
  const taken = new MemberLoginError("That username is already taken", 409);
  const user = await findUserByEmail(admin, input.email);
  if (!user) throw taken;

  const { data: profile, error: readErr } = await admin
    .from("profiles")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (readErr) throw new MemberLoginError("Failed to look up the username", 500);
  if (profile) throw taken; // a current member (here or elsewhere) has it

  const { error: upErr } = await admin.auth.admin.updateUserById(user.id, {
    password: input.password,
    ban_duration: "none",
    email_confirm: true,
    user_metadata: { full_name: input.fullName },
    app_metadata: { must_change_password: true },
  });
  if (upErr) {
    console.error("[member-logins] restore updateUserById failed:", upErr);
    throw new MemberLoginError("Failed to restore the login", 500);
  }

  try {
    await insertProfile(admin, user.id, input);
  } catch (err) {
    // Put the ban back so an unbanned login with no profile is never left
    // behind. Not if a profile is there after all: a concurrent re-add of
    // the same username won the insert, and that member must stay in.
    const { data: winner } = await admin
      .from("profiles")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!winner) {
      await admin.auth.admin
        .updateUserById(user.id, { ban_duration: BAN_FOREVER })
        .catch((e: unknown) => console.error("[member-logins] re-ban failed:", user.id, e));
    }
    throw err;
  }
  return { userId: user.id, login: input.username, password: input.password, restored: true };
}

/**
 * New one-time password for a member of the caller's account. Signs
 * them out everywhere (GoTrue drops sessions on an admin password
 * change) and holds them on /set-password at next sign-in.
 */
export async function resetMemberPassword(
  admin: SupabaseClient,
  input: { accountId: string; callerUserId: string; targetUserId: string },
): Promise<IssuedLogin> {
  if (input.targetUserId === input.callerUserId) {
    throw new MemberLoginError("Change your own password in Settings → Password", 400);
  }
  const { data: profile, error: readErr } = await admin
    .from("profiles")
    .select("account_id, account_role")
    .eq("user_id", input.targetUserId)
    .maybeSingle();
  if (readErr) throw new MemberLoginError("Failed to look up the member", 500);
  const p = profile as { account_id: string; account_role: AccountRole } | null;
  if (!p || p.account_id !== input.accountId) {
    throw new MemberLoginError("Member not found", 404);
  }
  if (p.account_role === "owner") {
    throw new MemberLoginError("The owner's password can't be reset here", 400);
  }

  const password = generateOneTimePassword();
  const { data, error } = await admin.auth.admin.updateUserById(input.targetUserId, {
    password,
    app_metadata: { must_change_password: true },
  });
  if (error || !data?.user) {
    console.error("[member-logins] reset updateUserById failed:", error);
    throw new MemberLoginError("Failed to reset the password", 500);
  }
  const email = data.user.email ?? "";
  return {
    userId: input.targetUserId,
    login: emailToUsername(email) ?? email,
    password,
  };
}
