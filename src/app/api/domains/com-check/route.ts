import { NextResponse } from "next/server";
import { checkComAvailability, getComCheckStatus } from "@/lib/server/soinda-store";

export const runtime = "nodejs";

function getErrorDetails(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function GET() {
  return NextResponse.json(await getComCheckStatus());
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { force?: boolean };
    void checkComAvailability(Boolean(body.force));
    return NextResponse.json({ success: true, status: await getComCheckStatus() });
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error: "No se pudo iniciar la comprobación .com libre",
        details: getErrorDetails(error),
      },
      { status: 500 }
    );
  }
}
