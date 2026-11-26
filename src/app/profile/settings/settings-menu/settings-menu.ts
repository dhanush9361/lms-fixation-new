import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { AuthService } from '../../../services/auth';
import { Subscription } from '../../../subscription-billing/subscription/subscription';
import { TwoFaVerification } from '../two-fa-verification/two-fa-verification';

interface SettingsTab {
  id: string;
  label: string;
  /** false = placeholder tab ("Coming Soon"), not selectable yet */
  enabled: boolean;
}

@Component({
  selector: 'app-settings-menu',
  imports: [TwoFaVerification, Subscription],
  templateUrl: './settings-menu.html',
  styleUrl: './settings-menu.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsMenu {
  private readonly auth = inject(AuthService);

  private readonly allTabs: SettingsTab[] = [
    { id: 'general', label: 'General Settings', enabled: true },
    { id: 'subscription', label: 'Subscription & Billing', enabled: true },
    { id: 'invoice', label: 'Invoice Setup', enabled: true },
  ];

  /** Subscription & Billing is for the company admin only (same rule the old sidebar menu used). */
  readonly tabs = computed(() =>
    this.allTabs.filter((tab) => tab.id !== 'subscription' || this.auth.isCompanyAdmin()),
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