import { authenticate } from "@/lib/server/auth";
import { parseBody, respond } from "@/lib/server/http";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try { return await authenticate(await parseBody(request), true, request); } catch (error) { return respond(error); }
}
