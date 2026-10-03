import { createDocument } from "@/lib/server/provenance";
import { parseBody, respond } from "@/lib/server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try { return Response.json(createDocument(await parseBody(request)), { status: 201 }); }
  catch (error) { return respond(error); }
}
