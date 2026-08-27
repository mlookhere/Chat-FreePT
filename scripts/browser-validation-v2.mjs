import { chromium } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PRIMARY_ID = "11111111-1111-1111-1111-111111111111";
const SLEEP_ID = "22222222-2222-2222-2222-222222222222";
const extensionPath = path.resolve("dist");
const profilePath = await mkdtemp(path.join(os.tmpdir(), "cfpt-browser-v2-"));
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
  return { cdp, nodes: walk(root) };
}

async function nodeCenter(cdp, node) {
  const { model } = await cdp.send("DOM.getBoxModel", { backendNodeId: node.backendNodeId });
  const q = model.border;
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

async function mouseClick(cdp, point) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
}

async function nodeStyle(cdp, node) {
  const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: node.backendNodeId });
  const result = await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: "function(){const s=getComputedStyle(this);return {text:this.textContent,opacity:s.opacity,visibility:s.visibility,borderRadius:s.borderRadius};}",
    returnByValue: true,
  });
  return result.result.value;
}

function composerFixture(stop) {
  return `<!doctype html><html><body>
<main id="main"><div id="thread"></div>
<form data-type="unified-composer"><div data-composer-surface="true" style="position:relative;width:700px;height:120px">
<button data-testid="composer-plus-btn" aria-label="Add files and more" type="button">+</button>
<div id="prompt-textarea" class="ProseMirror" contenteditable="true"></div>
<button data-testid="send-button" type="submit">Send</button>
${stop ? '<button data-testid="stop-button" aria-label="Stop generating" type="button">Stop</button>' : ""}
</div></form></main>
<script>
window.__cfptFixture={plusClicks:0,developerClicks:0,appClicks:0};
const plus=document.querySelector('[data-testid="composer-plus-btn"]');
plus.addEventListener('click',()=>{
  window.__cfptFixture.plusClicks++;
  if(document.getElementById('developer-mode-fixture')) return;
  const dev=document.createElement('button'); dev.id='developer-mode-fixture'; dev.textContent='Developer mode';
  dev.addEventListener('click',()=>{
    window.__cfptFixture.developerClicks++;
    if(document.getElementById('cfpt-app-fixture')) return;
    const app=document.createElement('button'); app.id='cfpt-app-fixture'; app.textContent='Chat FreePT GitHub MCP'; app.setAttribute('aria-checked','false');
    app.addEventListener('click',()=>{window.__cfptFixture.appClicks++; app.setAttribute('aria-checked','true');});
    document.body.appendChild(app);
  });
  document.body.appendChild(dev);
});
</script></body></html>`;
}

const context = await chromium.launchPersistentContext(profilePath, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--disable-dev-shm-usage"],
});

const allConsole = [];
context.on("page", (page) => page.on("console", (msg) => {
  const row = { url: page.url(), type: msg.type(), text: msg.text() };
  allConsole.push(row);
  console.log(`BROWSER[${row.type}] ${row.text}`);
}));

try {
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
  check(Boolean(worker), "MV3 service worker starts in Chromium");

  await worker.evaluate(async () => {
    await chrome.storage.local.set({ "cfpt:onboarding:v1": { launcherTipSuppressed: true, setupShown: true } });
    await chrome.storage.sync.set({ "cfpt:settings": {
      v: 1, continueMessage: "continue. (End with your CHATFREEPT status block.)", autoContinueCap: 50,
      sendDelayMs: 8000, quietMs: 3000, toolQuietMs: 10000, maxStreamMinutes: 0.001,
      contractRefreshEvery: 12, notificationsEnabled: false, templateRepo: "mlookhere/CI-Pipline"
    }});
  });

  await context.addInitScript((primaryId) => {
    if (location.hostname === "chatgpt.com" && location.pathname === `/c/${primaryId}`) {
      sessionStorage.setItem("cfpt:setup-guide:browser-validation", JSON.stringify({ active: true, step: "done", returnUrl: location.href }));
    }
  }, PRIMARY_ID);

  await context.route("https://chatgpt.com/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const body = pathname === "/library" || pathname === "/plugins"
      ? "<!doctype html><html><body><main id=main><h1>Utility route</h1></main></body></html>"
      : composerFixture(pathname === `/c/${SLEEP_ID}`);
    await route.fulfill({ status: 200, contentType: "text/html", body });
  });

  const page = await context.newPage();
  await page.goto(`https://chatgpt.com/c/${PRIMARY_ID}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#cfpt-root", { timeout: 20000 });
  await page.waitForTimeout(1200);

  const activation = await page.evaluate(() => ({
    fixture: window.__cfptFixture,
    stored: JSON.parse(sessionStorage.getItem("cfpt:setup-guide:browser-validation") || "null"),
  }));
  check(activation.fixture.plusClicks >= 1, "post-OAuth activation opens composer Plus");
  check(activation.fixture.developerClicks >= 1, "post-OAuth activation selects Developer mode");
  check(activation.fixture.appClicks >= 1, "post-OAuth activation selects exact Chat FreePT GitHub MCP");
  check(activation.stored?.active === false, "setup completes only after app activation");

  const placement = await page.evaluate(() => {
    const plus = document.querySelector('[data-testid="composer-plus-btn"]');
    const host = document.getElementById("cfpt-root");
    return { nextSibling: plus?.nextElementSibling === host, fallback: host?.dataset.fallback };
  });
  check(placement.nextSibling, "airplane mounts immediately after native Plus");
  check(placement.fallback === "false", "airplane uses native composer placement");

  const tree = await cdpTree(context, page);
  const launcher = tree.nodes.find((n) => (attrs(n).class ?? "").split(/\s+/).includes("cfpt-launcher"));
  const tooltip = tree.nodes.find((n) => attrs(n).id === "cfpt-launcher-tooltip");
  check(Boolean(launcher && tooltip), "closed-shadow launcher and tooltip exist in browser DOM");
  const launcherAttrs = attrs(launcher);
  check(!("title" in launcherAttrs), "launcher has no browser-native title tooltip");
  check(launcherAttrs["aria-describedby"] === "cfpt-launcher-tooltip", "launcher owns tooltip through aria-describedby");
  check(attrs(tooltip).role === "tooltip" && textOf(tooltip).trim() === "Chat FreePT", "owned tooltip is role=tooltip with exact Chat FreePT text");

  const point = await nodeCenter(tree.cdp, launcher);
  await tree.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await page.waitForTimeout(180);
  const style = await nodeStyle(tree.cdp, tooltip);
  check(style.visibility === "visible" && Number(style.opacity) > 0.9, "owned tooltip becomes visible on airplane hover");
  check(parseFloat(style.borderRadius) >= 8, "owned tooltip uses rounded native-like styling");
  check(!(await page.evaluate(() => document.querySelector('[data-testid="composer-plus-btn"]')?.matches(":hover") ?? false)), "airplane hover does not hover native Add files control");

  await mouseClick(tree.cdp, point);
  await page.waitForTimeout(150);
  const openState = await page.evaluate(() => {
    const host = document.getElementById("cfpt-root");
    const surface = document.querySelector('[data-composer-surface="true"]');
    return { expanded: host?.dataset.expanded, takeover: surface?.dataset.cfptTakeover, inert: surface?.inert, pointerEvents: surface?.style.pointerEvents };
  });
  check(openState.expanded === "true", "airplane opens takeover");
  check(openState.takeover === "true" && openState.inert === true && openState.pointerEvents === "none", "takeover safely disables native composer");

  await mouseClick(tree.cdp, { x: 20, y: 20 });
  await page.waitForTimeout(150);
  const closedState = await page.evaluate(() => {
    const host = document.getElementById("cfpt-root");
    const surface = document.querySelector('[data-composer-surface="true"]');
    return { expanded: host?.dataset.expanded, takeover: surface?.dataset.cfptTakeover, inert: surface?.inert, pointerEvents: surface?.style.pointerEvents };
  });
  check(closedState.expanded === "false", "outside click closes takeover");
  check(closedState.takeover === undefined && closedState.inert === false && closedState.pointerEvents === "", "closing takeover exactly restores native composer state");

  for (const routePath of ["/library", "/plugins"]) {
    const utility = await context.newPage();
    const warnings = [];
    utility.on("console", (msg) => { if (["warning", "error"].includes(msg.type())) warnings.push(msg.text()); });
    await utility.goto(`https://chatgpt.com${routePath}`, { waitUntil: "domcontentloaded" });
    await utility.waitForTimeout(1400);
    check(!warnings.some((text) => /composer never appeared/i.test(text)), `${routePath} does not emit missing-composer warning`);
    await utility.close();
  }

  const duplicate = await context.newPage();
  const duplicateConsole = [];
  duplicate.on("console", (msg) => duplicateConsole.push({ type: msg.type(), text: msg.text() }));
  await duplicate.goto(`https://chatgpt.com/c/${PRIMARY_ID}`, { waitUntil: "domcontentloaded" });
  await duplicate.waitForSelector("#cfpt-root", { timeout: 20000 });
  await duplicate.waitForTimeout(1200);
  check(!duplicateConsole.some((row) => ["warning", "error"].includes(row.type) && /another tab is driving this conversation/i.test(row.text)), "duplicate-tab ownership is informational, not warning/error");
  await duplicate.close();

  await worker.evaluate(async (sleepId) => {
    const now = Date.now();
    await chrome.storage.local.set({ [`cfpt:run:${sleepId}`]: {
      v: 1, conversationId: sleepId, phase: "developing", status: "streaming", idea: "browser validation",
      repoMode: "existing", repoName: "mlookhere/Chat-FreePT", repo: "mlookhere/Chat-FreePT",
      autoContinueEnabled: false, autoSends: 0, nudges: 0, repliesSinceContract: 0,
      startedAt: now, updatedAt: now, log: []
    }});
  }, SLEEP_ID);

  const sleepPage = await context.newPage();
  const sleepConsole = [];
  sleepPage.on("console", (msg) => sleepConsole.push({ type: msg.type(), text: msg.text() }));
  await sleepPage.goto(`https://chatgpt.com/c/${SLEEP_ID}`, { waitUntil: "domcontentloaded" });
  await sleepPage.waitForSelector('#cfpt-root[data-status="streaming"]', { timeout: 20000 });
  await sleepPage.waitForTimeout(900);
  const sleepTree = await cdpTree(context, sleepPage);
  const stopNode = sleepTree.nodes.find((n) => attrs(n)["data-testid"] === "stop-button");
  check(Boolean(stopNode), "sleep fixture starts with live Stop/generation signal");
  await sleepTree.cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  await sleepTree.cdp.send("DOM.removeNode", { nodeId: stopNode.nodeId });
  await new Promise((resolve) => setTimeout(resolve, 4500));
  await sleepTree.cdp.send("Page.setWebLifecycleState", { state: "active" });
  await sleepPage.waitForTimeout(1300);
  const sleepStatus = await sleepPage.evaluate(() => document.getElementById("cfpt-root")?.dataset.status);
  check(sleepStatus !== "error", "real Chromium freeze/resume gap does not become false generation error");
  check(sleepConsole.some((row) => /resumed after a timer gap|Chat FreePT ready/i.test(row.text)), "extension remains alive and reconciles after lifecycle resume");
  await sleepPage.close();

  const badWarnings = allConsole.filter((row) => ["warning", "error"].includes(row.type) && /Blocked aria-hidden|beforetoggle|composer never appeared/i.test(row.text));
  check(badWarnings.length === 0, "browser smoke emits none of the known aria-hidden/beforetoggle/missing-composer warnings");

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
