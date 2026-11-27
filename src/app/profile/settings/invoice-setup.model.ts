/** GET / PUT /api/invoice-settings - field names match InvoiceSettingDto on the backend. */
export interface InvoiceSetting {
  builtInEnabled: boolean;
  invoicePrefix: string;
  /** null = not set yet (the backend starts from 1). */
  nextInvoiceNumber: number | null;
  creditNotePrefix: string;
  nextCreditNoteNumber: number | null;
  vatNumber: string;
  /** Tax in percent (0 - 100); null = no tax. */
  taxRate: number | null;
  /** true = the course price already contains the tax; false = tax is added on top. */
  pricesIncludeTax: boolean;
  invoiceForFullDiscount: boolean;
  showLogo: boolean;
  /** JPG / PNG as a data URL, or null. */
  logo: string | null;
  logoName: string | null;
  thankYouMessage: string;
  taxMessage: string;
  /** Label overrides keyed by InvoiceTextItem.key; only the changed ones. */
  texts: Record<string, string>;
}

export const DEFAULT_INVOICE_SETTING: InvoiceSetting = {
  builtInEnabled: false,
  invoicePrefix: '',
  nextInvoiceNumber: null,
  creditNotePrefix: '',
  nextCreditNoteNumber: null,
  vatNumber: '',
  taxRate: null,
  pricesIncludeTax: false,
  invoiceForFullDiscount: false,
  showLogo: false,
  logo: null,
  logoName: null,
  thankYouMessage: '',
  taxMessage: '',
  texts: {},
};

export interface InvoiceTextItem {
  readonly key: string;
  readonly label: string;
}

export interface InvoiceTextGroup {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly items: readonly InvoiceTextItem[];
}

/** The keys must match KNOWN_TEXT_KEYS in InvoiceSettingService (backend). */
export const INVOICE_TEXT_GROUPS: readonly InvoiceTextGroup[] = [
  {
    id: 'invoice',
    title: 'Invoice texts',
    description: 'Customise the details that appear on your invoices',
    items: [
      { key: 'invoiceNumber', label: 'Invoice Number' },
      { key: 'invoice', label: 'Invoice' },
      { key: 'invoiceDate', label: 'Invoice Date' },
      { key: 'customerDetails', label: 'Customer Details' },
      { key: 'description', label: 'Description' },
      { key: 'unitPrice', label: 'Unit Price' },
      { key: 'quantity', label: 'Quantity' },
      { key: 'subtotal', label: 'Subtotal' },
      { key: 'price', label: 'Price' },
      { key: 'discount', label: 'Discount' },
      { key: 'totalAmount', label: 'Total Amount' },
      { key: 'website', label: 'Website' },
      { key: 'email', label: 'Email' },
    ],
  },
  {
    id: 'tax',
    title: 'Tax, Credit Note & Refund Details',
    description: 'Configure tax, credit note, and refund settings for your invoices',
    items: [
      { key: 'pricesIncludeTax', label: 'Prices Include Tax' },
      { key: 'tax', label: 'Tax' },
      { key: 'taxIncluded', label: 'Tax Included' },
      { key: 'refundReason', label: 'Refund Reason' },
      { key: 'refundMethod', label: 'Refund Method' },
      { key: 'invoiceReference', label: 'Invoice Reference' },
      { key: 'refundedAmount', label: 'Refunded Amount' },
    ],
  },
  {
    id: 'status',
    title: 'Invoice Status & Records',
    description: 'Track invoice statuses and maintain your invoice records',
    items: [
      { key: 'paid', label: 'Paid' },
      { key: 'refunded', label: 'Refunded' },
      { key: 'pending', label: 'Pending' },
      { key: 'completed', label: 'Completed' },
    ],
  },
];

export const INVOICE_TEXT_KEYS: readonly string[] = INVOICE_TEXT_GROUPS.flatMap((g) =>
  g.items.map((i) => i.key),
);