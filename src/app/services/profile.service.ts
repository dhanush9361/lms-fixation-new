import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../environments/environment';

interface ApiResponse<T> {
  success: boolean;
  message: string;
  data: T;
}

/** Shape returned by GET/PUT/POST /api/profile/... (picture URLs are already absolute here). */
export interface ProfileData {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  active: boolean;
  department: string | null;
  organizationName: string | null;
  organizationAddress: string | null;
  personalAddress: string | null;
  timeZone: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  postalCode: string | null;
  countryCode: string | null;
  phoneNumber: string;
  profilePictureUrl: string | null;
  backgroundPictureUrl: string | null;
}

/** Super Admin editing a company admin (/api/super-admin/admins/{adminId}/profile). */
export interface SuperAdminProfileTarget {
  adminId: number;
}

/** null / undefined = yourself, number = a user of your company, object = an admin (super admin only). */
export type ProfileTarget = number | SuperAdminProfileTarget | null | undefined;

/** Body of PUT /api/profile/me. */
export interface ProfileUpdate {
  firstName: string;
  lastName: string;
  email: string;
  /** Sent always; the server applies it only for an admin editing another user. */
  department?: string;
  organizationName: string;
  organizationAddress: string;
  personalAddress: string;
  timeZone: string;
  country: string;
  state: string;
  city: string;
  postalCode: string;
  countryCode: string;
  phoneNumber: string;
}

@Injectable({ providedIn: 'root' })
export class ProfileService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = `${environment.apiBaseUrl}/api/profile`;

  /**
   * Every method takes an optional target. Without it the call targets the logged-in user
   * (/api/profile/me). A user id (admin opening a row's "Edit Profile" in All Users) targets
   * /api/users/{id}/profile, which the backend limits to users of the admin's own company.
   * { adminId } (Super Admin > Admins) targets /api/super-admin/admins/{id}/profile.
   */
  private base(target?: ProfileTarget): string {
    if (target == null) return `${this.apiUrl}/me`;
    return typeof target === 'number'
      ? `${environment.apiBaseUrl}/api/users/${target}/profile`
      : `${environment.apiBaseUrl}/api/super-admin/admins/${target.adminId}/profile`;
  }

  private pictureBase(target?: ProfileTarget): string {
    return `${this.base(target)}/picture`;
  }

  private backgroundBase(target?: ProfileTarget): string {
    return `${this.base(target)}/background-picture`;
  }

  getMyProfile(target?: ProfileTarget): Observable<ProfileData> {
    return this.http.get<ApiResponse<ProfileData>>(this.base(target)).pipe(this.unwrap());
  }

  updateMyProfile(payload: ProfileUpdate, target?: ProfileTarget): Observable<ProfileData> {
    return this.http.put<ApiResponse<ProfileData>>(this.base(target), payload).pipe(this.unwrap());
  }

  uploadProfilePicture(file: File, target?: ProfileTarget): Observable<ProfileData> {
    return this.http
      .post<ApiResponse<ProfileData>>(this.pictureBase(target), this.toFormData(file))
      .pipe(this.unwrap());
  }

  uploadBackgroundPicture(file: File, target?: ProfileTarget): Observable<ProfileData> {
    return this.http
      .post<ApiResponse<ProfileData>>(this.backgroundBase(target), this.toFormData(file))
      .pipe(this.unwrap());
  }

  removeProfilePicture(target?: ProfileTarget): Observable<ProfileData> {
    return this.http.delete<ApiResponse<ProfileData>>(this.pictureBase(target)).pipe(this.unwrap());
  }

  removeBackgroundPicture(target?: ProfileTarget): Observable<ProfileData> {
    return this.http.delete<ApiResponse<ProfileData>>(this.backgroundBase(target)).pipe(this.unwrap());
  }

  /** Backend stores relative paths (/uploads/profile/x.jpg); make them absolute for <img [src]>. */
  private resolveMediaUrl(path: string | null): string | null {
    if (!path) return null;
    return /^https?:\/\//i.test(path) ? path : `${environment.apiBaseUrl}${path}`;
  }

  private unwrap() {
    return map<ApiResponse<ProfileData>, ProfileData>(({ data }) => ({
      ...data,
      profilePictureUrl: this.resolveMediaUrl(data.profilePictureUrl),
      backgroundPictureUrl: this.resolveMediaUrl(data.backgroundPictureUrl),
    }));
  }

  // Do NOT set Content-Type manually - the browser adds the multipart boundary.
  private toFormData(file: File): FormData {
    const form = new FormData();
    form.append('file', file);
    return form;
  }
}