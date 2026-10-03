import { describe, expect, it, vi } from "vitest";
import { logStructured } from "../src/logging";

describe("structured operational logging", () => {
  it("allowlists container diagnostics and drops private payloads", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logStructured("media_container_prepare_failed", {
      errorStage: "container_prepare",
      containerDiagnostics: {
        error_stage: "probe", failure_reason: "no_formats", process_name: "yt-dlp",
        process_exit_code: 1, process_timed_out: false,
        stderr: "https://private.invalid/?token=secret", args: ["cookie=secret"], title: "private title",
      },
    });
    const payload = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      error_stage: "container_prepare", container_error_stage: "probe", container_failure_reason: "no_formats",
      process_name: "yt-dlp", process_exit_code: 1, process_timed_out: false,
    });
    expect(JSON.stringify(payload)).not.toMatch(/private|secret|stderr|cookie/u);
    output.mockRestore();
  });

  it.each([undefined, null, [], "secret", {
    error_stage: "private-stage", failure_reason: "https://private.invalid", process_name: "/private/binary",
    process_exit_code: true, process_timed_out: "secret",
  }, { process_exit_code: 2 ** 32 }, { process_exit_code: NaN }])("ignores absent or malformed container diagnostics: %j", (containerDiagnostics) => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logStructured("media_container_prepare_failed", { containerDiagnostics });
    const payload = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(Object.keys(payload).sort()).toEqual(["event", "timestamp"]);
    output.mockRestore();
  });

  it("emits allowlisted diagnostics without Telegram identifiers or arbitrary input", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logStructured("media_job_failed", {
      jobId: "job-safe-reference",
      updateId: "telegram-update-must-not-be-logged",
      sourceHost: "youtube.com",
      errorCode: "DOWNLOAD_FAILED",
      errorStage: "container_prepare",
      failureReason: "workflow_wrapper",
      workflowAttempt: 4,
      workflowErrorName: "WorkflowInternalError",
      workflowErrorCodeRecovered: true,
      sourceUrl: "https://example.invalid/private",
      token: "must-not-appear",
      stderr: "must-not-appear",
    } as never);

    expect(output).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(output.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(payload).toMatchObject({
      event: "media_job_failed",
      job_id: "job-safe-reference",
      source_host: "youtube.com",
      error_code: "DOWNLOAD_FAILED",
      error_stage: "container_prepare",
      failure_reason: "workflow_wrapper",
      workflow_attempt: 4,
      workflow_error_name: "WorkflowInternalError",
      workflow_error_code_recovered: true,
    });
    expect(payload).not.toHaveProperty("update_id");
    expect(JSON.stringify(payload)).not.toContain("telegram-update-must-not-be-logged");
    expect(JSON.stringify(payload)).not.toContain("example.invalid");
    expect(JSON.stringify(payload)).not.toContain("must-not-appear");

    output.mockRestore();
  });
});
