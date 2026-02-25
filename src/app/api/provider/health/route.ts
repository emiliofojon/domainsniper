import { NextResponse } from "next/server";
import { lookup } from "node:dns/promises";

export const runtime = "nodejs";

function getBaseUrl(): string {
  return process.env.DOMAIN_PROVIDER_BASE_URL?.trim() || "";
}

export async function GET() {
  const baseUrl = getBaseUrl();
  const hasApiKey = Boolean(process.env.DOMAIN_PROVIDER_API_KEY?.trim());
  const header = process.env.DOMAIN_PROVIDER_API_KEY_HEADER?.trim() || "";
  const hasHeaderValue = Boolean(process.env.DOMAIN_PROVIDER_API_KEY_VALUE?.trim());

  if (!baseUrl) {
    return NextResponse.json(
      {
        ok: false,
        error: "Falta DOMAIN_PROVIDER_BASE_URL",
        hasApiKey,
        header,
        hasHeaderValue,
      },
      { status: 500 }
    );
  }

  let host = "";
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "DOMAIN_PROVIDER_BASE_URL no es una URL válida",
        baseUrl,
        hasApiKey,
        header,
        hasHeaderValue,
      },
      { status: 500 }
    );
  }

  let dnsResult: string | null = null;
  let dnsError: string | null = null;
  try {
    const result = await lookup(host);
    dnsResult = result.address;
  } catch (error: unknown) {
    dnsError = error instanceof Error ? error.message : String(error);
  }

  let fetchStatus: number | null = null;
  let fetchError: string | null = null;
  try {
    const response = await fetch(baseUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      cache: "no-store",
    });
    fetchStatus = response.status;
  } catch (error: unknown) {
    fetchError = error instanceof Error ? error.message : String(error);
  }

  return NextResponse.json({
    ok: Boolean(hasApiKey && dnsResult && fetchStatus !== null && !fetchError),
    baseUrl,
    host,
    hasApiKey,
    header,
    hasHeaderValue,
    dnsResult,
    dnsError,
    fetchStatus,
    fetchError,
  });
}
