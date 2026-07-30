import { apiClient } from './client';

/** The restaurant's identity: what shows in the app and prints on a receipt. */
export interface Branding {
  logo_url: string | null;
  display_name: string | null;
  updated_at: string | null;
}

export const brandingRepository = {
  async get(): Promise<Branding> {
    const { data } = await apiClient.get<Branding>('/api/branding');
    return data;
  },

  async setDisplayName(display_name: string | null): Promise<Branding> {
    const { data } = await apiClient.put<Branding>('/api/branding', { display_name });
    return data;
  },

  /**
   * Sends the image to OUR server, not to Supabase.
   *
   * A browser could upload to Supabase Storage directly, but a storage policy
   * cannot see this project's roles — they live in our own database — so it
   * could only have allowed "any signed-in user", which includes every cashier.
   * The rule is enforced where the roles are.
   */
  async uploadLogo(file: File): Promise<Branding> {
    const form = new FormData();
    form.append('logo', file);
    const { data } = await apiClient.post<Branding>('/api/branding/logo', form);
    return data;
  },

  async clearLogo(): Promise<Branding> {
    const { data } = await apiClient.put<Branding>('/api/branding', { logo_url: null });
    return data;
  },
};
