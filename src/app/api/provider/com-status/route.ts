import { NextResponse } from "next/server";
import { resolve4, resolve6, resolveCname, resolveMx, resolveNs, resolveTxt } from "node:dns/promises";

export const runtime = "nodejs";

type WhoisInfo = {
  found: boolean;
  domain: string;
  registrar: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  statuses: string[];
};

function baseLabelFromDomain(domain: string): string | null {
  const parts = domain.trim().toLowerCase().split(".");
  if (parts.length < 2) return null;
  if (!parts[0]) return null;
  return parts[0];
}

function buildComDomain(domain: string): string | null {
  const base = baseLabelFromDomain(domain);
  if (!base) return null;
  return `${base}.com`;
}

async function hasAnyPublicDns(domain: string): Promise<boolean> {
  const safe = domain.trim().toLowerCase();
  const safeResolve = async <T>(fn: () => Promise<T[]>): Promise<number> => {
    try {
      const records = await fn();
      return records.length;
    } catch {
      return 0;
    }
  };

  const counts = await Promise.all([
    safeResolve(() => resolve4(safe)),
    safeResolve(() => resolve6(safe)),
    safeResolve(() => resolveCname(safe)),
    safeResolve(() => resolveMx(safe)),
    safeResolve(() => resolveNs(safe)),
    safeResolve(() => resolveTxt(safe)),
  ]);
  return counts.some((count) => count > 0);
}

async function fetchComWhoisRdap(comDomain: string): Promise<WhoisInfo> {
  const url = `https://rdap.verisign.com/com/v1/domain/${encodeURIComponent(comDomain)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/rdap+json, application/json" },
    cache: "no-store",
  });

  if (response.status === 404) {
    return {
      found: false,
      domain: comDomain,
      registrar: null,
      createdAt: null,
      expiresAt: null,
      statuses: [],
    };
  }

  if (!response.ok) {
    throw new Error(`WHOIS RDAP ${response.status}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const events = Array.isArray(payload.events) ? (payload.events as Array<Record<string, unknown>>) : [];
  const eventDate = (name: string) => {
    const hit = events.find((ev) => String(ev.eventAction || "").toLowerCase() === name.toLowerCase());
    return hit ? String(hit.eventDate || "") || null : null;
  };

  const entities = Array.isArray(payload.entities) ? (payload.entities as Array<Record<string, unknown>>) : [];
  let registrar: string | null = null;
  for (const entity of entities) {
    const roles = Array.isArray(entity.roles) ? entity.roles.map((r) => String(r).toLowerCase()) : [];
    if (!roles.includes("registrar")) continue;
    const vcard = Array.isArray(entity.vcardArray) ? entity.vcardArray : [];
    const entries = Array.isArray(vcard[1]) ? (vcard[1] as unknown[]) : [];
    const fnEntry = entries.find((entry) => Array.isArray(entry) && String(entry[0] || "").toLowerCase() === "fn") as
      | [string, unknown, unknown, string]
      | undefined;
    if (fnEntry?.[3]) {
      registrar = String(fnEntry[3]);
      break;
    }
  }

  const statuses = Array.isArray(payload.status) ? payload.status.map((s) => String(s)) : [];

  return {
    found: true,
    domain: comDomain,
    registrar,
    createdAt: eventDate("registration"),
    expiresAt: eventDate("expiration"),
    statuses,
  };
}

async function checkWithCdmon(comDomain: string): Promise<{ ok: boolean; raw: unknown }> {
  const baseUrl = (process.env.DOMAIN_PROVIDER_BASE_URL || "").trim();
  const apiKey = (process.env.DOMAIN_PROVIDER_API_KEY_VALUE || process.env.DOMAIN_PROVIDER_API_KEY || "").trim();
  if (!baseUrl || !apiKey) return { ok: false, raw: { reason: "missing-provider-config" } };

  const url = `${baseUrl.replace(/\/+$/, "")}/check`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      apikey: apiKey,
    },
    body: JSON.stringify({ data: { domain: comDomain } }),
    cache: "no-store",
  });

  const text = await response.text();
  let raw: unknown = text;
  try {
    raw = JSON.parse(text);
  } catch {
    // keep text
  }
  return { ok: response.ok, raw };
}

function inferAvailability(args: { hasDns: boolean; whoisFound: boolean }): { available: boolean; confidence: string } {
  if (args.whoisFound) return { available: false, confidence: "high" };
  if (args.hasDns) return { available: false, confidence: "medium" };
  return { available: true, confidence: "medium" };
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const domain = (searchParams.get("domain") || "").trim().toLowerCase();
    if (!domain) return NextResponse.json({ error: "Falta domain" }, { status: 400 });

    const comDomain = buildComDomain(domain);
    if (!comDomain) return NextResponse.json({ error: "Dominio no válido" }, { status: 400 });

    const [hasDns, whois, cdmonCheck] = await Promise.all([
      hasAnyPublicDns(comDomain),
      fetchComWhoisRdap(comDomain),
      checkWithCdmon(comDomain),
    ]);

    const inferred = inferAvailability({ hasDns, whoisFound: whois.found });

    return NextResponse.json({
      sourceDomain: domain,
      comDomain,
      availability: {
        available: inferred.available,
        confidence: inferred.confidence,
        reason: inferred.available ? "Sin WHOIS y sin DNS detectada" : "WHOIS o DNS detectado",
      },
      whois,
      dns: { hasAnyRecord: hasDns },
      cdmon: cdmonCheck,
    });
  } catch (error: unknown) {
    const details = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        error: "No se pudo comprobar disponibilidad/WHOIS .com",
        details,
      },
      { status: 500 }
    );
  }
}
