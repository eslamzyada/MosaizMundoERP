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
