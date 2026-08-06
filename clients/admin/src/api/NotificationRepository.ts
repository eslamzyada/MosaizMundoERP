import { apiClient } from './client';

/**
 * Your own inbox (0036).
 *
 * There is no `send`, and there never will be from here: the application role
 * holds no INSERT on the table. Notifications are written by the database at
 * the moment an event happens, to recipients chosen by ROLE. This repository
 * can only read yours and mark it read.
 */

export interface Notification {
  id: string;
  kind: string;
  subject: string;
  body: string | null;
  /** A relative path inside the admin — never an absolute URL. */
  link: string | null;
  actor_id: string | null;
  read_at: string | null;
  created_at: string;
}

export interface Inbox {
  unread: number;
  notifications: Notification[];
}

export const notificationRepository = {
  async list(): Promise<Inbox> {
    const { data } = await apiClient.get<Inbox>('/api/notifications');
    return data;
  },

  /** Somebody else's id, or one already read, answers 404. */
  async markRead(id: string): Promise<void> {
    await apiClient.post(`/api/notifications/${id}/read`);
  },

  async markAllRead(): Promise<void> {
    await apiClient.post('/api/notifications/read-all');
  },
};
