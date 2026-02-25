import { NextResponse } from "next/server";
import { ensureSoindaDataLoaded, querySoindaDomains } from "@/lib/server/soinda-store";

export const runtime = "nodejs";

function getErrorDetails(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message || "";
    if (message.toLowerCase().includes("429") || message.toLowerCase().includes("rate limit")) {
      return "Soinda está limitando peticiones (429). Se reintentará automáticamente.";
    }
    return message;
  }
  return String(error);
}

function parseBool(value: string | null): boolean | null {
  if (value === null) return null;
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "si", "sí"].includes(normalized)) return true;
  if (["0", "false", "no"].includes(normalized)) return false;
  return null;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const page = Math.max(1, Number(searchParams.get("page") || "1"));
    const perPage = Math.min(100, Math.max(1, Number(searchParams.get("per_page") || "25")));

    const q = (searchParams.get("q") || "").trim().toLowerCase();
    const tld = (searchParams.get("tld") || "").trim().toLowerCase();
    const onlyAvailable = parseBool(searchParams.get("available"));
    const sortBy = (searchParams.get("sort_by") || "domain").trim();
    const sortDir = (searchParams.get("sort_dir") || "asc").toLowerCase() === "desc" ? "desc" : "asc";
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

    const result = await querySoindaDomains({
      page,
      perPage,
      q,
      tld,
      available: onlyAvailable,
      columnFilters,
      sortBy,
      sortDir,
    });

    return NextResponse.json({
      data: result.data,
      fields: result.fields,
      pagination: {
        page,
        perPage,
        total: result.total,
        hasMore: result.hasMore,
        scope: "global",
      },
    });
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error: "No se pudieron cargar dominios",
        details: getErrorDetails(error),
      },
      { status: 500 }
    );
  }
}
