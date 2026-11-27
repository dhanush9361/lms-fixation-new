import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { AuthService, FEATURE } from '../../services/auth';
import { BulkImportModal } from '../pop-modals/bulk-import-modal/bulk-import-modal';
import { BulkEnrollModal } from '../pop-modals/bulk-enroll-modal/bulk-enroll-modal';
import { BulkDeleteModal } from '../pop-modals/bulk-delete-modal/bulk-delete-modal';
import { DeleteImportResult, EnrollImportResult, ImportResult, ManagedUser, UnenrollImportResult, UserManagementService, UserStatus } from '../../services/user-management.service';

type RowAction = 'suspend' | 'active' | 'inactive' | 'delete';
type BulkAction = 'import' | 'export' | 'enroll' | 'unenroll' | 'delete';

@Component({
  selector: 'app-user-management',
  imports: [ReactiveFormsModule, BulkImportModal, BulkEnrollModal, BulkDeleteModal],
  templateUrl: './user-management.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'closeAll()',
    '(document:keydown.escape)': 'closeAll()',
    '(window:beforeunload)': 'onBeforeUnload($event)',
  },
})
export class UserManagement implements OnInit {
  private readonly api = inject(UserManagementService);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly users = this.api.users;
  protected readonly selected = signal<ReadonlySet<number>>(new Set());
  protected readonly menuUserId = signal<number | null>(null);
  protected readonly pendingAction = signal<RowAction | null>(null);
  /** True when the open row menu has to open upwards (not enough room below the clicked row). */
  protected readonly menuUp = signal(false);
  protected readonly bulkOpen = signal(false);
  protected readonly importOpen = signal(false);
  protected readonly enrollMode = signal<'enroll' | 'unenroll' | null>(null);
  protected readonly deleteOpen = signal(false);
  protected readonly toast = signal('');

  protected readonly dates = new FormGroup({
    start: new FormControl('', { nonNullable: true }),
    end: new FormControl('', { nonNullable: true }),
  });

  protected readonly allSelected = computed(
    () => this.users().length > 0 && this.selected().size === this.users().length,
  );
  protected readonly selectedIds = computed(() => [...this.selected()]);
  protected readonly someSelected = computed(() => this.selected().size > 0 && !this.allSelected());

  protected readonly bulkItems: readonly { id: BulkAction; label: string }[] = [
    { id: 'import', label: 'Import users' },
    { id: 'export', label: 'Export selected' },
    { id: 'enroll', label: 'Enroll in course' },
    { id: 'unenroll', label: 'Unenroll from course' },
    { id: 'delete', label: 'Delete users' },
  ];

  protected readonly visibleBulkItems = computed(() =>
    this.bulkItems.filter(
      (i) =>
        (i.id !== 'delete' || this.canDelete()) &&
        (i.id !== 'import' || this.canUpdate()) &&
        (i.id !== 'enroll' || (this.canEnroll() && this.canUpdate())) &&
        (i.id !== 'unenroll' || this.canUnenroll()),
    ),
  );

  /** Package / role permission on "All Users": update = edit profile + status, delete = delete users. */
  protected readonly canUpdate = computed(() => this.auth.can(FEATURE.USER_ALL, 'update'));
  /** Enrollment permission (same feature as the course page): create = enroll, delete = unenroll. */
  protected readonly canEnroll = computed(() => this.auth.can(FEATURE.ENROLL_UNENROLL, 'create'));
  protected readonly canUnenroll = computed(() => this.auth.can(FEATURE.ENROLL_UNENROLL, 'delete'));
  protected readonly canDelete = computed(() => this.auth.can(FEATURE.USER_ALL, 'delete'));

  private readonly allRowActions: readonly { id: RowAction; label: string }[] = [
    { id: 'active', label: 'Active' },
    { id: 'inactive', label: 'Inactive' },
    { id: 'delete', label: 'Delete User' },
  ];

  protected readonly rowActions = computed(() =>
    this.allRowActions.filter((a) => (a.id === 'delete' ? this.canDelete() : this.canUpdate())),
  );

  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  ngOnInit(): void {
    // Suspend User is unchecked by default, so the dates start disabled.
    this.dates.disable({ emitEvent: false });

    this.api
      .load()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ error: (e: HttpErrorResponse) => this.notify(this.errorText(e, 'Unable to load users.')) });
  }

  /** Used by unsavedChangesGuard (guards/role.guard.ts) and the browser refresh/close warning. */
  hasUnsavedChanges(): boolean {
    return this.pendingAction() !== null;
  }

  protected onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.hasUnsavedChanges()) event.preventDefault();
  }

  /** "Edit Profile" in the row menu -> the existing edit-profile screen, filled with this user's details. */
  protected editProfile(user: ManagedUser): void {
    this.closeAll();
    void this.router.navigate(['/admin-dashboard', 'users', user.id, 'edit-profile']);
  }

  /** Only hides the menus. Does NOT clear pendingAction (the navigation guard needs it). */
  protected closeAll(): void {
    this.menuUserId.set(null);
    this.bulkOpen.set(false);
  }

  /** Cancel button: close the popup and throw away the unsaved choice and dates. */
  protected cancel(): void {
    this.discard();
  }

  private discard(): void {
    this.pendingAction.set(null);
    this.resetDates();
    this.closeAll();
  }

  private resetDates(): void {
    this.dates.reset({ start: '', end: '' });
    this.dates.disable({ emitEvent: false });
  }

  protected toggleAll(): void {
    this.selected.set(this.allSelected() ? new Set() : new Set(this.users().map((u) => u.id)));
  }

  protected toggleOne(id: number): void {
    this.selected.update((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected toggleMenu(event: Event, user: ManagedUser): void {
    event.stopPropagation();
    this.bulkOpen.set(false);
    if (this.menuUserId() === user.id) {
      this.menuUserId.set(null);
      return;
    }
    // Every time the popup opens it starts clean: nothing checked, dates empty and disabled.
    this.pendingAction.set(null);
    this.resetDates();
    this.menuUp.set(this.shouldOpenUp(event.currentTarget as HTMLElement));
    this.menuUserId.set(user.id);
  }

  /** Opens the menu upwards when the room below the button (card bottom / screen bottom) is smaller than the menu. */
  private shouldOpenUp(button: HTMLElement): boolean {
    const MENU_HEIGHT = 280; // tallest state (suspend dates open)
    const r = button.getBoundingClientRect();
    const card = button.closest('.um-scroll')?.getBoundingClientRect();
    const limit = Math.min(card?.bottom ?? window.innerHeight, window.innerHeight);
    const below = limit - r.top;
    const above = r.bottom - Math.max(card?.top ?? 0, 0);
    return below < MENU_HEIGHT && above > below;
  }

  protected toggleBulk(event: Event): void {
    event.stopPropagation();
    this.menuUserId.set(null);
    this.bulkOpen.update((v) => !v);
  }

  protected pick(action: RowAction): void {
    const next = this.pendingAction() === action ? null : action;
    this.pendingAction.set(next);

    if (next === 'suspend') {
      this.dates.enable({ emitEvent: false });
    } else {
      // Suspend unchecked (or another option picked): dates disabled and cleared.
      this.resetDates();
    }
  }

  protected saveRow(user: ManagedUser): void {
    const action = this.pendingAction();
    if (!action) return;
    if (action === 'delete' ? !this.canDelete() : !this.canUpdate()) return;

    if (action === 'delete') {
      // Confirmation first. No / Cancel -> user is not deleted.
      if (!window.confirm(`Are you sure you want to delete ${user.username}?`)) return;

      this.api
        .remove([user.id])
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: () => {
            this.selected.update((s) => new Set([...s].filter((id) => id !== user.id)));
            this.notify(`${user.username} was deleted`);
            this.discard();
          },
          error: (e: HttpErrorResponse) => this.notify(this.errorText(e, 'Unable to delete the user.')),
        });
      return;
    }

    const status: UserStatus =
      action === 'suspend' ? 'Suspended' : action === 'active' ? 'Active' : 'Inactive';
    const { start, end } = this.dates.getRawValue();

    if (status === 'Suspended') {
      if (!start || !end) {
        this.notify('Select the suspension start and end dates');
        return;
      }
      if (end < start) {
        this.notify('End date cannot be before the start date');
        return;
      }
    }

    this.api
      .setStatus(user.id, status, start, end)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.notify(`${user.username} is now ${status.toLowerCase()}`);
          this.discard();
        },
        error: (e: HttpErrorResponse) => this.notify(this.errorText(e, 'Unable to update the user.')),
      });
  }

  protected bulk(action: BulkAction): void {
    this.bulkOpen.set(false);
    const ids = [...this.selected()];
    if (action === 'delete') {
      // Excel upload as well: users are matched by email from the sheet, so no table selection is needed.
      if (this.canDelete()) this.deleteOpen.set(true);
      return;
    }
    if (action === 'import') {
      if (this.canUpdate()) this.importOpen.set(true);
      return;
    }
    if (action === 'enroll') {
      // Excel upload: users are matched / created from the sheet, so no table selection is needed.
      if (this.canEnroll() && this.canUpdate()) this.enrollMode.set('enroll');
      return;
    }
    if (action === 'unenroll') {
      // Excel upload as well: users are matched by email from the sheet, so no table selection is needed.
      if (this.canUnenroll()) this.enrollMode.set('unenroll');
      return;
    }
    if (action === 'export') {
      const rows = this.users().filter((u) => !ids.length || ids.includes(u.id));
      const csv = [
        'Username,Role,Email,Status,Department',
        ...rows.map((u) => [u.username, u.role, u.email, u.status, u.department ?? ''].join(',')),
      ].join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'users.csv';
      a.click();
      URL.revokeObjectURL(url);
      return this.notify('Users exported');
    }
  }

  protected onUnenrolled(r: UnenrollImportResult): void {
    this.notify(`${r.unenrolled} user(s) unenrolled`);
  }

  protected onDeleted(r: DeleteImportResult): void {
    this.selected.set(new Set());
    this.notify(`${r.deleted} user(s) deleted`);
  }

  protected onEnrollImported(r: EnrollImportResult): void {
    this.notify(`${r.enrolled} enrollment(s) saved, ${r.usersCreated} new user(s) created`);
  }

  protected onImported(r: ImportResult): void {
    this.notify(`${r.imported} user(s) imported`);
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
    this.toastTimer = setTimeout(() => this.toast.set(''), 2600);
  }
}