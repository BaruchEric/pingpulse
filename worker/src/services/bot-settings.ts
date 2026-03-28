const KEYS = {
  MUTED_UNTIL: "muted_until",
  DEFAULT_CLIENT: "default_client",
} as const;

export { KEYS as BOT_SETTING_KEYS };

async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM bot_settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function getMuteUntil(db: D1Database): Promise<number | null> {
  const value = await getSetting(db, KEYS.MUTED_UNTIL);
  if (!value) return null;
  const until = parseInt(value, 10);
  if (until <= Date.now()) {
    await db.prepare("DELETE FROM bot_settings WHERE key = ?").bind(KEYS.MUTED_UNTIL).run();
    return null;
  }
  return until;
}

export async function getDefaultClient(db: D1Database): Promise<string | null> {
  return getSetting(db, KEYS.DEFAULT_CLIENT);
}

export async function setDefaultClient(db: D1Database, clientId: string): Promise<void> {
  await db.prepare(
    "INSERT INTO bot_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  )
    .bind(KEYS.DEFAULT_CLIENT, clientId)
    .run();
}
