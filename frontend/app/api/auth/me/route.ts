import { currentUser } from "@/lib/server/auth";
import { respond } from "@/lib/server/http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { return Response.json({ user: currentUser(request) }, { headers: { "Cache-Control": "no-store" } }); } catch (error) { return respond(error); }
}
