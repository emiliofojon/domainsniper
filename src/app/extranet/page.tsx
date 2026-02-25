"use client";

import Link from "next/link";
import { RoleGuard } from "@/components/role-guard";
import { useAuth } from "@/context/auth-context";

export default function ExtranetPage() {
  const { profile } = useAuth();

  return (
    <RoleGuard allow={["client", "admin"]}>
      <main className="min-h-screen bg-neutral-100 p-6">
        <div className="mx-auto max-w-4xl rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
          <h1 className="text-2xl font-semibold text-neutral-900">Extranet</h1>
          <p className="mt-2 text-sm text-neutral-600">
            Área de cliente para consultar dominios asignados.
          </p>

          <div className="mt-6 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
            <h2 className="text-sm font-semibold text-neutral-900">
              Dominios asignados
            </h2>
            {profile?.domains?.length ? (
              <ul className="mt-2 space-y-1 text-sm text-neutral-700">
                {profile.domains.map((domain) => (
                  <li key={domain}>{domain}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-neutral-600">
                No hay dominios asignados en `users/{'{uid}'}.domains`.
              </p>
            )}
          </div>

          <Link
            href="/"
            className="mt-5 inline-block rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-50"
          >
            Volver al portal
          </Link>
        </div>
      </main>
    </RoleGuard>
  );
}

