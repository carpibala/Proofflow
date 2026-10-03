import { requireDocument } from "@/lib/server/auth";
import { finalizeDocument } from "@/lib/server/provenance";
import { parseBody, respond } from "@/lib/server/http";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  try { requireDocument(request, (await params).documentId);
    return Response.json(finalizeDocument((await params).documentId, await parseBody(request)),
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return respond(error);
  }
}
