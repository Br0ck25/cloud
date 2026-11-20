#!/usr/bin/env node
// Turns a nightly database dump from the backup bucket (db/YYYY-MM-DD.json.gz) into SQL for D1. See docs/RESTORE.md.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/restore-db.mjs db-YYYY-MM-DD.json.gz > restore.sql");
  process.exit(1);
}
const { tables } = JSON.parse(gunzipSync(readFileSync(file)).toString());

const q = (v) => (v === null ? "null" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);
const insert = (table, row) => `insert into ${table} (${Object.keys(row).join(", ")}) values (${Object.values(row).map(q).join(", ")});`;

// A folder's parent must exist before it does.
const byId = new Map(tables.nodes.map((n) => [n.id, n]));
const seen = new Set();
const nodes = [];
const add = (n) => {
  if (seen.has(n.id)) return;
  seen.add(n.id);
  if (n.parent_id != null && byId.has(n.parent_id)) add(byId.get(n.parent_id));
  nodes.push(n);
};
tables.nodes.forEach(add);

console.log([
  "delete from shares;", "delete from versions;", "delete from nodes;", "delete from users;",
  ...tables.users.map((r) => insert("users", r)),
  ...nodes.map((r) => insert("nodes", r)),
  ...tables.versions.map((r) => insert("versions", r)),
  ...tables.shares.map((r) => insert("shares", r)),
].join("\n"));
