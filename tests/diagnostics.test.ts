import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newRunState } from "../src/common/state-machine";
import type { RunState } from "../src/common/types";
import { DiagnosticsRecorder } from "../src/content/diagnostics";
import { redactUrl, summarizeResponseText, summarizeString } from "../src/diagnostics/sanitize";
import { installChromeMock } from "./chrome-mock";

const recorders: DiagnosticsRecorder[] = [];

function fixture(): void {
  document.body.innerHTML = `
    <main id="main">
      <div id="thread">
        <article data-message-author-role="user" data-message-id="u1">user secret text</article>
        <article data-message-author-role="assistant" data-message-id="a1">
          answer secret text
          CHATFREEPT_STATUS: CONTINUE
          V: 1
          PHASE: DEVELOPING
        </article>
      </div>
      <form data-type="unified-composer">
        <div data-composer-surface="true">
          <div id="prompt-textarea" contenteditable="true"></div>
          <button data-testid="send-button">Send</button>
        </div>
      </form>
    </main>
  `;
}

function stateWithSecrets(): RunState {
  return {
    ...newRunState("conversation-secret-1234567890", 1),
    phase: "developing",
    status: "streaming",
    idea: "TOP SECRET PROJECT IDEA",
    repoName: "owner/private-secret-repo",
    queuedUserText: "SECRET QUEUED USER MESSAGE",
    pauseReason: "SECRET PAUSE REASON",
    lastMarker: {
      status: "CONTINUE",
      version: 1,
      phase: "DEVELOPING",
      note: "SECRET MARKER NOTE",
      raw: "CONTINUE note=SECRET MARKER NOTE",
    },
    log: [{ at: 1, kind: "info", text: "SECRET LOG TEXT" }],
  };
}

function makeRecorder(state: RunState): DiagnosticsRecorder {
  const recorder = new DiagnosticsRecorder({ getRunState: () => state });
  recorders.push(recorder);
  return recorder;
}

beforeEach(() => {
  installChromeMock();
  fixture();
});

afterEach(() => {
  for (const recorder of recorders.splice(0)) recorder.dispose();
  vi.restoreAllMocks();
});

describe("diagnostics sanitization", () => {
  it("redacts URL values and message content while retaining semantic state", () => {
    const url = redactUrl(
      "https://chatgpt.com/backend-api/conversation/1234567890abcdef1234567890abcdef?token=secret&foo=bar",
    );
    expect(url).toContain("/backend-api/conversation/[id]");
    expect(url).toContain("token=[redacted]");
    expect(url).toContain("foo=[redacted]");
    expect(url).not.toContain("secret");
    expect(url).not.toContain("bar");

    const summary = summarizeResponseText(
      JSON.stringify({
        message: {
          status: "finished_successfully",
          end_turn: true,
          content: { parts: ["SECRET ASSISTANT CONTENT"] },
        },
      }),
      "application/json",
    );
    const serialized = JSON.stringify(summary);
    expect(serialized).toContain("finished_successfully");
    expect(serialized).toContain("end_turn");
    expect(serialized).not.toContain("SECRET ASSISTANT CONTENT");
  });

  it("exports run and reducer evidence without raw free-form text", () => {
    const state = stateWithSecrets();
    const recorder = makeRecorder(state);
    recorder.start();
    recorder.recordControllerEvent({
      kind: "machine-event",
      event: { type: "USER_REPLY", text: "SECRET DIRECT USER REPLY" },
    });

    const exported = recorder.buildExport();
    const serialized = JSON.stringify(exported);

    for (const secret of [
      "TOP SECRET PROJECT IDEA",
      "SECRET QUEUED USER MESSAGE",
      "SECRET PAUSE REASON",
      "SECRET MARKER NOTE",
      "SECRET LOG TEXT",
      "SECRET DIRECT USER REPLY",
      "answer secret text",
      "user secret text",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('"type":"snapshot"');
    expect(serialized).toContain('"kind":"machine-event"');
    expect(serialized).toContain(JSON.stringify(summarizeString("SECRET DIRECT USER REPLY")));
  });
});

describe("diagnostics event correlation", () => {
  it("accepts page-bridge network events into the same monotonic timeline", async () => {
    const recorder = makeRecorder(stateWithSecrets());
    const postMessage = vi.spyOn(window, "postMessage");
    recorder.start();

    const script = document.getElementById("cfpt-diagnostics-page-bridge");
    expect(script).not.toBeNull();
    script?.dispatchEvent(new Event("load"));

    const control = postMessage.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .find(
        (message) =>
          message["source"] === "cfpt-diagnostics-content" && message["action"] === "start",
      );
    expect(control).toBeDefined();

    window.postMessage(
      {
        source: "cfpt-diagnostics-bridge",
        channel: control?.["channel"],
        payload: {
          type: "network-response",
          transport: "fetch",
          id: "fetch-1",
          url: "https://chatgpt.com/backend-api/conversation?token=[redacted]",
          status: 200,
        },
      },
      "*",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    recorder.recordControllerEvent({
      kind: "state-transition",
      event: { type: "STREAM_STARTED" },
      detail: { fromStatus: "sending", toStatus: "streaming" },
    });

    const exported = recorder.buildExport();
    const network = exported.records.find((record) => record.type === "network");
    expect(network).toMatchObject({ transport: "fetch", status: 200 });

    const seq = exported.records.map((record) => record.seq);
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
    expect(new Set(seq).size).toBe(seq.length);
  });

  it("stops recording without discarding the captured session", () => {
    const recorder = makeRecorder(stateWithSecrets());
    recorder.start();
    const before = recorder.status.records;
    recorder.stop();

    expect(recorder.status.recording).toBe(false);
    expect(recorder.status.records).toBeGreaterThan(before);
    const exported = recorder.buildExport();
    expect(exported.summary["recording"]).toBe(false);
    expect(exported.records.at(-1)).toMatchObject({ type: "session", event: "stop" });
  });
});
