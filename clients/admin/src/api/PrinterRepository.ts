import type { CreatePrinterPayload, Printer, UpdatePrinterPayload } from '../types';

// Data-access boundary for printers (0031). Reads are open to every member — a
// till that cannot read the address cannot print — while writes are admin-only,
// enforced by the API and the RESTRICTIVE policies behind it.
export interface PrinterRepository {
  list(): Promise<Printer[]>;
  create(payload: CreatePrinterPayload): Promise<Printer>;
  update(id: string, payload: UpdatePrinterPayload): Promise<Printer>;
  /** Removes a mistyped entry outright. Retiring a used one is update({ is_active: false }). */
  remove(id: string): Promise<void>;
}
