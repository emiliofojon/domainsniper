import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

let initialized = false;

function validateConfig() {
  const hasFirebaseConfig = Object.values(firebaseConfig).every(Boolean);
  if (!hasFirebaseConfig) {
    throw new Error("Firebase env vars are missing. Check .env.local");
  }
}

function ensureClient() {
  if (typeof window === "undefined") {
    throw new Error("Firebase client is only available in the browser");
  }
}

function ensureInitialized() {
  ensureClient();
  validateConfig();
  if (!initialized) {
    if (getApps().length === 0) {
      initializeApp(firebaseConfig);
    }
    initialized = true;
  }
}

export function getFirebaseAuth() {
  ensureInitialized();
  return getAuth(getApp());
}

export function getFirebaseDb() {
  ensureInitialized();
  return getFirestore(getApp());
}
