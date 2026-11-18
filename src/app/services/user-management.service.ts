import { Injectable, signal } from '@angular/core';

export type UserStatus = 'Active' | 'Inactive' | 'Suspended';

export interface ManagedUser {
  id: number;
  username: string;
  role: string;
  email: string;
  status: UserStatus;
  department: string;
  suspendFrom?: string;
  suspendTo?: string;
}

/**
 * Users list for the "All Users" page.
 * Sample data for now - when the backend endpoint is ready, replace the signal with an HttpClient
 * call (GET /api/users, PATCH /api/users/{id}/status, DELETE /api/users/{id}) and keep the same methods.
 */
@Injectable({ providedIn: 'root' })
export class UserManagementService {
  readonly users = signal<ManagedUser[]>(
    Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      username: 'John doe',
      role: 'Learner',
      email: 'sampleuser@gmail.com',
      status: 'Active' as UserStatus,
      department: 'Cyber security',
    })),
  );

  setStatus(id: number, status: UserStatus, suspendFrom?: string, suspendTo?: string): void {
    this.users.update((list) =>
      list.map((u) => (u.id === id ? { ...u, status, suspendFrom, suspendTo } : u)),
    );
  }

  remove(ids: readonly number[]): void {
    const gone = new Set(ids);
    this.users.update((list) => list.filter((u) => !gone.has(u.id)));
  }
}
