import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  admitIntegrationInvite,
  approveIntegrationPairing,
  authenticateIntegrationRequest,
  createIntegrationInvitation,
  createIntegrationPairing,
  exchangeIntegrationPairing,
  getIntegrationPairingSummary,
  handleIntegrationAuth,
  INTEGRATION_AUTH_POLICY,
  integrationAccountForTelegram,
  refreshIntegrationSession,
  revokeIntegrationInvitation,
} from "../src/integration-auth";
import type { IntegrationAuthEnv, IntegrationSessionCredentials } from "../src/integration-auth";
import { authenticateMiniAppRequest } from "../src/mini-app-auth";
import { bytesToBase64Url } from "../src/security";
import type { D1BatchDatabaseLike } from "../src/types";
import { localD1 } from "./helpers/local-d1";

const NOW = 1_800_000_000;
const BOT_TOKEN = "integration-test-bot-token";
const LEGACY_USERS = "12345,67890";
const UUID_V4_FOR_TEST = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const encoder = new TextEncoder();
let db: D1BatchDatabaseLike;
let dispose: () => Promise<void>;
let env: IntegrationAuthEnv;
let tokenSeed = 1;

function verifier(seed = tokenSeed++): string {
  return bytesToBase64Url(new Uint8Array(32).fill(seed));
}

async function hmac(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(keyBytes).buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signedInitData(userId: number): Promise<string> {
  const fields = {
    auth_date: String(NOW),
    query_id: `query-${userId}`,
    user: JSON.stringify({ id: userId, first_name: "Test" }),
  };
  const dataCheckString = Object.entries(fields)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = await hmac(encoder.encode("WebAppData"), BOT_TOKEN);
  return new URLSearchParams({
    ...fields,
    hash: hex(await hmac(secretKey, dataCheckString)),
  }).toString();
}

async function pairedSession(userId: string, seed = tokenSeed++): Promise<IntegrationSessionCredentials> {
  const privateVerifier = verifier(seed);
  const pairing = await createIntegrationPairing(env, {
    verifier: privateVerifier,
    deviceName: `Device ${seed}`,
  }, NOW);
  const summary = await getIntegrationPairingSummary(env, {
    pairId: pairing.pairId,
    telegramUserId: userId,
    privateChatId: userId,
  }, NOW);
  expect(summary?.confirmationCode).toBe(pairing.confirmationCode);
  await expect(approveIntegrationPairing(env, {
    pairId: pairing.pairId,
    confirmationCode: pairing.confirmationCode,
    telegramUserId: userId,
    privateChatId: userId,
  }, NOW)).resolves.toMatchObject({ telegramUserId: userId });
  const session = await exchangeIntegrationPairing(env, {
    pairId: pairing.pairId,
    verifier: privateVerifier,
  }, NOW);
  if (!session) throw new Error("Expected paired session");
  return session;
}

function authorizedRequest(token: string, path = "/api/integration/history", method = "GET"): Request {
  return new Request(`https://worker.example${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeAll(async () => {
  ({ db, dispose } = await localD1());
  env = { DB: db, TELEGRAM_BOT_TOKEN: BOT_TOKEN, ALLOWED_TELEGRAM_USER_IDS: LEGACY_USERS };
});

beforeEach(async () => {
  tokenSeed = 1;
  await db.batch([
    db.prepare("DELETE FROM integration_sessions"),
    db.prepare("DELETE FROM integration_pairing_claims"),
    db.prepare("DELETE FROM integration_pairings"),
    db.prepare("DELETE FROM integration_accounts"),
    db.prepare("DELETE FROM integration_invitation_claims"),
    db.prepare("DELETE FROM integration_invitations"),
    db.prepare("DELETE FROM integration_rate_limits"),
  ]);
});

afterAll(async () => dispose());

describe("integration account admission", () => {
  it("keeps invite use atomic and prevents invited users from issuing invites or gaining legacy auth", async () => {
    const invitation = await createIntegrationInvitation(env, { issuerTelegramUserId: "12345" }, NOW);
    expect(invitation?.inviteToken).toMatch(/^inv_[A-Za-z0-9_-]{43}$/u);
    if (!invitation) throw new Error("Expected invitation");

    const [first, second] = await Promise.all([
      admitIntegrationInvite(env, {
        inviteToken: invitation.inviteToken,
        telegramUserId: "55555",
        privateChatId: "55555",
      }, NOW),
      admitIntegrationInvite(env, {
        inviteToken: invitation.inviteToken,
        telegramUserId: "66666",
        privateChatId: "66666",
      }, NOW),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM integration_invitation_claims").first()).toEqual({ count: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM integration_accounts").first()).toEqual({ count: 1 });

    const invited = first ?? second;
    if (!invited) throw new Error("Expected one admitted account");
    expect(await createIntegrationInvitation(env, { issuerTelegramUserId: invited.telegramUserId }, NOW)).toBeNull();
    const initData = await signedInitData(Number(invited.telegramUserId));
    const tmaRequest = new Request("https://worker.example/api/integration/history", {
      headers: { authorization: `tma ${initData}` },
    });
    await expect(authenticateIntegrationRequest(tmaRequest, env, NOW)).resolves.toMatchObject({
      ok: true,
      principal: { accountId: invited.accountId, sessionId: null, authMethod: "telegram_init_data" },
    });
    await expect(authenticateMiniAppRequest(tmaRequest, BOT_TOKEN, LEGACY_USERS, NOW)).resolves.toBeNull();
  });

  it("requires a confirmed private identity and rejects revoked, expired, or replayed invites", async () => {
    const mismatch = await createIntegrationInvitation(env, { issuerTelegramUserId: "12345" }, NOW);
    if (!mismatch) throw new Error("Expected invitation");
    await expect(admitIntegrationInvite(env, {
      inviteToken: mismatch.inviteToken,
      telegramUserId: "55555",
      privateChatId: "99999",
    }, NOW)).resolves.toBeNull();

    const expired = await createIntegrationInvitation(env, {
      issuerTelegramUserId: "12345",
      ttlSeconds: INTEGRATION_AUTH_POLICY.pairingTtlSeconds,
    }, NOW);
    if (!expired) throw new Error("Expected invitation");
    await expect(admitIntegrationInvite(env, {
      inviteToken: expired.inviteToken,
      telegramUserId: "55555",
      privateChatId: "55555",
    }, NOW + INTEGRATION_AUTH_POLICY.pairingTtlSeconds)).resolves.toBeNull();

    const revoked = await createIntegrationInvitation(env, { issuerTelegramUserId: "12345" }, NOW);
    if (!revoked) throw new Error("Expected invitation");
    await expect(revokeIntegrationInvitation(env, {
      issuerTelegramUserId: "12345",
      invitationId: revoked.invitationId,
    }, NOW)).resolves.toBe(true);
    await expect(admitIntegrationInvite(env, {
      inviteToken: revoked.inviteToken,
      telegramUserId: "55555",
      privateChatId: "55555",
    }, NOW)).resolves.toBeNull();
  });
});

describe("pairing and sessions", () => {
  it("atomically consumes one approved pairing and rejects wrong, replayed, and expired verifiers", async () => {
    const privateVerifier = verifier();
    const pairing = await createIntegrationPairing(env, { verifier: privateVerifier, deviceName: "Lens" }, NOW);
    await approveIntegrationPairing(env, {
      pairId: pairing.pairId,
      confirmationCode: pairing.confirmationCode,
      telegramUserId: "12345",
      privateChatId: "12345",
    }, NOW);

    await expect(exchangeIntegrationPairing(env, {
      pairId: pairing.pairId,
      verifier: verifier(),
    }, NOW)).resolves.toBeNull();
    const [left, right] = await Promise.all([
      exchangeIntegrationPairing(env, { pairId: pairing.pairId, verifier: privateVerifier }, NOW),
      exchangeIntegrationPairing(env, { pairId: pairing.pairId, verifier: privateVerifier }, NOW),
    ]);
    expect([left, right].filter(Boolean)).toHaveLength(1);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM integration_pairing_claims").first()).toEqual({ count: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM integration_sessions").first()).toEqual({ count: 1 });
    await expect(exchangeIntegrationPairing(env, {
      pairId: pairing.pairId,
      verifier: privateVerifier,
    }, NOW)).resolves.toBeNull();

    const expiringVerifier = verifier();
    const expiring = await createIntegrationPairing(env, { verifier: expiringVerifier, deviceName: "Expired" }, NOW);
    await approveIntegrationPairing(env, {
      pairId: expiring.pairId,
      confirmationCode: expiring.confirmationCode,
      telegramUserId: "12345",
      privateChatId: "12345",
    }, NOW);
    await expect(exchangeIntegrationPairing(env, {
      pairId: expiring.pairId,
      verifier: expiringVerifier,
    }, NOW + INTEGRATION_AUTH_POLICY.pairingTtlSeconds)).resolves.toBeNull();

    const revokedVerifier = verifier();
    const revoked = await createIntegrationPairing(env, { verifier: revokedVerifier, deviceName: "Revoked" }, NOW);
    const revokedAccount = await approveIntegrationPairing(env, {
      pairId: revoked.pairId,
      confirmationCode: revoked.confirmationCode,
      telegramUserId: "12345",
      privateChatId: "12345",
    }, NOW);
    if (!revokedAccount) throw new Error("Expected approved account");
    await db.prepare("UPDATE integration_accounts SET status = 'revoked', revoked_at = ?1 WHERE id = ?2")
      .bind(NOW, revokedAccount.accountId).run();
    await expect(exchangeIntegrationPairing(env, {
      pairId: revoked.pairId,
      verifier: revokedVerifier,
    }, NOW)).resolves.toBeNull();
    expect(await db.prepare("SELECT COUNT(*) AS count FROM integration_pairing_claims WHERE pairing_id = ?1")
      .bind(revoked.pairId).first()).toEqual({ count: 0 });
  });

  it("rotates refresh and access secrets while keeping the fixed absolute expiry", async () => {
    const session = await pairedSession("12345");
    await expect(authenticateIntegrationRequest(authorizedRequest(session.accessToken), env, NOW)).resolves.toMatchObject({
      ok: true,
      principal: { accountId: session.accountId, sessionId: session.sessionId },
    });

    const rotated = await refreshIntegrationSession(env, session.refreshToken, NOW + 1);
    expect(rotated).toMatchObject({
      accountId: session.accountId,
      sessionId: session.sessionId,
      absoluteExpiresAt: session.absoluteExpiresAt,
    });
    if (!rotated) throw new Error("Expected rotated session");
    expect(rotated.accessToken).not.toBe(session.accessToken);
    expect(rotated.refreshToken).not.toBe(session.refreshToken);
    await expect(refreshIntegrationSession(env, session.refreshToken, NOW + 1)).resolves.toBeNull();
    await expect(authenticateIntegrationRequest(authorizedRequest(session.accessToken), env, NOW + 1)).resolves.toMatchObject({
      ok: false,
      code: "UNAUTHORIZED",
    });
    await expect(authenticateIntegrationRequest(authorizedRequest(rotated.accessToken), env, NOW + 1)).resolves.toMatchObject({ ok: true });
    await expect(authenticateIntegrationRequest(
      authorizedRequest(rotated.accessToken),
      env,
      NOW + 1 + INTEGRATION_AUTH_POLICY.accessTtlSeconds,
    )).resolves.toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    await expect(refreshIntegrationSession(
      env,
      rotated.refreshToken,
      NOW + INTEGRATION_AUTH_POLICY.sessionAbsoluteTtlSeconds,
    )).resolves.toBeNull();
  });

  it("binds revocation to the authenticated account across two accounts", async () => {
    const first = await pairedSession("12345", 10);
    const second = await pairedSession("67890", 11);

    expect((await handleIntegrationAuth(
      authorizedRequest(first.accessToken, `/api/integration/sessions/${second.sessionId}`, "DELETE"),
      env,
      NOW,
    ))?.status).toBe(204);
    await expect(authenticateIntegrationRequest(authorizedRequest(second.accessToken), env, NOW)).resolves.toMatchObject({
      ok: true,
      principal: { accountId: second.accountId },
    });

    expect((await handleIntegrationAuth(
      authorizedRequest(second.accessToken, `/api/integration/sessions/${second.sessionId}`, "DELETE"),
      env,
      NOW,
    ))?.status).toBe(204);
    await expect(authenticateIntegrationRequest(authorizedRequest(second.accessToken), env, NOW)).resolves.toMatchObject({
      ok: false,
      code: "UNAUTHORIZED",
    });
  });
});

describe("HTTP admission boundary", () => {
  it("returns the shared top-level pairing/session contract and structured errors", async () => {
    const privateVerifier = verifier();
    const created = await handleIntegrationAuth(new Request("https://worker.example/api/integration/pairings", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
      body: JSON.stringify({ verifier: privateVerifier, deviceName: "Lens contract" }),
    }), env, NOW);
    expect(created?.status).toBe(201);
    if (!created) throw new Error("Expected pairing response");
    const pairing = await created.json() as {
      pairId: string;
      confirmationCode: string;
      expiresAt: string;
    };
    expect(pairing).toEqual({
      pairId: expect.stringMatching(UUID_V4_FOR_TEST),
      confirmationCode: expect.stringMatching(/^\d{6}$/u),
      expiresAt: new Date((NOW + INTEGRATION_AUTH_POLICY.pairingTtlSeconds) * 1000).toISOString(),
    });
    expect(pairing).not.toHaveProperty("ok");
    expect(pairing).not.toHaveProperty("pairing");

    const pending = await handleIntegrationAuth(new Request(
      `https://worker.example/api/integration/pairings/${pairing.pairId}/exchange`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
        body: JSON.stringify({ verifier: privateVerifier }),
      },
    ), env, NOW);
    expect(pending?.status).toBe(409);
    if (!pending) throw new Error("Expected pending pairing response");
    await expect(pending.json()).resolves.toEqual({
      error: {
        code: "pairing_not_ready",
        message: "Approve this pairing in DigiBot, then try again.",
        retryable: true,
      },
    });

    await expect(approveIntegrationPairing(env, {
      pairId: pairing.pairId,
      confirmationCode: pairing.confirmationCode,
      telegramUserId: "12345",
      privateChatId: "12345",
    }, NOW)).resolves.toMatchObject({ telegramUserId: "12345" });
    const exchanged = await handleIntegrationAuth(new Request(
      `https://worker.example/api/integration/pairings/${pairing.pairId}/exchange`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
        body: JSON.stringify({ verifier: privateVerifier }),
      },
    ), env, NOW);
    expect(exchanged?.status).toBe(200);
    if (!exchanged) throw new Error("Expected session response");
    const session = await exchanged.json() as IntegrationSessionCredentials;
    expect(session).toMatchObject({ tokenType: "Bearer", accountId: expect.any(String), sessionId: expect.any(String) });
    expect(session).not.toHaveProperty("ok");
    expect(session).not.toHaveProperty("session");

    const refreshed = await handleIntegrationAuth(new Request("https://worker.example/api/integration/sessions/refresh", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    }), env, NOW + 1);
    expect(refreshed?.status).toBe(200);
    if (!refreshed) throw new Error("Expected refresh response");
    await expect(refreshed.json()).resolves.toMatchObject({
      tokenType: "Bearer",
      accountId: session.accountId,
      sessionId: session.sessionId,
    });
  });

  it("rejects caller-selected account context and rate-limits public pairing creation", async () => {
    const selectedAccount = new Request("https://worker.example/api/integration/pairings", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.5" },
      body: JSON.stringify({ verifier: verifier(), deviceName: "Lens", accountId: "attacker-choice" }),
    });
    expect((await handleIntegrationAuth(selectedAccount, env, NOW))?.status).toBe(400);

    for (let index = 0; index < INTEGRATION_AUTH_POLICY.pairingCreatesPerWindow - 1; index += 1) {
      const response = await handleIntegrationAuth(new Request("https://worker.example/api/integration/pairings", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.5" },
        body: JSON.stringify({ verifier: verifier(), deviceName: `Lens ${index}` }),
      }), env, NOW);
      expect(response?.status).toBe(201);
    }
    const limited = await handleIntegrationAuth(new Request("https://worker.example/api/integration/pairings", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.5" },
      body: JSON.stringify({ verifier: verifier(), deviceName: "One too many" }),
    }), env, NOW);
    expect(limited?.status).toBe(429);
  });

  it("admits only existing legacy users or previously invited accounts through signed TMA", async () => {
    const legacyInitData = await signedInitData(12345);
    const legacyRequest = new Request("https://worker.example/api/integration/history", {
      headers: { authorization: `tma ${legacyInitData}` },
    });
    await expect(authenticateIntegrationRequest(legacyRequest, env, NOW)).resolves.toMatchObject({
      ok: true,
      principal: { telegramUserId: "12345", authMethod: "telegram_init_data" },
    });
    await expect(integrationAccountForTelegram(env, {
      telegramUserId: "77777",
      privateChatId: "77777",
    }, NOW)).resolves.toBeNull();
    const outsider = new Request("https://worker.example/api/integration/history", {
      headers: { authorization: `tma ${await signedInitData(77777)}` },
    });
    await expect(authenticateIntegrationRequest(outsider, env, NOW)).resolves.toMatchObject({
      ok: false,
      code: "UNAUTHORIZED",
    });
  });

  it("applies the authenticated quota to the server-derived account", async () => {
    const session = await pairedSession("12345");
    for (let index = 0; index < INTEGRATION_AUTH_POLICY.authenticatedRequestsPerMinute; index += 1) {
      await expect(authenticateIntegrationRequest(authorizedRequest(session.accessToken), env, NOW))
        .resolves.toMatchObject({ ok: true });
    }
    await expect(authenticateIntegrationRequest(authorizedRequest(session.accessToken), env, NOW))
      .resolves.toMatchObject({ ok: false, status: 429, code: "RATE_LIMITED" });
  }, 15_000);
});
