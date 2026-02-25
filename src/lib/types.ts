// ─── Marketplace Types ───────────────────────────────────────────────────────

export interface MarketplaceDomain {
  domain: string;
  tld: string;
  available: boolean | null;
  price: number | null;
  currency: string | null;
  status: string | null;
  raw: Record<string, unknown>;
}

export interface MarketplaceDomainResponse {
  data: MarketplaceDomain[];
  fields: string[];
  pagination: {
    page: number;
    perPage: number;
    total: number | null;
    hasMore: boolean;
    scope?: "page" | "global";
  };
}

// ─── User Types ──────────────────────────────────────────────────────────────

export type UserRole = "admin" | "client";

export interface AppUser {
  uid: string;
  email: string;
  name?: string;
  role: UserRole;
  domains?: string[];
  created_at?: string;
}
