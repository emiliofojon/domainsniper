import type { MarketplaceDomain } from "@/lib/types";

const DEFAULT_URL = "https://comercial01.soinda.es/api/external/domains";
const DOMAIN_REGEX = /\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/i;
const GLOBAL_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_RETRIES = 8;

let globalCache: { data: MarketplaceDomain[]; fields: string[]; fetchedAt: number } | null = null;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

function findDomainInText(value: string): string | null {
  const match = value.toLowerCase().match(DOMAIN_REGEX);
  return match?.[0] ?? null;
}

function scoreArray(items: unknown[]): number {
  let score = 0;
  for (const item of items) {
    if (typeof item === "string" && findDomainInText(item)) {
      score += 2;
      continue;
    }

    const row = asRecord(item);
    if (!Object.keys(row).length) continue;

    const keys = Object.keys(row).map((key) => key.toLowerCase());
    if (keys.some((key) => key.includes("domain") || key.includes("dominio") || key.includes("host"))) {
      score += 3;
    }

    for (const value of Object.values(row)) {
      if (typeof value === "string" && findDomainInText(value)) {
        score += 1;
        break;
      }
    }
  }
  return score;
}

function collectArrays(payload: unknown, depth = 0): unknown[][] {
  if (depth > 5 || payload === null || payload === undefined) return [];
  if (Array.isArray(payload)) return [payload];
  if (typeof payload !== "object") return [];

  const arrays: unknown[][] = [];
  for (const value of Object.values(payload as Record<string, unknown>)) {
    arrays.push(...collectArrays(value, depth + 1));
  }
  return arrays;
}

function extractRows(payload: unknown): unknown[] {
  const arrays = collectArrays(payload);
  if (!arrays.length) return [];

  const ranked = arrays
    .map((items) => ({ items, score: scoreArray(items) }))
    .sort((a, b) => b.score - a.score || b.items.length - a.items.length);

  if (ranked[0].score > 0) return ranked[0].items;
  return ranked[0].items;
}

function extractDomainField(item: Record<string, unknown>): string | null {
  const candidates = [
    "domain",
    "dominio",
    "domain_name",
    "nombre_dominio",
    "name",
    "hostname",
    "host",
    "fqdn",
    "url",
    "website",
    "com_domain",
  ];

  for (const key of candidates) {
    const value = item[key];
    if (typeof value === "string") {
      const found = findDomainInText(value) ?? value.trim().toLowerCase();
      if (found.includes(".")) return found;
    }
  }

  for (const value of Object.values(item)) {
    if (typeof value !== "string") continue;
    const found = findDomainInText(value);
    if (found) return found;
  }
  return null;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = Number(value.replace(",", "."));
    if (Number.isFinite(normalized)) return normalized;
  }
  return null;
}

function coerceBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "si", "sí", "available", "libre"].includes(normalized)) return true;
    if (["false", "0", "no", "occupied", "ocupado", "taken"].includes(normalized)) return false;
  }
  return null;
}

function normalizeDomain(row: unknown): MarketplaceDomain | null {
  if (typeof row === "string") {
    const domain = findDomainInText(row) ?? row.trim().toLowerCase();
    if (!domain.includes(".")) return null;
    const parts = domain.split(".");
    return {
      domain,
      tld: parts[parts.length - 1] ?? "",
      available: null,
      price: null,
      currency: null,
      status: null,
      raw: { value: row },
    };
  }

  const item = asRecord(row);
  const rawDomain = extractDomainField(item);
  if (!rawDomain) return null;

  const domain = rawDomain.trim().toLowerCase();
  const parts = domain.split(".");
  const tld = parts[parts.length - 1] ?? "";

  const available = coerceBoolean(
    item.available ??
      item.is_available ??
      item.isAvailable ??
      item.com_available ??
      item.disponible ??
      item.libre ??
      item.disponibilidad
  );

  const price = coerceNumber(
    item.price ??
      item.com_price ??
      item.amount ??
      item.precio ??
      item.registration_price ??
      item.registrationPrice ??
      item.sale_price ??
      item.salePrice
  );
  const currencyRaw = item.currency ?? item.currencyCode ?? item.currency_code ?? item.moneda;
  const currency = typeof currencyRaw === "string" ? currencyRaw : null;

  const statusRaw =
    item.status ?? item.state ?? item.pricingMode ?? item.estado ?? item.availability_status;
  const status = typeof statusRaw === "string" ? statusRaw : null;

  return {
    domain,
    tld,
    available,
    price,
    currency,
    status,
    raw: item,
  };
}

function parseTotal(payload: unknown): number | null {
  const data = asRecord(payload);

  const total =
    data.total ??
    data.total_count ??
    data.totalCount ??
    data.count ??
    asRecord(data.pagination).total ??
    asRecord(data.meta).total;

  return coerceNumber(total);
}

export async function fetchExternalDomainsPage(page: number, perPage: number): Promise<{
  data: MarketplaceDomain[];
  fields: string[];
  total: number | null;
  hasMore: boolean;
  sourceCount: number;
}> {
  const payload = await fetchExternalDomainsRaw(page, perPage);
  const rows = extractRows(payload);
  const data = rows.map(normalizeDomain).filter((item): item is MarketplaceDomain => Boolean(item));
  const fields = Array.from(
    new Set(
      data.flatMap((item) => Object.keys(item.raw || {}))
    )
  ).sort((a, b) => a.localeCompare(b));
  const total = parseTotal(payload);

  return {
    data,
    fields,
    total,
    hasMore: rows.length >= perPage,
    sourceCount: rows.length,
  };
}

export async function fetchExternalDomainsRaw(page: number, perPage: number): Promise<unknown> {
  const apiUrl = process.env.EXTERNAL_DOMAINS_API_URL || DEFAULT_URL;
  const apiKey = process.env.EXTERNAL_DOMAINS_API_KEY;

  if (!apiKey) {
    throw new Error("Falta EXTERNAL_DOMAINS_API_KEY en variables de entorno");
  }

  const params = new URLSearchParams({
    page: String(page),
    per_page: String(perPage),
  });

  let lastStatus = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const response = await fetch(`${apiUrl}?${params.toString()}`, {
      method: "GET",
      headers: {
        "X-API-Key": apiKey,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (response.ok) {
      return (await response.json()) as unknown;
    }

    lastStatus = response.status;

    if (response.status === 429) {
      const retryAfterRaw = response.headers.get("retry-after");
      const retryAfterSec = retryAfterRaw ? Number(retryAfterRaw) : NaN;
      const waitMs = Number.isFinite(retryAfterSec)
        ? Math.min(120000, Math.max(1000, retryAfterSec * 1000))
        : Math.min(120000, 2000 * Math.pow(2, attempt));

      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    if (response.status >= 500) {
      const waitMs = Math.min(30000, 1000 * Math.pow(2, attempt));
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    throw new Error(`Soinda API error (${response.status})`);
  }

  if (lastStatus === 429) {
    throw new Error("Soinda rate limit (429). Reintenta en unos minutos.");
  }

  throw new Error(`Soinda API no disponible (${lastStatus || "sin status"})`);
}

export async function fetchAllExternalDomains(forceRefresh = false): Promise<{
  data: MarketplaceDomain[];
  fields: string[];
}> {
  const now = Date.now();
  if (!forceRefresh && globalCache && now - globalCache.fetchedAt < GLOBAL_CACHE_TTL_MS) {
    return { data: globalCache.data, fields: globalCache.fields };
  }

  const perPage = 100;
  const first = await fetchExternalDomainsPage(1, perPage);
  const all: MarketplaceDomain[] = [...first.data];
  const fieldsSet = new Set<string>(first.fields);
  const total = first.total;

  if (typeof total === "number" && total > 0) {
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    for (let page = 2; page <= totalPages; page += 1) {
      const current = await fetchExternalDomainsPage(page, perPage);
      all.push(...current.data);
      for (const field of current.fields) fieldsSet.add(field);
    }
  } else {
    let page = 2;
    let keepLoading = first.hasMore;

    while (keepLoading) {
      const current = await fetchExternalDomainsPage(page, perPage);
      all.push(...current.data);
      for (const field of current.fields) fieldsSet.add(field);
      keepLoading = current.hasMore;
      page += 1;
    }
  }

  const deduped = Array.from(
    all.reduce((acc, item) => {
      if (!acc.has(item.domain)) acc.set(item.domain, item);
      return acc;
    }, new Map<string, MarketplaceDomain>()).values()
  );

  const fields = Array.from(fieldsSet).sort((a, b) => a.localeCompare(b));
  globalCache = { data: deduped, fields, fetchedAt: now };

  return { data: deduped, fields };
}
