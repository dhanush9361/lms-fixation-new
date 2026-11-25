import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DeleteImportResult, UserManagementService } from '../../../services/user-management.service';

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Bulk Users > Delete users: upload an Excel sheet with one email per row.
 * The listed users of this company are deleted, every other row is reported with its reason.
 */
@Component({
  selector: 'app-bulk-delete-modal',
  templateUrl: './bulk-delete-modal.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'close()' },
})
export class BulkDeleteModal {
  private readonly api = inject(UserManagementService);
  private readonly destroyRef = inject(DestroyRef);

  readonly closed = output<void>();
  /** Emitted once after at least one user was deleted, so the page can show a toast. */
  readonly deleted = output<DeleteImportResult>();

  protected readonly file = signal<File | null>(null);
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly result = signal<DeleteImportResult | null>(null);

  protected close(): void {
    if (!this.submitting()) this.closed.emit();
  }

  protected pick(event: Event): void {
    const input = event.target as HTMLInputElement;
    const f = input.files?.[0] ?? null;
    input.value = '';
    this.error.set(null);
    this.result.set(null);
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.xlsx')) {
      this.file.set(null);
      return this.error.set('Only .xlsx files are supported. Please use the sample template.');
    }
    if (f.size > MAX_BYTES) {
      this.file.set(null);
      return this.error.set('File is larger than 5 MB.');
    }
    this.file.set(f);
  }

  protected clear(): void {
    this.file.set(null);
    this.error.set(null);
  }

  protected downloadTemplate(event: Event): void {
    event.preventDefault();
    this.api
      .downloadDeleteTemplate()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (blob) => this.save(blob, 'delete-users-template.xlsx'),
        error: () => this.error.set('Unable to download the template. Please try again.'),
      });
  }

  protected upload(): void {
    const f = this.file();
    if (!f || this.submitting()) return;
    this.submitting.set(true);
    this.error.set(null);

    this.api
      .importDeletions(f)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.submitting.set(false);
          this.file.set(null);
          this.result.set(r);
          if (r.deleted > 0) this.deleted.emit(r);
          if (r.failed === 0) this.closed.emit();
        },
        error: (e: HttpErrorResponse) => {
          this.submitting.set(false);
          const msg: unknown = e?.error?.message;
          this.error.set(
            e.status >= 400 && e.status < 500 && typeof msg === 'string' ? msg : 'Upload failed. Please try again.',
          );
        },
      });
  }

  protected downloadErrors(): void {
    const r = this.result();
    if (!r) return;
    const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = ['Row,Email,Reason', ...r.errors.map((e) => [e.row || '', esc(e.email), esc(e.reason)].join(','))].join('\n');
    this.save(new Blob([csv], { type: 'text/csv' }), 'delete-users-errors.csv');
  }

  private save(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }
}