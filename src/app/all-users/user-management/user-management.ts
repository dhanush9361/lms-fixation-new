import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
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
export class UserManagement {
  private readonly api = inject(UserManagementService);

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

  protected readonly rowActions: readonly { id: RowAction; label: string }[] = [
    { id: 'active', label: 'Active' },
    { id: 'inactive', label: 'Inactive' },
    { id: 'delete', label: 'Delete User' },
  ];

  private toastTimer: ReturnType<typeof setTimeout> | undefined;

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
    if (action === 'delete') {
      this.api.remove([user.id]);
      this.selected.update((s) => new Set([...s].filter((id) => id !== user.id)));
      this.notify(`${user.username} was deleted`);
    } else if (action) {
      const status: UserStatus =
        action === 'suspend' ? 'Suspended' : action === 'active' ? 'Active' : 'Inactive';
      const { start, end } = this.dates.getRawValue();
      this.api.setStatus(user.id, status, action === 'suspend' ? start : undefined, action === 'suspend' ? end : undefined);
      this.notify(`${user.username} is now ${status.toLowerCase()}`);
    }
    this.closeAll();
  }

  protected bulk(action: BulkAction): void {
    this.bulkOpen.set(false);
    const ids = [...this.selected()];
    if (action === 'delete') {
      if (!ids.length) return this.notify('Select at least one user first');
      this.api.remove(ids);
      this.selected.set(new Set());
      return this.notify(`${ids.length} user(s) deleted`);
    }
    if (action === 'export') {
      const rows = this.users().filter((u) => !ids.length || ids.includes(u.id));
      const csv = [
        'Username,Role,Email,Status,Department',
        ...rows.map((u) => [u.username, u.role, u.email, u.status, u.department].join(',')),
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

  private notify(message: string): void {
    clearTimeout(this.toastTimer);
    this.toast.set(message);
    this.toastTimer = setTimeout(() => this.toast.set(''), 2600);
  }
}
