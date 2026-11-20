import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, ValidatorFn, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { finalize } from 'rxjs';
import {
  MyBilling,
  MySubscription,
  PackageRecord,
  PackageService,
  UpdateMyBillingPayload,
} from '../../services/package.service';
import { CheckoutCurrency, CheckoutService, CURRENCY_RATES } from '../../services/checkout.service';

/** Adjust to match app.routes.ts. */
const ADMIN_HOME_PATH = '/admin-dashboard';
const PAYMENT_PATH = '/admin-dashboard/subscription/payment';


const serverActionErrorMessage =
  'Unable to complete the requested action due to a server error. Please try again later.';
const isServerError = (status?: number): boolean => status === 0 || (status ?? 0) >= 500;

type BillingPeriod = 'Monthly' | 'Yearly';
type DetailsTab = 'subscription' | 'billing';

/** Same rule as the server's @NotBlank: spaces only do not count as a value. */
const notBlank: ValidatorFn = (control) =>
  String(control.value ?? '').trim() ? null : { required: true };

/** Same countries as the Payment page (the saved billing country is the readable name, e.g. "India"). */
const BILLING_COUNTRIES = [
  'India',
  'United States',
  'United Kingdom',
  'Germany',
  'France',
  'United Arab Emirates',
  'Singapore',
  'Australia',
  'Canada',
] as const;

/** Billing Details tab, edit mode: one row per field (same limits as PackageDto.UpdateBillingRequest). */
const BILLING_FIELDS = [
  { name: 'billingName', label: 'Billing Name', type: 'text', maxlength: 200, autocomplete: 'name', required: true },
  { name: 'companyName', label: 'Company Name', type: 'text', maxlength: 200, autocomplete: 'organization', required: false },
  { name: 'address', label: 'Billing Address', type: 'text', maxlength: 200, autocomplete: 'street-address', required: true },
  { name: 'city', label: 'City', type: 'text', maxlength: 100, autocomplete: 'address-level2', required: true },
  { name: 'state', label: 'State', type: 'text', maxlength: 100, autocomplete: 'address-level1', required: false },
  { name: 'postalCode', label: 'Postal Code', type: 'text', maxlength: 100, autocomplete: 'postal-code', required: true },
  { name: 'country', label: 'Country', type: 'select', maxlength: 100, autocomplete: 'country-name', required: true },
  { name: 'email', label: 'Billing Email', type: 'email', maxlength: 100, autocomplete: 'email', required: true },
  { name: 'vatNumber', label: 'VAT Number', type: 'text', maxlength: 50, autocomplete: 'off', required: false },
] as const;

const BILLING_ERROR_MESSAGES: Record<string, Record<string, string>> = {
  billingName: { required: 'Billing name is required.', maxlength: 'Billing name is too long.' },
  companyName: { maxlength: 'Company name is too long.' },
  address: { required: 'Billing address is required.', maxlength: 'Billing address is too long.' },
  city: { required: 'City is required.', maxlength: 'City is too long.' },
  state: { maxlength: 'State is too long.' },
  postalCode: { required: 'Postal code is required.', maxlength: 'Postal code is too long.' },
  country: { required: 'Please select a country.', maxlength: 'Country is too long.' },
  email: {
    required: 'Billing email is required.',
    email: 'Enter a valid email address.',
    maxlength: 'Enter a valid email address.',
  },
  vatNumber: { maxlength: 'VAT number is too long.' },
};



/**
 * Subscription & Billing page (company admin).
 * Shows ONLY packages the Super Admin published: Active + "Price" + "Show on website".
 * The backend already filters for ADMIN users; the filter here is a second safety net.
 *
 * "Manage Details" popup shows the admin's CURRENT plan (name, start date, due date)
 * and the billing details they entered when they subscribed.
 */
@Component({
  selector: 'app-subscription',
  imports: [CurrencyPipe, ReactiveFormsModule],
  templateUrl: './subscription.html',
  styleUrl: './subscription.css',
})
export class Subscription implements OnInit {
  private readonly packagesApi = inject(PackageService);
  private readonly checkout = inject(CheckoutService);
  private readonly router = inject(Router);

  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly actionMessage = signal('');

  protected readonly packages = signal<PackageRecord[]>([]);
  protected readonly billingCycle = signal<BillingPeriod>('Monthly');
  protected readonly currency = this.checkout.currency;

  // Details popup
  protected readonly detailsOpen = signal(false);
  protected readonly detailsTab = signal<DetailsTab>('subscription');
  protected readonly selectedPackage = signal<PackageRecord | null>(null);

  // Manage Details data: the admin's current subscription + saved billing details
  protected readonly mySubscription = signal<MySubscription | null>(null);
  protected readonly myBilling = signal<MyBilling | null>(null);

  // Billing Details tab: view mode <-> edit mode
  protected readonly billingEditing = signal(false);
  protected readonly billingSaving = signal(false);
  protected readonly billingSaveError = signal('');
  protected readonly billingSavedMessage = signal('');
  protected readonly billingFields = BILLING_FIELDS;

  protected readonly billingForm = new FormGroup({
    billingName: new FormControl('', { nonNullable: true, validators: [notBlank, Validators.maxLength(200)] }),
    companyName: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(200)] }),
    address: new FormControl('', { nonNullable: true, validators: [notBlank, Validators.maxLength(200)] }),
    city: new FormControl('', { nonNullable: true, validators: [notBlank, Validators.maxLength(100)] }),
    state: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(100)] }),
    postalCode: new FormControl('', { nonNullable: true, validators: [notBlank, Validators.maxLength(100)] }),
    country: new FormControl('', { nonNullable: true, validators: [notBlank, Validators.maxLength(100)] }),
    email: new FormControl('', {
      nonNullable: true,
      validators: [notBlank, Validators.email, Validators.maxLength(100)],
    }),
    vatNumber: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(50)] }),
  });

  /** One-line billing address: "street, city, state, postal code, country". */
  protected readonly billingAddress = computed(() => {
    const b = this.myBilling();
    if (!b?.address) return '';
    return [b.address, b.city, b.state, b.postalCode, b.country].filter((part) => !!part).join(', ');
  });

  /** Plans shown on the page: published, Active, paid, and matching the Monthly / Yearly toggle. */
  protected readonly visiblePackages = computed(() =>
    this.packages()
      .filter((p) => p.showOnWebsite && p.status === 'Active' && p.availablePackage === 'Price')
      .filter((p) => p.billingCycle === this.billingCycle())
      .sort((a, b) => a.price - b.price));

  /** The plan with the most features gets the "Popular Plan" badge (only when there is a choice). */
  private readonly popularId = computed(() => {
    const plans = this.visiblePackages();
    if (plans.length < 2) return null;
    return plans.reduce((best, p) => (this.featureCount(p) > this.featureCount(best) ? p : best)).id;
  });

  ngOnInit(): void {
    this.load();
    this.loadAccountDetails();
    this.flashIfReturningFromPayment();
  }

  protected load(): void {
    this.loading.set(true);
    this.loadError.set('');
    this.packagesApi
      .list({ size: 100 })
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (result) => this.packages.set(result.content),
        error: (error) =>
          this.loadError.set(
            error?.status === 403
              ? 'You do not have permission to view this page.'
              : isServerError(error?.status)
                ? serverActionErrorMessage
                : 'Plans could not be loaded. Please try again.',
          ),
      });
  }

  /**
   * Current plan dates + saved billing details for the Manage Details popup.
   * A failure just leaves the popup on "Not available"; it must not break the plans page.
   */
  private loadAccountDetails(): void {
    this.packagesApi.getMySubscription().subscribe({
      next: (value) => this.mySubscription.set(value),
      error: () => this.mySubscription.set(null),
    });
    this.packagesApi.getMyBilling().subscribe({
      next: (value) => this.myBilling.set(value),
      error: () => this.myBilling.set(null),
    });
  }

  // ---- Toggles -----------------------------------------------------------

  protected setBillingCycle(cycle: BillingPeriod): void {
    this.billingCycle.set(cycle);
  }

  protected setCurrency(value: string): void {
    if (value in CURRENCY_RATES) {
      this.currency.set(value as CheckoutCurrency);
    }
  }

  protected convertedPrice(price: number): number {
    return this.checkout.convert(price);
  }

  // ---- Plan card helpers ---------------------------------------------------------

  protected isPopular(plan: PackageRecord): boolean {
    return this.popularId() === plan.id;
  }

  /** Bullet list on a plan card: limits + every feature that has at least one action enabled. */
  protected featuresFor(plan: PackageRecord): string[] {
    const list: string[] = [`${plan.userLimit} user${plan.userLimit === 1 ? '' : 's'}`, `${this.packageStorageLimit(plan)} storage`];
    for (const category of plan.permissions ?? []) {
      for (const feature of category.features ?? []) {
        if (Object.values(feature.permissions ?? {}).some(Boolean)) {
          list.push(feature.name);
        }
      }
    }
    return list;
  }

  private featureCount(plan: PackageRecord): number {
    return (plan.permissions ?? []).reduce(
      (total, c) => total + (c.features ?? []).filter((f) => Object.values(f.permissions ?? {}).some(Boolean)).length,
      0,
    );
  }

  protected packageStorageLimit(plan: PackageRecord): string {
    return plan.storageLimit == null ? 'Unlimited' : `${plan.storageLimit} GB`;
  }

  // ---- Manage Details formatting ----------------------------------------------------

  /** "06 Nov 2026", or "Not available" when there is no date. */
  protected formatDate(value: string | null | undefined): string {
    if (!value) return 'Not available';
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? 'Not available'
      : date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  /** True when the current plan's due date has passed (shown in red). */
  protected isPlanExpired(): boolean {
    const expiresAt = this.mySubscription()?.expiresAt;
    return !!expiresAt && new Date(expiresAt).getTime() <= Date.now();
  }

  // ---- Details popup -----------------------------------------------------------

  protected openPackageDetails(plan: PackageRecord): void {
    this.selectedPackage.set(plan);
    this.detailsTab.set('subscription');
    this.detailsOpen.set(true);
  }

  /** "Manage Details" button: current subscription / billing info (no plan selected). */
  protected openManageDetails(): void {
    this.selectedPackage.set(null);
    this.resetBillingEdit();
    this.detailsTab.set('subscription');
    this.detailsOpen.set(true);
    // Refresh every time, so a plan bought a moment ago always shows.
    this.loadAccountDetails();
  }

  protected openDetails(tab: DetailsTab): void {
    this.detailsTab.set(tab);
  }

  protected closeDetails(): void {
    this.detailsOpen.set(false);
    this.resetBillingEdit();
  }

  // ---- Billing Details: edit + save ----------------------------------------------------

  /** "Edit Billing Details": fills the form with what is saved and switches the tab to edit mode. */
  protected editBillingDetails(): void {
    const billing: Partial<MyBilling> = this.myBilling() ?? {};
    this.billingForm.reset({
      billingName: billing.billingName ?? '',
      companyName: billing.companyName ?? '',
      address: billing.address ?? '',
      city: billing.city ?? '',
      state: billing.state ?? '',
      postalCode: billing.postalCode ?? '',
      country: billing.country ?? '',
      email: billing.email ?? '',
      vatNumber: billing.vatNumber ?? '',
    });
    this.billingSaveError.set('');
    this.billingSavedMessage.set('');
    this.billingEditing.set(true);
  }

  protected cancelBillingEdit(): void {
    if (this.billingSaving()) return;
    this.resetBillingEdit();
  }

  /** Validates the form, sends it to the server and shows what the server stored. */
  protected saveBillingEdit(): void {
    if (this.billingSaving()) return;
    this.billingForm.markAllAsTouched();
    if (this.billingForm.invalid) return;

    const value = this.billingForm.getRawValue();
    const payload: UpdateMyBillingPayload = {
      billingName: value.billingName.trim(),
      companyName: value.companyName.trim(),
      address: value.address.trim(),
      city: value.city.trim(),
      state: value.state.trim(),
      postalCode: value.postalCode.trim(),
      country: value.country.trim(),
      email: value.email.trim(),
      vatNumber: value.vatNumber.trim(),
    };

    this.billingSaving.set(true);
    this.billingSaveError.set('');
    this.packagesApi
      .updateMyBilling(payload)
      .pipe(finalize(() => this.billingSaving.set(false)))
      .subscribe({
        next: (saved) => {
          this.myBilling.set(saved);
          this.billingEditing.set(false);
          this.billingSavedMessage.set('Billing details updated.');
        },
        error: (error) => {
          // The server answers { success:false, message } for validation errors.
          const body = error?.error as { message?: string; detail?: string } | string | undefined;
          const backendMessage = typeof body === 'string' ? body : (body?.message ?? body?.detail ?? '');
          this.billingSaveError.set(
            error?.status === 401 || error?.status === 403
              ? 'Your session cannot update billing details. Please log in again.'
              : isServerError(error?.status)
                ? serverActionErrorMessage
                : backendMessage || 'Billing details could not be saved. Please try again.',
          );
        },
      });
  }

  /** Error text of one billing field (only after the field was touched, or Save was pressed). */
  protected billingError(name: string): string {
    const control = this.billingForm.get(name);
    if (!control || !control.invalid || !(control.touched || control.dirty)) return '';
    const key = Object.keys(control.errors ?? {})[0] ?? '';
    return BILLING_ERROR_MESSAGES[name]?.[key] ?? 'This value is not valid.';
  }

  /** The Payment page countries; a saved country that is not in that list stays selectable. */
  protected countryChoices(): readonly string[] {
    const current = this.billingForm.controls.country.value.trim();
    return !current || (BILLING_COUNTRIES as readonly string[]).includes(current)
      ? BILLING_COUNTRIES
      : [current, ...BILLING_COUNTRIES];
  }

  private resetBillingEdit(): void {
    this.billingEditing.set(false);
    this.billingSaveError.set('');
    this.billingSavedMessage.set('');
  }

  // ---- Buy ---------------------------------------------------------------------

  /** "Buy Plan": only the plan ID is handed over; the Payment page re-loads it from the server. */
  protected selectPlan(plan: PackageRecord): void {
    this.checkout.start(plan.id);
    void this.router.navigate([PAYMENT_PATH]);
  }

  protected goBack(): void {
    void this.router.navigate([ADMIN_HOME_PATH]);
  }

  /** The Payment page navigates back with { state: { purchased: true } } after a successful purchase. */
  private flashIfReturningFromPayment(): void {
    const state = this.router.getCurrentNavigation()?.extras.state
      ?? (history.state as { purchased?: boolean; planName?: string } | undefined);
    if (state?.purchased) {
      this.actionMessage.set(
        state.planName ? `${state.planName} package purchased and assigned to your account.` : 'Package purchased successfully.',
      );
      history.replaceState({ ...history.state, purchased: undefined, planName: undefined }, '');
      setTimeout(() => this.actionMessage.set(''), 5000);
    }
  }
}