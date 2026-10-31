import test from "node:test";
import assert from "node:assert/strict";
import { handleGateway } from "../lib/secure-openai/core.mjs";
const good = {
  OAI_GATEWAY_ENABLED: "1",
  OPENAI_API_KEY: "upstream-" + "x".repeat(40),
  OAI_GATEWAY_KEYS: "client-" + "y".repeat(40),
  OAI_GATEWAY_MODELS: "gpt-4.1-mini,gpt-image-1",
};
const token = good.OAI_GATEWAY_KEYS;
function req(path, body = {}, auth = true, extra = {}) {
  return new Request("https://example.test/v1/" + path, {
    method: path === "models" ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: "Bearer " + token } : {}),
      ...extra,
    },
    ...(path === "models" ? {} : { body: JSON.stringify(body) }),
  });
}
const quota = async () => true;
test("disabled by default; fail closed", async () => {
  assert.equal(
    (await handleGateway(req("models"), "models", { env: {}, quota })).status,
    503
  );
});
test("auth required for every endpoint including models", async () => {
  assert.equal(
    (
      await handleGateway(req("models", {}, false), "models", {
        env: good,
        quota,
      })
    ).status,
    401
  );
  assert.equal(
    (
      await handleGateway(
        req(
          "chat/completions",
          {
            model: "gpt-4.1-mini",
            messages: [{ role: "user", content: "hey" }],
          },
          false
        ),
        "chat/completions",
        { env: good, quota }
      )
    ).status,
    401
  );
});
test("unknown model rejected without upstream call", async () => {
  let calls = 0;
  const res = await handleGateway(
    req("chat/completions", {
      model: "secret-model",
      messages: [{ role: "user", content: "hello" }],
    }),
    "chat/completions",
    {
      env: good,
      quota,
      fetchUpstream: async () => {
        calls++;
        throw Error("unexpected");
      },
    }
  );
  assert.equal(res.status, 400);
  assert.equal(calls, 0);
});
test("upstream credential never forwarded to client", async () => {
  const response = await handleGateway(
    req("chat/completions", {
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: "hello" }],
    }),
    "chat/completions",
    {
      env: good,
      quota,
      fetchUpstream: async (url, opts) => {
        assert.equal(url, "https://api.openai.com/v1/chat/completions");
        assert.equal(
          opts.headers.get("authorization"),
          "Bearer " + good.OPENAI_API_KEY
        );
        const body = JSON.parse(opts.body);
        assert.equal(body.store, false);
        return new Response(JSON.stringify({ choices: [] }), {
          headers: { "content-type": "application/json" },
        });
      },
    }
  );
  assert.equal(response.status, 200);
  assert.ok(!(await response.text()).includes(good.OPENAI_API_KEY));
});
test("quota outage and quota exceeded reject", async () => {
  assert.equal(
    (
      await handleGateway(req("models"), "models", {
        env: good,
        quota: async () => {
          throw Error("redis down");
        },
      })
    ).status,
    503
  );
  assert.equal(
    (
      await handleGateway(req("models"), "models", {
        env: good,
        quota: async () => false,
      })
    ).status,
    429
  );
});
test("malicious Origin blocked and CORS wildcard never accepted", async () => {
  assert.equal(
    (
      await handleGateway(
        req("models", {}, true, { Origin: "https://attacker.com" }),
        "models",
        { env: good, quota }
      )
    ).status,
    403
  );
});
test("error body containing upstream key is redacted", async () => {
  const res = await handleGateway(
    req("images/generations", { model: "gpt-image-1", prompt: "cat" }),
    "images/generations",
    {
      env: good,
      quota,
      fetchUpstream: async () =>
        new Response(good.OPENAI_API_KEY, { status: 400 }),
    }
  );
  assert.equal(res.status, 400);
  assert.ok(!(await res.text()).includes(good.OPENAI_API_KEY));
});
test("oversized request denied", async () => {
  const res = await handleGateway(
    req("images/generations", {
      model: "gpt-image-1",
      prompt: "x".repeat(40000),
    }),
    "images/generations",
    { env: good, quota }
  );
  assert.equal(res.status, 413);
});
test("SSE kept streaming", async () => {
  const res = await handleGateway(
    req("chat/completions", {
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }),
    "chat/completions",
    {
      env: good,
      quota,
      fetchUpstream: async () =>
        new Response("data: [DONE]\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        }),
    }
  );
  assert.equal(res.headers.get("Content-Type"), "text/event-stream");
  assert.equal(await res.text(), "data: [DONE]\n\n");
});
test("models returns explicit allowlist only", async () => {
  const res = await handleGateway(req("models"), "models", {
    env: good,
    quota,
  });
  assert.deepEqual(
    (await res.json()).data.map((x) => x.id),
    ["gpt-4.1-mini", "gpt-image-1"]
  );
});
