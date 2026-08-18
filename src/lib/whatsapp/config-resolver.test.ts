import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getConfigForConversation, getPrimaryConfig } from "./config-resolver";

// Minimal chainable stub of the PostgREST query builder used by the resolver.
// Supports the exact chain shapes the resolver calls:
//   .from(t).select(..).eq(..).eq(..).maybeSingle()
//   .from(t).select(..).eq(..).order(..).order(..).limit(..).maybeSingle()
type Row = Record<string, unknown>;
type Tables = { conversations?: Row[]; whatsapp_config?: Row[] };

function makeDb(tables: Tables): SupabaseClient {
  return {
    from(table: keyof Tables) {
      const filters: Record<string, unknown> = {};
      let primaryFirst = false;
      const builder = {
        select() {
          return builder;
        },
        eq(col: string, val: unknown) {
          filters[col] = val;
          return builder;
        },
        order(col: string, opts?: { ascending?: boolean }) {
          if (col === "is_primary" && opts?.ascending === false) {
            primaryFirst = true;
          }
          return builder;
        },
        limit() {
          return builder;
        },
        async maybeSingle() {
          let rows = (tables[table] ?? []).filter((r) =>
            Object.entries(filters).every(([k, v]) => r[k] === v),
          );
          if (primaryFirst) {
            rows = [...rows].sort(
              (a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0),
            );
          }
          return { data: rows[0] ?? null, error: null };
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const ACCOUNT = "acct-1";
const primaryCfg = {
  id: "cfg-a",
  account_id: ACCOUNT,
  phone_number_id: "111",
  access_token: "enc-a",
  is_primary: true,
};
const secondaryCfg = {
  id: "cfg-b",
  account_id: ACCOUNT,
  phone_number_id: "222",
  access_token: "enc-b",
  is_primary: false,
};

describe("getConfigForConversation", () => {
  it("returns the config matching the conversation's tagged number", async () => {
    const db = makeDb({
      conversations: [
        { id: "conv-1", account_id: ACCOUNT, phone_number_id: "222" },
      ],
      whatsapp_config: [primaryCfg, secondaryCfg],
    });
    const cfg = await getConfigForConversation(db, "conv-1", ACCOUNT);
    expect(cfg.id).toBe("cfg-b");
    expect(cfg.phone_number_id).toBe("222");
  });

  it("falls back to the primary config when the conversation has no tag", async () => {
    const db = makeDb({
      conversations: [
        { id: "conv-2", account_id: ACCOUNT, phone_number_id: null },
      ],
      whatsapp_config: [primaryCfg, secondaryCfg],
    });
    const cfg = await getConfigForConversation(db, "conv-2", ACCOUNT);
    expect(cfg.id).toBe("cfg-a");
  });

  it("falls back to primary when the tagged number's config no longer exists", async () => {
    const db = makeDb({
      conversations: [
        { id: "conv-3", account_id: ACCOUNT, phone_number_id: "999" },
      ],
      whatsapp_config: [primaryCfg],
    });
    const cfg = await getConfigForConversation(db, "conv-3", ACCOUNT);
    expect(cfg.id).toBe("cfg-a");
  });

  it("never crosses tenants: a same-id conversation on another account is ignored", async () => {
    const db = makeDb({
      conversations: [
        { id: "conv-1", account_id: "other", phone_number_id: "222" },
      ],
      whatsapp_config: [primaryCfg, secondaryCfg],
    });
    // conv-1 belongs to "other", so lookup by (id, ACCOUNT) misses -> primary.
    const cfg = await getConfigForConversation(db, "conv-1", ACCOUNT);
    expect(cfg.id).toBe("cfg-a");
  });
});

describe("getPrimaryConfig", () => {
  it("prefers the is_primary row", async () => {
    const db = makeDb({ whatsapp_config: [secondaryCfg, primaryCfg] });
    const cfg = await getPrimaryConfig(db, ACCOUNT);
    expect(cfg.id).toBe("cfg-a");
  });

  it("throws when the account has no config", async () => {
    const db = makeDb({ whatsapp_config: [] });
    await expect(getPrimaryConfig(db, ACCOUNT)).rejects.toThrow(
      "WhatsApp not configured",
    );
  });
});
