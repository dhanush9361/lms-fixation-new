import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { AuthService, FEATURE } from '../../services/auth';
import { ManagedUser, UserManagementService, UserStatus } from '../../services/user-management.service';

type RowAction = 'suspend' | 'active' | 'inactive' | 'delete';
type BulkAction = 'import' | 'export' | 'enroll' | 'unenroll' | 'delete';

@Component({
  selector: 'app-user-management',
  imports: [ReactiveFormsModule],
  templateUrl: './user-management.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'closeAll()',
    '(document:keydown.escape)': 'closeAll()',
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
  protected readonly bulkOpen = signal(false);
  protected readonly toast = signal('');

  protected readonly dates = new FormGroup({
    start: new FormControl('', { nonNullable: true }),
    end: new FormControl('', { nonNullable: true }),
  });

  protected readonly allSelected = computed(
    () => this.users().length > 0 && this.selected().size === this.users().length,
  );
  protected readonly someSelected = computed(() => this.selected().size > 0 && !this.allSelected());

  protected readonly bulkItems: readonly { id: BulkAction; label: string }[] = [
    { id: 'import', label: 'Import users' },
    { id: 'export', label: 'Export selected' },
    { id: 'enroll', label: 'Enroll in course' },
    { id: 'unenroll', label: 'Unenroll from course' },
    { id: 'delete', label: 'Delete selected' },
  ];

  protected readonly visibleBulkItems = computed(() =>
    this.bulkItems.filter((i) => i.id !== 'delete' || this.canDelete()),
  );

  /** Package / role permission on "All Users": update = edit profile + status, delete = delete users. */
  protected readonly canUpdate = computed(() => this.auth.can(FEATURE.USER_ALL, 'update'));
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
    this.api
      .load()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ error: (e: HttpErrorResponse) => this.notify(this.errorText(e, 'Unable to load users.')) });
  }

  /** "Edit Profile" in the row menu -> the existing edit-profile screen, filled with this user's details. */
  protected editProfile(user: ManagedUser): void {
    this.closeAll();
    void this.router.navigate(['/admin-dashboard', 'users', user.id, 'edit-profile']);
  }

  protected closeAll(): void {
    this.menuUserId.set(null);
    this.bulkOpen.set(false);
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
    this.pendingAction.set(null);
    this.dates.reset({ start: user.suspendFrom ?? '', end: user.suspendTo ?? '' });
    this.menuUserId.set(user.id);
  }

  protected toggleBulk(event: Event): void {
    event.stopPropagation();
    this.menuUserId.set(null);
    this.bulkOpen.update((v) => !v);
  }

  protected pick(action: RowAction): void {
    this.pendingAction.update((a) => (a === action ? null : action));
  }

  protected saveRow(user: ManagedUser): void {
    const action = this.pendingAction();
    if (!action) return;
    if (action === 'delete' ? !this.canDelete() : !this.canUpdate()) return;

    if (action === 'delete') {
      this.api
        .remove([user.id])
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: () => {
            this.selected.update((s) => new Set([...s].filter((id) => id !== user.id)));
            this.notify(`${user.username} was deleted`);
            this.closeAll();
          },
          error: (e: HttpErrorResponse) => this.notify(this.errorText(e, 'Unable to delete the user.')),
        });
      return;
    }

    const status: UserStatus =
      action === 'suspend' ? 'Suspended' : action === 'active' ? 'Active' : 'Inactive';
    const { start, end } = this.dates.getRawValue();
    if (status === 'Suspended' && (!start || !end)) {
      this.notify('Select the suspension start and end dates');
      return;
    }
    this.api
      .setStatus(user.id, status, start, end)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.notify(`${user.username} is now ${status.toLowerCase()}`);
          this.closeAll();
        },
        error: (e: HttpErrorResponse) => this.notify(this.errorText(e, 'Unable to update the user.')),
      });
  }

  protected bulk(action: BulkAction): void {
    this.bulkOpen.set(false);
    const ids = [...this.selected()];
    if (action === 'delete') {
      if (!this.canDelete()) return;
      if (!ids.length) return this.notify('Select at least one user first');
      this.api
        .remove(ids)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: () => {
            this.selected.set(new Set());
            this.notify(`${ids.length} user(s) deleted`);
          },
          error: (e: HttpErrorResponse) => this.notify(this.errorText(e, 'Unable to delete the users.')),
        });
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
    this.notify('This bulk action will be connected to the backend soon');
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