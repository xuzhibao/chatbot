import { type NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { guestRegex, isDevelopmentEnvironment } from "./lib/constants";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/ping")) {
    return new Response("pong", { status: 200 });
  }

  // /v1 has its own strict Bearer authorization. Never redirect API clients.
  if (pathname === "/v1" || pathname.startsWith("/v1/")) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: !isDevelopmentEnvironment,
  });

  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

  const isGuest =
    token?.type === "guest" || guestRegex.test(token?.email ?? "");
  const guestAllowed = process.env.ALLOW_GUEST_CHAT === "1";
  if (!token || (isGuest && !guestAllowed)) {
    if (pathname === "/login" || pathname === "/register")
      return NextResponse.next();
    if (!token && guestAllowed) {
      const redirectUrl = encodeURIComponent(new URL(request.url).pathname);
      return NextResponse.redirect(
        new URL(
          `${base}/api/auth/guest?redirectUrl=${redirectUrl}`,
          request.url
        )
      );
    }
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Unauthorized" },
        {
          status: 401,
          headers: { "Cache-Control": "no-store" },
        }
      );
    }
    return NextResponse.redirect(new URL(`${base}/login`, request.url));
  }
  if (!isGuest && ["/login", "/register"].includes(pathname)) {
    return NextResponse.redirect(new URL(`${base}/`, request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/chat/:id",
    "/api/:path*",
    "/login",
    "/register",

    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
