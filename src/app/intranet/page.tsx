"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { RoleGuard } from "@/components/role-guard";
import type { MarketplaceDomain, MarketplaceDomainResponse } from "@/lib/types";

const PAGE_SIZES = [25, 50, 100, 250, 500];

type DashboardAnalytics = {
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

type SyncInfo = {
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

type ComCheckInfo = {
  isChecking: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  totalEsDomains: number;
  checkedEsDomains: number;
  pendingEsDomains: number;
  lastProcessed: number;
  lastMarkedFree: number;
};

type ProviderDnsRecord = {
  id: string;
  type: string;
  name: string;
  value: string;
  ttl: number | null;
};

type ProviderDomainSnapshot = {
  domain: string;
  info: Record<string, unknown>;
  dnsRecords: ProviderDnsRecord[];
};

type PublicDnsSnapshot = {
  domain: string;
  hasDns: boolean;
  records: {
    A: string[];
    AAAA: string[];
    CNAME: string[];
    MX: string[];
    NS: string[];
    TXT: string[];
  };
};

type ComStatusSnapshot = {
  sourceDomain: string;
  comDomain: string;
  availability: {
    available: boolean;
    confidence: string;
    reason: string;
  };
  whois: {
    found: boolean;
    domain: string;
    registrar: string | null;
    createdAt: string | null;
    expiresAt: string | null;
    statuses: string[];
  };
  dns: {
    hasAnyRecord: boolean;
  };
  cdmon: {
    ok: boolean;
    raw: unknown;
  };
};

function getErrorDetails(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
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

function formatRawValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value || "-";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => formatRawValue(item)).join(", ");

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function renderRawValue(field: string, value: unknown, expanded = false): React.ReactNode {
  const compactField = field.toLowerCase().replace(/[_\s-]/g, "");
  if (field === "com_libre" && typeof value === "boolean") {
    return value ? "Sí" : "No";
  }

  if (compactField.includes("techstack")) {
    const items = splitTechstack(value);
    if (!items.length) return "-";
    const visible = expanded ? items : items.slice(0, 2);

    return (
      <div className={`flex max-w-xs gap-1 ${expanded ? "flex-wrap" : "overflow-hidden whitespace-nowrap"}`}>
        {visible.map((item) => (
          <span key={item} className="rounded bg-neutral-200 px-2 py-0.5 text-xs text-neutral-800">
            {item}
          </span>
        ))}
        {!expanded && items.length > visible.length ? (
          <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">+{items.length - visible.length}</span>
        ) : null}
      </div>
    );
  }

  const text = formatRawValue(value);
  if (expanded) return text;
  return <div className="max-w-xs truncate">{text}</div>;
}

function formatFieldLabel(field: string): string {
  if (field === "com_libre") return ".com libre";
  if (field === "com_domain") return ".com";
  if (field === "com_checked_at") return "com checked at";
  return field;
}

function rowHasExpandableContent(item: MarketplaceDomain, fields: string[]): boolean {
  for (const field of fields) {
    const compactField = field.toLowerCase().replace(/[_\s-]/g, "");
    const value = item.raw?.[field];
    if (compactField.includes("techstack")) {
      if (splitTechstack(value).length > 2) return true;
      continue;
    }

    const text = formatRawValue(value);
    if (text.length > 42) return true;
  }

  return false;
}

export default function IntranetPage() {
  const [domains, setDomains] = useState<MarketplaceDomain[]>([]);
  const [domainFields, setDomainFields] = useState<string[]>([]);
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [loadingDomains, setLoadingDomains] = useState(false);
  const [domainsError, setDomainsError] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [tld, setTld] = useState("");
  const [availableOnly, setAvailableOnly] = useState(false);
  const [viewMode, setViewMode] = useState<"table" | "tableau">("table");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  const [hasMore, setHasMore] = useState(false);
  const [sortBy, setSortBy] = useState("domain");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [totalMatches, setTotalMatches] = useState<number | null>(null);
  const [syncInfo, setSyncInfo] = useState<SyncInfo | null>(null);
  const [comCheckInfo, setComCheckInfo] = useState<ComCheckInfo | null>(null);
  const [analytics, setAnalytics] = useState<DashboardAnalytics | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [providerLoading, setProviderLoading] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerData, setProviderData] = useState<ProviderDomainSnapshot | null>(null);
  const [dnsForm, setDnsForm] = useState({ type: "A", name: "@", value: "", ttl: "3600" });
  const [dnsSaving, setDnsSaving] = useState(false);
  const [publicDnsLoading, setPublicDnsLoading] = useState(false);
  const [publicDnsError, setPublicDnsError] = useState<string | null>(null);
  const [publicDns, setPublicDns] = useState<PublicDnsSnapshot | null>(null);
  const [comStatusLoading, setComStatusLoading] = useState(false);
  const [comStatusError, setComStatusError] = useState<string | null>(null);
  const [comStatus, setComStatus] = useState<ComStatusSnapshot | null>(null);
  const managerSectionRef = useRef<HTMLElement | null>(null);

  const tldOptions = useMemo(() => {
    const set = new Set<string>();
    domains.forEach((item) => set.add(item.tld));
    return Array.from(set).sort();
  }, [domains]);

  const loadAnalytics = useCallback(async () => {
    try {
      const activeColumnFilters = Object.fromEntries(
        Object.entries(columnFilters).filter(([, value]) => value.trim().length > 0)
      );
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (tld.trim()) params.set("tld", tld.trim().toLowerCase());
      if (availableOnly) params.set("available", "true");
      if (Object.keys(activeColumnFilters).length > 0) {
        params.set("filters", JSON.stringify(activeColumnFilters));
      }

      const response = await fetch(`/api/domains/analytics?${params.toString()}`);
      if (!response.ok) return;
      const payload = (await response.json()) as DashboardAnalytics;
      setAnalytics(payload);
    } catch {
      // optional panel
    }
  }, [availableOnly, columnFilters, q, tld]);

  const loadDomains = useCallback(async () => {
    setLoadingDomains(true);
    setDomainsError(null);

    try {
      const activeColumnFilters = Object.fromEntries(
        Object.entries(columnFilters).filter(([, value]) => value.trim().length > 0)
      );

      const params = new URLSearchParams({
        page: String(page),
        per_page: String(perPage),
      });

      if (q.trim()) params.set("q", q.trim());
      if (tld.trim()) params.set("tld", tld.trim().toLowerCase());
      if (availableOnly) params.set("available", "true");
      params.set("sort_by", sortBy);
      params.set("sort_dir", sortDir);
      if (Object.keys(activeColumnFilters).length > 0) {
        params.set("filters", JSON.stringify(activeColumnFilters));
      }

      const response = await fetch(`/api/domains?${params.toString()}`);
      const payload = (await response.json()) as MarketplaceDomainResponse & { error?: string; details?: string };

      if (!response.ok) {
        throw new Error(payload.details || payload.error || "Error cargando dominios");
      }

      setDomains(payload.data || []);
      setDomainFields(payload.fields || []);
      setHasMore(Boolean(payload.pagination?.hasMore));
      setTotalMatches(payload.pagination?.total ?? null);
      setExpandedRows(new Set());
    } catch (error: unknown) {
      setDomains([]);
      setDomainFields([]);
      setHasMore(false);
      setTotalMatches(null);
      setAnalytics(null);
      setDomainsError(getErrorDetails(error));
    } finally {
      setLoadingDomains(false);
    }
  }, [availableOnly, columnFilters, page, perPage, q, sortBy, sortDir, tld]);

  const loadSyncInfo = useCallback(async () => {
    try {
      const response = await fetch("/api/domains/sync");
      if (!response.ok) return;
      const payload = (await response.json()) as SyncInfo;
      setSyncInfo(payload);
    } catch {
      // ignore
    }
  }, []);

  const loadComCheckInfo = useCallback(async () => {
    try {
      const response = await fetch("/api/domains/com-check");
      if (!response.ok) return;
      const payload = (await response.json()) as ComCheckInfo;
      setComCheckInfo(payload);
    } catch {
      // ignore
    }
  }, []);

  const syncNow = useCallback(async () => {
    setDomainsError(null);
    try {
      const response = await fetch("/api/domains/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: false }),
      });
      const payload = (await response.json()) as { error?: string; details?: string };
      if (!response.ok) throw new Error(payload.details || payload.error || "No se pudo sincronizar");
      await loadSyncInfo();
      await loadComCheckInfo();
      await loadDomains();
    } catch (error: unknown) {
      setDomainsError(getErrorDetails(error));
    }
  }, [loadComCheckInfo, loadDomains, loadSyncInfo]);

  const resetAndSync = useCallback(async () => {
    setDomainsError(null);
    if (!window.confirm("Esto vaciará el catálogo local y hará una carga completa desde Soinda. ¿Continuar?")) return;
    try {
      const response = await fetch("/api/domains/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true, reset: true }),
      });
      const payload = (await response.json()) as { error?: string; details?: string };
      if (!response.ok) throw new Error(payload.details || payload.error || "No se pudo reiniciar y sincronizar");
      setPage(1);
      setColumnFilters({});
      await loadSyncInfo();
      await loadComCheckInfo();
      await loadDomains();
    } catch (error: unknown) {
      setDomainsError(getErrorDetails(error));
    }
  }, [loadComCheckInfo, loadDomains, loadSyncInfo]);

  const refreshComLibre = useCallback(async () => {
    setDomainsError(null);
    try {
      const response = await fetch("/api/domains/com-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      const payload = (await response.json()) as { error?: string; details?: string };
      if (!response.ok) throw new Error(payload.details || payload.error || "No se pudo lanzar refresco .com");
      await loadComCheckInfo();
      await loadDomains();
    } catch (error: unknown) {
      setDomainsError(getErrorDetails(error));
    }
  }, [loadComCheckInfo, loadDomains]);

  const openDomainManager = useCallback(async (domain: string) => {
    setSelectedDomain(domain);
    setProviderLoading(true);
    setProviderError(null);
    setPublicDnsError(null);
    setPublicDns(null);
    setComStatusError(null);
    setComStatus(null);
    setTimeout(() => {
      managerSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
    try {
      const response = await fetch(`/api/provider/domain?domain=${encodeURIComponent(domain)}`);
      const payload = (await response.json()) as ProviderDomainSnapshot & { error?: string; details?: string };
      if (!response.ok) {
        throw new Error(payload.details || payload.error || "No se pudo cargar el dominio en el proveedor");
      }
      setProviderData(payload);
    } catch (error: unknown) {
      setProviderData(null);
      setProviderError(getErrorDetails(error));
    } finally {
      setProviderLoading(false);
    }
  }, []);

  const refreshProviderDns = useCallback(async () => {
    if (!selectedDomain) return;
    setProviderLoading(true);
    setProviderError(null);
    try {
      const response = await fetch(`/api/provider/domain/dns?domain=${encodeURIComponent(selectedDomain)}`);
      const payload = (await response.json()) as { records?: ProviderDnsRecord[]; error?: string; details?: string };
      if (!response.ok) throw new Error(payload.details || payload.error || "No se pudo refrescar DNS");
      setProviderData((prev) =>
        prev
          ? {
              ...prev,
              dnsRecords: payload.records || [],
            }
          : null
      );
    } catch (error: unknown) {
      setProviderError(getErrorDetails(error));
    } finally {
      setProviderLoading(false);
    }
  }, [selectedDomain]);

  const createDnsRecord = useCallback(async () => {
    if (!selectedDomain) return;
    if (!dnsForm.value.trim()) {
      setProviderError("El campo Target/Value es obligatorio.");
      return;
    }

    setDnsSaving(true);
    setProviderError(null);
    try {
      const ttlValue = Number(dnsForm.ttl);
      const response = await fetch("/api/provider/domain/dns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: selectedDomain,
          type: dnsForm.type,
          name: dnsForm.name || "@",
          value: dnsForm.value,
          ttl: Number.isFinite(ttlValue) ? ttlValue : null,
        }),
      });
      const payload = (await response.json()) as { records?: ProviderDnsRecord[]; error?: string; details?: string };
      if (!response.ok) throw new Error(payload.details || payload.error || "No se pudo crear el registro DNS");
      setProviderData((prev) =>
        prev
          ? {
              ...prev,
              dnsRecords: payload.records || [],
            }
          : null
      );
      setDnsForm((prev) => ({ ...prev, value: "" }));
    } catch (error: unknown) {
      setProviderError(getErrorDetails(error));
    } finally {
      setDnsSaving(false);
    }
  }, [dnsForm, selectedDomain]);

  const deleteDnsRecord = useCallback(
    async (recordId: string) => {
      if (!selectedDomain) return;
      setDnsSaving(true);
      setProviderError(null);
      try {
        const response = await fetch("/api/provider/domain/dns", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            domain: selectedDomain,
            recordId,
          }),
        });
        const payload = (await response.json()) as { records?: ProviderDnsRecord[]; error?: string; details?: string };
        if (!response.ok) throw new Error(payload.details || payload.error || "No se pudo eliminar el registro DNS");
        setProviderData((prev) =>
          prev
            ? {
                ...prev,
                dnsRecords: payload.records || [],
              }
            : null
        );
      } catch (error: unknown) {
        setProviderError(getErrorDetails(error));
      } finally {
        setDnsSaving(false);
      }
    },
    [selectedDomain]
  );

  const checkPublicDns = useCallback(async () => {
    if (!selectedDomain) return;
    setPublicDnsLoading(true);
    setPublicDnsError(null);
    try {
      const response = await fetch(`/api/provider/public-dns?domain=${encodeURIComponent(selectedDomain)}`);
      const payload = (await response.json()) as PublicDnsSnapshot & { error?: string; details?: string };
      if (!response.ok) throw new Error(payload.details || payload.error || "No se pudo comprobar DNS pública");
      setPublicDns(payload);
    } catch (error: unknown) {
      setPublicDns(null);
      setPublicDnsError(getErrorDetails(error));
    } finally {
      setPublicDnsLoading(false);
    }
  }, [selectedDomain]);

  const checkComStatus = useCallback(async () => {
    if (!selectedDomain) return;
    setComStatusLoading(true);
    setComStatusError(null);
    try {
      const response = await fetch(`/api/provider/com-status?domain=${encodeURIComponent(selectedDomain)}`);
      const payload = (await response.json()) as ComStatusSnapshot & { error?: string; details?: string };
      if (!response.ok) throw new Error(payload.details || payload.error || "No se pudo comprobar el .com");
      setComStatus(payload);
    } catch (error: unknown) {
      setComStatus(null);
      setComStatusError(getErrorDetails(error));
    } finally {
      setComStatusLoading(false);
    }
  }, [selectedDomain]);

  const setSort = useCallback((field: string, dir: "asc" | "desc") => {
    setPage(1);
    setSortBy(field);
    setSortDir(dir);
  }, []);

  useEffect(() => {
    void loadSyncInfo();
  }, [loadSyncInfo]);

  useEffect(() => {
    void loadComCheckInfo();
  }, [loadComCheckInfo]);

  useEffect(() => {
    void loadDomains();
  }, [loadDomains]);

  useEffect(() => {
    if (!comCheckInfo?.isChecking) return;
    const timer = setInterval(() => {
      void loadComCheckInfo();
    }, 4000);
    return () => clearInterval(timer);
  }, [comCheckInfo?.isChecking, loadComCheckInfo]);

  useEffect(() => {
    if (viewMode !== "tableau") return;
    void loadAnalytics();
  }, [loadAnalytics, viewMode]);

  const dashboard = analytics ?? {
    total: 0,
    available: 0,
    avgPrice: null,
    uniqueTlds: 0,
    topTlds: [],
    topTech: [],
    topLevels: [],
    heatRows: [],
    heatCols: [],
    heatMatrix: [],
    heatMax: 0,
  };

  return (
    <RoleGuard allow={["admin"]}>
      <main className="min-h-screen bg-neutral-100 p-6">
        <div className="mx-auto max-w-7xl space-y-5 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold text-neutral-900">Intranet: Catálogo Soinda</h1>
              <p className="mt-1 text-sm text-neutral-600">Visualización y filtros sobre la base local sincronizada.</p>
            </div>
            <Link href="/" className="inline-block rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-50">
              Volver al portal
            </Link>
          </div>

          <section className="grid gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4 md:grid-cols-6">
            <input
              type="text"
              placeholder="Buscar dominio..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm md:col-span-2"
            />

            <select value={tld} onChange={(e) => setTld(e.target.value)} className="rounded-md border border-neutral-300 px-3 py-2 text-sm">
              <option value="">Todos los TLD</option>
              {tldOptions.map((option) => (
                <option key={option} value={option}>
                  .{option}
                </option>
              ))}
            </select>

            <select
              value={perPage}
              onChange={(e) => {
                setPerPage(Number(e.target.value));
                setPage(1);
              }}
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size} / página
                </option>
              ))}
            </select>

            <label className="flex items-center gap-2 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm">
              <input type="checkbox" checked={availableOnly} onChange={(e) => setAvailableOnly(e.target.checked)} />
              Solo disponibles
            </label>

            <button
              onClick={() => void loadDomains()}
              disabled={loadingDomains}
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-50"
            >
              {loadingDomains ? "Cargando..." : "Buscar"}
            </button>
          </section>

          {domainsError ? <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{domainsError}</p> : null}

          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-neutral-600">
            <p>
              Catálogo local (BBDD): {syncInfo?.totalDomains ?? 0} dominios.
              {syncInfo?.lastSyncAt ? ` Última sync: ${new Date(syncInfo.lastSyncAt).toLocaleString()}.` : ""}
              {syncInfo?.sourceCreatedAtMax
                ? ` Cursor created_at: ${new Date(syncInfo.sourceCreatedAtMax).toLocaleString()}.`
                : ""}
              {syncInfo?.syncMode ? ` Modo: ${syncInfo.syncMode === "full" ? "carga completa" : "incremental"}.` : ""}
              {syncInfo?.totalPages
                ? ` Progreso sync: página ${syncInfo.cursorPage} de ${syncInfo.totalPages}.`
                : syncInfo?.lastPage
                  ? ` Última página procesada: ${syncInfo.lastPage}.`
                  : ""}
              {syncInfo?.nextSyncNotBefore ? ` Próximo intento permitido: ${new Date(syncInfo.nextSyncNotBefore).toLocaleString()}.` : ""}
              {totalMatches !== null ? ` Coincidencias: ${totalMatches}.` : ""}
            </p>
            <div className="flex items-center gap-2">
              {syncInfo?.isSyncing ? <span>Sincronizando...</span> : null}
              <button
                onClick={() => void syncNow()}
                disabled={Boolean(syncInfo?.isSyncing)}
                className="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50"
              >
                Sincronizar ahora
              </button>
              <button
                onClick={() => void refreshComLibre()}
                disabled={Boolean(comCheckInfo?.isChecking)}
                className="rounded-md border border-blue-300 px-3 py-1 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-50"
              >
                Refrescar .com libre (manual)
              </button>
              <button
                onClick={() => void resetAndSync()}
                disabled={Boolean(syncInfo?.isSyncing)}
                className="rounded-md border border-red-300 px-3 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                Empezar de cero
              </button>
            </div>
          </div>

          {syncInfo?.lastError ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">Último error de sync: {syncInfo.lastError}</p>
          ) : null}
          {comCheckInfo ? (
            <p className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
              .es revisados para .com libre: {comCheckInfo.checkedEsDomains}/{comCheckInfo.totalEsDomains}
              {comCheckInfo.pendingEsDomains > 0 ? ` (pendientes: ${comCheckInfo.pendingEsDomains})` : ""}.
              {comCheckInfo.lastRunAt ? ` Última comprobación: ${new Date(comCheckInfo.lastRunAt).toLocaleString()}.` : ""}
              {comCheckInfo.isChecking ? " Comprobando..." : ""}
              {comCheckInfo.lastError ? ` Error: ${comCheckInfo.lastError}` : ""}
            </p>
          ) : null}

          <div className="flex items-center gap-2">
            <button
              onClick={() => setViewMode("table")}
              className={`rounded-md px-3 py-1 text-sm ${viewMode === "table" ? "bg-neutral-900 text-white" : "border border-neutral-300 hover:bg-neutral-100"}`}
            >
              Tabla
            </button>
            <button
              onClick={() => setViewMode("tableau")}
              className={`rounded-md px-3 py-1 text-sm ${viewMode === "tableau" ? "bg-neutral-900 text-white" : "border border-neutral-300 hover:bg-neutral-100"}`}
            >
              Tableau
            </button>
          </div>

          {selectedDomain ? (
            <p className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
              Dominio seleccionado: <span className="font-semibold">{selectedDomain}</span>. Se abrió la sección “Gestión dominio” más abajo.
            </p>
          ) : null}

          {viewMode === "table" ? (
            <section className="overflow-x-auto rounded-lg border border-neutral-200">
              <table className="min-w-full text-xs">
                <thead className="bg-neutral-50 text-left text-neutral-700">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">
                      <div className="inline-flex items-center gap-2">
                        <span>Dominio</span>
                        <button onClick={() => setSort("domain", "asc")} className={`text-xs ${sortBy === "domain" && sortDir === "asc" ? "font-bold" : "opacity-60"}`}>↑</button>
                        <button onClick={() => setSort("domain", "desc")} className={`text-xs ${sortBy === "domain" && sortDir === "desc" ? "font-bold" : "opacity-60"}`}>↓</button>
                      </div>
                    </th>
                    {domainFields.map((field) => (
                      <th key={field} className="px-3 py-1.5 font-medium">
                        <div className="inline-flex items-center gap-2">
                          <span>{formatFieldLabel(field)}</span>
                          <button onClick={() => setSort(field, "asc")} className={`text-xs ${sortBy === field && sortDir === "asc" ? "font-bold" : "opacity-60"}`}>↑</button>
                          <button onClick={() => setSort(field, "desc")} className={`text-xs ${sortBy === field && sortDir === "desc" ? "font-bold" : "opacity-60"}`}>↓</button>
                        </div>
                      </th>
                    ))}
                    <th className="px-3 py-1.5 font-medium">Detalle</th>
                  </tr>
                  <tr>
                    <th className="px-3 py-1.5">
                      <input
                        type="text"
                        placeholder="Filtrar dominio"
                        value={columnFilters.domain || ""}
                        onChange={(e) => setColumnFilters((prev) => ({ ...prev, domain: e.target.value }))}
                        className="w-full rounded border border-neutral-300 px-2 py-0.5 text-xs"
                      />
                    </th>
                    {domainFields.map((field) => (
                      <th key={`${field}-filter`} className="px-3 py-1.5">
                        <input
                          type="text"
                          placeholder={`Filtrar ${formatFieldLabel(field)}`}
                          value={columnFilters[field] || ""}
                          onChange={(e) => setColumnFilters((prev) => ({ ...prev, [field]: e.target.value }))}
                          className="w-full rounded border border-neutral-300 px-2 py-0.5 text-xs"
                        />
                      </th>
                    ))}
                    <th className="px-3 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {domains.map((item) => {
                    const expanded = expandedRows.has(item.domain);
                    const canExpand = rowHasExpandableContent(item, domainFields);
                    return (
                    <tr key={item.domain} className="border-t border-neutral-200">
                      <td className={`px-3 ${expanded ? "py-2" : "py-1"} font-medium text-neutral-900`}>
                        <div className={expanded ? "" : "max-w-xs truncate"}>{item.domain}</div>
                      </td>
                      {domainFields.map((field) => (
                        <td key={`${item.domain}-${field}`} className={`max-w-xs px-3 ${expanded ? "py-2" : "py-1"} text-neutral-700`}>
                          {renderRawValue(field, item.raw?.[field], expanded)}
                        </td>
                      ))}
                      <td className={`px-3 ${expanded ? "py-2" : "py-1"} align-top`}>
                        <div className="flex flex-wrap gap-2">
                          {canExpand ? (
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedRows((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(item.domain)) next.delete(item.domain);
                                  else next.add(item.domain);
                                  return next;
                                })
                              }
                              className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100"
                            >
                              {expanded ? "Ver menos" : "Ver más"}
                            </button>
                          ) : (
                            <span className="text-xs text-neutral-400">-</span>
                          )}
                          <button
                            type="button"
                            onClick={() => void openDomainManager(item.domain)}
                            className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100"
                          >
                            Gestionar
                          </button>
                        </div>
                      </td>
                    </tr>
                  )})}

                  {!domains.length && !loadingDomains ? (
                    <tr>
                      <td colSpan={2 + domainFields.length} className="px-3 py-8 text-center text-neutral-600">
                        Sin resultados. Ajusta filtros o pulsa Buscar.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </section>
          ) : (
            <section className="space-y-4">
              <div className="grid gap-3 md:grid-cols-4">
                <div className="rounded-lg border border-neutral-200 bg-white p-4">
                  <p className="text-xs uppercase text-neutral-500">Registros (global)</p>
                  <p className="text-2xl font-semibold">{dashboard.total}</p>
                </div>
                <div className="rounded-lg border border-neutral-200 bg-white p-4">
                  <p className="text-xs uppercase text-neutral-500">Disponibles</p>
                  <p className="text-2xl font-semibold">{dashboard.available}</p>
                </div>
                <div className="rounded-lg border border-neutral-200 bg-white p-4">
                  <p className="text-xs uppercase text-neutral-500">TLD únicos</p>
                  <p className="text-2xl font-semibold">{dashboard.uniqueTlds}</p>
                </div>
                <div className="rounded-lg border border-neutral-200 bg-white p-4">
                  <p className="text-xs uppercase text-neutral-500">Precio medio</p>
                  <p className="text-2xl font-semibold">{dashboard.avgPrice !== null ? `${dashboard.avgPrice.toFixed(2)} EUR` : "N/D"}</p>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-lg border border-neutral-200 bg-white p-4">
                  <h3 className="mb-3 text-sm font-semibold text-neutral-800">Top TLD</h3>
                  <div className="space-y-2">
                    {dashboard.topTlds.map((row) => (
                      <div key={row.label}>
                        <div className="mb-1 flex justify-between text-xs">
                          <span>.{row.label}</span>
                          <span>{row.value}</span>
                        </div>
                        <div className="h-2 rounded bg-neutral-200">
                          <div
                            className="h-2 rounded bg-neutral-800"
                            style={{ width: `${Math.max(4, (row.value / (dashboard.topTlds[0]?.value || 1)) * 100)}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-lg border border-neutral-200 bg-white p-4">
                  <h3 className="mb-3 text-sm font-semibold text-neutral-800">Top tecnologías</h3>
                  <div className="flex flex-wrap gap-2">
                    {dashboard.topTech.map((item) => (
                      <span key={item.label} className="rounded bg-neutral-900 px-2 py-1 text-xs text-white">
                        {item.label} ({item.value})
                      </span>
                    ))}
                    {!dashboard.topTech.length ? <span className="text-sm text-neutral-500">Sin datos.</span> : null}
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-neutral-200 bg-white p-4">
                <h3 className="mb-3 text-sm font-semibold text-neutral-800">Matriz TLD x Nivel técnico</h3>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead>
                      <tr>
                        <th className="px-2 py-1 text-left">TLD</th>
                        {dashboard.heatCols.map((col) => (
                          <th key={col} className="px-2 py-1 text-left capitalize">{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {dashboard.heatRows.map((row, rowIndex) => (
                        <tr key={row}>
                          <td className="px-2 py-1 font-medium">.{row}</td>
                          {dashboard.heatCols.map((col, colIndex) => {
                            const value = dashboard.heatMatrix[rowIndex]?.[colIndex] || 0;
                            const alpha = dashboard.heatMax ? value / dashboard.heatMax : 0;
                            return (
                              <td
                                key={`${row}-${col}`}
                                className="px-2 py-1"
                                style={{ backgroundColor: `rgba(17, 24, 39, ${Math.max(0.08, alpha)})`, color: alpha > 0.55 ? "white" : "black" }}
                              >
                                {value}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

          <section ref={managerSectionRef} className="space-y-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold text-neutral-900">Gestión dominio (API proveedor)</h2>
              <div className="flex items-center gap-2">
                {selectedDomain ? (
                  <button
                    onClick={() => void checkPublicDns()}
                    disabled={publicDnsLoading}
                    className="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50"
                  >
                    {publicDnsLoading ? "Comprobando DNS..." : "Comprobar DNS pública"}
                  </button>
                ) : null}
                {selectedDomain ? (
                  <button
                    onClick={() => void checkComStatus()}
                    disabled={comStatusLoading}
                    className="rounded-md border border-green-300 px-3 py-1 text-xs text-green-700 hover:bg-green-50 disabled:opacity-50"
                  >
                    {comStatusLoading ? "Comprobando .com..." : "WHOIS / Disponibilidad .com"}
                  </button>
                ) : null}
                {selectedDomain ? (
                  <button
                    onClick={() => void refreshProviderDns()}
                    disabled={providerLoading}
                    className="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50"
                  >
                    Refrescar DNS
                  </button>
                ) : null}
              </div>
            </div>

            {!selectedDomain ? (
              <p className="text-sm text-neutral-600">Pulsa “Gestionar” en cualquier fila para abrir su panel.</p>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-neutral-700">
                  Dominio seleccionado: <span className="font-medium">{selectedDomain}</span>
                </p>
                {providerError ? (
                  <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{providerError}</p>
                ) : null}
                {publicDnsError ? (
                  <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">{publicDnsError}</p>
                ) : null}
                {comStatusError ? (
                  <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">{comStatusError}</p>
                ) : null}
                {publicDns ? (
                  <div className="rounded-md border border-neutral-200 bg-white p-3">
                    <h3 className="mb-2 text-sm font-semibold text-neutral-800">DNS pública</h3>
                    <p className="mb-2 text-sm text-neutral-700">
                      Estado:{" "}
                      <span className={publicDns.hasDns ? "font-semibold text-green-700" : "font-semibold text-red-700"}>
                        {publicDns.hasDns ? "Tiene registros DNS" : "Sin registros detectados"}
                      </span>
                    </p>
                    <div className="grid gap-2 md:grid-cols-3">
                      {Object.entries(publicDns.records).map(([type, values]) => (
                        <div key={type} className="rounded border border-neutral-200 px-2 py-1 text-xs">
                          <p className="font-medium text-neutral-700">{type}</p>
                          <p className="text-neutral-600">{values.length ? values.slice(0, 3).join(" | ") : "-"}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {comStatus ? (
                  <div className="rounded-md border border-green-200 bg-white p-3">
                    <h3 className="mb-2 text-sm font-semibold text-neutral-800">Estado .com + WHOIS</h3>
                    <div className="grid gap-2 md:grid-cols-2">
                      <div className="rounded border border-neutral-200 px-2 py-1 text-xs">
                        <p className="font-medium text-neutral-700">Dominio .com</p>
                        <p className="text-neutral-700">{comStatus.comDomain}</p>
                      </div>
                      <div className="rounded border border-neutral-200 px-2 py-1 text-xs">
                        <p className="font-medium text-neutral-700">Disponibilidad inferida</p>
                        <p className={comStatus.availability.available ? "text-green-700 font-semibold" : "text-red-700 font-semibold"}>
                          {comStatus.availability.available ? "Disponible" : "No disponible"}
                        </p>
                        <p className="text-neutral-500">Confianza: {comStatus.availability.confidence}</p>
                      </div>
                      <div className="rounded border border-neutral-200 px-2 py-1 text-xs">
                        <p className="font-medium text-neutral-700">WHOIS</p>
                        <p className="text-neutral-700">{comStatus.whois.found ? "Encontrado" : "No encontrado"}</p>
                        <p className="text-neutral-500">Registrar: {comStatus.whois.registrar || "-"}</p>
                      </div>
                      <div className="rounded border border-neutral-200 px-2 py-1 text-xs">
                        <p className="font-medium text-neutral-700">DNS pública .com</p>
                        <p className="text-neutral-700">{comStatus.dns.hasAnyRecord ? "Tiene DNS" : "Sin DNS"}</p>
                      </div>
                      <div className="rounded border border-neutral-200 px-2 py-1 text-xs">
                        <p className="font-medium text-neutral-700">Creación</p>
                        <p className="text-neutral-700">{comStatus.whois.createdAt || "-"}</p>
                      </div>
                      <div className="rounded border border-neutral-200 px-2 py-1 text-xs">
                        <p className="font-medium text-neutral-700">Expiración</p>
                        <p className="text-neutral-700">{comStatus.whois.expiresAt || "-"}</p>
                      </div>
                    </div>
                  </div>
                ) : null}

                {providerLoading ? <p className="text-sm text-neutral-500">Cargando datos del proveedor...</p> : null}

                {providerData ? (
                  <>
                    <div className="rounded-md border border-neutral-200 bg-white p-3">
                      <h3 className="mb-2 text-sm font-semibold text-neutral-800">Ficha dominio</h3>
                      <div className="grid gap-2 md:grid-cols-2">
                        {Object.entries(providerData.info).map(([key, value]) => (
                          <div key={key} className="rounded border border-neutral-200 px-2 py-1 text-xs">
                            <p className="font-medium text-neutral-700">{key}</p>
                            <p className="text-neutral-600">{formatRawValue(value)}</p>
                          </div>
                        ))}
                        {!Object.keys(providerData.info).length ? <p className="text-sm text-neutral-500">Sin datos de ficha.</p> : null}
                      </div>
                    </div>

                    <div className="rounded-md border border-neutral-200 bg-white p-3">
                      <h3 className="mb-2 text-sm font-semibold text-neutral-800">Crear registro DNS</h3>
                      <div className="grid gap-2 md:grid-cols-5">
                        <select
                          value={dnsForm.type}
                          onChange={(e) => setDnsForm((prev) => ({ ...prev, type: e.target.value }))}
                          className="rounded border border-neutral-300 px-2 py-1 text-sm"
                        >
                          {["A", "AAAA", "CNAME", "TXT", "MX", "NS", "SRV", "CAA"].map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                        <input
                          type="text"
                          value={dnsForm.name}
                          onChange={(e) => setDnsForm((prev) => ({ ...prev, name: e.target.value }))}
                          placeholder="Host (@ o www)"
                          className="rounded border border-neutral-300 px-2 py-1 text-sm"
                        />
                        <input
                          type="text"
                          value={dnsForm.value}
                          onChange={(e) => setDnsForm((prev) => ({ ...prev, value: e.target.value }))}
                          placeholder="Target / Value"
                          className="rounded border border-neutral-300 px-2 py-1 text-sm md:col-span-2"
                        />
                        <input
                          type="number"
                          min={60}
                          value={dnsForm.ttl}
                          onChange={(e) => setDnsForm((prev) => ({ ...prev, ttl: e.target.value }))}
                          placeholder="TTL"
                          className="rounded border border-neutral-300 px-2 py-1 text-sm"
                        />
                      </div>
                      <div className="mt-2">
                        <button
                          onClick={() => void createDnsRecord()}
                          disabled={dnsSaving || providerLoading}
                          className="rounded-md bg-neutral-900 px-3 py-1 text-xs text-white hover:bg-neutral-800 disabled:opacity-50"
                        >
                          {dnsSaving ? "Guardando..." : "Crear registro"}
                        </button>
                      </div>
                    </div>

                    <div className="overflow-x-auto rounded-md border border-neutral-200 bg-white">
                      <table className="min-w-full text-sm">
                        <thead className="bg-neutral-50">
                          <tr>
                            <th className="px-3 py-2 text-left">ID</th>
                            <th className="px-3 py-2 text-left">Tipo</th>
                            <th className="px-3 py-2 text-left">Host</th>
                            <th className="px-3 py-2 text-left">Valor</th>
                            <th className="px-3 py-2 text-left">TTL</th>
                            <th className="px-3 py-2 text-left">Acción</th>
                          </tr>
                        </thead>
                        <tbody>
                          {providerData.dnsRecords.map((record) => (
                            <tr key={record.id} className="border-t border-neutral-200">
                              <td className="px-3 py-2 text-xs text-neutral-700">{record.id}</td>
                              <td className="px-3 py-2">{record.type}</td>
                              <td className="px-3 py-2">{record.name}</td>
                              <td className="max-w-xs truncate px-3 py-2">{record.value}</td>
                              <td className="px-3 py-2">{record.ttl ?? "-"}</td>
                              <td className="px-3 py-2">
                                <button
                                  onClick={() => void deleteDnsRecord(record.id)}
                                  disabled={dnsSaving || providerLoading}
                                  className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                                >
                                  Eliminar
                                </button>
                              </td>
                            </tr>
                          ))}
                          {!providerData.dnsRecords.length ? (
                            <tr>
                              <td colSpan={6} className="px-3 py-6 text-center text-sm text-neutral-500">
                                Sin registros DNS.
                              </td>
                            </tr>
                          ) : null}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : null}
              </div>
            )}
          </section>

          <div className="flex items-center justify-between">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-50 disabled:opacity-40"
            >
              Anterior
            </button>
            <p className="text-sm text-neutral-700">Página {page}</p>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={!hasMore}
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-50 disabled:opacity-40"
            >
              Siguiente
            </button>
          </div>
        </div>
      </main>
    </RoleGuard>
  );
}
