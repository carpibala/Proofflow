import { ApiError } from "./provenance";

export async function parseBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > 250000) throw new ApiError(413, "REQUEST_TOO_LARGE", "Request exceeds demo limit");
  try { return JSON.parse(text); }
  catch { throw new ApiError(400, "INVALID_JSON", "Request body must be JSON"); }
}

export function respond(error: unknown): Response {
  if (error instanceof ApiError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  console.error(error);
  return Response.json({ error: "INTERNAL_ERROR", message: "Unexpected server error" }, { status: 500 });
}
