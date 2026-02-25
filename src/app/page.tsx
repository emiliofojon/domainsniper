"use client";

import Link from "next/link";
import { useAuth } from "@/context/auth-context";

export default function Home() {
  const { user, role, logout, loading } = useAuth();

  return (
    <main className="min-h-screen bg-neutral-100 p-6 md:p-10">
      <div className="mx-auto max-w-5xl rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm md:p-8">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-neutral-900">
              Domain Sniper Portal
            </h1>
            <p className="mt-1 text-sm text-neutral-600">
              Base de intranet/extranet con Firebase Auth + roles.
            </p>
          </div>
          <div className="text-right text-sm text-neutral-700">
            {loading ? (
              <span>Cargando sesión...</span>
            ) : user ? (
              <div className="space-y-1">
                <p>{user.email}</p>
                <p className="font-medium uppercase">{role ?? "sin rol"}</p>
                <button
                  onClick={() => void logout()}
                  className="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-50"
                >
                  Cerrar sesión
                </button>
              </div>
            ) : (
              <Link
                href="/login"
                className="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-50"
              >
                Iniciar sesión
              </Link>
            )}
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <section className="rounded-xl border border-neutral-200 p-5">
            <h2 className="text-lg font-semibold text-neutral-900">Intranet</h2>
            <p className="mt-2 text-sm text-neutral-600">
              Área interna para administración (`role=admin`).
            </p>
            <Link
              href="/intranet"
              className="mt-4 inline-block rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800"
            >
              Abrir intranet
            </Link>
          </section>

          <section className="rounded-xl border border-neutral-200 p-5">
            <h2 className="text-lg font-semibold text-neutral-900">Extranet</h2>
            <p className="mt-2 text-sm text-neutral-600">
              Área cliente (`role=client`) para consultar dominios asignados.
            </p>
            <Link
              href="/extranet"
              className="mt-4 inline-block rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800"
            >
              Abrir extranet
            </Link>
          </section>
        </div>
      </div>
    </main>
  );
}
