import { describe, expect, it } from "vitest";

import type { Conversation } from "@/types";
import { sortConversationsByActivity } from "./conversation-order";

function conversation(
  id: string,
  createdAt: string,
  lastMessageAt?: string,
): Conversation {
  return {
    id,
    user_id: "user-id",
    contact_id: `contact-${id}`,
    status: "open",
    unread_count: 0,
    created_at: createdAt,
    updated_at: createdAt,
    last_message_at: lastMessageAt,
  };
}

describe("sortConversationsByActivity", () => {
  it("does not pin a missing last-message timestamp ahead of active chats", () => {
    const stale = conversation("stale", "2026-07-20T00:00:00.000Z");
    const active = conversation(
      "active",
      "2026-07-01T00:00:00.000Z",
      "2026-07-28T00:00:00.000Z",
    );

    expect(sortConversationsByActivity([stale, active]).map((row) => row.id)).toEqual([
      "active",
      "stale",
    ]);
  });

  it("uses created_at for a new conversation that has no messages yet", () => {
    const older = conversation("older", "2026-07-20T00:00:00.000Z");
    const newer = conversation("newer", "2026-07-28T00:00:00.000Z");

    expect(sortConversationsByActivity([older, newer]).map((row) => row.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("does not mutate the caller's array", () => {
    const rows = [
      conversation("older", "2026-07-20T00:00:00.000Z"),
      conversation("newer", "2026-07-28T00:00:00.000Z"),
    ];

    sortConversationsByActivity(rows);

    expect(rows.map((row) => row.id)).toEqual(["older", "newer"]);
  });
});
