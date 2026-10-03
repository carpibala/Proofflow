import { requireDocument } from "@/lib/server/auth";
import { getEvidencePackage } from "@/lib/server/provenance";
import { respond } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  try { requireDocument(request, (await params).documentId);
    const id = (await params).documentId;
    return Response.json(getEvidencePackage(id), { headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="proofflow-evidence-${id}.json"`,
    } });
  } catch (error) {
    return respond(error);
  }
}
