import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const plantedKey = `aws_key = ${["AKIA", "SYNTHETIC0TEST0KEY"].join("")}\n`;

function scanCopy(initRepo: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "secret-scan-"));
  if (initRepo) expect(spawnSync("git", ["init", "--quiet"], { cwd: directory }).status).toBe(0);
  mkdirSync(join(directory, "scripts"));
  copyFileSync(join(root, "scripts/scan-secrets.sh"), join(directory, "scripts/scan-secrets.sh"));
  const scan = () => spawnSync("/bin/bash", [join(directory, "scripts/scan-secrets.sh")], {
    encoding: "utf8",
    timeout: 20_000,
    // Never let a copy outside a repository fall back to an enclosing one.
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(directory) },
  });
  return { directory, scan };
}

describe("secret scan", () => {
  it("fails on a planted access key, also in a path marked binary, and passes once it is gone", () => {
    const { directory, scan } = scanCopy(true);
    const note = join(directory, "note.txt");
    try {
      writeFileSync(note, plantedKey);
      const flagged = scan();
      expect(flagged.status).toBe(1);
      expect(flagged.stdout).toContain("note.txt:1:");

      writeFileSync(join(directory, ".gitattributes"), "note.txt binary\n");
      const binary = scan();
      expect(binary.status).toBe(1);
      expect(binary.stdout).toContain("Binary file note.txt matches");

      writeFileSync(note, "nothing secret here\n");
      const clean = scan();
      expect(clean.status).toBe(0);
      expect(clean.stdout).toContain("No high-confidence secret patterns found");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("fails closed when git cannot run the scan", () => {
    const { directory, scan } = scanCopy(false);
    try {
      const result = scan();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Secret scan could not run");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  // root reads any file, so only a non-root run (CI, the Mac) can see the error path.
  it.skipIf(process.getuid?.() === 0)("fails closed when a file could not be read", () => {
    const { directory, scan } = scanCopy(true);
    try {
      writeFileSync(join(directory, "unreadable.txt"), "nothing secret here\n");
      chmodSync(join(directory, "unreadable.txt"), 0o000);
      const result = scan();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Secret scan could not run");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
