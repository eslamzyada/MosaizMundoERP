import axios from 'axios';

// Base URL comes from the build-time env, defaulting to the local backend.
const baseURL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export const apiClient = axios.create({ baseURL });

// Attach the Supabase bearer token (if present) to every request. The token is
// stashed in localStorage under 'mosaiz_token'; the backend verifies it and
// binds the RLS identity for the request.
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('mosaiz_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});
