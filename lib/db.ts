import { neon } from "@neondatabase/serverless";
import { setupDatabase } from "./schema";

const client = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

// A tagged-template proxy: every query first awaits table setup (once per
// server instance, retried if it failed), then runs normally. null when
// DATABASE_URL isn't set — every caller has an in-memory fallback.
export const sql = client
  ? (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      await setupDatabase(client);
      return (client as any)(strings, ...values) as Promise<any[]>;
    })
  : null;
