import test from "node:test";
import assert from "node:assert/strict";
import { verifyAccessJwt } from "./auth.ts";

const TEAM = "t.cloudflareaccess.com";
const AUD = "app-aud";
const b64u = (b: ArrayBuffer | string) =>
  Buffer.from(typeof b === "string" ? b : new Uint8Array(b)).toString("base64url");

const pair = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"])) as CryptoKeyPair;
const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
const keys = async () => [jwk as any];

async function sign(claims: object, key = pair.privateKey, kid = "k1") {
  const h = b64u(JSON.stringify({ alg: "RS256", kid }));
  const p = b64u(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}
const good = { aud: [AUD], iss: `https://${TEAM}`, exp: Date.now() / 1000 + 60, email: "Mom@Example.com" };

test("valid token returns lower-cased email", async () => {
  assert.equal(await verifyAccessJwt(await sign(good), TEAM, AUD, keys), "mom@example.com");
});
test("wrong audience, issuer, expired, unknown kid, bad signature and garbage are rejected", async () => {
  const other = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"])) as CryptoKeyPair;
  for (const t of [
    await sign({ ...good, aud: ["nope"] }),
    await sign({ ...good, iss: "https://evil.example" }),
    await sign({ ...good, exp: Date.now() / 1000 - 1 }),
    await sign(good, pair.privateKey, "unknown"),
    await sign(good, other.privateKey),
    "not.a.jwt",
    "",
  ]) assert.equal(await verifyAccessJwt(t, TEAM, AUD, keys), null);
});
