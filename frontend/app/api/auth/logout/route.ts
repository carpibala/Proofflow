import { logout } from "@/lib/server/auth";
import { respond } from "@/lib/server/http";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try { return logout(request); } catch (error) { return respond(error); }
}
