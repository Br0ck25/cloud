import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

test("manifest is installable and accepts files from the Share sheet", () => {
  const m = JSON.parse(readFileSync("web/public/manifest.webmanifest", "utf8"));
  assert.equal(m.display, "standalone");
  const css = readFileSync("web/src/style.css", "utf8");
  assert.ok(css.includes(`--bg: ${m.theme_color}`), "manifest theme_color matches the page background (iOS paints the bottom bar with it)");
  assert.equal(m.background_color, m.theme_color);
  for (const i of m.icons) assert.ok(existsSync(`web/public${i.src}`), `${i.src} exists`);
  const t = m.share_target;
  assert.equal(t.method, "POST");
  assert.equal(t.enctype, "multipart/form-data");
  assert.equal(t.params.files[0].name, "files");
  assert.ok(readFileSync("web/public/sw.js", "utf8").includes(`"${t.action}"`), "service worker handles the share action");
});
