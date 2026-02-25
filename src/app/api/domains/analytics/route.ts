import { NextResponse } from "next/server";
import { ensureSoindaDataLoaded, querySoindaAnalytics } from "@/lib/server/soinda-store";

export const runtime = "nodejs";

function parseBool(value: string | null): boolean | null {
  if (value === null) return null;
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "si", "sí"].includes(normalized)) return true;
  if (["0", "false", "no"].includes(normalized)) return false;
  return null;
}

function getErrorDetails(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const q = (searchParams.get("q") || "").trim().toLowerCase();
    const tld = (searchParams.get("tld") || "").trim().toLowerCase();
    const available = parseBool(searchParams.get("available"));
    const filtersRaw = searchParams.get("filters");

    let columnFilters: Record<string, string> = {};
    if (filtersRaw) {
      try {
        const parsed = JSON.parse(filtersRaw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          columnFilters = Object.fromEntries(
            Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, String(value ?? "")])
          );
        }
      } catch {
        columnFilters = {};
      }
    }

    await ensureSoindaDataLoaded();

    const analytics = await querySoindaAnalytics({
      q,
      tld,
      available,
      columnFilters,
    });

    return NextResponse.json(analytics);
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error: "No se pudieron generar analíticas",
        details: getErrorDetails(error),
      },
      { status: 500 }
    );
  }
}
