import type {
  CreateSupplierPayload,
  Supplier,
  SupplierPriceRow,
  UpdateSupplierPayload,
} from '../types';

// Data-access boundary for suppliers. Reads are open to every member; writes
// are admin-only, enforced by the API and the 0020 policies behind it.
export interface SupplierRepository {
  list(): Promise<Supplier[]>;
  create(payload: CreateSupplierPayload): Promise<Supplier>;
  update(id: string, payload: UpdateSupplierPayload): Promise<Supplier>;
  /** What each supplier has charged for each ingredient, and whether it moved. */
  priceHistory(): Promise<SupplierPriceRow[]>;
}
