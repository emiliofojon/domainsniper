import { NextResponse } from "next/server";
import { fetchProviderDomain } from "@/lib/server/domain-provider";

export const runtime = "nodejs";

function getErrorDetails(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const domain = (searchParams.get("domain") || "").trim().toLowerCase();
    if (!domain) {
      return NextResponse.json({ error: "Falta el parámetro domain" }, { status: 400 });
    }

    const snapshot = await fetchProviderDomain(domain);
    return NextResponse.json(snapshot);
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error: "No se pudo cargar el dominio en el proveedor",
        details: getErrorDetails(error),
      },
      { status: 500 }
    );
  }
}
