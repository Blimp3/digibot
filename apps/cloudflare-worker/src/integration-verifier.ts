import { IntegrationFailure, type IntegrationInput } from "./integration-store";

export const IMAGE_POLICY = "content-provenance-c2pa-6273cdcb4f27-v2";
export const AUDIO_POLICY = "openai-content-provenance-v1";
const UUID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/iu;
const ISO_DATE_TIME = /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|02-(?:0[1-9]|1\d|2[0-8])))T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;

type Verdict = "openai_signal_detected" | "no_supported_openai_signal" | "indeterminate";
type SignalOutcome = "detected" | "not_detected";
type ValidationState = "trusted" | "valid" | "invalid" | "not_present";
type CacheSource = "fresh" | "local_cache" | "server_cache";

export interface IntegrationVerifierSignal {
  type: "c2pa" | "synthid";
  outcome: SignalOutcome;
  validationState: ValidationState | null;
  issuer: string | null;
  model: string | null;
  generatedAt: string | null;
}

export interface IntegrationVerifierContentCredentials {
  status: "not_present" | "verified" | "invalid" | "unavailable";
  signatureValid: boolean;
  contentBindingValid: boolean;
  signerTrusted: boolean;
  issuer: string | null;
  actions: Array<{ action: string; digitalSourceType: string | null }>;
  aiDeclaration: "generated" | "edited" | null;
  validationCodes: string[];
  trustListVersion: string;
}

export interface IntegrationVerifierResult {
  verdict: Verdict;
  summary: string;
  signals: IntegrationVerifierSignal[];
  warnings: string[];
  checkedAt: string;
  requestId: string;
  contentCredentials?: IntegrationVerifierContentCredentials;
}

export interface IntegrationVerifierCacheMetadata {
  source: CacheSource;
  originallyCheckedAt: string;
  expiresAt: string;
  verificationPolicyVersion: string;
  resultSchemaVersion: number;
}

export interface IntegrationVerifierResponse {
  result: IntegrationVerifierResult;
  cache: IntegrationVerifierCacheMetadata | null;
}

function invalid(): never {
  throw new IntegrationFailure(503, "verification_failed", "Verification returned an invalid response.", true);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function trimmedString(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string") return invalid();
  const normalized = value.trim();
  return normalized.length >= minimum && normalized.length <= maximum ? normalized : invalid();
}

function nullableString(value: unknown, maximum: number, minimum = 0): string | null {
  return value === null ? null : trimmedString(value, minimum, maximum);
}

function isoDateTime(value: unknown): string {
  return typeof value === "string" && ISO_DATE_TIME.test(value) && Number.isFinite(Date.parse(value)) ? value : invalid();
}

function parseSignal(value: unknown): IntegrationVerifierSignal {
  if (!record(value) || !exactKeys(value, ["type", "outcome", "validationState", "issuer", "model", "generatedAt"])) return invalid();
  if (!oneOf(value.type, ["c2pa", "synthid"] as const)
    || !oneOf(value.outcome, ["detected", "not_detected"] as const)
    || !(value.validationState === null || oneOf(value.validationState, ["trusted", "valid", "invalid", "not_present"] as const))) return invalid();
  return {
    type: value.type,
    outcome: value.outcome,
    validationState: value.validationState,
    issuer: nullableString(value.issuer, 512),
    model: nullableString(value.model, 512),
    generatedAt: value.generatedAt === null ? null : isoDateTime(value.generatedAt),
  };
}

function parseContentCredentials(value: unknown): IntegrationVerifierContentCredentials {
  if (!record(value) || !exactKeys(value, [
    "status", "signatureValid", "contentBindingValid", "signerTrusted", "issuer", "actions",
    "aiDeclaration", "validationCodes", "trustListVersion",
  ])) return invalid();
  if (!oneOf(value.status, ["not_present", "verified", "invalid", "unavailable"] as const)
    || typeof value.signatureValid !== "boolean" || typeof value.contentBindingValid !== "boolean"
    || typeof value.signerTrusted !== "boolean" || !Array.isArray(value.actions) || value.actions.length > 20
    || !(value.aiDeclaration === null || oneOf(value.aiDeclaration, ["generated", "edited"] as const))
    || !Array.isArray(value.validationCodes) || value.validationCodes.length > 30) return invalid();

  const actions = value.actions.map((action) => {
    if (!record(action) || !exactKeys(action, ["action", "digitalSourceType"])) return invalid();
    return {
      action: trimmedString(action.action, 1, 128),
      digitalSourceType: nullableString(action.digitalSourceType, 256, 1),
    };
  });
  const validationCodes = value.validationCodes.map((code) => trimmedString(code, 1, 128));
  const integrityVerified = value.signatureValid && value.contentBindingValid;
  if ((value.status === "verified" && !integrityVerified)
    || (value.status !== "verified" && (value.signerTrusted || value.aiDeclaration !== null))
    || (value.status === "not_present" && (value.signatureValid || value.contentBindingValid || actions.length > 0))) return invalid();

  return {
    status: value.status,
    signatureValid: value.signatureValid,
    contentBindingValid: value.contentBindingValid,
    signerTrusted: value.signerTrusted,
    issuer: nullableString(value.issuer, 512),
    actions,
    aiDeclaration: value.aiDeclaration,
    validationCodes,
    trustListVersion: trimmedString(value.trustListVersion, 1, 64),
  };
}

function parseResult(value: unknown): IntegrationVerifierResult {
  if (!record(value) || !exactKeys(value, ["verdict", "summary", "signals", "warnings", "checkedAt", "requestId"], ["contentCredentials"])) return invalid();
  if (!oneOf(value.verdict, ["openai_signal_detected", "no_supported_openai_signal", "indeterminate"] as const)
    || !Array.isArray(value.signals) || value.signals.length > 10
    || !Array.isArray(value.warnings) || value.warnings.length > 10
    || typeof value.requestId !== "string" || !UUID.test(value.requestId)) return invalid();
  const signals = value.signals.map(parseSignal);
  const warnings = value.warnings.map((warning) => trimmedString(warning, 1, 1_000));
  const hasDetected = signals.some((signal) => signal.outcome === "detected");
  const hasReliableDetection = signals.some((signal) => signal.outcome === "detected"
    && (signal.type === "synthid" || signal.validationState === "trusted" || signal.validationState === "valid"));
  if ((value.verdict === "openai_signal_detected" && !hasReliableDetection)
    || (value.verdict === "no_supported_openai_signal" && hasDetected)) return invalid();

  const contentCredentials = Object.hasOwn(value, "contentCredentials")
    ? parseContentCredentials(value.contentCredentials)
    : undefined;
  return {
    verdict: value.verdict,
    summary: trimmedString(value.summary, 1, 1_000),
    signals,
    warnings,
    checkedAt: isoDateTime(value.checkedAt),
    requestId: value.requestId,
    ...(contentCredentials ? { contentCredentials } : {}),
  };
}

function parseCache(
  value: unknown,
  result: IntegrationVerifierResult,
  input: IntegrationInput,
): IntegrationVerifierCacheMetadata | null {
  if (value === null) return null;
  if (!record(value) || !exactKeys(value, [
    "source", "originallyCheckedAt", "expiresAt", "verificationPolicyVersion", "resultSchemaVersion",
  ])) return invalid();
  const image = input.media.mimeType.startsWith("image/");
  const expectedPolicy = image ? IMAGE_POLICY : AUDIO_POLICY;
  const expectedSchema = image ? 2 : 1;
  if (!oneOf(value.source, ["fresh", "local_cache", "server_cache"] as const)
    || value.verificationPolicyVersion !== expectedPolicy || value.resultSchemaVersion !== expectedSchema
    || !Number.isSafeInteger(value.resultSchemaVersion) || Number(value.resultSchemaVersion) <= 0) return invalid();
  const originallyCheckedAt = isoDateTime(value.originallyCheckedAt);
  const expiresAt = isoDateTime(value.expiresAt);
  if (originallyCheckedAt !== result.checkedAt || Date.parse(expiresAt) <= Date.parse(originallyCheckedAt)
    || (input.forceRecheck && value.source !== "fresh")) return invalid();
  return {
    source: value.source,
    originallyCheckedAt,
    expiresAt,
    verificationPolicyVersion: expectedPolicy,
    resultSchemaVersion: expectedSchema,
  };
}

/** Validate the complete private Lens response before it becomes authoritative History. */
export function parseIntegrationVerifierResponse(value: unknown, input: IntegrationInput): IntegrationVerifierResponse {
  if (input.action !== "check" || !record(value) || !exactKeys(value, ["result", "cache"])) return invalid();
  const result = parseResult(value.result);
  const cache = parseCache(value.cache, result, input);
  if (result.verdict === "indeterminate" && cache !== null) return invalid();
  // Integrated Lens may return a completed result with null cache metadata when its cache write fails.
  return { result, cache };
}
