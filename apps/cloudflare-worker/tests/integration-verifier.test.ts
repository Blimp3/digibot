import { describe, expect, it } from "vitest";
import { parseIntegrationVerifierResponse } from "../src/integration-verifier";
import type { IntegrationVerifierResponse } from "../src/integration-verifier";
import type { IntegrationInput } from "../src/integration-store";

function imageInput(forceRecheck = false): IntegrationInput {
  return {
    version: 1,
    operationId: "11111111-1111-4111-8111-111111111111",
    action: "check",
    forceRecheck,
    media: {
      mediaSha256: "a".repeat(64),
      byteLength: 68,
      mimeType: "image/png",
      inputKind: "original",
      audioDurationSeconds: null,
      segment: null,
      fullSourceSha256: null,
    },
  };
}

function audioInput(): IntegrationInput {
  return {
    ...imageInput(),
    media: {
      ...imageInput().media,
      mimeType: "audio/mpeg",
      audioDurationSeconds: 30,
    },
  };
}

function imageResponse(): IntegrationVerifierResponse {
  return {
    result: {
      verdict: "no_supported_openai_signal",
      summary: "No supported provenance signal was detected.",
      signals: [],
      warnings: [],
      checkedAt: "2026-09-16T10:00:00.000Z",
      requestId: "22222222-2222-4222-8222-222222222222",
      contentCredentials: {
        status: "not_present",
        signatureValid: false,
        contentBindingValid: false,
        signerTrusted: false,
        issuer: null,
        actions: [],
        aiDeclaration: null,
        validationCodes: [],
        trustListVersion: "fixture-v1",
      },
    },
    cache: {
      source: "fresh",
      originallyCheckedAt: "2026-09-16T10:00:00.000Z",
      expiresAt: "2026-09-23T10:00:00.000Z",
      verificationPolicyVersion: "content-provenance-c2pa-6273cdcb4f27-v2",
      resultSchemaVersion: 2,
    },
  };
}

function expectInvalid(value: unknown, input = imageInput()): void {
  expect(() => parseIntegrationVerifierResponse(value, input)).toThrow(expect.objectContaining({
    status: 503,
    code: "verification_failed",
    retryable: true,
  }));
}

describe("private integration verifier response", () => {
  it("accepts complete image and audio evidence under their pinned policy/schema", () => {
    expect(parseIntegrationVerifierResponse(imageResponse(), imageInput())).toEqual(imageResponse());

    const audio = imageResponse();
    audio.result.verdict = "openai_signal_detected";
    audio.result.summary = "A supported signal was detected.";
    audio.result.signals = [{
      type: "synthid",
      outcome: "detected",
      validationState: null,
      issuer: null,
      model: "audio-model",
      generatedAt: null,
    }];
    delete audio.result.contentCredentials;
    if (!audio.cache) throw new Error("Expected audio cache metadata");
    audio.cache.verificationPolicyVersion = "openai-content-provenance-v1";
    audio.cache.resultSchemaVersion = 1;
    expect(parseIntegrationVerifierResponse(audio, audioInput()).result.signals[0]?.type).toBe("synthid");
  });

  it("preserves completed or indeterminate evidence when integrated cache persistence is unavailable", () => {
    const completed = imageResponse();
    completed.cache = null;
    expect(parseIntegrationVerifierResponse(completed, imageInput()).cache).toBeNull();

    const indeterminate = imageResponse();
    indeterminate.result.verdict = "indeterminate";
    indeterminate.result.summary = "The provider was unavailable.";
    indeterminate.cache = null;
    expect(parseIntegrationVerifierResponse(indeterminate, imageInput()).result.verdict).toBe("indeterminate");
  });

  it("rejects unknown metadata and malformed normalized evidence", () => {
    const extra = { ...imageResponse(), accountId: "caller-selected" };
    expectInvalid(extra);

    const unreliable = imageResponse();
    unreliable.result.verdict = "openai_signal_detected";
    unreliable.result.signals = [{
      type: "c2pa", outcome: "detected", validationState: "invalid", issuer: null, model: null, generatedAt: null,
    }];
    expectInvalid(unreliable);

    const inconsistentCredentials = imageResponse();
    if (!inconsistentCredentials.result.contentCredentials) throw new Error("Expected Content Credentials");
    inconsistentCredentials.result.contentCredentials.signatureValid = true;
    expectInvalid(inconsistentCredentials);

    const badDate = imageResponse();
    badDate.result.checkedAt = "2026-02-30T10:00:00.000Z";
    if (!badDate.cache) throw new Error("Expected cache metadata");
    badDate.cache.originallyCheckedAt = badDate.result.checkedAt;
    expectInvalid(badDate);
  });

  it("rejects stale contract metadata, mismatched check time, and invalid cache lifetime", () => {
    const policy = imageResponse();
    if (!policy.cache) throw new Error("Expected cache metadata");
    policy.cache.verificationPolicyVersion = "openai-content-provenance-v1";
    expectInvalid(policy);

    const schema = imageResponse();
    if (!schema.cache) throw new Error("Expected cache metadata");
    schema.cache.resultSchemaVersion = 1;
    expectInvalid(schema);

    const checkTime = imageResponse();
    if (!checkTime.cache) throw new Error("Expected cache metadata");
    checkTime.cache.originallyCheckedAt = "2026-09-16T09:59:59.000Z";
    expectInvalid(checkTime);

    const expired = imageResponse();
    if (!expired.cache) throw new Error("Expected cache metadata");
    expired.cache.expiresAt = expired.cache.originallyCheckedAt;
    expectInvalid(expired);
  });

  it("requires forced checks to be fresh and indeterminate results to be uncached", () => {
    const forcedCache = imageResponse();
    if (!forcedCache.cache) throw new Error("Expected cache metadata");
    forcedCache.cache.source = "server_cache";
    expectInvalid(forcedCache, imageInput(true));

    const indeterminateCache = imageResponse();
    indeterminateCache.result.verdict = "indeterminate";
    expectInvalid(indeterminateCache);
  });
});
