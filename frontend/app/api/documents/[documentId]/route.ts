import { requireDocument } from "@/lib/server/auth";
import { getDocument } from "@/lib/server/provenance";
import { respond } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  try { requireDocument(request, (await params).documentId); return Response.json(getDocument((await params).documentId), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return respond(error); }
}
