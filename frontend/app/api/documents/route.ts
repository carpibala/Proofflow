import { requireUser, listDocuments } from "@/lib/server/auth";
import { createDocument } from "@/lib/server/provenance";
import { parseBody, respond } from "@/lib/server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try { const user = requireUser(request); return Response.json(createDocument(await parseBody(request), user.id), { status: 201 }); }
  catch (error) { return respond(error); }
}

export async function GET(request: Request) {
  try { return Response.json({ documents: listDocuments(requireUser(request).id) }, { headers: { "Cache-Control": "no-store" } }); } catch (error) { return respond(error); }
}
