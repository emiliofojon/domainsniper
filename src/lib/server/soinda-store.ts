import { Pool } from "pg";
import type { MarketplaceDomain } from "@/lib/types";
import { fetchExternalDomainsPage } from "@/lib/server/external-domains";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const PAGE_SIZE_SYNC = 100;
const ANALYTICS_CACHE_TTL_MS = 5 * 60 * 1000;
const SYNC_MAX_PAGES_PER_RUN = 80;

type SyncStatus = {
  isSyncing: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  totalDomains: number;
  nextSyncNotBefore: string | null;
  cursorPage: number;
  totalPages: number | null;
  lastPage: number | null;
  sourceCreatedAtMax: string | null;
  syncMode: "full" | "incremental";
};

export type SoindaAnalytics = {
  total: number;
  available: number;
  avgPrice: number | null;
  uniqueTlds: number;
  topTlds: Array<{ label: string; value: number }>;
  topTech: Array<{ label: string; value: number }>;
  topLevels: Array<{ label: string; value: number }>;
  heatRows: string[];
  heatCols: string[];
  heatMatrix: number[][];
  heatMax: number;
};

type PgDomainRow = {
  domain: string;
  tld: string;
  available: boolean | null;
  price: number | null;
  currency: string | null;
  status: string | null;
  raw_json: unknown;
};

let pool: Pool | null = null;
let initPromise: Promise<void> | null = null;
let runningSync: Promise<void> | null = null;
let analyticsVersion = 0;
const analyticsCache = new Map<string, { ts: number; version: number; value: SoindaAnalytics }>();

function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Falta DATABASE_URL para usar PostgreSQL");
  }

  const shouldUseSsl = !connectionString.includes("localhost") && !connectionString.includes("127.0.0.1");

  pool = new Pool({
    connectionString,
    ssl: shouldUseSsl ? { rejectUnauthorized: false } : undefined,
    max: 10,
  });

  return pool;
}

async function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const db = getPool();
      await db.query(`
        CREATE TABLE IF NOT EXISTS soinda_domains (
          domain TEXT PRIMARY KEY,
          tld TEXT NOT NULL,
          available BOOLEAN NULL,
          price DOUBLE PRECISION NULL,
          currency TEXT NULL,
          status TEXT NULL,
          raw_json JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE IF NOT EXISTS soinda_meta (
          key TEXT PRIMARY KEY,
          value TEXT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_soinda_domains_tld ON soinda_domains (tld);
        CREATE INDEX IF NOT EXISTS idx_soinda_domains_available ON soinda_domains (available);
        CREATE INDEX IF NOT EXISTS idx_soinda_domains_updated_at ON soinda_domains (updated_at DESC);
      `);
    })();
  }

  await initPromise;
}

function asRawObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }

  return {};
}

async function setMeta(key: string, value: string | null): Promise<void> {
  await ensureInitialized();
  await getPool().query(
    `INSERT INTO soinda_meta (key, value)
     VALUES ($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

async function getMeta(key: string): Promise<string | null> {
  await ensureInitialized();
  const { rows } = await getPool().query<{ value: string | null }>("SELECT value FROM soinda_meta WHERE key = $1", [key]);
  return rows[0]?.value ?? null;
}

async function getTotalDomains(): Promise<number> {
  await ensureInitialized();
  const { rows } = await getPool().query<{ count: string }>("SELECT COUNT(*)::text as count FROM soinda_domains");
  return Number(rows[0]?.count || "0");
}

async function upsertMany(items: MarketplaceDomain[], nowIso: string): Promise<void> {
  if (!items.length) return;
  await ensureInitialized();

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    for (const item of items) {
      await client.query(
        `INSERT INTO soinda_domains (domain, tld, available, price, currency, status, raw_json, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)
         ON CONFLICT(domain) DO UPDATE SET
           tld = EXCLUDED.tld,
           available = EXCLUDED.available,
           price = EXCLUDED.price,
           currency = EXCLUDED.currency,
           status = EXCLUDED.status,
           raw_json = EXCLUDED.raw_json,
           updated_at = EXCLUDED.updated_at`,
        [
          item.domain,
          item.tld,
          item.available,
          item.price,
          item.currency,
          item.status,
          JSON.stringify(item.raw || {}),
          nowIso,
        ]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function collectAllFields(): Promise<string[]> {
  await ensureInitialized();
  const { rows } = await getPool().query<{ field: string }>(`
    SELECT DISTINCT key as field
    FROM soinda_domains, LATERAL jsonb_object_keys(raw_json) as key
    ORDER BY key ASC
  `);
  return rows.map((row) => row.field);
}

function getCreatedAtFromDomain(domain: MarketplaceDomain): number | null {
  const raw = domain.raw || {};
  const candidates = [
    raw.created_at,
    raw.createdAt,
    raw.first_seen_at,
    raw.firstSeenAt,
    raw.updated_at,
    raw.updatedAt,
  ];

  for (const value of candidates) {
    if (typeof value !== "string" || !value.trim()) continue;
    const ts = Date.parse(value);
    if (!Number.isNaN(ts)) return ts;
  }

  return null;
}

function getMaxCreatedAtIso(items: MarketplaceDomain[]): string | null {
  let maxTs = 0;
  for (const item of items) {
    const ts = getCreatedAtFromDomain(item);
    if (ts && ts > maxTs) maxTs = ts;
  }
  return maxTs ? new Date(maxTs).toISOString() : null;
}

async function getLocalMaxCreatedAtIso(): Promise<string | null> {
  await ensureInitialized();
  const { rows } = await getPool().query<{ max_created_at: string | null }>(`
    SELECT MAX(
      COALESCE(
        raw_json->>'created_at',
        raw_json->>'createdAt',
        raw_json->>'first_seen_at',
        raw_json->>'firstSeenAt',
        raw_json->>'updated_at',
        raw_json->>'updatedAt'
      )
    ) as max_created_at
    FROM soinda_domains
  `);

  const raw = rows[0]?.max_created_at;
  if (!raw) return null;
  const ts = Date.parse(raw);
  return Number.isNaN(ts) ? null : new Date(ts).toISOString();
}

function splitTechstack(value: unknown): string[] {
  const normalized = (input: string) =>
    input
      .split(/[,;|/\n]/g)
      .map((item) => item.trim())
      .filter(Boolean);

  if (Array.isArray(value)) {
    return value.flatMap((item) => splitTechstack(item)).filter((item, index, arr) => arr.indexOf(item) === index);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];

    const techMatches = Array.from(trimmed.matchAll(/"technology_name"\s*:\s*"([^"]+)"/g))
      .map((match) => match[1]?.trim())
      .filter(Boolean) as string[];
    if (techMatches.length) return techMatches.filter((item, index, arr) => arr.indexOf(item) === index);

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed) || typeof parsed === "object") return splitTechstack(parsed);
    } catch {
      // continue
    }

    return normalized(trimmed);
  }

  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .flatMap((item) => splitTechstack(item))
      .filter((item, index, arr) => arr.indexOf(item) === index);
  }

  return [];
}

function isRateLimitError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("429") || normalized.includes("too many attempts") || normalized.includes("throttle");
}

async function getNextSyncNotBeforeTs(): Promise<number | null> {
  const raw = await getMeta("next_sync_not_before");
  if (!raw) return null;
  const ts = Date.parse(raw);
  return Number.isNaN(ts) ? null : ts;
}

async function canSyncNow(): Promise<boolean> {
  const nextTs = await getNextSyncNotBeforeTs();
  if (!nextTs) return true;
  return Date.now() >= nextTs;
}

async function isSyncDue(): Promise<boolean> {
  const lastSyncAt = await getMeta("last_sync_at");
  if (!lastSyncAt) return true;
  const last = Date.parse(lastSyncAt);
  if (Number.isNaN(last)) return true;
  return Date.now() - last >= TWO_HOURS_MS;
}

async function getSyncMode(): Promise<"full" | "incremental"> {
  const raw = (await getMeta("sync_mode"))?.trim().toLowerCase() || "";
  return raw === "incremental" ? "incremental" : "full";
}

export async function getSoindaSyncStatus(): Promise<SyncStatus> {
  const totalDomains = await getTotalDomains();
  const cursorPage = Math.max(1, Number((await getMeta("sync_cursor_page")) || "1"));
  const totalPagesRaw = Number((await getMeta("sync_total_pages")) || "0");
  const totalPages = Number.isFinite(totalPagesRaw) && totalPagesRaw > 0 ? totalPagesRaw : null;
  const lastPageRaw = Number((await getMeta("sync_last_page")) || "0");
  const lastPage = Number.isFinite(lastPageRaw) && lastPageRaw > 0 ? lastPageRaw : null;

  return {
    isSyncing: runningSync !== null,
    lastSyncAt: await getMeta("last_sync_at"),
    lastError: await getMeta("last_sync_error"),
    totalDomains,
    nextSyncNotBefore: await getMeta("next_sync_not_before"),
    cursorPage,
    totalPages,
    lastPage,
    sourceCreatedAtMax: await getMeta("source_created_at_max"),
    syncMode: await getSyncMode(),
  };
}

function buildWhere(options: {
  q?: string;
  tld?: string;
  available?: boolean | null;
  columnFilters?: Record<string, string>;
}): { whereSql: string; params: Array<string | number | boolean> } {
  const parts: string[] = [];
  const params: Array<string | number | boolean> = [];

  const pushParam = (value: string | number | boolean) => {
    params.push(value);
    return `$${params.length}`;
  };

  const q = options.q?.trim().toLowerCase() || "";
  const tld = options.tld?.trim().toLowerCase() || "";

  if (q) {
    const p = pushParam(`%${q}%`);
    parts.push(`LOWER(domain) LIKE ${p}`);
  }

  if (tld) {
    const p = pushParam(tld);
    parts.push(`LOWER(tld) = ${p}`);
  }

  if (options.available === true || options.available === false) {
    const p = pushParam(options.available);
    parts.push(`available = ${p}`);
  }

  for (const [field, value] of Object.entries(options.columnFilters || {})) {
    const needle = value.trim().toLowerCase();
    if (!needle) continue;

    if (field === "domain") {
      const p = pushParam(`%${needle}%`);
      parts.push(`LOWER(domain) LIKE ${p}`);
      continue;
    }

    const fieldParam = pushParam(field);
    const needleParam = pushParam(`%${needle}%`);
    parts.push(`LOWER(COALESCE(raw_json->>${fieldParam}, '')) LIKE ${needleParam}`);
  }

  return {
    whereSql: parts.length ? `WHERE ${parts.join(" AND ")}` : "",
    params,
  };
}

export async function querySoindaDomains(options: {
  page: number;
  perPage: number;
  q?: string;
  tld?: string;
  available?: boolean | null;
  columnFilters?: Record<string, string>;
  sortBy?: string;
  sortDir?: "asc" | "desc";
}): Promise<{
  data: MarketplaceDomain[];
  fields: string[];
  total: number;
  hasMore: boolean;
}> {
  await ensureInitialized();

  const { whereSql, params } = buildWhere(options);
  const offset = (options.page - 1) * options.perPage;
  const direction = options.sortDir === "desc" ? "DESC" : "ASC";

  const baseSortable = new Set(["domain", "tld", "available", "price", "currency", "status"]);
  const requestedSort = (options.sortBy || "domain").trim();

  let orderBy = `domain ${direction}`;
  if (baseSortable.has(requestedSort)) {
    if (requestedSort === "available" || requestedSort === "price") {
      orderBy = `${requestedSort} ${direction}`;
    } else {
      orderBy = `LOWER(COALESCE(${requestedSort}, '')) ${direction}`;
    }
  } else if (/^[a-zA-Z0-9_]+$/.test(requestedSort)) {
    orderBy = `LOWER(COALESCE(raw_json->>'${requestedSort}', '')) ${direction}`;
  }

  const countRes = await getPool().query<{ count: string }>(`SELECT COUNT(*)::text as count FROM soinda_domains ${whereSql}`, params);
  const total = Number(countRes.rows[0]?.count || "0");

  const rowsRes = await getPool().query<PgDomainRow>(
    `SELECT domain, tld, available, price, currency, status, raw_json
     FROM soinda_domains
     ${whereSql}
     ORDER BY ${orderBy}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, options.perPage, offset]
  );

  const data = rowsRes.rows.map((row) => ({
    domain: row.domain,
    tld: row.tld,
    available: row.available,
    price: row.price,
    currency: row.currency,
    status: row.status,
    raw: asRawObject(row.raw_json),
  }));

  const fields = await collectAllFields();

  return {
    data,
    fields,
    total,
    hasMore: offset + options.perPage < total,
  };
}

export async function querySoindaAnalytics(options: {
  q?: string;
  tld?: string;
  available?: boolean | null;
  columnFilters?: Record<string, string>;
}): Promise<SoindaAnalytics> {
  await ensureInitialized();

  const cacheKey = JSON.stringify({
    q: options.q || "",
    tld: options.tld || "",
    available: options.available ?? null,
    columnFilters: Object.fromEntries(
      Object.entries(options.columnFilters || {})
        .map(([key, value]) => [key, value.trim()])
        .filter(([, value]) => value.length > 0)
        .sort(([a], [b]) => a.localeCompare(b))
    ),
  });

  const cached = analyticsCache.get(cacheKey);
  if (cached && cached.version === analyticsVersion && Date.now() - cached.ts < ANALYTICS_CACHE_TTL_MS) {
    return cached.value;
  }

  const { whereSql, params } = buildWhere(options);

  const total = Number((await getPool().query<{ count: string }>(`SELECT COUNT(*)::text as count FROM soinda_domains ${whereSql}`, params)).rows[0]?.count || "0");

  const available = Number(
    (
      await getPool().query<{ count: string }>(
        `SELECT COUNT(*)::text as count FROM soinda_domains ${whereSql ? `${whereSql} AND` : "WHERE"} available = true`,
        params
      )
    ).rows[0]?.count || "0"
  );

  const avgPriceRaw = (
    await getPool().query<{ avg_price: number | null }>(
      `SELECT AVG(price) as avg_price FROM soinda_domains ${whereSql ? `${whereSql} AND` : "WHERE"} price IS NOT NULL`,
      params
    )
  ).rows[0]?.avg_price;
  const avgPrice = typeof avgPriceRaw === "number" ? avgPriceRaw : null;

  const uniqueTlds = Number(
    (
      await getPool().query<{ count: string }>(`SELECT COUNT(DISTINCT tld)::text as count FROM soinda_domains ${whereSql}`, params)
    ).rows[0]?.count || "0"
  );

  const topTlds = (
    await getPool().query<{ label: string; value: string }>(
      `SELECT tld as label, COUNT(*)::text as value FROM soinda_domains ${whereSql} GROUP BY tld ORDER BY COUNT(*) DESC LIMIT 8`,
      params
    )
  ).rows.map((row) => ({ label: row.label, value: Number(row.value) }));

  const rows = (
    await getPool().query<{ tld: string; raw_json: unknown }>(`SELECT tld, raw_json FROM soinda_domains ${whereSql}`, params)
  ).rows;

  const techMap = new Map<string, number>();
  const levelMap = new Map<string, number>();

  for (const row of rows) {
    const raw = asRawObject(row.raw_json);
    const levelRaw = raw.tech_level ?? raw.techLevel ?? raw.nivel_tecnico;
    const level = typeof levelRaw === "string" && levelRaw.trim() ? levelRaw.trim().toLowerCase() : "unknown";
    levelMap.set(level, (levelMap.get(level) || 0) + 1);

    const techs = splitTechstack(raw.tech_stack ?? raw.techstack ?? raw.stack);
    for (const tech of techs) techMap.set(tech, (techMap.get(tech) || 0) + 1);
  }

  const topTech = Array.from(techMap.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);

  const topLevels = Array.from(levelMap.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);

  const heatRows = topTlds.slice(0, 6).map((row) => row.label);
  const heatCols = topLevels.map((item) => item.label);
  const heatMatrix = heatRows.map((rowTld) =>
    heatCols.map((colLevel) => {
      let count = 0;
      for (const row of rows) {
        if (row.tld !== rowTld) continue;
        const raw = asRawObject(row.raw_json);
        const levelRaw = raw.tech_level ?? raw.techLevel ?? raw.nivel_tecnico;
        const level = typeof levelRaw === "string" && levelRaw.trim() ? levelRaw.trim().toLowerCase() : "unknown";
        if (level === colLevel) count += 1;
      }
      return count;
    })
  );

  const heatMax = heatMatrix.flat().reduce((max, value) => (value > max ? value : max), 0);

  const value = {
    total,
    available,
    avgPrice,
    uniqueTlds,
    topTlds,
    topTech,
    topLevels,
    heatRows,
    heatCols,
    heatMatrix,
    heatMax,
  };

  analyticsCache.set(cacheKey, { ts: Date.now(), version: analyticsVersion, value });
  return value;
}

export async function syncSoindaDomains(force = false, bypassSchedule = false): Promise<void> {
  if (runningSync) return runningSync;

  if (!bypassSchedule && !force && (!(await isSyncDue()) || !(await canSyncNow()))) return;
  if (force) {
    await setMeta("next_sync_not_before", null);
    await setMeta("sync_mode", "full");
    await setMeta("sync_cursor_page", "1");
    await setMeta("sync_total_pages", null);
  }

  runningSync = (async () => {
    await setMeta("last_sync_error", null);
    await setMeta("sync_started_at", new Date().toISOString());

    const totalDomains = await getTotalDomains();
    const mode = force ? "full" : totalDomains === 0 ? "full" : await getSyncMode();
    await setMeta("sync_mode", mode);

    let page = Math.max(1, Number((await getMeta("sync_cursor_page")) || "1"));
    let totalPages = Number((await getMeta("sync_total_pages")) || "0");
    if (!Number.isFinite(totalPages) || totalPages <= 0) totalPages = 0;
    let pagesProcessed = 0;
    let completed = false;
    let maxSeenTs = 0;

    let cursorCreatedAtTs = Number.NaN;
    if (mode === "incremental") {
      let cursorRaw = await getMeta("source_created_at_max");
      if (!cursorRaw) {
        cursorRaw = await getLocalMaxCreatedAtIso();
        if (cursorRaw) await setMeta("source_created_at_max", cursorRaw);
      }
      cursorCreatedAtTs = cursorRaw ? Date.parse(cursorRaw) : Number.NaN;
    }

    while (true) {
      const current = await fetchExternalDomainsPage(page, PAGE_SIZE_SYNC);
      const nowIso = new Date().toISOString();
      await upsertMany(current.data, nowIso);
      pagesProcessed += 1;

      if (totalPages === 0 && typeof current.total === "number") {
        totalPages = Math.max(1, Math.ceil(current.total / PAGE_SIZE_SYNC));
        await setMeta("sync_total_pages", String(totalPages));
      }

      await setMeta("sync_last_page", String(page));
      await setMeta("sync_last_source_count", String(current.sourceCount));
      await setMeta("sync_last_normalized_count", String(current.data.length));

      const pageMaxIso = getMaxCreatedAtIso(current.data);
      const pageMaxTs = pageMaxIso ? Date.parse(pageMaxIso) : Number.NaN;
      if (Number.isFinite(pageMaxTs) && pageMaxTs > maxSeenTs) maxSeenTs = pageMaxTs;

      const reachedEnd = totalPages > 0 ? page >= totalPages : !current.hasMore || current.sourceCount < PAGE_SIZE_SYNC;
      if (reachedEnd) {
        completed = true;
        break;
      }

      if (mode === "incremental") {
        const hasCursor = Number.isFinite(cursorCreatedAtTs) && cursorCreatedAtTs > 0;
        const hasNewerOnPage = !hasCursor || (Number.isFinite(pageMaxTs) && pageMaxTs > cursorCreatedAtTs);
        if (!hasNewerOnPage) {
          completed = true;
          break;
        }
      }

      if (pagesProcessed >= SYNC_MAX_PAGES_PER_RUN) {
        await setMeta("sync_cursor_page", String(page + 1));
        break;
      }

      page += 1;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (maxSeenTs > 0) {
      await setMeta("source_created_at_max", new Date(maxSeenTs).toISOString());
    }

    if (completed) {
      await setMeta("last_sync_at", new Date().toISOString());
      await setMeta("sync_finished_at", new Date().toISOString());
      await setMeta("next_sync_not_before", null);
      await setMeta("sync_cursor_page", "1");
      await setMeta("sync_total_pages", null);
      if (mode === "full") await setMeta("sync_mode", "incremental");
    }

    analyticsVersion += 1;
    analyticsCache.clear();
  })()
    .catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (isRateLimitError(message)) {
        const blockedUntil = new Date(Date.now() + TWO_HOURS_MS).toISOString();
        await setMeta("next_sync_not_before", blockedUntil);
        await setMeta("last_sync_error", `Rate limited by Soinda (429). Next retry after ${blockedUntil}`);
      } else {
        await setMeta("last_sync_error", message);
      }
      throw error;
    })
    .finally(() => {
      runningSync = null;
    });

  return runningSync;
}

export async function ensureSoindaDataLoaded(): Promise<void> {
  const total = await getTotalDomains();
  if (total === 0) {
    await syncSoindaDomains(true);
    return;
  }

  void syncSoindaDomains(false);
}

export async function resetSoindaCatalog(): Promise<void> {
  await ensureInitialized();
  await getPool().query("TRUNCATE TABLE soinda_domains, soinda_meta");
  analyticsVersion += 1;
  analyticsCache.clear();
}
