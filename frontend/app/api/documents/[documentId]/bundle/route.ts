import { getEvidencePackage } from "@/lib/server/provenance";
import { respond } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  try {
    const id = (await params).documentId;
    return Response.json(getEvidencePackage(id), { headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="proofflow-evidence-${id}.json"`,
    } });
  } catch (error) {
    return respond(error);
  }
}
