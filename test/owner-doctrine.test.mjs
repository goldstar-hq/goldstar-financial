import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import worker, { ai, sha256Hex } from "../src/worker.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

function makeKV(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    async get(key) { return values.has(key) ? values.get(key) : null; },
    async put(key, value) { values.set(key, String(value)); },
    async delete(key) { values.delete(key); }
  };
}

function makeEnv(overrides = {}) {
  const knowledge = makeKV();
  const calls = [];
  return {
    API_KEY: "legacy-l2-api-key",
    L1_BRIDGE_KEY: "dedicated-l1-bridge-key",
    KNOWLEDGE: knowledge,
    AI: {
      async run(model, options) {
        calls.push({ model, prompt: options.prompt });
        return { response: "AI_TEST_OK" };
      }
    },
    calls,
    ...overrides
  };
}

function doctrineBody(overrides = {}) {
  return {
    document_id: "OWNER_DOCTRINE_V1",
    revision: "1.1.0",
    authority: { owner_level: "L0", owner_role: "human_owner_and_final_authority" },
    identity_and_readers: {
      l1: { must_read_and_apply: true },
      all_managers_and_agents: {
        must_read_before_assignment: true,
        must_follow_owner_hierarchy: true
      }
    },
    owner_working_profile: {
      communication: "Direct, precise, verifiable.",
      test_directive: "OWNER_DIRECTIVE_FOR_TEST"
    },
    lifecycle: {
      status: "production_l1_runtime_injection_verified_behavioral_and_l2_l3_distribution_pending",
      production_effective: false
    },
    ...overrides
  };
}

async function validPayload(overrides = {}) {
  const body = doctrineBody();
  const payload = {
    document_id: "OWNER_DOCTRINE_V1",
    record_version: 2,
    revision: "1.1.0",
    status: "production_pending_integration",
    owner_authority: "L0_HUMAN_OWNER_FINAL_AUTHORITY",
    body,
    body_sha256: await sha256Hex(JSON.stringify(body))
  };
  return { ...payload, ...overrides };
}

function request(path, method, payload, headers = {}) {
  const init = {
    method,
    headers: { "content-type": "application/json", ...headers }
  };
  if (payload !== undefined) init.body = JSON.stringify(payload);
  return new Request("https://l2.example" + path, init);
}

const bridge = { "X-Goldstar-Bridge-Key": "dedicated-l1-bridge-key" };
const legacy = { "X-API-Key": "legacy-l2-api-key" };

test("L2 accepts a valid Owner Doctrine only through the dedicated L1 bridge and verifies KV read-back", async () => {
  const env = makeEnv();
  const payload = await validPayload();
  const response = await worker.fetch(
    request("/governance/owner-doctrine", "POST", payload, bridge), env, {}
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.received, true);
  assert.equal(result.already_received, false);
  assert.equal(result.document_id, "OWNER_DOCTRINE_V1");
  assert.equal(result.revision, "1.1.0");
  assert.equal(result.record_version, 2);
  assert.match(result.body_sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.recipient_agent_id, "L2");
  assert.ok(result.received_at);

  const stored = JSON.parse(await env.KNOWLEDGE.get("governance:owner-doctrine:OWNER_DOCTRINE_V1"));
  assert.equal(stored.body_sha256, result.body_sha256);
  assert.equal(stored.body.owner_working_profile.test_directive, "OWNER_DIRECTIVE_FOR_TEST");
});

test("legacy X-API-Key alone cannot deliver or read Owner Doctrine", async () => {
  const env = makeEnv();
  const payload = await validPayload();
  const deliver = await worker.fetch(
    request("/governance/owner-doctrine", "POST", payload, legacy), env, {}
  );
  assert.equal(deliver.status, 401);

  const status = await worker.fetch(
    request("/governance/owner-doctrine/status", "GET", undefined, legacy), env, {}
  );
  assert.equal(status.status, 401);
  assert.equal(await env.KNOWLEDGE.get("governance:owner-doctrine:OWNER_DOCTRINE_V1"), null);
});

test("Owner Doctrine receipt is idempotent and status exposes metadata, not the document body", async () => {
  const env = makeEnv();
  const payload = await validPayload();
  const first = await worker.fetch(
    request("/governance/owner-doctrine", "POST", payload, bridge), env, {}
  );
  const firstResult = await first.json();
  const second = await worker.fetch(
    request("/governance/owner-doctrine", "POST", payload, bridge), env, {}
  );
  const secondResult = await second.json();

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(secondResult.already_received, true);
  assert.equal(secondResult.received_at, firstResult.received_at);

  const status = await worker.fetch(
    request("/governance/owner-doctrine/status", "GET", undefined, bridge), env, {}
  );
  const statusResult = await status.json();
  assert.equal(status.status, 200);
  assert.equal(statusResult.received, true);
  assert.equal(statusResult.body_sha256, firstResult.body_sha256);
  assert.equal(Object.hasOwn(statusResult, "body"), false);
});

test("L2 rejects an Owner Doctrine with a mismatched body hash", async () => {
  const env = makeEnv();
  const payload = await validPayload({ body_sha256: "0".repeat(64) });
  const response = await worker.fetch(
    request("/governance/owner-doctrine", "POST", payload, bridge), env, {}
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "OWNER_DOCTRINE_HASH_MISMATCH");
  assert.equal(await env.KNOWLEDGE.get("governance:owner-doctrine:OWNER_DOCTRINE_V1"), null);
});

test("L2 rejects a pending Owner Doctrine whose body claims production_effective=true", async () => {
  const env = makeEnv();
  const body = doctrineBody({ lifecycle: { production_effective: true } });
  const payload = await validPayload({
    body,
    body_sha256: await sha256Hex(JSON.stringify(body))
  });
  const response = await worker.fetch(
    request("/governance/owner-doctrine", "POST", payload, bridge), env, {}
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "OWNER_DOCTRINE_LIFECYCLE_MISMATCH");
});

test("L2 rejects a stale Owner Doctrine revision", async () => {
  const env = makeEnv();
  const payload = await validPayload({ revision: "1.0.0" });
  const response = await worker.fetch(
    request("/governance/owner-doctrine", "POST", payload, bridge), env, {}
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "OWNER_DOCTRINE_CONTRACT_INVALID");
});

test("AI work fails closed when the Owner Doctrine has not been received", async () => {
  const env = makeEnv();
  await assert.rejects(() => ai(env, "perform a test task"), /OWNER_DOCTRINE_NOT_RECEIVED/);
  assert.equal(env.calls.length, 0);
});

test("AI prompt includes the verified L0 Owner Doctrine before the task", async () => {
  const env = makeEnv();
  const payload = await validPayload();
  const response = await worker.fetch(
    request("/governance/owner-doctrine", "POST", payload, bridge), env, {}
  );
  assert.equal(response.status, 200);

  const result = await ai(env, "TASK_FOR_TEST");
  assert.equal(result, "AI_TEST_OK");
  assert.equal(env.calls.length, 1);
  assert.ok(env.calls[0].prompt.includes("OWNER_DIRECTIVE_FOR_TEST"));
  assert.ok(env.calls[0].prompt.indexOf("MANDATORY GOLDSTAR L0 OWNER DOCTRINE") <
    env.calls[0].prompt.indexOf("TASK_FOR_TEST"));
});

test("tampered stored Owner Doctrine is rejected before AI execution", async () => {
  const env = makeEnv();
  const payload = await validPayload();
  const response = await worker.fetch(
    request("/governance/owner-doctrine", "POST", payload, bridge), env, {}
  );
  assert.equal(response.status, 200);

  const key = "governance:owner-doctrine:OWNER_DOCTRINE_V1";
  const stored = JSON.parse(await env.KNOWLEDGE.get(key));
  stored.body.owner_working_profile.test_directive = "TAMPERED";
  await env.KNOWLEDGE.put(key, JSON.stringify(stored));

  await assert.rejects(() => ai(env, "TASK_FOR_TEST"), /OWNER_DOCTRINE_HASH_MISMATCH/);
  assert.equal(env.calls.length, 0);
});

test("market analysis remains disabled after adding Owner Doctrine receipt support", async () => {
  const env = makeEnv();
  const health = await worker.fetch(new Request("https://l2.example/health"), env, {});
  assert.equal(health.status, 200);
  assert.equal((await health.json()).analysisEnabled, false);

  const analysis = await worker.fetch(
    request("/analyze", "POST", { symbol: "XAUUSD", timeframe: "H1" }, bridge), env, {}
  );
  assert.equal(analysis.status, 503);
});
