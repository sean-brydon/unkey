import { collectPageViewAnalytics } from "@/lib/analytics";
import { db } from "@/lib/db";
import { authMiddleware, clerkClient } from "@clerk/nextjs";
import { redirectToSignIn } from "@clerk/nextjs";
import { type NextFetchEvent, type NextRequest, NextResponse } from "next/server";
const findWorkspace = async ({ tenantId }: { tenantId: string }) => {
  const workspace = await db.query.workspaces.findFirst({
    where: (table, { and, eq, isNull }) =>
      and(eq(table.tenantId, tenantId), isNull(table.deletedAt)),
  });
  return workspace;
};

export default async function (req: NextRequest, evt: NextFetchEvent) {
  let userId: string | undefined = undefined;
  let tenantId: string | undefined = undefined;
  const privateMatch = "^/";
  console.debug(req.url);
  const res = await authMiddleware({
    debug: process.env.CLERK_DEBUG === "true",
    afterAuth: async (auth, req) => {
      if (!auth.userId && privateMatch.match(req.nextUrl.pathname)) {
        return redirectToSignIn({ returnBackUrl: req.url });
      }
      userId = auth.userId ?? undefined;
      tenantId = auth.orgId ?? auth.userId ?? undefined;
      if (auth.orgId && privateMatch.match(req.nextUrl.pathname)) {
        const workspace = await findWorkspace({ tenantId: auth.orgId });
        if (!workspace && req.nextUrl.pathname !== "/new") {
          console.error("Workspace not found for orgId", auth.orgId);
          await clerkClient.organizations.deleteOrganization(auth.orgId);
          console.info("Deleted orgId", auth.orgId, " sending to create new workspace.");
          return NextResponse.redirect(new URL("/new", req.url));
        }
        // this stops users if they haven't paid.
        if (!["/settings/billing/stripe", "/apis", "/", "/new"].includes(req.nextUrl.pathname)) {
          if (workspace?.plan === "free") {
            return NextResponse.redirect(new URL("/settings/billing/stripe", req.url));
          }
          return NextResponse.next();
        }
      }
      if (auth.userId && !auth.orgId && req.nextUrl.pathname === "/apis") {
        const workspace = await findWorkspace({ tenantId: auth.userId });
        if (!workspace) {
          return NextResponse.redirect(new URL("/new", req.url));
        }
      }
    },
  })(req, evt);

  evt.waitUntil(collectPageViewAnalytics({ req, userId, tenantId }));

  return res;
}

export const config = {
  matcher: [
    "/",
    "/apis",
    "/apis/(.*)",
    "/audit",
    "/audit/(.*)",
    "/authorization",
    "/authorization/(.*)",
    "/debug",
    "/debug/(.*)",
    "/gateways",
    "/gateways/(.*)",
    "/keys",
    "/keys/(.*)",
    "/overview",
    "/overview/(.*)",
    "/ratelimits",
    "/ratelimits/(.*)",
    "/secrets",
    "/secrets/(.*)",
    "/semant-cache",
    "/semantic-cache/(.*)",
    "/settings",
    "/settings/(.*)",
    "/success",
    "/success/(.*)",
    "/auth/(.*)",
    "/(api|trpc)(.*)",
    "/((?!.+\\.[\\w]+$|_next).*)",
    "/((?!_next/static|_next/image|images|favicon.ico|$).*)",
  ],
};
