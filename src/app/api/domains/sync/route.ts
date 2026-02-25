import { NextResponse } from "next/server";
import { getSoindaSyncStatus, resetSoindaCatalog, syncSoindaDomains } from "@/lib/server/soinda-store";

export const runtime = "nodejs";

function getErrorDetails(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function GET() {
  return NextResponse.json(getSoindaSyncStatus());
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { force?: boolean; reset?: boolean };
    if (body.reset) {
      resetSoindaCatalog();
    }
    await syncSoindaDomains(Boolean(body.force), true);
    return NextResponse.json({ success: true, status: getSoindaSyncStatus() });
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error: "No se pudo sincronizar con Soinda",
        details: getErrorDetails(error),
      },
      { status: 500 }
    );
  }
}
