import { chromium } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const extensionPath = path.resolve("dist");
const profilePath = await mkdtemp(path.join(os.tmpdir(), "cfpt-browser-"));
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
  console.log(`${condition ? "PASS" : "FAIL"}: ${message}`);
}

function attrs(node) {
  const out = {};
  const list = node.attributes ?? [];
  for (let i = 0; i < list.length; i += 2) out[list[i]] = list[i + 1];
  return out;
}

function walk(node, out = []) {
  out.push(node);
  for (const shadow of node.shadowRoots ?? []) walk(shadow, out);
  for (const child of node.children ?? []) walk(child, out);
  return out;
}

function textOf(node) {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  return [...(node.children ?? []), ...(node.shadowRoots ?? [])].map(textOf).join("");
}

async function cdpTree(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("DOM.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  return { cdp, root, nodes: walk(root) };
}

function findNode(nodes, predicate) {
  return nodes.find(predicate);
}

async function nodeStyle(cdp, node) {
  const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: node.backendNodeId });
  const result = await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration:
      "function(){const s=getComputedStyle(this);return {text:this.textContent,opacity:s.opacity,visibility:s.visibility,borderRadius:s.borderRadius,pointerEvents:s.pointerEvents};}",
    returnByValue: true,
  });
  return result.result.value;
}

async function nodeCenter(cdp, node) {
  const { model } = await cdp.send("DOM.getBoxModel", { backendNodeId: node.backendNodeId });
  const q = model.border;
  return {
    x: (q[0] + q[2] + q[4] + q[6]) / 4,
    y: (q[1] + q[3] + q[5] + q[7]) / 4,
  };
}

async function mouseClick(cdp, point) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
}

function composerFixture({ stop = false } = {}) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>ChatGPT fixture</title></head>
<body>
<main id="main">
  <div id="thread"></div>
  <form data-type="unified-composer">
    <div data-composer-surface="true" style="position:relative;width:700px;height:120px">
      <button data-testid="composer-plus-btn" aria-label="Add files and more" type="button">+</button>
      <div id="prompt-textarea" class="ProseMirror" contenteditable="true"></div>
      <button data-testid="send-button" type="submit">Send</button>
      ${stop ? '<button data-testid="stop-button" aria-label="Stop generating" type="button">Stop</button>' : ""}
    </div>
  </form>
</main>
<script>
  window.__cfptFixture = { plusClicks: 0, developerClicks: 0, appClicks: 0 };
  const plus = document.querySelector('[data-testid="composer-plus-btn"]');
  plus.addEventListener('click', () => {
    window.__cfptFixture.plusClicks++;
    if (document.getElementById('developer-mode-fixture')) return;
    const dev = document.createElement('button');
    dev.id = 'developer-mode-fixture';
    dev.type = 'button';
    dev.textContent = 'Developer mode';
    dev.addEventListener('click', () => {
      window.__cfptFixture.developerClicks++;
      if (document.getElementById('cfpt-app-fixture')) return;
      const app = document.createElement('button');
      app.id = 'cfpt-app-fixture';
      app.type = 'button';
      app.textContent = 'Chat FreePT GitHub MCP';
      app.setAttribute('aria-checked', 'false');
      app.addEventListener('click', () => {
        window.__cfptFixture.appClicks++;
        app.setAttribute('aria-checked', 'true');
      });
      document.body.appendChild(app);
    });
    document.body.appendChild(dev);
  });
</script>
</body></html>`;
}

function utilityFixture() {
  return "<!doctype html><html><body><main id=main><h1>Utility route</h1></main></body></html>";
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

const allConsole = [];
context.on("page", (page) => {
  page.on("console", (msg) => {
    const row = { url: page.url(), type: msg.type(), text: msg.text() };
    allConsole.push(row);
    console.log(`BROWSER[${row.type}] ${row.text}`);
  });
});

try {
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
  check(Boolean(worker), "MV3 service worker starts in Chromium");

  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      "cfpt:onboarding:v1": { launcherTipSuppressed: true, setupShown: true },
    });
    await chrome.storage.sync.set({
      "cfpt:settings": {
        v: 1,
        continueMessage: "continue. (End with your CHATFREEPT status block.)",
        autoContinueCap: 50,
        sendDelayMs: 8000,
        quietMs: 3000,
        toolQuietMs: 10000,
        maxStreamMinutes: 0.001,
        contractRefreshEvery: 12,
        notificationsEnabled: false,
        templateRepo: "mlookhere/CI-Pipline",
      },
    });
  });

  await context.addInitScript(() => {
    if (location.hostname === "chatgpt.com" && location.pathname === "/c/browser-validation") {
      sessionStorage.setItem(
        "cfpt:setup-guide:browser-validation",
        JSON.stringify({ active: true, step: "done", returnUrl: location.href }),
      );
    }
  });

  await context.route("https://chatgpt.com/**", async (route) => {
    const url = new URL(route.request().url());
    const body = url.pathname === "/library" || url.pathname === "/plugins"
      ? utilityFixture()
      : composerFixture({ stop: url.pathname === "/c/browser-sleep" });
    await route.fulfill({ status: 200, contentType: "text/html", body });
  });

  const page = await context.newPage();
  await page.goto("https://chatgpt.com/c/browser-validation", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#cfpt-root", { timeout: 20000 });
  await page.waitForTimeout(1200);

  const activation = await page.evaluate(() => ({
    fixture: window.__cfptFixture,
    stored: JSON.parse(sessionStorage.getItem("cfpt:setup-guide:browser-validation") || "null"),
  }));
  check(activation.fixture.plusClicks >= 1, "post-OAuth activation opens the composer Plus menu");
  check(activation.fixture.developerClicks >= 1, "post-OAuth activation selects Developer mode");
  check(activation.fixture.appClicks >= 1, "post-OAuth activation selects exact Chat FreePT GitHub MCP");
  check(activation.stored?.active === false, "setup is marked complete only after app activation");

  const placement = await page.evaluate(() => {
    const plus = document.querySelector('[data-testid="composer-plus-btn"]');
    const host = document.getElementById("cfpt-root");
    return {
      nextSibling: plus?.nextElementSibling === host,
      fallback: host?.dataset.cfptEmbedded === "true" ? host.dataset.fallback : "missing",
      expanded: host?.dataset.expanded,
    };
  });
  check(placement.nextSibling, "airplane launcher mounts immediately after ChatGPT Plus control");
  check(placement.fallback === "false", "airplane uses native composer placement rather than fallback");

  let tree = await cdpTree(context, page);
  const host = findNode(tree.nodes, (n) => attrs(n).id === "cfpt-root");
  const launcher = findNode(tree.nodes, (n) => (attrs(n).class ?? "").split(/\s+/).includes("cfpt-launcher"));
  const tooltip = findNode(tree.nodes, (n) => attrs(n).id === "cfpt-launcher-tooltip");
  check(Boolean(host && launcher && tooltip), "closed-shadow launcher and tooltip are present in the real browser DOM");

  const launcherAttrs = attrs(launcher);
  const tooltipAttrs = attrs(tooltip);
  check(!("title" in launcherAttrs), "airplane launcher has no browser-native title tooltip");
  check(launcherAttrs["aria-describedby"] === "cfpt-launcher-tooltip", "launcher owns its tooltip through aria-describedby");
  check(tooltipAttrs.role === "tooltip", "owned tooltip exposes role=tooltip");
  check(textOf(tooltip).trim() === "Chat FreePT", "owned tooltip text is exactly Chat FreePT");

  const point = await nodeCenter(tree.cdp, launcher);
  await tree.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await page.waitForTimeout(180);
  const hoveredStyle = await nodeStyle(tree.cdp, tooltip);
  check(hoveredStyle.visibility === "visible" && Number(hoveredStyle.opacity) > 0.9, "owned tooltip becomes visible on airplane hover");
  check(parseFloat(hoveredStyle.borderRadius) >= 8, "owned tooltip uses the rounded ChatGPT-like surface");
  const plusHovered = await page.evaluate(() => document.querySelector('[data-testid="composer-plus-btn"]')?.matches(":hover") ?? false);
  check(!plusHovered, "airplane hover does not hover the adjacent Add files and more control");

  await mouseClick(tree.cdp, point);
  await page.waitForTimeout(150);
  const openState = await page.evaluate(() => {
    const host = document.getElementById("cfpt-root");
    const surface = document.querySelector('[data-composer-surface="true"]');
    return {
      expanded: host?.dataset.expanded,
      takeover: surface?.dataset.cfptTakeover,
      inert: surface?.inert,
      pointerEvents: surface?.style.pointerEvents,
    };
  });
  check(openState.expanded === "true", "airplane click opens Chat FreePT takeover");
  check(openState.takeover === "true" && openState.inert === true && openState.pointerEvents === "none", "open takeover safely disables the native composer");

  await mouseClick(tree.cdp, point);
  await page.waitForTimeout(150);
  const closedState = await page.evaluate(() => {
    const host = document.getElementById("cfpt-root");
    const surface = document.querySelector('[data-composer-surface="true"]');
    return {
      expanded: host?.dataset.expanded,
      takeover: surface?.dataset.cfptTakeover,
      inert: surface?.inert,
      pointerEvents: surface?.style.pointerEvents,
    };
  });
  check(closedState.expanded === "false", "second airplane click closes Chat FreePT takeover");
  check(closedState.takeover === undefined && closedState.inert === false && closedState.pointerEvents === "", "closing takeover exactly restores the native composer state");

  for (const routePath of ["/library", "/plugins"]) {
    const utility = await context.newPage();
    const warnings = [];
    utility.on("console", (msg) => {
      if (msg.type() === "warning" || msg.type() === "error") warnings.push(msg.text());
    });
    await utility.goto(`https://chatgpt.com${routePath}`, { waitUntil: "domcontentloaded" });
    await utility.waitForTimeout(1400);
    check(!warnings.some((text) => /composer never appeared/i.test(text)), `${routePath} does not emit the old missing-composer warning`);
    await utility.close();
  }

  const duplicate = await context.newPage();
  const duplicateConsole = [];
  duplicate.on("console", (msg) => duplicateConsole.push({ type: msg.type(), text: msg.text() }));
  await duplicate.goto("https://chatgpt.com/c/browser-validation", { waitUntil: "domcontentloaded" });
  await duplicate.waitForSelector("#cfpt-root", { timeout: 20000 });
  await duplicate.waitForTimeout(1200);
  check(
    !duplicateConsole.some((row) => (row.type === "warning" || row.type === "error") && /another tab is driving this conversation/i.test(row.text)),
    "passive duplicate-tab ownership is not logged as a warning/error",
  );
  await duplicate.close();

  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      "cfpt:run:browser-sleep": {
        v: 1,
        conversationId: "browser-sleep",
        phase: "developing",
        status: "streaming",
        idea: "browser validation",
        repoMode: "existing",
        repoName: "mlookhere/Chat-FreePT",
        repo: "mlookhere/Chat-FreePT",
        autoContinueEnabled: false,
        autoSends: 0,
        nudges: 0,
        repliesSinceContract: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        log: [],
      },
    });
  });

  const sleepPage = await context.newPage();
  const sleepConsole = [];
  sleepPage.on("console", (msg) => sleepConsole.push({ type: msg.type(), text: msg.text() }));
  await sleepPage.goto("https://chatgpt.com/c/browser-sleep", { waitUntil: "domcontentloaded" });
  await sleepPage.waitForSelector('#cfpt-root[data-status="streaming"]', { timeout: 20000 });
  await sleepPage.waitForTimeout(1000);
  const sleepTree = await cdpTree(context, sleepPage);
  const stopNode = findNode(sleepTree.nodes, (n) => attrs(n)["data-testid"] === "stop-button");
  check(Boolean(stopNode), "sleep fixture begins with a live Stop/generation signal");
  await sleepTree.cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  await sleepTree.cdp.send("DOM.removeNode", { nodeId: stopNode.nodeId });
  await new Promise((resolve) => setTimeout(resolve, 4500));
  await sleepTree.cdp.send("Page.setWebLifecycleState", { state: "active" });
  await sleepPage.waitForTimeout(1300);
  const sleepState = await sleepPage.evaluate(() => ({
    status: document.getElementById("cfpt-root")?.dataset.status,
    phase: document.getElementById("cfpt-root")?.dataset.phase,
  }));
  check(sleepState.status !== "error", "Chromium freeze/resume gap does not become a false generation error");
  check(
    sleepConsole.some((row) => /stream watcher resumed after a timer gap|Chat FreePT ready/i.test(row.text)),
    "extension remains alive and reconciles after the Chromium lifecycle resume",
  );
  await sleepPage.close();

  const forbiddenWarnings = allConsole.filter(
    (row) =>
      (row.type === "warning" || row.type === "error") &&
      /Blocked aria-hidden|beforetoggle|composer never appeared/i.test(row.text),
  );
  check(forbiddenWarnings.length === 0, "browser smoke produced none of the known aria-hidden/beforetoggle/missing-composer warnings");

  if (failures.length) {
    console.error(`\n${failures.length} browser validation check(s) failed:`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log("\nAll automated Chromium browser validation checks passed.");
  }
} finally {
  await context.close();
  await rm(profilePath, { recursive: true, force: true });
}
