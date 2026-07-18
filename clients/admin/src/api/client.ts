import axios from 'axios';
import { supabase } from '../lib/supabase';

// Base URL comes from the build-time env, defaulting to the local backend.
const baseURL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export const apiClient = axios.create({ baseURL });

// Attach the current Supabase access token to every request. supabase-js keeps
// the session fresh (refreshing as needed), so reading it per-request always
// yields a valid bearer token; the backend verifies it and binds the RLS
// identity for the request.
apiClient.interceptors.request.use(async (config) => {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// If the backend rejects the token as unauthenticated (401 — expired or
// revoked, distinct from a 403 role denial), end the local session so the app
// returns to sign-in instead of silently failing every subsequent request
// (analysis F-13). signOut() fires onAuthStateChange, which swaps the app back
// to the Login screen. The original error still propagates so the caller's own
// error handling runs.
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      await supabase.auth.signOut();
    }
    return Promise.reject(error);
  },
);
