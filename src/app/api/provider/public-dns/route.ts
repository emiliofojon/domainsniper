import { NextResponse } from "next/server";
import { resolve4, resolve6, resolveCname, resolveMx, resolveNs, resolveTxt } from "node:dns/promises";

export const runtime = "nodejs";

type DnsSnapshot = {
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

async function safeResolve<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const domain = (searchParams.get("domain") || "").trim().toLowerCase();
    if (!domain) return NextResponse.json({ error: "Falta domain" }, { status: 400 });

    const [a, aaaa, cname, mx, ns, txt] = await Promise.all([
      safeResolve(() => resolve4(domain)),
      safeResolve(() => resolve6(domain)),
      safeResolve(() => resolveCname(domain)),
      safeResolve(() => resolveMx(domain)),
      safeResolve(() => resolveNs(domain)),
      safeResolve(() => resolveTxt(domain)),
    ]);

    const payload: DnsSnapshot = {
      domain,
      hasDns: Boolean(a.length || aaaa.length || cname.length || mx.length || ns.length || txt.length),
      records: {
        A: a,
        AAAA: aaaa,
        CNAME: cname,
        MX: mx.map((item) => `${item.exchange} (prio ${item.priority})`),
        NS: ns,
        TXT: txt.map((chunks) => chunks.join("")),
      },
    };

    return NextResponse.json(payload);
  } catch (error: unknown) {
    const details = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "No se pudo consultar DNS pública", details }, { status: 500 });
  }
}
