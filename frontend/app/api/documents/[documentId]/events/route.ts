import { requireDocument } from "@/lib/server/auth";
import { listEvents, saveEvent } from "@/lib/server/provenance";
import { parseBody, respond } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  try { requireDocument(request, (await params).documentId); return Response.json({ events: listEvents((await params).documentId) }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return respond(error); }
}

export async function POST(request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  try { requireDocument(request, (await params).documentId); return Response.json(saveEvent((await params).documentId, await parseBody(request)), { status: 201 }); }
  catch (error) { return respond(error); }
}
