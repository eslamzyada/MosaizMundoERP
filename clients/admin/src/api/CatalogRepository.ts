import type {
  CatalogItem,
  CatalogItemBase,
  CreateItemPayload,
  UpdateItemPayload,
} from '../types';

// The data-access boundary for the Catalog (menu items) context.
export interface CatalogRepository {
  /** The organization's menu items, with price. Readable by any member. */
  getItems(): Promise<CatalogItem[]>;

  /** Creates a menu item and sets its price. Admin-only (server-enforced). */
  createItem(payload: CreateItemPayload): Promise<CatalogItemBase>;

  /** Renames / re-prices / re-SKUs a menu item. Admin-only. */
  updateItem(id: string, payload: UpdateItemPayload): Promise<CatalogItemBase>;
}
