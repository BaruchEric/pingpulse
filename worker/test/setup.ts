import { env } from "cloudflare:test";
import { hashString } from "@/utils/hash";

export async function seedAdmin(password: string = "testpass123") {
  const hash = await hashString(password);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO admin (id, password_hash, created_at) VALUES (1, ?, ?)"
  )
    .bind(hash, new Date().toISOString())
    .run();
}
