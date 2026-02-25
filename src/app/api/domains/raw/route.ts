import { NextResponse } from "next/server";
import { fetchExternalDomainsRaw } from "@/lib/server/external-domains";

export const runtime = "nodejs";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

function getErrorDetails(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function collectArrays(payload: unknown, depth = 0): unknown[][] {
  if (depth > 6 || payload === null || payload === undefined) return [];
  if (Array.isArray(payload)) return [payload];
  if (typeof payload !== "object") return [];

  const arrays: unknown[][] = [];
  for (const value of Object.values(payload as Record<string, unknown>)) {
    arrays.push(...collectArrays(value, depth + 1));
  }
  return arrays;
}

function collectObjectFieldStats(rows: unknown[]): Array<{ field: string; occurrences: number }> {
  const counters = new Map<string, number>();

  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    for (const key of Object.keys(row as Record<string, unknown>)) {
      counters.set(key, (counters.get(key) || 0) + 1);
    }
  }

  return Array.from(counters.entries())
    .map(([field, occurrences]) => ({ field, occurrences }))
    .sort((a, b) => b.occurrences - a.occurrences || a.field.localeCompare(b.field));
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const page = Math.max(1, Number(searchParams.get("page") || "1"));
    const perPage = Math.min(100, Math.max(1, Number(searchParams.get("per_page") || "25")));

    const payload = await fetchExternalDomainsRaw(page, perPage);
    const allArrays = collectArrays(payload);

    const bestArray = allArrays
      .slice()
      .sort((a, b) => b.length - a.length)[0] || [];

    const objectRows = bestArray.filter((row) => row && typeof row === "object" && !Array.isArray(row));

    const fields = collectObjectFieldStats(objectRows);

    return NextResponse.json({
      request: { page, perPage },
      payloadType: Array.isArray(payload) ? "array" : typeof payload,
      topLevelKeys: Object.keys(asRecord(payload)),
      detectedArrays: allArrays.map((arr) => arr.length).sort((a, b) => b - a),
      selectedArrayLength: bestArray.length,
      objectRowCount: objectRows.length,
      fields,
      sampleRows: bestArray.slice(0, 5),
      raw: payload,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error: "No se pudo obtener respuesta cruda de Soinda",
        details: getErrorDetails(error),
      },
      { status: 500 }
    );
  }
}
