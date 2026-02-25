"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { getFirebaseAuth, getFirebaseDb } from "@/lib/firebase/client";
import type { AppUser, UserRole } from "@/lib/types";

interface AuthContextValue {
  user: User | null;
  profile: AppUser | null;
  loading: boolean;
  role: UserRole | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let unsubscribe = () => {};

    try {
      const auth = getFirebaseAuth();
      const db = getFirebaseDb();

      unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
        setUser(currentUser);

        if (!currentUser) {
          setProfile(null);
          setLoading(false);
          return;
        }

        try {
          const userDoc = await getDoc(doc(db, "users", currentUser.uid));
          if (userDoc.exists()) {
            setProfile(userDoc.data() as AppUser);
          } else {
            setProfile({
              uid: currentUser.uid,
              email: currentUser.email ?? "",
              role: "client",
            });
          }
        } catch {
          setProfile({
            uid: currentUser.uid,
            email: currentUser.email ?? "",
            role: "client",
          });
        } finally {
          setLoading(false);
        }
      });
    } catch {
      setUser(null);
      setProfile(null);
      setLoading(false);
    }

    return () => unsubscribe();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      profile,
      loading,
      role: profile?.role ?? null,
      login: async (email: string, password: string) => {
        const auth = getFirebaseAuth();
        await signInWithEmailAndPassword(auth, email, password);
      },
      logout: async () => {
        const auth = getFirebaseAuth();
        await signOut(auth);
      },
    }),
    [user, profile, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider");
  }
  return context;
}
