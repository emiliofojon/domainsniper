import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { MarketplaceDomain } from "@/lib/types";
import { fetchExternalDomainsPage } from "@/lib/server/external-domains";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const PAGE_SIZE_SYNC = 100;
const ANALYTICS_CACHE_TTL_MS = 5 * 60 * 1000;
const SYNC_MAX_PAGES_PER_RUN = 80;

type DbDomainRow = {
  domain: string;
  tld: string;
  available: number | null;
  price: number | null;
  currency: string | null;
  status: string | null;
  raw_json: string;
  updated_at: string;
};

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

const dbPath = (() => {
  const folder = path.resolve(process.cwd(), "data");
  fs.mkdirSync(folder, { recursive: true });
  return path.join(folder, "soinda-cache.db");
})();

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;

  const instance = new Database(dbPath);
  instance.pragma("busy_timeout = 5000");
  instance.exec(`
    CREATE TABLE IF NOT EXISTS soinda_domains (
      domain TEXT PRIMARY KEY,
      tld TEXT NOT NULL,
      available INTEGER NULL,
      price REAL NULL,
      currency TEXT NULL,
      status TEXT NULL,
      raw_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS soinda_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  db = instance;
  return instance;
}

function upsertMany(items: MarketplaceDomain[], nowIso: string) {
  const instance = getDb();
  const upsertStmt = instance.prepare(`
    INSERT INTO soinda_domains (domain, tld, available, price, currency, status, raw_json, updated_at)
    VALUES (@domain, @tld, @available, @price, @currency, @status, @raw_json, @updated_at)
    ON CONFLICT(domain) DO UPDATE SET
      tld=excluded.tld,
      available=excluded.available,
      price=excluded.price,
      currency=excluded.currency,
      status=excluded.status,
      raw_json=excluded.raw_json,
      updated_at=excluded.updated_at
  `);

  const tx = instance.transaction((batch: MarketplaceDomain[]) => {
    for (const item of batch) {
      upsertStmt.run({
        domain: item.domain,
        tld: item.tld,
        available: item.available === null ? null : item.available ? 1 : 0,
        price: item.price,
        currency: item.currency,
        status: item.status,
        raw_json: JSON.stringify(item.raw || {}),
        updated_at: nowIso,
      });
    }
  });

  tx(items);
}

function setMeta(key: string, value: string | null) {
  getDb()
    .prepare(`INSERT INTO soinda_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
    .run(key, value);
}

function getMeta(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM soinda_meta WHERE key = ?").get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? null;
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
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
      // fall through
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

function collectAllFields(): string[] {
  const rows = getDb().prepare("SELECT raw_json FROM soinda_domains").all() as Array<{ raw_json: string }>;
  const fields = new Set<string>();

  for (const row of rows) {
    const raw = parseJsonObject(row.raw_json);
    for (const key of Object.keys(raw)) fields.add(key);
  }

  return Array.from(fields).sort((a, b) => a.localeCompare(b));
}

function buildFilterWhere(options: {
  q?: string;
  tld?: string;
  available?: boolean | null;
  columnFilters?: Record<string, string>;
}): { where: string; params: Array<string | number> } {
  const whereParts: string[] = [];
  const params: Array<string | number> = [];

  const q = options.q?.trim().toLowerCase() || "";
  const tld = options.tld?.trim().toLowerCase() || "";

  if (q) {
    whereParts.push("LOWER(domain) LIKE ?");
    params.push(`%${q}%`);
  }

  if (tld) {
    whereParts.push("LOWER(tld) = ?");
    params.push(tld);
  }

  if (options.available === true) whereParts.push("available = 1");
  if (options.available === false) whereParts.push("available = 0");

  for (const [field, value] of Object.entries(options.columnFilters || {})) {
    const needle = value.trim().toLowerCase();
    if (!needle) continue;

    if (field === "domain") {
      whereParts.push("LOWER(domain) LIKE ?");
      params.push(`%${needle}%`);
      continue;
    }

    whereParts.push("LOWER(COALESCE(json_extract(raw_json, ?), '')) LIKE ?");
    params.push(`$."${field}"`, `%${needle}%`);
  }

  return { where: whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "", params };
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
  if (!maxTs) return null;
  return new Date(maxTs).toISOString();
}

function getLocalMaxCreatedAtIso(): string | null {
  const row = getDb()
    .prepare(
      `SELECT MAX(
        COALESCE(
          json_extract(raw_json, '$.created_at'),
          json_extract(raw_json, '$.createdAt'),
          json_extract(raw_json, '$.first_seen_at'),
          json_extract(raw_json, '$.firstSeenAt'),
          json_extract(raw_json, '$.updated_at'),
          json_extract(raw_json, '$.updatedAt')
        )
      ) as max_created_at
      FROM soinda_domains`
    )
    .get() as { max_created_at: string | null };

  if (!row.max_created_at || typeof row.max_created_at !== "string") return null;
  const ts = Date.parse(row.max_created_at);
  if (Number.isNaN(ts)) return null;
  return new Date(ts).toISOString();
}

let runningSync: Promise<void> | null = null;
let analyticsVersion = 0;
const analyticsCache = new Map<string, { ts: number; version: number; value: SoindaAnalytics }>();

function isRateLimitError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("429") || normalized.includes("too many attempts") || normalized.includes("throttle");
}

function getNextSyncNotBeforeTs(): number | null {
  const raw = getMeta("next_sync_not_before");
  if (!raw) return null;
  const ts = Date.parse(raw);
  return Number.isNaN(ts) ? null : ts;
}

function canSyncNow(): boolean {
  const nextTs = getNextSyncNotBeforeTs();
  if (!nextTs) return true;
  return Date.now() >= nextTs;
}

function isSyncDue(): boolean {
  const lastSyncAt = getMeta("last_sync_at");
  if (!lastSyncAt) return true;
  const last = Date.parse(lastSyncAt);
  if (Number.isNaN(last)) return true;
  return Date.now() - last >= TWO_HOURS_MS;
}

function getSyncMode(): "full" | "incremental" {
  const raw = (getMeta("sync_mode") || "").trim().toLowerCase();
  if (raw === "incremental") return "incremental";
  return "full";
}

export function getSoindaSyncStatus(): SyncStatus {
  const totalRow = getDb().prepare("SELECT COUNT(*) as count FROM soinda_domains").get() as { count: number };
  const cursorPage = Math.max(1, Number(getMeta("sync_cursor_page") || "1"));
  const totalPagesRaw = Number(getMeta("sync_total_pages") || "0");
  const totalPages = Number.isFinite(totalPagesRaw) && totalPagesRaw > 0 ? totalPagesRaw : null;
  const lastPageRaw = Number(getMeta("sync_last_page") || "0");
  const lastPage = Number.isFinite(lastPageRaw) && lastPageRaw > 0 ? lastPageRaw : null;

  return {
    isSyncing: runningSync !== null,
    lastSyncAt: getMeta("last_sync_at"),
    lastError: getMeta("last_sync_error"),
    totalDomains: totalRow.count,
    nextSyncNotBefore: getMeta("next_sync_not_before"),
    cursorPage,
    totalPages,
    lastPage,
    sourceCreatedAtMax: getMeta("source_created_at_max"),
    syncMode: getSyncMode(),
  };
}

export function querySoindaDomains(options: {
  page: number;
  perPage: number;
  q?: string;
  tld?: string;
  available?: boolean | null;
  columnFilters?: Record<string, string>;
  sortBy?: string;
  sortDir?: "asc" | "desc";
}): {
  data: MarketplaceDomain[];
  fields: string[];
  total: number;
  hasMore: boolean;
} {
  const { where, params } = buildFilterWhere(options);
  const offset = (options.page - 1) * options.perPage;
  const direction = options.sortDir === "desc" ? "DESC" : "ASC";

  const baseSortable = new Set(["domain", "tld", "available", "price", "currency", "status"]);
  const requestedSort = (options.sortBy || "domain").trim();

  let orderBy = "domain ASC";
  if (baseSortable.has(requestedSort)) {
    if (requestedSort === "available" || requestedSort === "price") {
      orderBy = `${requestedSort} ${direction}`;
    } else {
      orderBy = `LOWER(COALESCE(${requestedSort}, '')) ${direction}`;
    }
  } else if (/^[a-zA-Z0-9_]+$/.test(requestedSort)) {
    const safeField = requestedSort.replace(/"/g, "");
    orderBy = `LOWER(COALESCE(json_extract(raw_json, '$."${safeField}"'), '')) ${direction}`;
  }

  const countSql = `SELECT COUNT(*) as count FROM soinda_domains ${where}`;
  const rowsSql = `
    SELECT domain, tld, available, price, currency, status, raw_json, updated_at
    FROM soinda_domains
    ${where}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;

  const total = (getDb().prepare(countSql).get(...params) as { count: number }).count;
  const rows = getDb().prepare(rowsSql).all(...params, options.perPage, offset) as DbDomainRow[];

  const data = rows.map((row) => ({
    domain: row.domain,
    tld: row.tld,
    available: row.available === null ? null : row.available === 1,
    price: row.price,
    currency: row.currency,
    status: row.status,
    raw: parseJsonObject(row.raw_json),
  }));

  return {
    data,
    fields: collectAllFields(),
    total,
    hasMore: offset + options.perPage < total,
  };
}

export function querySoindaAnalytics(options: {
  q?: string;
  tld?: string;
  available?: boolean | null;
  columnFilters?: Record<string, string>;
}): SoindaAnalytics {
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

  const { where, params } = buildFilterWhere(options);
  const instance = getDb();

  const total = (instance.prepare(`SELECT COUNT(*) as count FROM soinda_domains ${where}`).get(...params) as {
    count: number;
  }).count;

  const available = (
    instance
      .prepare(`SELECT COUNT(*) as count FROM soinda_domains ${where ? `${where} AND` : "WHERE"} available = 1`)
      .get(...params) as { count: number }
  ).count;

  const avgPrice = (
    instance
      .prepare(`SELECT AVG(price) as avg_price FROM soinda_domains ${where ? `${where} AND` : "WHERE"} price IS NOT NULL`)
      .get(...params) as { avg_price: number | null }
  ).avg_price;

  const uniqueTlds = (
    instance.prepare(`SELECT COUNT(DISTINCT tld) as count FROM soinda_domains ${where}`).get(...params) as {
      count: number;
    }
  ).count;

  const topTlds = (
    instance
      .prepare(
        `SELECT tld as label, COUNT(*) as value FROM soinda_domains ${where} GROUP BY tld ORDER BY value DESC LIMIT 8`
      )
      .all(...params) as Array<{ label: string; value: number }>
  );

  const rows = instance
    .prepare(`SELECT tld, raw_json FROM soinda_domains ${where}`)
    .all(...params) as Array<{ tld: string; raw_json: string }>;

  const techMap = new Map<string, number>();
  const levelMap = new Map<string, number>();

  for (const row of rows) {
    const raw = parseJsonObject(row.raw_json);
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
        const raw = parseJsonObject(row.raw_json);
        const levelRaw = raw.tech_level ?? raw.techLevel ?? raw.nivel_tecnico;
        const level =
          typeof levelRaw === "string" && levelRaw.trim() ? levelRaw.trim().toLowerCase() : "unknown";
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

  if (!bypassSchedule && !force && (!isSyncDue() || !canSyncNow())) return;
  if (force) {
    setMeta("next_sync_not_before", null);
    setMeta("sync_mode", "full");
    setMeta("sync_cursor_page", "1");
    setMeta("sync_total_pages", null);
  }

  runningSync = (async () => {
    setMeta("last_sync_error", null);
    setMeta("sync_started_at", new Date().toISOString());

    const totalRow = getDb().prepare("SELECT COUNT(*) as count FROM soinda_domains").get() as { count: number };
    const mode = force ? "full" : totalRow.count === 0 ? "full" : getSyncMode();
    setMeta("sync_mode", mode);

    let page = Math.max(1, Number(getMeta("sync_cursor_page") || "1"));
    let totalPages = Number(getMeta("sync_total_pages") || "0");
    if (!Number.isFinite(totalPages) || totalPages <= 0) totalPages = 0;
    let pagesProcessed = 0;
    let completed = false;
    let maxSeenTs = 0;

    let cursorCreatedAtTs = Number.NaN;
    if (mode === "incremental") {
      let cursorRaw = getMeta("source_created_at_max");
      if (!cursorRaw) {
        cursorRaw = getLocalMaxCreatedAtIso();
        if (cursorRaw) setMeta("source_created_at_max", cursorRaw);
      }
      cursorCreatedAtTs = cursorRaw ? Date.parse(cursorRaw) : Number.NaN;
    }

    while (true) {
      const current = await fetchExternalDomainsPage(page, PAGE_SIZE_SYNC);
      const nowIso = new Date().toISOString();
      upsertMany(current.data, nowIso);
      pagesProcessed += 1;

      if (totalPages === 0 && typeof current.total === "number") {
        totalPages = Math.max(1, Math.ceil(current.total / PAGE_SIZE_SYNC));
        setMeta("sync_total_pages", String(totalPages));
      }

      setMeta("sync_last_page", String(page));
      setMeta("sync_last_source_count", String(current.sourceCount));
      setMeta("sync_last_normalized_count", String(current.data.length));

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
        setMeta("sync_cursor_page", String(page + 1));
        break;
      }

      page += 1;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (maxSeenTs > 0) {
      setMeta("source_created_at_max", new Date(maxSeenTs).toISOString());
    }

    if (completed) {
      setMeta("last_sync_at", new Date().toISOString());
      setMeta("sync_finished_at", new Date().toISOString());
      setMeta("next_sync_not_before", null);
      setMeta("sync_cursor_page", "1");
      setMeta("sync_total_pages", null);
      if (mode === "full") setMeta("sync_mode", "incremental");
    }

    analyticsVersion += 1;
    analyticsCache.clear();
  })()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (isRateLimitError(message)) {
        const blockedUntil = new Date(Date.now() + TWO_HOURS_MS).toISOString();
        setMeta("next_sync_not_before", blockedUntil);
        setMeta("last_sync_error", `Rate limited by Soinda (429). Next retry after ${blockedUntil}`);
      } else {
        setMeta("last_sync_error", message);
      }
      throw error;
    })
    .finally(() => {
      runningSync = null;
    });

  return runningSync;
}

export async function ensureSoindaDataLoaded(): Promise<void> {
  const totalRow = getDb().prepare("SELECT COUNT(*) as count FROM soinda_domains").get() as { count: number };

  if (totalRow.count === 0) {
    await syncSoindaDomains(true);
    return;
  }

  void syncSoindaDomains(false);
}

export function resetSoindaCatalog(): void {
  const instance = getDb();
  instance.prepare("DELETE FROM soinda_domains").run();
  instance.prepare("DELETE FROM soinda_meta").run();
  analyticsVersion += 1;
  analyticsCache.clear();
}
