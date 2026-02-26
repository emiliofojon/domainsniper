type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ProviderDnsRecord = {
  id: string;
  type: string;
  name: string;
  value: string;
  ttl: number | null;
  raw: Record<string, unknown>;
};

export type ProviderDomainSnapshot = {
  domain: string;
  info: Record<string, unknown>;
  dnsRecords: ProviderDnsRecord[];
};

type RequestOptions = {
  method?: HttpMethod;
  pathTemplate: string;
  params?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

function getEnv(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function getConfig() {
  const apiKey = getEnv("DOMAIN_PROVIDER_API_KEY");
  if (!apiKey) {
    throw new Error("Falta DOMAIN_PROVIDER_API_KEY en el servidor.");
  }

  const baseUrl = getEnv("DOMAIN_PROVIDER_BASE_URL");
  if (!baseUrl) {
    throw new Error("Falta DOMAIN_PROVIDER_BASE_URL en el servidor.");
  }

  const headerName = getEnv("DOMAIN_PROVIDER_API_KEY_HEADER", "X-API-Key");
  const headerValue = getEnv("DOMAIN_PROVIDER_API_KEY_VALUE", apiKey);

  return {
    baseUrl,
    headerName,
    headerValue,
    domainInfoPath: getEnv("DOMAIN_PROVIDER_DOMAIN_INFO_PATH", "/check"),
    dnsListPath: getEnv("DOMAIN_PROVIDER_DNS_LIST_PATH", "/getDnsRecords"),
    dnsCreatePath: getEnv("DOMAIN_PROVIDER_DNS_CREATE_PATH", "/dnsrecords/create"),
    dnsUpdatePath: getEnv("DOMAIN_PROVIDER_DNS_UPDATE_PATH", "/dnsrecords/edit"),
    dnsDeletePath: getEnv("DOMAIN_PROVIDER_DNS_DELETE_PATH", "/dnsrecords/delete"),
  };
}

function applyTemplate(pathTemplate: string, params: Record<string, string | number> = {}): string {
  return Object.entries(params).reduce((acc, [key, value]) => {
    return acc.replaceAll(`{${key}}`, encodeURIComponent(String(value)));
  }, pathTemplate);
}

function toUrl(baseUrl: string, path: string, query?: Record<string, string | number | boolean | undefined>): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}${normalizedPath}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function providerRequest<T = unknown>(options: RequestOptions): Promise<T> {
  const config = getConfig();
  const path = applyTemplate(options.pathTemplate, options.params);
  const url = toUrl(config.baseUrl, path, options.query);

  const headers: HeadersInit = {
    Accept: "application/json",
    [config.headerName]: config.headerValue,
  };

  const init: RequestInit = {
    method: options.method || "GET",
    headers,
    cache: "no-store",
  };

  if (options.body !== undefined) {
    (headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const cause =
      error && typeof error === "object" && "cause" in error
        ? String((error as { cause?: unknown }).cause)
        : "";
    throw new Error(`No se pudo conectar con proveedor (${url}): ${message}${cause ? ` | cause: ${cause}` : ""}`);
  }
  const text = await response.text();
  const payload = text ? tryJson(text) : null;

  if (!response.ok) {
    const detail = payload && typeof payload === "object" ? JSON.stringify(payload) : text;
    throw new Error(`Proveedor dominios ${response.status}: ${detail || response.statusText}`);
  }

  return payload as T;
}

function tryJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function unwrapData(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const obj = payload as Record<string, unknown>;
  if (obj.data !== undefined) return obj.data;
  if (obj.result !== undefined) return obj.result;
  return obj;
}

function normalizeDnsRecord(raw: unknown, index: number): ProviderDnsRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const idSource = r.id ?? r.record_id ?? r.uuid ?? index;
  const type = String(r.type ?? r.record_type ?? "").trim().toUpperCase();
  const name = String(r.name ?? r.host ?? r.subdomain ?? "@").trim();
  const value = String(r.value ?? r.content ?? r.target ?? "").trim();
  const ttlRaw = r.ttl ?? r.time_to_live;
  const ttl = ttlRaw === null || ttlRaw === undefined ? null : Number(ttlRaw);

  if (!type || !value) return null;

  return {
    id: String(idSource),
    type,
    name: name || "@",
    value,
    ttl: Number.isFinite(ttl) ? ttl : null,
    raw: r,
  };
}

function parseDnsList(payload: unknown): ProviderDnsRecord[] {
  const data = unwrapData(payload);
  if (Array.isArray(data)) {
    return data.map((row, index) => normalizeDnsRecord(row, index)).filter(Boolean) as ProviderDnsRecord[];
  }
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const nested = obj.records ?? obj.dns ?? obj.items ?? obj.list;
    if (Array.isArray(nested)) {
      return nested.map((row, index) => normalizeDnsRecord(row, index)).filter(Boolean) as ProviderDnsRecord[];
    }
  }
  return [];
}

export async function fetchProviderDomain(domain: string): Promise<ProviderDomainSnapshot> {
  const config = getConfig();
  const safeDomain = domain.trim().toLowerCase();

  const [infoPayload, dnsPayload] = await Promise.all([
    providerRequest({
      method: "POST",
      pathTemplate: config.domainInfoPath,
      body: { domain: safeDomain },
    }),
    providerRequest({
      method: "POST",
      pathTemplate: config.dnsListPath,
      body: { domain: safeDomain },
    }),
  ]);

  return {
    domain: safeDomain,
    info: (unwrapData(infoPayload) as Record<string, unknown>) || {},
    dnsRecords: parseDnsList(dnsPayload),
  };
}

export async function createProviderDnsRecord(
  domain: string,
  input: { type: string; name: string; value: string; ttl?: number | null }
) {
  const config = getConfig();
  return providerRequest({
    method: "POST",
    pathTemplate: config.dnsCreatePath,
    body: {
      domain: domain.trim().toLowerCase(),
      type: input.type.trim().toUpperCase(),
      name: input.name.trim(),
      value: input.value.trim(),
      ttl: input.ttl ?? undefined,
    },
  });
}

export async function updateProviderDnsRecord(
  domain: string,
  recordId: string,
  input: { type?: string; name?: string; value?: string; ttl?: number | null }
) {
  const config = getConfig();
  return providerRequest({
    method: "POST",
    pathTemplate: config.dnsUpdatePath,
    body: {
      domain: domain.trim().toLowerCase(),
      id: recordId.trim(),
      ...(input.type ? { type: input.type.trim().toUpperCase() } : {}),
      ...(input.name ? { name: input.name.trim() } : {}),
      ...(input.value ? { value: input.value.trim() } : {}),
      ...(input.ttl !== undefined ? { ttl: input.ttl } : {}),
    },
  });
}

export async function deleteProviderDnsRecord(domain: string, recordId: string) {
  const config = getConfig();
  return providerRequest({
    method: "POST",
    pathTemplate: config.dnsDeletePath,
    body: { domain: domain.trim().toLowerCase(), id: recordId.trim() },
  });
}
