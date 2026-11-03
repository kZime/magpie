const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");
const engines = process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"];
const launch = (engine) => engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" });

const now = new Date();
const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
const at = (i) => new Date(now.getTime() - (i + 1) * 60e3).toISOString();
// the reporter's rows: WorkBuddy's deepseek, no session id, under a
// session that has one
const who = { id: "workbuddy-key", provider: "workbuddy", name: "WorkBuddy", who: "key-1", kind: "key", model: "deepseek-v4.1-flash", routing: "", used: 0 };
const routes = Array.from({ length: 40 }, (_, i) => ({ id: 100 - i, seq: 100 - i, time: at(i), agent: "workbuddy", model: "deepseek-v4.1-flash", provider: "workbuddy", order: [who],
  tries: [{ id: who.id, model: "deepseek-v4.1-flash", start: at(i), done: true, status: 200, ms: 1200 }], done: true, status: 200, ms: 1200, tokens: 3000, ...(i < 4 ? { agent: "codex", session: "chat-1" } : {}) }));
const agents = Array.from({ length: 14 }, (_, i) => ({ id: "a" + i, name: "Agent " + i, path: "/t/a" + i + ".json", icon: "generic", wired: true,
  fields: [{ key: "model", label: "model", value: "m", options: [{ value: "m", label: "M", ref: "a/m" }] }] }));

function serve(lang, enabled = true) {
  return async (r) => {
    const url = new URL(r.request().url());
    const json = (data) => r.fulfill({ json: data });
    if (url.pathname === "/boot.js") return r.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:true,scrollChain:${enabled}};` });
    if (url.pathname === "/wails/runtime.js") return r.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents, profiles: [], settings: { lang, theme: "light", scrollChain: enabled } });
    if (url.pathname === "/api/gateway/trace") {
      if (url.searchParams.get("wait")) await new Promise((ok) => setTimeout(ok, 100));
      return json({ mine: true, now: now.toISOString(), seq: 1, totals: { requests: routes.length, rerouted: 0, errors: 0 }, routes });
    }
    if (url.pathname === "/api/gateway/history") return json({ cut: false, days: [{ day, requests: routes.length }], routes: url.searchParams.get("day") ? routes : [] });
    if (url.pathname === "/api/groups") return json({ groups: [] });
    if (url.pathname === "/api/providers") return json({ providers: [], gateway: { running: true, window: true } });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await r.fulfill({ body: await fs.readFile(file), contentType });
  };
}

// the wheel, over the middle of box, n turns of dy, and a moment to settle
async function wheel(page, box, dy, n) {
  const b = await box.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  for (let i = 0; i < n; i++) { await page.mouse.wheel(0, dy); await page.waitForTimeout(60); }
  await page.waitForTimeout(400);
}
const tops = async (view, box) => view.evaluate((v, b) => ({ page: v.scrollTop, pageRange: v.scrollHeight - v.clientHeight, box: b.scrollTop, boxRange: b.scrollHeight - b.clientHeight }), await box.elementHandle());

// box brought to the page's middle by the wheel at the page's own left
// edge, as a reader would (the page puts a scroll by code back where the
// reader left it)
async function bringIn(page, view, box) {
  const vb = await view.boundingBox();
  for (let i = 0; i < 40; i++) {
    const b = await box.boundingBox(), off = b.y + b.height / 2 - (vb.y + vb.height / 2);
    if (Math.abs(off) < 40) break;
    await page.mouse.move(vb.x + 3, vb.y + vb.height / 2);
    await page.mouse.wheel(0, Math.sign(off) * Math.min(100, Math.abs(off)));
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(300);
}
// Use the real wheel: direct writes to the page's scrollTop are guarded.
for (const engine of engines) for (const fallback of [false, true]) {
  test(`${engine}: content can pass the wheel, with legacy fallback ${fallback}`, async (t) => {
    const browser = await launch(engine);
    t.after(() => browser.close());
    const ctx = await browser.newContext({ viewport: { width: 900, height: 700 }, reducedMotion: "reduce" });
    if (fallback) await ctx.addInitScript(() => {
      const supports = CSS.supports.bind(CSS);
      CSS.supports = (...a) => !/overscroll/.test(a.join(" ")) && supports(...a);
      document.addEventListener("DOMContentLoaded", () => document.head.append(Object.assign(document.createElement("style"), { textContent: "* { overscroll-behavior: auto !important; }" })));
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/*", serve("en"));
    await page.goto("http://magpie.test/?view=routing");
    await page.locator("#view-routing .rt-req").nth(39).waitFor();
    const view = page.locator("#view-routing");
    await view.evaluate(v => v.insertAdjacentHTML("beforeend", `<div style="flex:none;height:600px"></div><div data-chain-box style="flex:none;height:180px;overflow:auto">${"<div style='height:30px'>row</div>".repeat(40)}</div><div style="flex:none;height:1500px"></div>`));
    const box = page.locator("[data-chain-box]");
    await bringIn(page, view, box);
    let before = await tops(view, box);
    await wheel(page, box, 80, 2);
    let after = await tops(view, box);
    assert.ok(after.box > before.box, "the inner list scrolls in its middle");
    assert.equal(after.page, before.page, "the page waits for the inner edge");
    await box.evaluate(b => b.scrollTop = b.scrollHeight);
    before = await tops(view, box);
    await wheel(page, box, 100, 2);
    after = await tops(view, box);
    assert.ok(after.page > before.page, "past the bottom, the page scrolls down");
    await bringIn(page, view, box);
    await box.evaluate(b => b.scrollTop = 0);
    before = await tops(view, box);
    await wheel(page, box, -100, 2);
    after = await tops(view, box);
    assert.ok(after.page < before.page, "past the top, the page scrolls up");
    // Even inside a view, menu/dialog/editor scrollers never opt in.
    for (const html of ['<div class="pop"><div data-guard></div></div>', '<div role="dialog"><div data-guard></div></div>', '<textarea data-guard></textarea>']) {
      await view.evaluate((v, h) => v.insertAdjacentHTML("beforeend", h), html);
      const guard = page.locator("[data-guard]");
      await guard.evaluate(b => {
        b.style.cssText = "height:100px;overflow:auto";
        if (b.tagName === "TEXTAREA") b.value = "line\n".repeat(100);
        else b.innerHTML = "<div style='height:800px'>content</div>";
        b.dispatchEvent(new PointerEvent("pointerover", { bubbles:true }));
      });
      assert.equal(await guard.evaluate(b => b.classList.contains("chains")), false, "protected scroll area excluded");
      await guard.evaluate(b => (b.parentElement.matches(".pop,[role=dialog]") ? b.parentElement : b).remove());
    }
    assert.deepEqual(errors, []);
  });
}
