import { auth } from "@/app/(auth)/auth";
import { checkIpRateLimit } from "@/lib/ratelimit";
import { handleGateway, readLimited } from "@/lib/secure-openai/core.mjs";
import { enforceGatewayQuota } from "@/lib/secure-openai/limiter.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const reply = (message: string, status: number) =>
  Response.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } }
  );
async function allowed() {
  const session = await auth();
  return (
    !!session?.user &&
    (session.user.type !== "guest" || process.env.ALLOW_GUEST_CHAT === "1")
  );
}
export async function GET() {
  if (!(await allowed())) return reply("Unauthorized", 401);
  return Response.json(
    { model: process.env.WEB_IMAGE_MODEL || "gpt-image-1" },
    { headers: { "Cache-Control": "no-store" } }
  );
}
export async function POST(request: Request) {
  if (!(await allowed())) return reply("Unauthorized", 401);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    return reply("Origin denied", 403);
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") || ""
    )
  )
    return reply("JSON required", 415);
  let prompt: unknown;
  try {
    const raw = await readLimited(request, 12 * 1024);
    prompt = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(raw)
    )?.prompt;
  } catch {
    return reply("Invalid input", 400);
  }
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 8000)
    return reply("Invalid prompt", 400);
  try {
    await checkIpRateLimit(undefined);
  } catch {
    return reply("Capacity reached", 429);
  }
  const gatewayKey = (process.env.OAI_GATEWAY_KEYS || "").split(",")[0]?.trim();
  if (!gatewayKey) return reply("Image API not configured", 503);
  const internal = new Request(
    "https://internal.invalid/v1/images/generations",
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + gatewayKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.WEB_IMAGE_MODEL || "gpt-image-1",
        prompt,
        n: 1,
        size: "1024x1024",
      }),
      signal: request.signal,
    }
  );
  return handleGateway(internal, "images/generations", {
    quota: enforceGatewayQuota,
  });
}
