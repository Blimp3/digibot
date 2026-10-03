import { expect, it, vi } from "vitest";
import { parseTranscriptMarkdown, searchTranscript, searchTranscriptDocument, validateTranscriptQuery } from "../src/transcript-search";
const token = "12345:abcdef";
const doc = { file_id: "ABC_123", file_name: "saved transcript.md", file_size: 500 };
const md = (body = "[00:00:00.000] Before.\n\n[00:00:01.000] ＣＡＦÉ   prices <b>rose</b>.\n\n[00:00:02.000] After.") => `# Example\n\nSource: https://example.test/video\nDuration: 00:00:03.000\n\nMethod: Automatic speech transcription (Whisper small)\n\n## Transcript\n\n${body}\n`;
function fetcher(file: Record<string, unknown> = {}, response = new Response(md())) {
  return vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { file_id: doc.file_id, file_size: 500, file_path: "documents/file_1.md", ...file } }))).mockResolvedValueOnce(response);
}
it("normalizes Unicode/whitespace and keeps original plain excerpts and merged neighbors", () => {
  const result = searchTranscript(parseTranscriptMarkdown(md()), "café prices");
  expect(result).toContain("1 matching passage:");
  expect(result).toContain("[00:00:00.000] Before.");
  expect(result).toContain("ＣＡＦÉ   prices <b>rose</b>");
  expect(result).toContain("[00:00:02.000] After.");
  expect(searchTranscript(parseTranscriptMarkdown(md()), "e").match(/Before\./gu)).toHaveLength(1);
  expect(searchTranscript(parseTranscriptMarkdown(md()), "missing")).toContain("No matches found.");
  expect(searchTranscript(parseTranscriptMarkdown(md("_(No speech was detected.)_")), "x")).toContain("No matches found.");
});
it.each(["Publisher-provided captions", "Automatic captions"])("preserves %s provenance", method => {
  const parsed = parseTranscriptMarkdown(md().replace("Automatic speech transcription (Whisper small)", `${method}\nLanguage: it`));
  expect(searchTranscript(parsed, "Before")).toContain(`Method (file metadata): ${method}\nLanguage: it`);
});
it("accepts skipped Whisper provenance only with an empty transcript", () => {
  const method = "Digital silence check (Whisper skipped)";
  const silence = md("_(No speech was detected.)_").replace("Automatic speech transcription (Whisper small)", method);
  expect(searchTranscript(parseTranscriptMarkdown(silence), "word")).toBe(`Example\nMethod (file metadata): ${method}\n\nNo matches found.`);
  expect(() => parseTranscriptMarkdown(md().replace("Automatic speech transcription (Whisper small)", method))).toThrow();
});
it.each(["", " ", "x".repeat(201), "bad\u202Etext", "\u0000"])("rejects malformed queries", query => { expect(() => validateTranscriptQuery(query)).toThrow(); });
it.each([{ file_name: "../transcript.md" }, { file_name: "a.txt" }, { file_id: "https://example.test" }, { file_size: 2_000_001 }, { file_size: 0 }, { file_size: undefined }])("rejects invalid metadata before network", async change => {
  const mock = vi.fn();
  await expect(searchTranscriptDocument(token, { ...doc, ...change }, "word", mock)).rejects.toThrow();
  expect(mock).not.toHaveBeenCalled();
});
it.each([md().replace("00:00:03.000", "00:15:01.000"), md().replace("[00:00:02.000]", "[00:00:00.000]"), md().replace("[00:00:02.000]", "[00:00:04.000]"), md().replace("Whisper small", "made up"), md().replace("Source:", "Unknown:"), md().replace("[00:00:01.000]", "[00:99:01.000]"), md("not a timestamp"), md("[00:00:00.000] " + "x".repeat(2_000_001)), md() + "\n".repeat(20021)])("rejects malformed markdown", value => { expect(() => parseTranscriptMarkdown(value)).toThrow(); });
it("accepts the generated 10,000-segment ceiling and long Unicode paragraphs within 2 MB", () => {
  const segments = Array.from({ length: 10_000 }, () => "[00:00:00.000] Example.").join("\n\n");
  expect(parseTranscriptMarkdown(md(segments)).segments).toHaveLength(10_000);
  const text = `${"prefix ".repeat(2_000)}joined 👩‍💻 text\u200e end`;
  expect(searchTranscript(parseTranscriptMarkdown(md(`[00:00:00.000] ${text}`)), "joined")).toContain("joined 👩‍💻 text\u200e end");
});
it("caps long results and reports truncation", () => {
  const result = searchTranscript(parseTranscriptMarkdown(md(Array.from({ length: 20 }, (_, i) => `[00:00:00.000] match ${i} ${"x".repeat(800)}`).join("\n\n"))), "match");
  expect(result.length).toBeLessThanOrEqual(3500);
  expect(result).toContain("Results truncated");
});
it("uses fixed Telegram endpoints with redirects disabled", async () => {
  const mock = fetcher();
  await expect(searchTranscriptDocument(token, doc, "café prices", mock)).resolves.toContain("1 matching passage");
  expect(mock.mock.calls[0]![0]).toBe(`https://api.telegram.org/bot${token}/getFile`);
  expect(mock.mock.calls[0]![1]).toMatchObject({ redirect: "manual", body: JSON.stringify({ file_id: doc.file_id }) });
  expect(mock.mock.calls[1]![0]).toBe(`https://api.telegram.org/file/bot${token}/documents/file_1.md`);
  expect(mock.mock.calls[1]![1]).toMatchObject({ redirect: "manual" });
});
it.each(["../escape", "documents/../a.md", "https://evil.test/a", "/a.md", "a%2Fb.md", "a.md?x", "a\\b.md", "a.md#x"])("rejects untrusted paths %s", async file_path => {
  const mock = fetcher({ file_path });
  await expect(searchTranscriptDocument(token, doc, "word", mock)).rejects.toThrow();
  expect(mock).toHaveBeenCalledTimes(1);
});
it.each([{ file_id: "OTHER" }, { file_size: 2_000_001 }, { file_size: undefined }])("rejects invalid getFile metadata", async value => {
  const mock = fetcher(value);
  await expect(searchTranscriptDocument(token, doc, "word", mock)).rejects.toThrow();
  expect(mock).toHaveBeenCalledTimes(1);
});
it("rejects redirects and oversized headers and cancels bodies", async () => {
  for (const options of [{ status: 302 }, { headers: { "content-length": "2000001" } }]) {
    const cancel = vi.fn();
    await expect(searchTranscriptDocument(token, doc, "word", fetcher({}, new Response(new ReadableStream({ cancel }), options)))).rejects.toThrow();
    expect(cancel).toHaveBeenCalled();
  }
});
it("rejects response URL changes and invalid UTF-8", async () => {
  const response = new Response(md());
  Object.defineProperty(response, "url", { value: "https://evil.test" });
  await expect(searchTranscriptDocument(token, doc, "word", fetcher({}, response))).rejects.toThrow();
  await expect(searchTranscriptDocument(token, doc, "word", fetcher({}, new Response(new Uint8Array([0xff]))))).rejects.toThrow();
});
it("bounds streamed bytes and releases reader", async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2_000_001)); }, cancel });
  await expect(searchTranscriptDocument(token, doc, "word", fetcher({}, new Response(stream)))).rejects.toThrow();
  expect(cancel).toHaveBeenCalled();
  expect(stream.locked).toBe(false);
});
it("times out stalled streams and releases them", async () => {
  vi.useFakeTimers();
  try {
    const cancel = vi.fn();
    const stream = new ReadableStream({ cancel });
    const assertion = expect(searchTranscriptDocument(token, doc, "word", fetcher({}, new Response(stream)))).rejects.toThrow("Could not read that transcript");
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
    expect(cancel).toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  } finally { vi.useRealTimers(); }
});
it("includes matches near the end of long paragraphs", () => {
  const result = searchTranscript(parseTranscriptMarkdown(md(`[00:00:00.000] ${"prefix ".repeat(200)}ＴＡＲＧＥＴ phrase end.`)), "target phrase");
  expect(result).toContain("ＴＡＲＧＥＴ phrase");
});
it("redacts unexpected transport failures", async () => {
  const mock = vi.fn().mockRejectedValue(new Error(`secret ${token} query and transcript`));
  await expect(searchTranscriptDocument(token, doc, "private query", mock)).rejects.toThrow(/^Could not read that transcript\. Please attach the \.md file again and retry\.$/u);
});
it("rejects getFile redirects before downloading", async () => {
  const mock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://evil.test" } }));
  await expect(searchTranscriptDocument(token, doc, "word", mock)).rejects.toThrow();
  expect(mock).toHaveBeenCalledTimes(1);
});
