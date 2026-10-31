import { handleGateway, handlePreflight } from "@/lib/secure-openai/core.mjs";
import { enforceGatewayQuota } from "@/lib/secure-openai/limiter.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Context = { params: Promise<{ path: string[] }> };
export async function GET(req: Request, context: Context) {
  return handleGateway(req, (await context.params).path.join("/"), {
    quota: enforceGatewayQuota,
  });
}
export async function POST(req: Request, context: Context) {
  return handleGateway(req, (await context.params).path.join("/"), {
    quota: enforceGatewayQuota,
  });
}
export async function OPTIONS(req: Request) {
  return handlePreflight(req);
}
