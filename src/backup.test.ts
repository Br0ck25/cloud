import test from "node:test";
import assert from "node:assert/strict";
import { warningFor } from "./backup.ts";

const now = 1_800_000_000;
const ok = { ran_at: now - 3600, failed: 0, repaired: 0 };

test("backup warning: silent when healthy, loud when stale, failing or repairing", () => {
  assert.equal(warningFor(ok, now), null);
  assert.match(warningFor(null, now)!, /not run yet/);
  assert.match(warningFor({ ...ok, ran_at: now - 37 * 3600 }, now)!, /more than a day and a half/);
  assert.equal(warningFor({ ...ok, ran_at: now - 35 * 3600 }, now), null); // one missed night is not yet an alarm
  assert.match(warningFor({ ...ok, failed: 1 }, now)!, /1 problem in/);
  assert.match(warningFor({ ...ok, failed: 3 }, now)!, /3 problems in/);
  assert.match(warningFor({ ...ok, repaired: 2 }, now)!, /2 backup copies had gone missing and were copied again/);
  assert.match(warningFor({ ...ok, repaired: 1 }, now)!, /1 backup copy had gone missing and was copied again/);
  assert.match(warningFor({ ran_at: now - 40 * 3600, failed: 5, repaired: 0 }, now)!, /day and a half/); // staleness comes first
});
