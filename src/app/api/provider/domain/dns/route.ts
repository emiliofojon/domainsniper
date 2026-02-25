import { NextResponse } from "next/server";
import {
  createProviderDnsRecord,
  deleteProviderDnsRecord,
  fetchProviderDomain,
  updateProviderDnsRecord,
} from "@/lib/server/domain-provider";

export const runtime = "nodejs";

function getErrorDetails(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

type DnsInput = {
  domain?: string;
  recordId?: string;
  type?: string;
  name?: string;
  value?: string;
  ttl?: number | null;
};

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const domain = (searchParams.get("domain") || "").trim().toLowerCase();
    if (!domain) return NextResponse.json({ error: "Falta domain" }, { status: 400 });

    const snapshot = await fetchProviderDomain(domain);
    return NextResponse.json({ domain: snapshot.domain, records: snapshot.dnsRecords });
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error: "No se pudieron cargar los DNS",
        details: getErrorDetails(error),
      },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as DnsInput;
    const domain = (body.domain || "").trim().toLowerCase();
    const type = (body.type || "").trim();
    const value = (body.value || "").trim();
    const name = (body.name || "@").trim();
    if (!domain || !type || !value) {
      return NextResponse.json({ error: "Faltan domain, type o value" }, { status: 400 });
    }

    await createProviderDnsRecord(domain, {
      type,
      name,
      value,
      ttl: body.ttl ?? null,
    });
    const snapshot = await fetchProviderDomain(domain);
    return NextResponse.json({ success: true, records: snapshot.dnsRecords });
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error: "No se pudo crear el registro DNS",
        details: getErrorDetails(error),
      },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as DnsInput;
    const domain = (body.domain || "").trim().toLowerCase();
    const recordId = (body.recordId || "").trim();
    if (!domain || !recordId) {
      return NextResponse.json({ error: "Faltan domain o recordId" }, { status: 400 });
    }

    await updateProviderDnsRecord(domain, recordId, {
      type: body.type,
      name: body.name,
      value: body.value,
      ttl: body.ttl ?? undefined,
    });
    const snapshot = await fetchProviderDomain(domain);
    return NextResponse.json({ success: true, records: snapshot.dnsRecords });
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error: "No se pudo actualizar el registro DNS",
        details: getErrorDetails(error),
      },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const body = (await req.json()) as DnsInput;
    const domain = (body.domain || "").trim().toLowerCase();
    const recordId = (body.recordId || "").trim();
    if (!domain || !recordId) {
      return NextResponse.json({ error: "Faltan domain o recordId" }, { status: 400 });
    }

    await deleteProviderDnsRecord(domain, recordId);
    const snapshot = await fetchProviderDomain(domain);
    return NextResponse.json({ success: true, records: snapshot.dnsRecords });
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error: "No se pudo eliminar el registro DNS",
        details: getErrorDetails(error),
      },
      { status: 500 }
    );
  }
}
