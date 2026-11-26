import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AdminImportResult, AdminManagementService } from '../../../services/admin-management.service';
import { saveBlob } from '../../../services/download';

const MAX_BYTES = 5 * 1024 * 1024;

@Component({
  selector: 'app-admin-import-modal',
  templateUrl: './admin-import-modal.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'close()' },
})
export class AdminImportModal {
  private readonly api = inject(AdminManagementService);
  private readonly destroyRef = inject(DestroyRef);

  readonly closed = output<void>();
  /** Emitted once after at least one admin was imported, so the page can show a toast. */
  readonly imported = output<AdminImportResult>();

  protected readonly file = signal<File | null>(null);
  protected readonly uploading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly result = signal<AdminImportResult | null>(null);

  protected close(): void {
    if (!this.uploading()) this.closed.emit();
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
      .downloadTemplate()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (blob) => saveBlob(blob, 'admins-import-template.xlsx'),
        error: () => this.error.set('Unable to download the template. Please try again.'),
      });
  }

  protected upload(): void {
    const f = this.file();
    if (!f || this.uploading()) return;
    this.uploading.set(true);
    this.error.set(null);
    this.api
      .importAdmins(f)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.uploading.set(false);
          this.result.set(r);
          this.file.set(null);
          if (r.imported > 0) this.imported.emit(r);
          if (r.failed === 0 && r.withoutPackage === 0 && r.emailsFailed === 0) this.closed.emit();
        },
        error: (e: HttpErrorResponse) => {
          this.uploading.set(false);
          const msg: unknown = e?.error?.message;
          this.error.set(
            e.status >= 400 && e.status < 500 && typeof msg === 'string' ? msg : 'Import failed. Please try again.',
          );
        },
      });
  }

  protected downloadErrors(): void {
    const r = this.result();
    if (!r) return;
    const esc = (v: string | number) => `"${String(v).replace(/^[=+\-@]/, "'$&").replace(/"/g, '""')}"`;
    const csv = ['Row,Email,Reason', ...r.errors.map((e) => [e.row || '', esc(e.email), esc(e.reason)].join(','))].join('\n');
    saveBlob(new Blob([csv], { type: 'text/csv' }), 'admins-import-errors.csv');
  }
}