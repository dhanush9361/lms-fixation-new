import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { finalize, map, startWith } from 'rxjs';

import { InvoiceSetupService } from '../../../services/invoice-setup.service';
import {
  DEFAULT_INVOICE_SETTING,
  INVOICE_TEXT_GROUPS,
  INVOICE_TEXT_KEYS,
  InvoiceSetting,
} from '../invoice-setup.model';

type TabId = 'setup' | 'appearance';
type ModalMode = 'invoice' | 'creditNote' | 'thankYou' | 'tax';
type NumberField = 'nextInvoiceNumber' | 'nextCreditNoteNumber';
type SanitizedField = 'invoicePrefix' | 'creditNotePrefix' | 'vatNumber';
type SwitchField = 'builtInEnabled' | 'invoiceForFullDiscount' | 'pricesIncludeTax';

/** Same limits as InvoiceSettingDto on the backend. */
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const MAX_NUMBER_DIGITS = 10;
const MODAL_FADE_MS = 300;
const TOAST_MS = 2200;
/** Tax rate: 0 - 100 with at most 2 decimals (same as the backend). */
const TAX_RATE_PATTERN = /^\d{1,3}(\.\d{0,2})?$/;
const MAX_TAX_RATE = 100;
const ALLOWED_LOGO_TYPES = ['image/jpeg', 'image/png'];

/** What each input may contain - anything else is removed while typing (same rules as the backend patterns). */
const ALLOWED_CHARS: Record<SanitizedField, RegExp> = {
  invoicePrefix: /[^A-Za-z0-9_\-/]/g,
  creditNotePrefix: /[^A-Za-z0-9_\-/]/g,
  vatNumber: /[^A-Za-z0-9 \-]/g,
};

/** Only a short plain backend message is shown (Angular escapes it, so it is XSS-safe). */
const toMessage = (error: unknown, fallback: string): string => {
  const e = error as HttpErrorResponse;
  if (e?.status === 0 || e?.status >= 500) return fallback;
  const message: unknown = e?.error?.message;
  return typeof message === 'string' && message.trim() && message.length <= 200
    ? message.trim()
    : fallback;
};

/**
 * Profile > Settings > Invoice Setup (company admin only).
 * "Set Up" tab = numbering / VAT / switches, "Appearance" tab = logo, messages and label overrides.
 * Save sends the whole setup to PUT /api/invoice-settings; Cancel goes back to the last saved setup.
 */
@Component({
  selector: 'app-invoice-setup',
  imports: [ReactiveFormsModule],
  templateUrl: './invoice-setup.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    '(document:click)': 'previewMenuOpen.set(false)',
    '(document:keydown.escape)': 'onEscape()',
  },
})
export class InvoiceSetup {
  private readonly api = inject(InvoiceSetupService);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly destroyRef = inject(DestroyRef);

  readonly textGroups = INVOICE_TEXT_GROUPS;

  // ---------- page state ----------
  readonly mounted = signal(false);
  readonly loading = signal(true);
  readonly loadError = signal('');
  readonly saving = signal(false);
  readonly activeTab = signal<TabId>('setup');
  readonly openGroups = signal<readonly string[]>([]);
  readonly toast = signal('');

  // ---------- logo (kept outside the form: it is a file, not a typed value) ----------
  readonly logoUrl = signal<string | null>(null);
  readonly logoName = signal('');
  readonly logoError = signal('');

  // ---------- preview dropdown + modal ----------
  readonly previewMenuOpen = signal(false);
  readonly modalOpen = signal(false);
  readonly modalVisible = signal(false);
  readonly modalMode = signal<ModalMode>('invoice');
  private readonly previewModal = viewChild<ElementRef<HTMLElement>>('previewModal');
  private readonly closeButton = viewChild<ElementRef<HTMLButtonElement>>('closeButton');
  private opener: HTMLElement | null = null;

  /** The last saved setup - Cancel returns to it. */
  private saved: InvoiceSetting = { ...DEFAULT_INVOICE_SETTING, texts: {} };
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private modalTimer: ReturnType<typeof setTimeout> | undefined;

  readonly form = this.fb.group({
    builtInEnabled: false,
    invoicePrefix: ['', [Validators.maxLength(20)]],
    nextInvoiceNumber: ['', [Validators.pattern(/^\d{0,10}$/)]],
    creditNotePrefix: ['', [Validators.maxLength(20)]],
    nextCreditNoteNumber: ['', [Validators.pattern(/^\d{0,10}$/)]],
    vatNumber: ['', [Validators.maxLength(20)]],
    taxRate: ['', [Validators.pattern(TAX_RATE_PATTERN)]],
    pricesIncludeTax: false,
    invoiceForFullDiscount: false,
    showLogo: false,
    thankYouMessage: ['', [Validators.maxLength(500)]],
    taxMessage: ['', [Validators.maxLength(500)]],
    texts: this.buildTextsGroup(),
  });

  /** Live copy of the form, so the template and the preview react to every keystroke. */
  readonly value = toSignal(
    this.form.valueChanges.pipe(
      startWith(null),
      map(() => this.form.getRawValue()),
    ),
    { requireSync: true },
  );

  readonly modalTitle = computed(() => {
    switch (this.modalMode()) {
      case 'creditNote':
        return 'Credit note preview';
      case 'thankYou':
        return 'Thank you message preview';
      case 'tax':
        return 'Tax message preview';
      default:
        return 'Invoice preview';
    }
  });

  readonly modalDescription = computed(() => {
    switch (this.modalMode()) {
      case 'creditNote':
        return 'Check how your credit note will look when you refund or adjust a customer payment.';
      case 'thankYou':
        return 'Check how your thank you message will appear on the invoice.';
      case 'tax':
        return 'Check how your tax message will appear on the invoice.';
      default:
        return 'Check how your invoice will look to customers before you save the changes.';
    }
  });

  readonly previewNumber = computed(() => {
    const v = this.value();
    const credit = this.modalMode() === 'creditNote';
    const prefix = credit ? v.creditNotePrefix : v.invoicePrefix;
    const next = credit ? v.nextCreditNoteNumber : v.nextInvoiceNumber;
    return `${prefix}${(next || '1').padStart(5, '0')}`;
  });

  /** The sample purchase (price 100.00) with the admin's tax - same maths as TaxCalculator on the backend. */
  readonly sample = computed(() => {
    const v = this.value();
    const price = 100;
    const rate = Math.min(Math.max(Number(v.taxRate) || 0, 0), MAX_TAX_RATE);
    const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    const inclusive = v.pricesIncludeTax;
    const tax = inclusive ? round((price * rate) / (100 + rate)) : round((price * rate) / 100);
    const subtotal = inclusive ? round(price - tax) : price;
    const total = inclusive ? price : round(price + tax);
    const fmt = (n: number) => n.toFixed(2);
    return { rate, inclusive, subtotal: fmt(subtotal), tax: fmt(tax), total: fmt(total) };
  });

  /** If a message is empty, nothing is shown for it in the preview. */
  readonly showThankYou = computed(
    () => !!this.value().thankYouMessage.trim() && this.modalMode() !== 'tax',
  );
  readonly showTaxMessage = computed(
    () => !!this.value().taxMessage.trim() && this.modalMode() !== 'thankYou',
  );

  constructor() {
    this.load();
    this.later(() => this.mounted.set(true), 30);

    // The preview opens in the browser's top layer, so the whole page behind it is blurred.
    effect(() => {
      const el = this.previewModal()?.nativeElement;
      if (el && !el.matches(':popover-open')) {
        el.showPopover();
        this.closeButton()?.nativeElement.focus();
      }
    });

    this.destroyRef.onDestroy(() => {
      clearTimeout(this.toastTimer);
      clearTimeout(this.modalTimer);
    });
  }

  // ---------- load / save / cancel ----------
  load(): void {
    this.loading.set(true);
    this.loadError.set('');
    this.api
      .load()
      .pipe(
        finalize(() => this.loading.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (setting) => this.apply(setting),
        error: (err) => this.loadError.set(toMessage(err, 'Could not load the invoice setup. Please try again.')),
      });
  }

  save(): void {
    if (this.saving()) return;
    const problem = this.validate();
    if (problem) {
      this.showToast(problem);
      return;
    }
    this.saving.set(true);
    this.api
      .save(this.toSetting())
      .pipe(
        finalize(() => this.saving.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (setting) => {
          this.apply(setting);
          this.showToast('Invoice settings saved');
        },
        error: (err) => this.showToast(toMessage(err, 'Could not save the invoice setup. Please try again.')),
      });
  }

  cancel(): void {
    this.apply(this.saved);
    this.showToast('Changes discarded');
  }

  // ---------- tabs / accordion / switches ----------
  setTab(tab: TabId): void {
    this.activeTab.set(tab);
    this.previewMenuOpen.set(false);
  }

  toggleGroup(id: string): void {
    this.openGroups.update((open) => (open.includes(id) ? open.filter((g) => g !== id) : [...open, id]));
  }

  isGroupOpen(id: string): boolean {
    return this.openGroups().includes(id);
  }

  toggleSwitch(name: SwitchField): void {
    const control = this.form.controls[name];
    control.setValue(!control.value);
  }

  setShowLogo(show: boolean): void {
    this.form.controls.showLogo.setValue(show);
    this.logoError.set('');
  }

  // ---------- inputs ----------
  /** Keeps only the digits (max 10) in a "next number" field. */
  onDigits(name: NumberField, ev: Event): void {
    const el = ev.target as HTMLInputElement;
    const digits = el.value.replace(/\D/g, '').slice(0, MAX_NUMBER_DIGITS);
    el.value = digits;
    this.form.controls[name].setValue(digits);
  }

  /** Removes characters a prefix / VAT number may not contain. */
  onSanitized(name: SanitizedField, ev: Event): void {
    const el = ev.target as HTMLInputElement;
    const clean = el.value.replace(ALLOWED_CHARS[name], '');
    el.value = clean;
    this.form.controls[name].setValue(clean);
  }

  /** Tax rate: digits and one dot, at most 3 digits before and 2 after the dot, never above 100. */
  onTaxRate(ev: Event): void {
    const el = ev.target as HTMLInputElement;
    let clean = el.value.replace(/[^\d.]/g, '');
    const dot = clean.indexOf('.');
    if (dot !== -1) clean = clean.slice(0, dot + 1) + clean.slice(dot + 1).replace(/\./g, '');
    const [whole, fraction] = clean.split('.');
    clean = fraction === undefined ? whole.slice(0, 3) : `${whole.slice(0, 3)}.${fraction.slice(0, 2)}`;
    if (Number(clean) > MAX_TAX_RATE) clean = String(MAX_TAX_RATE);
    el.value = clean;
    this.form.controls.taxRate.setValue(clean);
  }

  /** The label shown in the preview: the admin's own text, or the default label. */
  text(key: string): string {
    const custom = (this.value().texts[key] ?? '').trim();
    if (custom) return custom;
    for (const group of this.textGroups) {
      const item = group.items.find((i) => i.key === key);
      if (item) return item.label;
    }
    return '';
  }

  // ---------- logo upload (JPG / JPEG / PNG, max 2 MB) ----------
  onLogoSelected(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    if (!ALLOWED_LOGO_TYPES.includes(file.type)) {
      this.logoError.set('Only JPG, JPEG or PNG files are allowed.');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      this.logoError.set('Logo size must be 2 MB or less.');
      return;
    }

    this.logoError.set('');
    const reader = new FileReader();
    reader.onload = () => {
      this.logoUrl.set(reader.result as string);
      this.logoName.set(file.name);
    };
    reader.onerror = () => this.logoError.set('Could not read this file. Please try another image.');
    reader.readAsDataURL(file);
  }

  removeLogo(): void {
    this.logoUrl.set(null);
    this.logoName.set('');
  }

  // ---------- preview dropdown + modal ----------
  togglePreviewMenu(): void {
    this.previewMenuOpen.update((open) => !open);
  }

  onEscape(): void {
    if (this.modalOpen()) this.closeModal();
    this.previewMenuOpen.set(false);
  }

  openModal(mode: ModalMode): void {
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.previewMenuOpen.set(false);
    this.modalMode.set(mode);
    this.modalOpen.set(true);
    this.later(() => this.modalVisible.set(true), 20);
  }

  closeModal(): void {
    this.modalVisible.set(false);
    clearTimeout(this.modalTimer);
    this.modalTimer = setTimeout(() => {
      this.modalOpen.set(false);
      this.opener?.focus();
      this.opener = null;
    }, MODAL_FADE_MS);
  }

  // ---------- helpers ----------
  private buildTextsGroup(): FormGroup<Record<string, FormControl<string>>> {
    const controls: Record<string, FormControl<string>> = {};
    for (const key of INVOICE_TEXT_KEYS) {
      controls[key] = new FormControl('', { nonNullable: true, validators: [Validators.maxLength(100)] });
    }
    return new FormGroup(controls);
  }

  /** Puts a setup (from the server, or the last saved one) on the screen. */
  private apply(setting: InvoiceSetting): void {
    this.saved = { ...setting, texts: { ...setting.texts } };
    const texts: Record<string, string> = {};
    for (const key of INVOICE_TEXT_KEYS) texts[key] = setting.texts[key] ?? '';

    this.form.reset({
      builtInEnabled: setting.builtInEnabled,
      invoicePrefix: setting.invoicePrefix,
      nextInvoiceNumber: setting.nextInvoiceNumber?.toString() ?? '',
      creditNotePrefix: setting.creditNotePrefix,
      nextCreditNoteNumber: setting.nextCreditNoteNumber?.toString() ?? '',
      vatNumber: setting.vatNumber,
      taxRate: setting.taxRate?.toString() ?? '',
      pricesIncludeTax: setting.pricesIncludeTax,
      invoiceForFullDiscount: setting.invoiceForFullDiscount,
      showLogo: setting.showLogo,
      thankYouMessage: setting.thankYouMessage,
      taxMessage: setting.taxMessage,
      texts,
    });
    this.logoUrl.set(setting.logo);
    this.logoName.set(setting.logoName ?? '');
    this.logoError.set('');
  }

  private toSetting(): InvoiceSetting {
    const v = this.form.getRawValue();
    const texts: Record<string, string> = {};
    for (const [key, text] of Object.entries(v.texts)) {
      if (text.trim()) texts[key] = text.trim();
    }
    const showLogo = v.showLogo && !!this.logoUrl();
    return {
      builtInEnabled: v.builtInEnabled,
      invoicePrefix: v.invoicePrefix.trim(),
      nextInvoiceNumber: v.nextInvoiceNumber ? Number(v.nextInvoiceNumber) : null,
      creditNotePrefix: v.creditNotePrefix.trim(),
      nextCreditNoteNumber: v.nextCreditNoteNumber ? Number(v.nextCreditNoteNumber) : null,
      vatNumber: v.vatNumber.trim(),
      taxRate: v.taxRate ? Number(v.taxRate) : null,
      pricesIncludeTax: v.pricesIncludeTax,
      invoiceForFullDiscount: v.invoiceForFullDiscount,
      showLogo,
      logo: showLogo ? this.logoUrl() : null,
      logoName: showLogo ? this.logoName() : null,
      thankYouMessage: v.thankYouMessage.trim(),
      taxMessage: v.taxMessage.trim(),
      texts,
    };
  }

  /** The same rules the backend checks - gives the admin the message before the request is sent. */
  private validate(): string {
    if (this.form.invalid) return 'Please fix the highlighted fields before saving.';
    const v = this.form.getRawValue();
    if (v.showLogo && !this.logoUrl()) return 'Upload a logo, or choose "Do not show a logo".';
    const invoicePrefix = v.invoicePrefix.trim().toLowerCase();
    if (invoicePrefix && invoicePrefix === v.creditNotePrefix.trim().toLowerCase()) {
      return 'Invoice prefix and credit note prefix must be different.';
    }
    if (v.taxRate && (Number.isNaN(Number(v.taxRate)) || Number(v.taxRate) > MAX_TAX_RATE)) {
      return 'Tax rate must be between 0 and 100.';
    }
    if (v.nextInvoiceNumber && Number(v.nextInvoiceNumber) < 1) return 'Next invoice number must be 1 or more.';
    if (v.nextCreditNoteNumber && Number(v.nextCreditNoteNumber) < 1) {
      return 'Next credit note number must be 1 or more.';
    }
    return '';
  }

  private showToast(message: string): void {
    clearTimeout(this.toastTimer);
    this.toast.set(message);
    this.toastTimer = setTimeout(() => this.toast.set(''), TOAST_MS);
  }

  /** Runs a function after a delay (cleared when the page is destroyed). */
  private later(fn: () => void, ms: number): void {
    const id = setTimeout(fn, ms);
    this.destroyRef.onDestroy(() => clearTimeout(id));
  }
}