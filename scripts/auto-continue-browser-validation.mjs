const { chromium } = await import("file:///tmp/cfpt-playwright/node_modules/playwright/index.mjs");
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CONVERSATION_ID = "33333333-3333-3333-3333-333333333333";
const extensionPath = path.resolve("dist");
const profilePath = await mkdtemp(path.join(os.tmpdir(), "cfpt-auto-continue-"));
const failures = [];

function check(condition, message) {
  console.log(`${condition ? "PASS" : "FAIL"}: ${message}`);
  if (!condition) failures.push(message);
}

function fixture() {
  return `<!doctype html><html><body>
<main id="main">
  <div data-testid="conversation-turn-1">
    <div data-message-author-role="assistant" data-message-id="reply-complete">
      Work item finished.
      CHATFREEPT_STATUS: CONTINUE
      V: 1
      PHASE: DEVELOPING
      REPO: mlookhere/Chat-FreePT
      ITEM: browser reconciliation
      NOTE: continue
    </div>
  </div>
  <form data-type="unified-composer">
    <div data-composer-surface="true">
      <button data-testid="composer-plus-btn" aria-label="Add files and more" type="button">+</button>
      <div id="prompt-textarea" class="ProseMirror" contenteditable="true"></div>
      <button data-testid="send-button" type="button">Send</button>
    </div>
  </form>
</main>
<script>
window.__cfptValidation = { sendClicks: 0, sent: [] };
const composer = document.getElementById("prompt-textarea");
document.querySelector('[data-testid="send-button"]').addEventListener("click", () => {
  window.__cfptValidation.sendClicks += 1;
  window.__cfptValidation.sent.push(composer.textContent || "");
  composer.textContent = "";
  composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContent" }));
});
</script>
</body></html>`;
}

const context = await chromium.launchPersistentContext(profilePath, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--disable-dev-shm-usage",
  ],
});

try {
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
  check(Boolean(worker), "MV3 service worker starts");

  await worker.evaluate(async (conversationId) => {
    const now = Date.now();
    await chrome.storage.local.set({
      "cfpt:onboarding:v1": { launcherTipSuppressed: true, setupShown: true },
      [`cfpt:run:${conversationId}`]: {
        v: 1,
        conversationId,
        phase: "developing",
        status: "streaming",
        idea: "browser reconciliation validation",
        repoMode: "existing",
        repoName: "mlookhere/Chat-FreePT",
        repo: "mlookhere/Chat-FreePT",
        autoContinueEnabled: true,
        autoSends: 0,
        nudges: 0,
        repliesSinceContract: 0,
        startedAt: now,
        updatedAt: now,
        log: [],
      },
    });
    await chrome.storage.sync.set({
      "cfpt:settings": {
        v: 1,
        continueMessage: "continue. (End with your CHATFREEPT status block.)",
        autoContinueCap: 50,
        sendDelayMs: 2000,
        quietMs: 1000,
        toolQuietMs: 1000,
        maxStreamMinutes: 1,
        contractRefreshEvery: 12,
        notificationsEnabled: false,
        templateRepo: "mlookhere/CI-Pipline",
      },
    });
  }, CONVERSATION_ID);

  // Disable DOM mutation delivery before extension content scripts initialize. This deliberately
  // prevents StreamWatcher from receiving lifecycle mutations, so only runtime reconciliation
  // can discover the already-completed assistant marker.
  await context.addInitScript(() => {
    window.MutationObserver = class {
      observe() {}
      disconnect() {}
      takeRecords() { return []; }
    };
  });

  await context.route("https://chatgpt.com/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: fixture() });
  });

  const page = await context.newPage();
  const consoleRows = [];
  page.on("console", (msg) => {
    consoleRows.push({ type: msg.type(), text: msg.text() });
    console.log(`BROWSER[${msg.type()}] ${msg.text()}`);
  });

  await page.goto(`https://chatgpt.com/c/${CONVERSATION_ID}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#cfpt-root", { timeout: 20000 });
  check(
    (await page.locator("#cfpt-root").getAttribute("data-status")) === "streaming",
    "persisted run restores as streaming",
  );

  await page.waitForFunction(
    () => window.__cfptValidation?.sendClicks === 1,
    undefined,
    { timeout: 12000 },
  );

  const first = await page.evaluate(() => window.__cfptValidation);
  check(first.sendClicks === 1, "reconciliation heartbeat sends the next continuation");
  check(
    first.sent[0]?.includes("continue.") === true,
    "the automatic continuation uses the configured continue prompt",
  );

  const stored = await worker.evaluate(async (conversationId) => {
    return (await chrome.storage.local.get(`cfpt:run:${conversationId}`))[
      `cfpt:run:${conversationId}`
    ];
  }, CONVERSATION_ID);
  check(stored?.autoSends === 1, "automatic send count persists exactly once");
  check(
    stored?.replyBaselineAssistantKey === "message:reply-complete",
    "the pre-send assistant baseline is persisted",
  );

  await page.waitForTimeout(3500);
  const after = await page.evaluate(() => window.__cfptValidation);
  check(after.sendClicks === 1, "stale assistant marker is not sent twice");

  const badConsole = consoleRows.filter(
    (row) =>
      ["warning", "error"].includes(row.type) &&
      /send click did not take|missing status marker|generation appears stuck/i.test(row.text),
  );
  check(badConsole.length === 0, "browser reconciliation emits no continuation errors");

  if (failures.length) {
    console.error(`\n${failures.length} browser validation check(s) failed:`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log("\nAuto-continue real Chromium validation passed.");
  }
} finally {
  await context.close();
  await rm(profilePath, { recursive: true, force: true });
}
