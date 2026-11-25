import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, map, tap } from 'rxjs';
import { environment } from '../../environments/environment';

export type UserStatus = 'Active' | 'Inactive' | 'Suspended';

export interface ManagedUser {
  id: number;
  username: string;
  role: string;
  email: string;
  status: UserStatus;
  department: string | null;
  suspendFrom?: string | null;
  suspendTo?: string | null;
}

export interface ImportRowError {
  row: number;
  email: string;
  reason: string;
}

export interface ImportResult {
  total: number;
  imported: number;
  failed: number;
  emailsFailed: number;
  errors: ImportRowError[];
}

export interface CourseOption {
  id: number;
  name: string;
  status: string;
}

export interface BulkEnrollSkipped {
  userId: number;
  name: string | null;
  reason: string;
}

export interface BulkEnrollResult {
  courseId: number;
  courseName: string;
  requested: number;
  affected: number;
  skipped: BulkEnrollSkipped[];
}

export interface EnrollImportResult {
  total: number;
  usersCreated: number;
  enrolled: number;
  alreadyEnrolled: number;
  failed: number;
  emailsFailed: number;
  errors: ImportRowError[];
}

export interface UnenrollImportResult {
  total: number;
  unenrolled: number;
  failed: number;
  errors: ImportRowError[];
}

export interface DeleteImportResult {
  total: number;
  deleted: number;
  failed: number;
  errors: ImportRowError[];
}

interface ApiResponse<T> {
  success: boolean;
  message: string;
  data: T;
}

interface UserPage {
  content: ManagedUser[];
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
}

/**
 * Users list for the "All Users" page, backed by UserManagementController (/api/users).
 * `users` stays a signal so the component template did not need to change.
 */
@Injectable({ providedIn: 'root' })
export class UserManagementService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = `${environment.apiBaseUrl}/api/users`;

  readonly users = signal<ManagedUser[]>([]);
  readonly loading = signal(false);
  /** Total rows on the server (can be more than `users().length` - the list is capped at 100 per request). */
  readonly total = signal(0);

  load(search = '', status: UserStatus | '' = ''): Observable<void> {
    let params = new HttpParams().set('page', 0).set('size', 100);
    if (search.trim()) params = params.set('search', search.trim());
    if (status) params = params.set('status', status);

    this.loading.set(true);
    return this.http.get<ApiResponse<UserPage>>(this.apiUrl, { params }).pipe(
      tap({
        next: ({ data }) => {
          this.users.set(data.content);
          this.total.set(data.totalElements);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      }),
      map(() => undefined),
    );
  }

  setStatus(
    id: number,
    status: UserStatus,
    suspendFrom?: string,
    suspendTo?: string,
  ): Observable<ManagedUser> {
    const body = {
      status,
      suspendFrom: status === 'Suspended' && suspendFrom ? suspendFrom : null,
      suspendTo: status === 'Suspended' && suspendTo ? suspendTo : null,
    };
    return this.http.patch<ApiResponse<ManagedUser>>(`${this.apiUrl}/${id}/status`, body).pipe(
      map((res) => res.data),
      tap((row) => this.users.update((list) => list.map((u) => (u.id === id ? row : u)))),
    );
  }

  remove(ids: readonly number[]): Observable<void> {
    const request =
      ids.length === 1
        ? this.http.delete<ApiResponse<void>>(`${this.apiUrl}/${ids[0]}`)
        : this.http.post<ApiResponse<unknown>>(`${this.apiUrl}/bulk-delete`, { ids });
    return request.pipe(
      tap(() => {
        const gone = new Set(ids);
        this.users.update((list) => list.filter((u) => !gone.has(u.id)));
        this.total.update((n) => Math.max(0, n - ids.length));
      }),
      map(() => undefined),
    );
  }

  /** Sample .xlsx for Bulk Users > Delete users. */
  downloadDeleteTemplate(): Observable<Blob> {
    return this.http.get(`${this.apiUrl}/bulk-delete/template`, { responseType: 'blob' });
  }

  /** Uploads the filled .xlsx (one email per row): listed users of this company are deleted, other rows are reported. */
  importDeletions(file: File): Observable<DeleteImportResult> {
    const body = new FormData();
    body.append('file', file);
    return this.http.post<ApiResponse<DeleteImportResult>>(`${this.apiUrl}/bulk-delete/import`, body).pipe(
      map((res) => res.data),
      tap(() => this.load().subscribe()),
    );
  }

  /** Sample .xlsx for Bulk Users > Import users. */
  downloadTemplate(): Observable<Blob> {
    return this.http.get(`${this.apiUrl}/import/template`, { responseType: 'blob' });
  }

  /** Uploads the filled .xlsx; imported users are stored in the users table, then the list is reloaded. */
  importUsers(file: File): Observable<ImportResult> {
    const body = new FormData();
    body.append('file', file);
    return this.http.post<ApiResponse<ImportResult>>(`${this.apiUrl}/import`, body).pipe(
      map((res) => res.data),
      tap((r) => {
        if (r.imported > 0) this.load().subscribe();
      }),
    );
  }

  // ---------- Bulk enroll / unenroll (All Users > Bulk Users) ----------

  loadCourseOptions(): Observable<CourseOption[]> {
    return this.http
      .get<ApiResponse<CourseOption[]>>(`${this.apiUrl}/bulk-enrollment/courses`)
      .pipe(map((res) => res.data));
  }

  /** Sample .xlsx for Bulk Users > Enroll in course. */
  downloadEnrollTemplate(): Observable<Blob> {
    return this.http.get(`${this.apiUrl}/bulk-enrollment/import/template`, { responseType: 'blob' });
  }

  /** Uploads the filled .xlsx: missing users are created, then every row's user is enrolled in its course. */
  importEnrollments(file: File): Observable<EnrollImportResult> {
    const body = new FormData();
    body.append('file', file);
    return this.http.post<ApiResponse<EnrollImportResult>>(`${this.apiUrl}/bulk-enrollment/import`, body).pipe(
      map((res) => res.data),
      tap((r) => {
        if (r.usersCreated > 0) this.load().subscribe();
      }),
    );
  }

  /** Sample .xlsx for Bulk Users > Unenroll from course. */
  downloadUnenrollTemplate(): Observable<Blob> {
    return this.http.get(`${this.apiUrl}/bulk-enrollment/unenroll-import/template`, { responseType: 'blob' });
  }

  /** Uploads the filled .xlsx (email + course per row): matching enrollments are removed, other rows are reported. */
  importUnenrollments(file: File): Observable<UnenrollImportResult> {
    const body = new FormData();
    body.append('file', file);
    return this.http
      .post<ApiResponse<UnenrollImportResult>>(`${this.apiUrl}/bulk-enrollment/unenroll-import`, body)
      .pipe(map((res) => res.data));
  }

  bulkUnenroll(courseId: number, userIds: readonly number[]): Observable<BulkEnrollResult> {
    return this.http
      .post<ApiResponse<BulkEnrollResult>>(`${this.apiUrl}/bulk-enrollment/unenroll`, { courseId, userIds })
      .pipe(map((res) => res.data));
  }
}