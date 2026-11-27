import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { AuthService } from '../../../services/auth';
import { Subscription } from '../../../subscription-billing/subscription/subscription';
import { InvoiceSetup } from '../invoice-setup/invoice-setup';
import { TwoFaVerification } from '../two-fa-verification/two-fa-verification';

interface SettingsTab {
  id: string;
  label: string;
  /** false = placeholder tab ("Coming Soon"), not selectable yet */
  enabled: boolean;
  /** true = only the company admin sees this tab. */
  companyAdminOnly?: boolean;
}

@Component({
  selector: 'app-settings-menu',
  imports: [TwoFaVerification, Subscription, InvoiceSetup],
  templateUrl: './settings-menu.html',
  styleUrl: './settings-menu.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsMenu {
  private readonly auth = inject(AuthService);

  private readonly allTabs: SettingsTab[] = [
    { id: 'general', label: 'General Settings', enabled: true },
    { id: 'subscription', label: 'Subscription & Billing', enabled: true, companyAdminOnly: true },
    { id: 'invoice', label: 'Invoice Setup', enabled: true, companyAdminOnly: true },
  ];

  /** Subscription & Billing and Invoice Setup are for the company admin only (the API is ADMIN-only too). */
  readonly tabs = computed(() =>
    this.allTabs.filter((tab) => !tab.companyAdminOnly || this.auth.isCompanyAdmin()),
  );

  readonly activeTab = signal<string>('general');

  /** Position of the active tab - drives the sliding pill. */
  readonly activeIndex = computed(() =>
    Math.max(0, this.tabs().findIndex((tab) => tab.id === this.activeTab())),
  );

  selectTab(tab: SettingsTab): void {
    if (tab.enabled) this.activeTab.set(tab.id);
  }
}