import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { BulkEnrollResult, CourseOption, UserManagementService } from '../../../services/user-management.service';

@Component({
  selector: 'app-bulk-enroll-modal',
  templateUrl: './bulk-enroll-modal.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'close()' },
})
export class BulkEnrollModal implements OnInit {
  private readonly api = inject(UserManagementService);
  private readonly destroyRef = inject(DestroyRef);

  readonly mode = input.required<'enroll' | 'unenroll'>();
  readonly userIds = input.required<readonly number[]>();

  readonly closed = output<void>();
  /** Emitted when at least one user was enrolled / unenrolled. */
  readonly done = output<BulkEnrollResult>();

  protected readonly courses = signal<CourseOption[]>([]);
  protected readonly loadingCourses = signal(true);
  protected readonly courseId = signal<number | null>(null);
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly result = signal<BulkEnrollResult | null>(null);

  protected readonly isEnroll = computed(() => this.mode() === 'enroll');

  ngOnInit(): void {
    this.api
      .loadCourseOptions()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (list) => {
          this.courses.set(list);
          this.loadingCourses.set(false);
        },
        error: () => {
          this.loadingCourses.set(false);
          this.error.set('Unable to load the courses. Please try again.');
        },
      });
  }

  protected close(): void {
    if (!this.submitting()) this.closed.emit();
  }

  protected selectCourse(event: Event): void {
    const v = (event.target as HTMLSelectElement).value;
    this.courseId.set(v ? Number(v) : null);
    this.error.set(null);
  }

  protected submit(): void {
    const id = this.courseId();
    if (id == null) return void this.error.set('Please select a course.');
    if (this.submitting()) return;
    this.submitting.set(true);
    this.error.set(null);

    const call = this.isEnroll() ? this.api.bulkEnroll(id, this.userIds()) : this.api.bulkUnenroll(id, this.userIds());
    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.submitting.set(false);
        this.result.set(r);
        if (r.affected > 0) this.done.emit(r);
        if (r.skipped.length === 0) this.closed.emit();
      },
      error: (e: HttpErrorResponse) => {
        this.submitting.set(false);
        const msg: unknown = e?.error?.message;
        this.error.set(e.status >= 400 && e.status < 500 && typeof msg === 'string' ? msg : 'Something went wrong. Please try again.');
      },
    });
  }
}