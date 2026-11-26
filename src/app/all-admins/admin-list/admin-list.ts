import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AdminImportResult, AdminManagementService, ManagedAdmin } from '../../services/admin-management.service';
import { saveBlob } from '../../services/download';
import { UserStatus } from '../../services/user-management.service';
import { AdminImportModal } from '../pop-modals/admin-import-modal/admin-import-modal';

type RowAction = 'suspend' | 'active' | 'inactive' | 'delete';

/** Tallest state of the row menu (suspend dates + delete warning). */
const MENU_HEIGHT = 300;

@Component({
  selector: 'app-admin-list',
  imports: [ReactiveFormsModule, AdminImportModal],
  templateUrl: './admin-list.html',
  styleUrl: './admin-list.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'closeMenus()',
    '(document:keydown.escape)': 'closeMenus()',
  },
})
export class AdminList implements OnInit {
  private readonly api = inject(AdminManagementService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly admins = this.api.admins;
  protected readonly total = this.api.total;
  protected readonly loading = this.api.loading;

  protected readonly bulkOpen = signal(false);
  protected readonly importOpen = signal(false);
  protected readonly exporting = signal(false);

  /** Row checkboxes. Export as CSV takes only these when any are ticked. */
  protected readonly selected = signal<ReadonlySet<number>>(new Set());
  protected readonly menuAdminId = signal<number | null>(null);
  protected readonly menuUp = signal(false);
  protected readonly pendingAction = signal<RowAction | null>(null);
  protected readonly saving = signal(false);
  protected readonly toast = signal('');

  protected readonly dates = new FormGroup({
    start: new FormControl('', { nonNullable: true }),
    end: new FormControl('', { nonNullable: true }),
  });

  protected readonly allSelected = computed(
    () => this.admins().length > 0 && this.admins().every((a) => this.selected().has(a.id)),
  );
  protected readonly someSelected = computed(() => this.selected().size > 0 && !this.allSelected());

  protected readonly statusActions: readonly { id: RowAction; label: string }[] = [
    { id: 'active', label: 'Active' },
    { id: 'inactive', label: 'Inactive' },
    { id: 'delete', label: 'Delete Admin' },
  ];

  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.destroyRef.onDestroy(() => clearTimeout(this.toastTimer));
  }

  ngOnInit(): void {
    this.fetch(false);
  }

  protected loadMore(): void {
    this.fetch(true);
  }

  protected toggleBulk(event: Event): void {
    event.stopPropagation();
    this.closeMenu();
    this.bulkOpen.update((open) => !open);
  }

  protected openImport(): void {
    this.bulkOpen.set(false);
    this.importOpen.set(true);
  }

  protected onImported(result: AdminImportResult): void {
    this.notify(`${result.imported} admin(s) imported`);
  }

  protected exportCsv(): void {
    this.bulkOpen.set(false);
    if (this.exporting()) return;
    this.exporting.set(true);
    this.api
      .exportCsv([...this.selected()])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (blob) => {
          this.exporting.set(false);
          saveBlob(blob, 'admins.csv');
        },
        error: () => {
          this.exporting.set(false);
          this.notify('Unable to export the admins.');
        },
      });
  }

  protected closeMenus(): void {
    this.closeMenu();
    this.bulkOpen.set(false);
  }

  protected toggleAll(): void {
    this.selected.set(this.allSelected() ? new Set() : new Set(this.admins().map((a) => a.id)));
  }

  protected toggleOne(id: number): void {
    this.selected.update((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected toggleMenu(event: Event, admin: ManagedAdmin): void {
    event.stopPropagation();
    this.bulkOpen.set(false);
    if (this.menuAdminId() === admin.id) {
      this.closeMenu();
      return;
    }
    this.pendingAction.set(null);
    this.dates.reset({ start: admin.suspendFrom ?? '', end: admin.suspendTo ?? '' });
    this.menuUp.set(this.shouldOpenUp(event.currentTarget as HTMLElement));
    this.menuAdminId.set(admin.id);
  }

  protected closeMenu(): void {
    this.menuAdminId.set(null);
  }

  protected pick(action: RowAction): void {
    this.pendingAction.update((a) => (a === action ? null : action));
  }

  protected editProfile(admin: ManagedAdmin): void {
    this.closeMenu();
    void this.router.navigate(['/super-admin-dashboard', 'admins', admin.id, 'edit-profile']);
  }

  protected save(admin: ManagedAdmin): void {
    const action = this.pendingAction();
    if (!action || this.saving()) return;

    if (action === 'delete') {
      this.saving.set(true);
      this.api
        .remove(admin.id)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: () => {
            this.selected.update((s) => new Set([...s].filter((id) => id !== admin.id)));
            this.done(`${admin.username} was deleted`);
          },
          error: (e: HttpErrorResponse) => this.failed(e, 'Unable to delete the admin.'),
        });
      return;
    }

    const status: UserStatus =
      action === 'suspend' ? 'Suspended' : action === 'active' ? 'Active' : 'Inactive';
    const { start, end } = this.dates.getRawValue();
    if (status === 'Suspended') {
      if (!start || !end) return this.notify('Select the suspension start and end dates');
      if (end < start) return this.notify('End date cannot be before the start date');
    }

    this.saving.set(true);
    this.api
      .setStatus(admin.id, status, start, end)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        // A suspension that starts later leaves the admin "Active" until then.
        next: (row) =>
          this.done(
            status === 'Suspended' && row.status !== 'Suspended'
              ? `${admin.username} will be suspended from ${start} to ${end}`
              : `${admin.username} is now ${row.status.toLowerCase()}`,
          ),
        error: (e: HttpErrorResponse) => this.failed(e, 'Unable to update the admin.'),
      });
  }

  private fetch(more: boolean): void {
    this.api
      .load(more)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ error: (e: HttpErrorResponse) => this.notify(this.errorText(e, 'Unable to load admins.')) });
  }

  /** Opens the menu upwards when there is not enough room below the clicked button. */
  private shouldOpenUp(button: HTMLElement): boolean {
    const r = button.getBoundingClientRect();
    const card = button.closest('.al-scroll')?.getBoundingClientRect();
    const below = Math.min(card?.bottom ?? window.innerHeight, window.innerHeight) - r.top;
    const above = r.bottom - Math.max(card?.top ?? 0, 0);
    return below < MENU_HEIGHT && above > below;
  }

  private done(message: string): void {
    this.saving.set(false);
    this.closeMenu();
    this.notify(message);
  }

  private failed(error: HttpErrorResponse, fallback: string): void {
    this.saving.set(false);
    this.notify(this.errorText(error, fallback));
  }

  private errorText(error: HttpErrorResponse, fallback: string): string {
    const message: unknown = error?.error?.message;
    return error.status >= 400 && error.status < 500 && typeof message === 'string' && message.length <= 200
      ? message
      : fallback;
  }

  private notify(message: string): void {
    clearTimeout(this.toastTimer);
    this.toast.set(message);
    this.toastTimer = setTimeout(() => this.toast.set(''), 3200);
  }
}