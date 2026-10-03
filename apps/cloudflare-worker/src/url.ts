import { ApplicationError } from "./errors";
import type { WorkerConfig } from "./config";

export interface ValidatedSourceUrl {
  url: string;
  hostname: string;
  sourceHost: string;
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
  "metadata.google.com",
  "instance-data.ec2.internal",
  "169.254.169.254",
  "100.100.100.200",
  "192.0.0.192",
]);

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second] = octets as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168)) ||
    (first === 198 && second >= 18 && second <= 19) ||
    first >= 224
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (!value.includes(":")) return false;
  // URL.hostname serializes IPv6 compressed and in hex (::ffff:7f00:1), so
  // block whole prefixes that embed or reach IPv4 rather than re-deriving the
  // IPv4 ranges. Every address in ::/96 (unspecified, loopback, IPv4-compatible)
  // and ::ffff:0:0/96 (IPv4-mapped) serializes with a leading "::"; anything
  // else with one is in ::/32, unallocated space inside the IETF-reserved ::/8.
  return (
    value.startsWith("::") ||
    value.startsWith("64:ff9b:") || // 64:ff9b::/32: NAT64 64:ff9b::/96 and local-use 64:ff9b:1::/48
    value.startsWith("2002:") || // 6to4
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    /^fe[89a-f]/u.test(value) || // link-local fe80::/10 and site-local fec0::/10
    value.startsWith("ff")
  );
}

export function isBlockedHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return BLOCKED_HOSTNAMES.has(normalized) || isPrivateIpv4(normalized) || isPrivateIpv6(normalized);
}

export function normalizeHostname(hostname: string): string {
  // URL.hostname applies IDNA/punycode normalization in the Worker runtime.
  const candidate = hostname.trim().replace(/\.$/u, "");
  try {
    return new URL(`http://${candidate}`).hostname.toLowerCase().replace(/\.$/u, "");
  } catch {
    return candidate.toLowerCase();
  }
}

export function isAllowedHostname(hostname: string, allowedHosts: ReadonlySet<string>): boolean {
  const normalized = normalizeHostname(hostname);
  if (isBlockedHost(normalized)) return false;
  return allowedHosts.has(normalized);
}

export function validateSourceUrl(input: string, config: Pick<WorkerConfig, "allowedSourceHosts" | "maxUrlLength">): ValidatedSourceUrl {
  if (typeof input !== "string" || input.length === 0 || input.length > config.maxUrlLength) {
    throw new ApplicationError("INVALID_URL", { status: 400 });
  }
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new ApplicationError("INVALID_URL", { status: 400 });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ApplicationError("INVALID_URL", { status: 400 });
  }
  if (parsed.username || parsed.password || !parsed.hostname || isBlockedHost(parsed.hostname)) {
    throw new ApplicationError("INVALID_URL", { status: 400 });
  }
  const hostname = normalizeHostname(parsed.hostname);
  if (!isAllowedHostname(hostname, config.allowedSourceHosts)) {
    throw new ApplicationError("UNSUPPORTED_HOST", { status: 400 });
  }
  parsed.hash = "";
  return { url: parsed.toString(), hostname, sourceHost: hostname };
}

export function extractSingleUrl(text: string): string | null {
  const matches = text.match(/https?:\/\/[^\s<>]+/giu) ?? [];
  if (matches.length !== 1) return null;
  return matches[0]?.replace(/[),.;!?]+$/u, "") ?? null;
}
