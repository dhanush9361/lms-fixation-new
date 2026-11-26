import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, map, tap } from 'rxjs';
import { environment } from '../../environments/environment';
import { ImportResult, UserStatus } from './user-management.service';

export interface ManagedAdmin {
  id: number;
  username: string;
  email: string;
  organization: string | null;
  profilePictureUrl: string | null;
  status: UserStatus;
  suspendFrom?: string | null;
  suspendTo?: string | null;
}

export interface AdminImportResult extends ImportResult {
  /** Imported admins with no package: they cannot log in until one is assigned. */
  withoutPackage: number;
}

interface ApiResponse<T> {
  success: boolean;
  message: string;
  data: T;
}

interface AdminRowPage {
  content: ManagedAdmin[];
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
}

const PAGE_SIZE = 100;

/** Super Admin > Admins, backed by SuperAdminAdminController (/api/super-admin/admins). */
@Injectable({ providedIn: 'root' })
export class AdminManagementService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = `${environment.apiBaseUrl}/api/super-admin/admins`;

  readonly admins = signal<ManagedAdmin[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);

  private nextPage = 0;

  /** `more: true` appends the next page; otherwise the list starts again from the first page. */
  load(more = false): Observable<void> {
    const page = more ? this.nextPage : 0;
    const params = new HttpParams().set('page', page).set('size', PAGE_SIZE);

    this.loading.set(true);
    return this.http.get<ApiResponse<AdminRowPage>>(this.apiUrl, { params }).pipe(
      tap({
        next: ({ data }) => {
          const rows = data.content.map((row) => this.withPictureUrl(row));
          this.admins.update((list) => {
            if (!more) return rows;
            const known = new Set(list.map((a) => a.id));
            return [...list, ...rows.filter((r) => !known.has(r.id))];
          });
          this.total.set(data.totalElements);
          this.nextPage = page + 1;
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      }),
      map(() => undefined),
    );
  }

  setStatus(id: number, status: UserStatus, suspendFrom?: string, suspendTo?: string): Observable<ManagedAdmin> {
    const body = {
      status,
      suspendFrom: status === 'Suspended' && suspendFrom ? suspendFrom : null,
      suspendTo: status === 'Suspended' && suspendTo ? suspendTo : null,
    };
    return this.http.patch<ApiResponse<ManagedAdmin>>(`${this.apiUrl}/${id}/status`, body).pipe(
      map(({ data }) => this.withPictureUrl(data)),
      tap((row) => this.admins.update((list) => list.map((a) => (a.id === id ? row : a)))),
    );
  }

  /** Reloads from the first page afterwards, so page boundaries stay right after a row is gone. */
  remove(id: number): Observable<void> {
    return this.http.delete<ApiResponse<void>>(`${this.apiUrl}/${id}`).pipe(
      tap(() => {
        this.admins.update((list) => list.filter((a) => a.id !== id));
        this.total.update((n) => Math.max(0, n - 1));
        this.load().subscribe({ error: () => undefined });
      }),
      map(() => undefined),
    );
  }

  /** Sample .xlsx for Bulk Admin's > Import. */
  downloadTemplate(): Observable<Blob> {
    return this.http.get(`${this.apiUrl}/import/template`, { responseType: 'blob' });
  }

  importAdmins(file: File): Observable<AdminImportResult> {
    const body = new FormData();
    body.append('file', file);
    return this.http.post<ApiResponse<AdminImportResult>>(`${this.apiUrl}/import`, body).pipe(
      map((res) => res.data),
      tap((r) => {
        if (r.imported > 0) this.load().subscribe({ error: () => undefined });
      }),
    );
  }

  /** Empty `ids` exports every admin. */
  exportCsv(ids: readonly number[]): Observable<Blob> {
    return this.http.post(`${this.apiUrl}/export`, { ids }, { responseType: 'blob' });
  }

  /** Backend may store a relative path (/uploads/...); make it absolute for <img [src]>. */
  private withPictureUrl(row: ManagedAdmin): ManagedAdmin {
    const path = row.profilePictureUrl;
    if (!path || /^https?:\/\//i.test(path)) return row;
    return { ...row, profilePictureUrl: `${environment.apiBaseUrl}${path}` };
  }
}