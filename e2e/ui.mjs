// Browser tests for the screens: runs the real app in Chromium against a local Worker with its own empty database.
//   npm run e2e          (CI installs the browser with: npx playwright install --with-deps chromium)
// Locally, if the browser lives somewhere unusual: CHROMIUM=/path/to/chrome npm run e2e
import { chromium } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import zlib from "node:zlib";
import { inspectZip, sha } from "./zipcheck.mjs";

const PORT = 8900 + Math.floor(Math.random() * 90);
const U = `http://localhost:${PORT}`;
const work = mkdtempSync(join(tmpdir(), "cloud-e2e-"));
const state = join(work, "state");
const wrangler = (...a) => execFileSync("npx", ["wrangler", ...a], { stdio: "pipe" });

// A small PNG: a diagonal gradient in one colour, so grids and previews have something to show.
const png = (w, h, [r, g, b]) => {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = 0.45 + 0.55 * ((x + y) / (w + h)), o = y * (w * 3 + 1) + 1 + x * 3;
    raw[o] = r * k; raw[o + 1] = g * k; raw[o + 2] = b * k;
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
};
const COLOURS = [[220, 38, 38], [22, 163, 74], [37, 99, 235], [245, 158, 11], [147, 51, 234]];
const file = (name, i = 0) => ({ name, mimeType: "image/png", buffer: png(96 + i * 4, 72, COLOURS[i % COLOURS.length]) });

let server, browser, failed = 0;
const cspViolations = [];
const step = async (name, fn) => {
  try { await fn(); console.log("PASS", name); } catch (e) { failed++; console.log("FAIL", name, "\n     ", String(e.message).split("\n").slice(0, 3).join(" | ")); }
};
const check = (cond, msg) => { if (!cond) throw new Error(msg); };

// Pages start in list view: folders holding photos otherwise open as a grid by themselves (which one step checks on purpose).
const newPage = async (headers = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, extraHTTPHeaders: headers });
  await ctx.addInitScript(() => { try { if (!sessionStorage.getItem("auto-view")) localStorage.setItem("view", "list"); } catch {} });
  ctx.setDefaultTimeout(15000);
  const p = await ctx.newPage();
  p.on("console", (m) => { if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text())) cspViolations.push(m.text()); });
  return p;
};
const home = async (p) => { await p.goto(U + "/#/"); await p.waitForSelector("text=Family"); };
const upload = async (p, ...files) => { await p.setInputFiles('label:has-text("Upload") input', files); };
const row = (p, name) => p.locator(`li:has-text("${name}")`);
const menu = async (p, name, item) => { await row(p, name).locator("summary").click(); await row(p, name).locator(`text=${item}`).click(); };
const swipe = (p, sel, dx) => p.evaluate(({ sel, dx }) => {
  const el = document.querySelector(sel), r = el.getBoundingClientRect(), x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
  const t = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y0 });
  const ev = (type, x) => new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchend" ? [] : [t(x)], changedTouches: [t(x)] });
  el.dispatchEvent(ev("touchstart", x0)); el.dispatchEvent(ev("touchmove", x0 + dx / 2)); el.dispatchEvent(ev("touchend", x0 + dx));
}, { sel, dx });
const longPress = (p, sel, index = 0) => p.evaluate(async ({ sel, index }) => { // what a finger does: down, hold half a second, up, then the browser's click
  const el = document.querySelectorAll(sel)[index];
  const fire = (type) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "touch" }));
  fire("pointerdown"); await new Promise((r) => setTimeout(r, 650)); fire("pointerup");
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}, { sel, index });

try {
  wrangler("d1", "migrations", "apply", "DB", "--local", "--persist-to", state);
  server = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--persist-to", state, "--var", "DEV_EMAIL:mom@example.com", "--var", "ADMIN_EMAIL:mom@example.com"], { stdio: "ignore" });
  for (let i = 0; i < 80; i++) { if (await fetch(`${U}/api/health`).then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 500)); }
  browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});

  await step("app opens, is installable, ships security headers", async () => {
    const p = await newPage();
    await home(p);
    await p.waitForFunction(() => document.querySelector(".who")?.textContent === "mom@example.com");
    const m = await (await p.request.get(U + "/manifest.webmanifest")).json();
    check(m.display === "standalone" && m.share_target?.action === "/share-target", "manifest");
    const h = (await p.request.get(U + "/")).headers();
    check(/default-src 'self'/.test(h["content-security-policy"]) && h["x-content-type-options"] === "nosniff" && h["x-frame-options"] === "DENY", "headers: " + JSON.stringify(h));
    await p.evaluate(() => navigator.serviceWorker.ready);
  });

  await step("Back up photos files them by year; the timeline, grid, viewer and swipe work", async () => {
    const photos = join(work, "photos");
    mkdirSync(photos);
    const paths = [["old-2023.png", new Date(2023, 5, 10, 12)], ["mid-2024.png", new Date(2024, 2, 5, 12)], ["new-2025.png", new Date(2025, 8, 20, 12)]].map(([n, d], i) => {
      const f = join(photos, n); writeFileSync(f, png(120, 90, COLOURS[i])); utimesSync(f, d, d); return f;
    });
    const p = await newPage();
    await home(p);
    await p.setInputFiles('label:has-text("Back up photos") input', paths);
    await p.waitForSelector(".sheet h2:has-text('Backup finished')", { timeout: 60000 });
    check(/Uploaded 3 · Already there 0 · Failed 0/.test(await p.textContent(".sheet")), "three uploaded");
    await p.click(".sheet >> text=Done");
    await p.click('a.main:has-text("Camera backup")');
    await p.waitForSelector('h1:has-text("Camera backup")');
    check((await p.locator("ul.list li .name").allTextContents()).sort().join() === "2023,2024,2025", "one folder per year");
    await p.evaluate(() => { sessionStorage.setItem("auto-view", "1"); localStorage.removeItem("view"); }); // from here on, let the app choose
    await p.reload(); // the app reads the remembered view once, at start
    await p.waitForSelector('a.main:has-text("2025")');
    await p.click('a.main:has-text("2025")');
    await p.waitForSelector(".grid .cell img");
    check(!(await p.isVisible("ul.list")), "a folder of photos opens as a grid");
    await p.click('button[aria-label="Show as a list"]');
    await p.waitForSelector("ul.list li .tile");
    await p.reload();
    await p.waitForSelector("ul.list li .tile");
    await p.click('button[aria-label="Show as a grid of pictures"]');
    await p.waitForSelector(".grid .cell img");

    await p.goto(U + "/#/photos");
    await p.waitForSelector(".month");
    check((await p.locator(".month").allTextContents()).join() === "September 2025,March 2024,June 2023", "newest month first, one heading per month");
    await p.click(".cell >> nth=0");
    await p.waitForSelector(".stage img");
    check((await p.textContent(".vbar .meta")).trim() === "1 / 3", "viewer spans the timeline");
    await swipe(p, ".stage img", -150);
    await p.waitForFunction(() => document.querySelector(".vbar .meta")?.textContent.trim() === "2 / 3");
    await swipe(p, ".stage img", 150);
    await p.waitForFunction(() => document.querySelector(".vbar .meta")?.textContent.trim() === "1 / 3");
    check(/^#\/f\/\d+$/.test(await p.getAttribute('.vbar a:has-text("Folder")', "href")), "Folder link");
    await p.keyboard.press("Escape");
    await p.waitForSelector(".view", { state: "detached" });
  });

  await step("upload shows a thumbnail; the same name is saved as 'name (1).png'; rename", async () => {
    const p = await newPage();
    await home(p);
    await upload(p, file("sunset.png"));
    await p.waitForSelector('li:has-text("sunset.png") .tile img');
    await upload(p, file("sunset.png", 1));
    await p.waitForSelector('li:has-text("sunset (1).png")');
    check(!(await p.isVisible(".upload .error")), "no error row for a name clash");
    await upload(p, file("sunset.png", 2));
    await p.waitForSelector('li:has-text("sunset (2).png")');
    await menu(p, "sunset (2).png", "Rename");
    await p.fill(".sheet input", "beach.png");
    await p.click(".sheet >> text=Save");
    await p.waitForSelector('li:has-text("beach.png")');
  });

  await step("select several: move them into a folder, delete some, restore", async () => {
    const p = await newPage();
    await home(p);
    await p.click("text=New folder"); await p.fill(".sheet input", "Trips"); await p.click(".sheet >> text=Save");
    await p.waitForSelector('li:has-text("Trips")');
    await upload(p, file("a.png"), file("b.png", 1), file("c.png", 2));
    for (const n of ["a.png", "b.png", "c.png"]) await p.waitForSelector(`li:has-text("${n}") .tile img`);

    await p.click('.searchrow >> text=Select');
    await p.click('.check[aria-label="Select a.png"]');
    await p.click('.check[aria-label="Select b.png"]');
    check((await p.textContent(".selbar")).includes("2 selected"), "count says 2 selected");
    check(!(await p.isVisible(".bar")), "the usual buttons are hidden while selecting");
    await p.click('.selbar >> text=Move');
    await p.click(".picker >> text=Trips");
    await p.click(".sheet >> text=Move here");
    await p.waitForSelector('li:has-text("a.png")', { state: "detached" });
    check(!(await p.isVisible(".selbar")), "selection ends after the move");
    await p.click('a.main:has-text("Trips")');
    await p.waitForSelector('h1:has-text("Trips")');
    check((await p.locator("li:has-text('a.png'), li:has-text('b.png')").count()) === 2, "both arrived in Trips");

    await p.goto(U + "/#/"); await p.waitForSelector('li:has-text("c.png")');
    await p.click('.searchrow >> text=Select');
    await p.click("text=All");
    check(/\d+ selected/.test(await p.textContent(".selbar")) && !(await p.locator('.check[aria-label="Select Family"]').isEnabled()), "All ticks everything, but the shared Family folder cannot be picked");
    await p.click('.selbar >> text=✕');
    await p.click('.searchrow >> text=Select');
    await p.click('.check[aria-label="Select c.png"]');
    await p.click('.selbar >> text=Delete');
    await p.waitForSelector('li:has-text("c.png")', { state: "detached" });

    await p.goto(U + "/#/trash");
    await p.waitForSelector('li:has-text("c.png")');
    await p.click("text=Select");
    await p.click('.check[aria-label="Select c.png"]');
    await p.click(".selbar >> text=Restore");
    await p.waitForSelector('li:has-text("c.png")', { state: "detached" });
    await p.goto(U + "/#/"); await p.waitForSelector('li:has-text("c.png")');
  });

  await step("trash: delete forever asks first; empty trash clears everything", async () => {
    const p = await newPage();
    await home(p);
    await menu(p, "c.png", "Delete");
    await menu(p, "sunset (1).png", "Delete");
    await p.goto(U + "/#/trash");
    await p.waitForSelector('li:has-text("c.png")');
    await p.click("text=Select");
    await p.click('.check[aria-label="Select c.png"]');
    await p.click(".selbar >> text=Delete forever");
    check(await p.isVisible(".sheet >> text=cannot be recovered"), "a confirmation appears");
    await p.click(".sheet >> text=Cancel");
    check(await p.isVisible('li:has-text("c.png")'), "cancelling deletes nothing");
    await p.click(".selbar >> text=Delete forever");
    await p.click(".sheet >> text=Delete forever");
    await p.waitForSelector('li:has-text("c.png")', { state: "detached" });
    check(await p.isVisible('li:has-text("sunset (1).png")'), "the other trashed file is still there");
    await p.click("text=Empty trash");
    await p.click(".sheet >> text=Empty trash");
    await p.waitForSelector("text=Trash is empty");
  });

  await step("long-press picks photos in the timeline; picked photos can be deleted", async () => {
    const p = await newPage();
    await p.goto(U + "/#/photos");
    await p.waitForSelector(".cell img");
    await longPress(p, ".grid .cell .thumb", 0);
    await p.waitForSelector(".selbar");
    const before = await p.locator(".cell").count();
    check((await p.textContent(".selbar")).includes("1 selected"), "long-press starts selecting");
    check(!(await p.isVisible(".view")), "and does not also open the viewer");
    await p.click(".cell >> nth=1");
    check((await p.textContent(".selbar")).includes("2 selected"), "a tap ticks another");
    await p.click(".selbar >> text=Delete");
    await p.waitForFunction((n) => document.querySelectorAll(".cell").length === n - 2, before);
    check(!(await p.isVisible(".selbar")), "selection ends");
    await p.goto(U + "/#/trash");
    await p.waitForSelector("li .name");
    check((await p.locator("li .name").count()) === 2, "both photos are in the trash");
  });

  await step("share link: public page works without signing in, then stops when revoked", async () => {
    const p = await newPage();
    await home(p);
    await p.click("text=New folder"); await p.fill(".sheet input", "Album"); await p.click(".sheet >> text=Save");
    await p.waitForSelector('li:has-text("Album")');
    await p.click('a.main:has-text("Album")');
    await p.waitForSelector('h1:has-text("Album")');
    await upload(p, file("shared.png"));
    await p.waitForSelector('li:has-text("shared.png") .tile img');
    await p.goto(U + "/#/");
    await menu(p, "Album", "Share link");
    await p.click(".sheet >> text=New link");
    await p.waitForSelector('.sheet li:has-text("Expires")');
    const token = (await (await p.request.get(U + "/api/shares?node=" + (await (await p.request.get(U + "/api/files")).json()).items.find((i) => i.name === "Album").id)).json()).items[0].token;
    const outsider = await browser.newPage();
    const res = await outsider.goto(`${U}/s/${token}`);
    check(res.status() === 200 && (await outsider.textContent("body")).includes("shared.png"), "outsider sees the folder");
    check((await outsider.evaluate(() => document.querySelectorAll("script").length)) === 0, "public page has no scripts");
    await p.click('.sheet li:has-text("Expires") >> text=Revoke');
    await p.waitForSelector("text=Link revoked");
    check((await outsider.goto(`${U}/s/${token}`)).status() === 404, "revoked link is Not found");
  });

  await step("search finds items and says where they are", async () => {
    const p = await newPage();
    await home(p);
    await p.fill(".search", "shared");
    await p.waitForSelector('li:has-text("shared.png"):has-text("in Album")');
  });

  await step("admins see the backup banner until a backup runs; members never do", async () => {
    const p = await newPage();
    await home(p);
    await p.waitForSelector(".notice");
    check(/not run yet/.test(await p.textContent(".notice")), "banner before the first run");
    await p.click(".notice");
    await p.waitForSelector("h1:has-text('Admin')");
    await p.click("text=Add person"); await p.fill(".sheet input", "kid@example.com"); await p.click(".sheet >> text=Save");
    await p.waitForSelector("li:has-text('kid@example.com')");
    await p.click("text=Back up now");
    await p.waitForSelector("li:has-text('Backup'):has-text('Last run')");
    await home(p);
    await p.waitForTimeout(500);
    check(!(await p.isVisible(".notice")), "banner still there after a backup: " + (await p.locator(".notice").allTextContents()).join(" "));
    const kid = await newPage({ "x-dev-email": "kid@example.com" });
    await home(kid);
    await kid.click(".account summary");
    check(!(await kid.isVisible(".account >> text=Admin")) && !(await kid.isVisible(".notice")), "a member has no Admin link and no banner");
  });

  await step("download a folder, a selection and a single file", async () => {
    const p = await newPage();
    const api = async (method, path, data, type) => (await p.request.fetch(U + path, { method, data, headers: type ? { "content-type": type } : {} })).json().catch(() => ({}));
    const folder = async (name, parent) => (await api("POST", "/api/folders", { name, parent })).id;
    const put = async (name, parent, bytes) => api("PUT", `/api/files?name=${encodeURIComponent(name)}${parent ? `&parent=${parent}` : ""}`, bytes, "application/octet-stream");
    const one = await folder("ZipMe"), inner = await folder("Inner", one), two = await folder("ZipToo");
    const bytes = { a: Buffer.from("first file"), b: Buffer.alloc(100_000, 7), c: Buffer.from("third") };
    await put("a.txt", one, bytes.a); await put("b.bin", inner, bytes.b); await put("c.txt", two, bytes.c);
    await put("lonely.txt", undefined, Buffer.from("just me"));
    await home(p);
    const grab = async (click) => { const [d] = await Promise.all([p.waitForEvent("download"), click()]); return { name: d.suggestedFilename(), bytes: readFileSync(await d.path()) }; };

    const z1 = await grab(async () => { await menu(p, "ZipMe", "Download as zip"); });
    check(z1.name === "ZipMe.zip", "folder zip is named after the folder: " + z1.name);
    const r1 = inspectZip(z1.bytes);
    check(r1.bad === null && r1.names.sort().join() === "ZipMe/,ZipMe/Inner/,ZipMe/Inner/b.bin,ZipMe/a.txt", "folder tree: " + r1.names);
    check(r1.sha["ZipMe/Inner/b.bin"] === sha(bytes.b) && r1.sha["ZipMe/a.txt"] === sha(bytes.a), "contents are identical");

    await p.click(".searchrow >> text=Select");
    await p.click('.check[aria-label="Select ZipMe"]');
    await p.click('.check[aria-label="Select ZipToo"]');
    const z2 = await grab(() => p.click(".selbar >> text=Download"));
    check(z2.name === "Family Cloud.zip", "several items: " + z2.name);
    const r2 = inspectZip(z2.bytes);
    check(r2.bad === null && r2.names.includes("ZipToo/c.txt") && r2.names.includes("ZipMe/Inner/b.bin"), "both trees are in it: " + r2.names);
    await p.click(".selbar >> text=✕");

    await p.click(".searchrow >> text=Select");
    await p.click('.check[aria-label="Select lonely.txt"]');
    const z3 = await grab(() => p.click(".selbar >> text=Download"));
    check(z3.name === "lonely.txt" && z3.bytes.toString() === "just me", "one file downloads as itself, not a zip: " + z3.name);
  });

  await step("no page broke the Content-Security-Policy", async () => { check(cspViolations.length === 0, cspViolations.join(" | ")); });
} catch (e) {
  failed++;
  console.log("FAIL harness:", e.message);
} finally {
  await browser?.close();
  server?.kill();
  try { execFileSync("pkill", ["-f", `wrangler.*${PORT}`]); } catch {}
  rmSync(work, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} step(s) failed` : "\nall steps passed");
process.exit(failed ? 1 : 0);
