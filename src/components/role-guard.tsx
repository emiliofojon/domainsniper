"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/auth-context";
import type { UserRole } from "@/lib/types";

export function RoleGuard({
  allow,
  children,
}: {
  allow: UserRole[];
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { user, role, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    if (!role || !allow.includes(role)) {
      router.replace("/");
    }
  }, [allow, loading, role, router, user]);

  if (loading || !user || !role || !allow.includes(role)) {
    return (
      <main className="min-h-screen bg-neutral-100 p-8">
        <p className="text-sm text-neutral-700">Comprobando permisos...</p>
      </main>
    );
  }

  return <>{children}</>;
}

