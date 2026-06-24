/**
 * Layout debugger for WhatsApp Hide Chat List.
 *
 * Loads a saved WhatsApp HTML snapshot in headless Chrome and prints computed
 * layout metrics (rail width, #side position, --navbar-width, div.two children).
 * Use this when WhatsApp changes its DOM and sidebar collapse/offset looks wrong.
 *
 * Usage:
 *   # Serve a saved page first (CSS needs HTTP, not file://):
 *   cd whatsapp-page && python3 -m http.server 8732
 *
 *   # Measure (from repo root or this directory):
 *   WHC_URL=http://127.0.0.1:8732/WhatsApp.html node _measure.mjs
 *
 *   # Optional: simulate rail-collapse fixes before measuring
 *   WHC_SIMULATE_FIX=1 WHC_URL=http://127.0.0.1:8732/WhatsApp.html node _measure.mjs
 *
 * Environment:
 *   WHC_URL          — page URL to load (required unless passed as argv[2])
 *   WHC_SIMULATE_FIX — if "1", apply rail padding/--navbar-width overrides first
 *   CHROME_BIN       — Chrome/Chromium binary (default: google-chrome-stable)
 *   CDP_PORT         — remote debugging port (default: 9222)
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const pageUrl = process.env.WHC_URL || process.argv[2];
if (!pageUrl) {
    console.error(
        "Usage: WHC_URL=http://127.0.0.1:PORT/WhatsApp.html node _measure.mjs",
    );
    process.exit(1);
}

const simulateFix = process.env.WHC_SIMULATE_FIX === "1";
const chromeBin = process.env.CHROME_BIN || "google-chrome-stable";
const cdpPort = process.env.CDP_PORT || "9222";

const chrome = spawn(chromeBin, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    `--remote-debugging-port=${cdpPort}`,
    "--window-size=1400,900",
    "about:blank",
]);
chrome.stderr.on("data", () => {});

async function getWs() {
    for (let i = 0; i < 40; i++) {
        try {
            const r = await fetch(`http://127.0.0.1:${cdpPort}/json`);
            const list = await r.json();
            const page = list.find((t) => t.type === "page");
            if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
        } catch {
            // Chrome may not be listening yet
        }
        await sleep(250);
    }
    throw new Error("no devtools target — is Chrome installed?");
}

const wsUrl = await getWs();
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
    }
});
function send(method, params = {}) {
    return new Promise((res) => {
        const mid = ++id;
        pending.set(mid, res);
        ws.send(JSON.stringify({ id: mid, method, params }));
    });
}
await new Promise((r) => ws.addEventListener("open", r));
await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: pageUrl });
await sleep(3500);

const measureExpr = `(simulateFix) => {
  const out = { simulateFix };
  const rail = document.querySelector('header[data-testid="chatlist-header"]');
  const side = document.getElementById("side");
  const two = document.querySelector("div.two");

  if (simulateFix) {
    if (rail) {
      rail.style.padding = "0px";
      rail.style.borderWidth = "0px";
    }
    document.documentElement.style.setProperty("--navbar-width", "0px");
    void (two && two.offsetWidth);
  }

  const rect = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      left: Math.round(b.left),
      width: Math.round(b.width),
      w_css: cs.width,
      minw: cs.minWidth,
      maxw: cs.maxWidth,
      ml: cs.marginInlineStart,
      pl: cs.paddingInlineStart,
      pr: cs.paddingInlineEnd,
      pos: cs.position,
      flex: cs.flex,
      display: cs.display,
    };
  };

  out.navbarVar = getComputedStyle(document.documentElement)
    .getPropertyValue("--navbar-width")
    .trim();
  out.rail = rect(rail);
  out.side = rect(side);
  out.two = rect(two);

  let el = side;
  const chain = [];
  while (el && el !== two && chain.length < 8) {
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    chain.push({
      tag: el.tagName,
      testid: el.getAttribute("data-testid"),
      left: Math.round(b.left),
      width: Math.round(b.width),
      ml: cs.marginInlineStart,
      pl: cs.paddingInlineStart,
      pos: cs.position,
    });
    el = el.parentElement;
  }
  out.sideAncestry = chain;

  out.twoChildren = [...(two ? two.children : [])].map((c) => {
    const b = c.getBoundingClientRect();
    const cs = getComputedStyle(c);
    return {
      tag: c.tagName,
      testid: c.getAttribute("data-testid"),
      id: c.id,
      left: Math.round(b.left),
      width: Math.round(b.width),
      pos: cs.position,
      ml: cs.marginInlineStart,
      pl: cs.paddingInlineStart,
      display: cs.display,
    };
  });

  return out;
}`;

const res = await send("Runtime.evaluate", {
    expression: `(${measureExpr})(${simulateFix})`,
    returnByValue: true,
});
if (res.exceptionDetails) {
    console.error("EXCEPTION:", JSON.stringify(res.exceptionDetails, null, 2));
    process.exit(1);
}
console.log(JSON.stringify(res.result?.value ?? res.result, null, 2));
ws.close();
chrome.kill();
process.exit(0);
