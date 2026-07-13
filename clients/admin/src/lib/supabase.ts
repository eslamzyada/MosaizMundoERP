import { createClient } from '@supabase/supabase-js';

// The URL and anon (publishable) key are safe to ship in the client bundle —
// they only work in concert with the backend's JWT verification and the
// database's Row Level Security. Provide them via clients/admin/.env.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
