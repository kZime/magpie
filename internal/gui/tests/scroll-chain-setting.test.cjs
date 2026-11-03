const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");
const { watchSettingsReads, settingsDrawn } = require("./reader.cjs");

const assets = path.resolve(__dirname, "../assets");

function serve(lang, saved, own, web) {
  const settings = { lang, theme: "light", redact: true, keepAwake: true, ...own };
  const state = { agents: [], profiles: [], settings };
  return async (r) => {
    const url = new URL(r.request().url());
    const json = (data) => r.fulfill({ json: data });
    if (url.pathname === "/boot.js") return r.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:${web}};` });
    if (url.pathname === "/wails/runtime.js") return r.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json(state);
    if (url.pathname === "/api/settings") {
      if (r.request().method() === "POST") {
        saved.push(JSON.parse(r.request().postData()));
        Object.assign(settings, saved.at(-1));
      }
      return json(settings);
    }
    if (url.pathname === "/api/groups") return json({ models: [], groups: [], pools: [] });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname === "/api/usage/quotas") return json([]);
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true, window: true, url: "http://127.0.0.1:3999" } });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await r.fulfill({ body: await fs.readFile(file), contentType });
  };
}


for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh", "zh-TW", "ja", "de"]) for (const width of [1100, 420]) {
    test(`${engine} ${lang} ${width}: scroll chaining opt-in is saved and restored`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel:"chromium" }));
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport:{width,height:900} });
      const saved = [], errors = [];
      page.on("pageerror", e => errors.push(e.message));
      await page.route("**/*", serve(lang, saved, {}, true));
      await watchSettingsReads(page);
      await page.goto("http://magpie.test/?view=settings&tab=general");
      await settingsDrawn(page);
      const row = page.locator("#scrollChainRow");
      await row.waitFor();
      assert.equal(await page.evaluate(() => !!document.documentElement.dataset.scrollChain), false);
      for (let i=0;i<30;i++) {
        const b=await row.boundingBox();
        if (b.y>=80 && b.y+b.height<850) break;
        await page.mouse.move(width/2,500); await page.mouse.wheel(0,100); await page.waitForTimeout(50);
      }
      await row.locator(".opt").nth(1).click();
      await page.waitForFunction(() => !!document.documentElement.dataset.scrollChain);
      assert.equal(saved.at(-1).scrollChain,true);
      assert.equal(saved.at(-1).keepAwake,true,"unrelated settings kept");
      await page.reload(); await settingsDrawn(page);
      assert.equal(await page.evaluate(() => !!document.documentElement.dataset.scrollChain),true);
      await row.locator(".opt").nth(0).click();
      await page.waitForFunction(() => !document.documentElement.dataset.scrollChain);
      assert.equal(saved.at(-1).scrollChain,false);
      assert.deepEqual(errors,[]);
    });
  }
}
