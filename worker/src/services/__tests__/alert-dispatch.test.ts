import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dispatchAlert, type AlertPayload } from "@/services/alert-dispatch";
import type { Env } from "@/index";

const mockDB = {
  prepare: () => ({
    bind: () => ({
      first: () => Promise.resolve(null),
      run: () => Promise.resolve(),
    }),
    first: () => Promise.resolve(null),
  }),
} as unknown as D1Database;

const baseAlert: AlertPayload = {
  alert_id: "test-1",
  client_id: "client-1",
  client_name: "Test Client",
  type: "high_latency",
  severity: "warning",
  value: 300,
  threshold: 250,
  timestamp: "2026-03-22T12:00:00Z",
};

describe("dispatchAlert", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns email:true, telegram:true on success", async () => {
    fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));

    const env = {
      DB: mockDB,
      RESEND_API_KEY: "re_test",
      ALERT_FROM_EMAIL: "from@test.com",
      ALERT_TO_EMAIL: "to@test.com",
      TELEGRAM_BOT_TOKEN: "bot123",
      TELEGRAM_CHAT_ID: "chat456",
    } as unknown as Env;

    const result = await dispatchAlert(env, baseAlert);
    expect(result).toEqual({ email: true, telegram: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns email:false when Resend fails", async () => {
    fetchSpy.mockImplementation((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("resend")) return Promise.reject(new Error("network"));
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const env = {
      DB: mockDB,
      RESEND_API_KEY: "re_test",
      TELEGRAM_BOT_TOKEN: "bot123",
      TELEGRAM_CHAT_ID: "chat456",
    } as unknown as Env;

    const result = await dispatchAlert(env, baseAlert);
    expect(result.email).toBe(false);
    expect(result.telegram).toBe(true);
  });

  it("skips channels when env vars missing", async () => {
    const env = {} as unknown as Env;
    const result = await dispatchAlert(env, baseAlert);
    expect(result).toEqual({ email: false, telegram: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
