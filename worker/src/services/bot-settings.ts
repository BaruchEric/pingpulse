const KEYS = {
  MUTED_UNTIL: "muted_until",
  DEFAULT_CLIENT: "default_client",
} as const;

export { KEYS as BOT_SETTING_KEYS };

export async function getMuteUntil(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare(`SELECT value FROM bot_settings WHERE key = '${KEYS.MUTED_UNTIL}'`)
    .first<{ value: string }>();

  if (!row) return null;
  const until = parseInt(row.value, 10);
  if (until <= Date.now()) {
    // Clean up expired mute row
    await db.prepare(`DELETE FROM bot_settings WHERE key = '${KEYS.MUTED_UNTIL}'`).run();
    return null;
  }
  return until;
}

export async function getDefaultClient(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM bot_settings WHERE key = '${KEYS.DEFAULT_CLIENT}'`)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setDefaultClient(db: D1Database, clientId: string): Promise<void> {
  await db.prepare(
    `INSERT INTO bot_settings (key, value, updated_at) VALUES ('${KEYS.DEFAULT_CLIENT}', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(clientId)
    .run();
}
