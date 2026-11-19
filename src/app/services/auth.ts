import { computed, inject, Injectable, signal } from '@angular/core';
import { HttpClient, HttpInterceptorFn, HttpParams } from '@angular/common/http';
import { EMPTY, map, Observable, tap } from 'rxjs';
import { environment } from '../../environments/environment';
import { TokenStorageService } from './token-storage.service';
import { catchError, throwError } from 'rxjs';
import { Router } from '@angular/router';

export type AccessAction = 'create' | 'read' | 'update' | 'delete';
export type PermissionFlags = Record<AccessAction, boolean>;

/** "Needs `action` on `featureId`" - one requirement of a menu item / route / button. */
export type AccessRequirement = readonly [featureId: string, action: AccessAction];

/** Feature ids - the same ids the backend seeds (SystemFeatureSeeder). */
export const FEATURE = {
  COURSE_CREATE: 'COURSE_MGMT_CREATE_COURSE',
  COURSE_LIST: 'COURSE_MGMT_COURSE_LIST',
  COURSE_ORGANIZE: 'COURSE_MGMT_ORGANIZE_MODULES',
  ENROLL_UNENROLL: 'ENROLLMENT_ENROLL_UNENROLL',
  ENROLLED_LIST: 'ENROLLMENT_ENROLLED_LIST',
  MULTIMEDIA: 'CONTENT_MGMT_MULTIMEDIA',
  EBOOK: 'CONTENT_MGMT_EBOOK',
  /** read = open / list, update = edit profile + status, delete = delete users */
  USER_ALL: 'USER_MGMT_ALL_USERS',
  /** read = open the designer, update = save the template */
  CERT_TEMPLATE: 'CERTIFICATE_MGMT_TEMPLATE',
} as const;

/**
 * Category ids (the same ids the backend seeds) whose LEFT MENU entry can be switched on in
 * Package / Role Management. The category switch only decides whether the menu is shown; the
 * create / read / update / delete flags decide what the user can do inside the page.
 */
export const MENU = {
  COURSE: 'COURSE_MGMT',
  CONTENT: 'CONTENT_MGMT',
  ENROLLMENT: 'ENROLLMENT',
  USERS: 'USER_MGMT',
  CERTIFICATE: 'CERTIFICATE_MGMT',
} as const;

export interface AuthUser {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  roles: string[];
  instructorId: number | null;
  /** True for SUPER_ADMIN (app owner) only: every action is allowed. */
  fullAccess: boolean;
  /**
   * True for the company's own ADMIN. Always sees Dashboard, Role Management and Subscription;
   * every other menu / button comes from the package (see `permissions`).
   */
  companyAdmin: boolean;
  /**
   * What the user may do, keyed by feature id (empty when fullAccess):
   * the package's features for the company ADMIN, the role's features (limited to the package) for everyone else.
   */
  permissions: Record<string, PermissionFlags>;
  /**
   * Category ids whose left-menu entry is visible (the category switch in Package / Role Management).
   * Independent of `permissions`: "Course Management" can be ON while every Course action is OFF.
   */
  menus: string[];
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}

/** Returned instead of a token when the password was right but the account has 2FA on. */
export interface TwoFactorChallenge {
  challengeToken: string;
  /** e.g. j***@gmail.com - where the OTP was e-mailed (empty for AUTHENTICATOR). */
  maskedEmail: string;
  /** Which code the login screen has to ask for. */
  method: 'EMAIL' | 'AUTHENTICATOR';
}

/** Result of step 1 of login: either logged in, or an OTP is needed (see verifyLoginOtp). */
export type LoginOutcome =
  | ({ twoFactorRequired: false } & LoginResponse)
  | { twoFactorRequired: true; challenge: TwoFactorChallenge };

interface ApiResponse<T> {
  success: boolean;
  message: string;
  data: T;
}

interface LoginApiData {
  token: string;
  tokenType: string;
  userId: number;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  roles?: string[];
  instructorId?: number | null;
  fullAccess?: boolean;
  companyAdmin?: boolean;
  permissions?: PermissionGrantApi[];
  menus?: string[];
  twoFactorRequired?: boolean;
  challengeToken?: string;
  maskedEmail?: string;
  twoFactorMethod?: 'EMAIL' | 'AUTHENTICATOR';
}

/** One row of the backend's permission list (PermissionDto.Grant). */
interface PermissionGrantApi extends PermissionFlags {
  featureId: string;
}

/** Row shape for GET /api/profile/permissions. */
interface PermissionsApiData {
  fullAccess?: boolean;
  companyAdmin?: boolean;
  permissions?: PermissionGrantApi[];
  menus?: string[];
}

/** Row shape for GET /api/auth/signup/admins — User-table fields only. */
export interface AdminSummary {
  id: number;
  username: string;
  email: string;
  role: string;
  status: 'Active' | 'Inactive';
  packageId: number | null;
  packageExpiresAt: string | null;
  createdAt: string;
}

export interface AdminPage {
  content: AdminSummary[];
  totalElements: number;
  totalPages: number;
  number: number;
  size: number;
}

export interface AdminListQuery {
  search?: string;
  status?: 'All' | 'Active' | 'Inactive';
  page?: number;
  size?: number;
}

@Injectable({ providedIn: 'root' })
export class AuthService {

  private readonly apiUrl = `${environment.apiBaseUrl}/api/auth`;

  private readonly tokenStorage = inject(TokenStorageService);

  readonly user = signal<AuthUser | null>(null);
  readonly roleResolved = signal(true);
  readonly isSuperAdmin = computed(() => this.user()?.role === 'SUPER_ADMIN');
  /** The company's own ADMIN (not an invited Instructor / Learner / custom role). */
  readonly isCompanyAdmin = computed(() => !!this.user()?.companyAdmin);
  /** An invited user whose role is literally LEARNER (the backend uses the same rule for the course list). */
  readonly isLearner = computed(() => this.user()?.role?.trim().toUpperCase() === 'LEARNER');
  readonly displayName = computed(() => {
    const user = this.user();
    if (!user) return '';
    return [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email;
  });

  constructor(private readonly http: HttpClient) {
    this.user.set(this.normalizeUser(this.tokenStorage.getUser<AuthUser>()));
  }

  /**
   * Step 1. If the account has 2FA on, nothing is stored yet and `twoFactorRequired` is true:
   * the caller shows the OTP box and finishes with verifyLoginOtp().
   */
  login(credentials: { email: string; password: string; rememberMe: boolean }): Observable<LoginOutcome> {
    return this.http.post<ApiResponse<LoginApiData>>(`${this.apiUrl}/login`, credentials).pipe(
      map(({ data }): LoginOutcome => {
        if (data.twoFactorRequired) {
          return {
            twoFactorRequired: true,
            challenge: {
              challengeToken: data.challengeToken ?? '',
              maskedEmail: data.maskedEmail ?? '',
              method: data.twoFactorMethod ?? 'EMAIL',
            },
          };
        }
        return { twoFactorRequired: false, ...this.toLoginResponse(data) };
      }),
      tap((outcome) => {
        if (!outcome.twoFactorRequired) this.startSession(outcome, credentials.rememberMe);
      }),
    );
  }

  /** Step 2 (2FA only) - POST /api/auth/2fa/login/verify. `rememberMe` only picks local vs session storage. */
  verifyLoginOtp(challengeToken: string, otp: string, rememberMe: boolean): Observable<LoginResponse> {
    return this.http
      .post<ApiResponse<LoginApiData>>(`${this.apiUrl}/2fa/login/verify`, { challengeToken, otp })
      .pipe(
        map(({ data }) => this.toLoginResponse(data)),
        tap((response) => this.startSession(response, rememberMe)),
      );
  }

  /** POST /api/auth/2fa/login/resend - e-mails a fresh OTP for the same login attempt. */
  resendLoginOtp(challengeToken: string): Observable<unknown> {
    return this.http.post(`${this.apiUrl}/2fa/login/resend`, { challengeToken });
  }

  private toLoginResponse(data: LoginApiData): LoginResponse {
    return {
      token: data.token,
      user: this.normalizeUser({
        id: data.userId,
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        role: data.role,
        roles: data.roles ?? [],
        instructorId: data.instructorId ?? null,
        fullAccess: !!data.fullAccess,
        companyAdmin: !!data.companyAdmin,
        permissions: this.toPermissionMap(data.permissions),
        menus: data.menus ?? [],
      })!,
    };
  }

  private startSession(response: LoginResponse, rememberMe: boolean): void {
    this.tokenStorage.save(response.token, response.user, rememberMe);
    this.user.set(response.user);
  }

  refreshProfile(): Observable<AuthUser> {
    this.roleResolved.set(false);
    return this.http.get<ApiResponse<LoginApiData>>(`${this.apiUrl}/me`).pipe(
      map(({ data }) =>
        this.normalizeUser({
          id: data.userId,
          firstName: data.firstName,
          lastName: data.lastName,
          email: data.email,
          role: data.role,
          roles: data.roles ?? [],
          instructorId: data.instructorId ?? null,
          fullAccess: !!data.fullAccess,
          companyAdmin: !!data.companyAdmin,
          permissions: this.toPermissionMap(data.permissions),
          menus: data.menus ?? [],
        })!,
      ),
      tap({
        next: (user) => {
          this.tokenStorage.updateUser(user);
          this.user.set(user);
          this.roleResolved.set(true);
        },
        error: () => {
          this.logout();
          this.roleResolved.set(true);
        },
      }),
    );
  }

  /**
   * Can the logged-in user do `action` on `featureId`? Menus, pages and buttons the role / package
   * does not grant stay hidden. Reads the `user` signal, so it works inside computed() and templates.
   *
   * Only SUPER_ADMIN (fullAccess) bypasses the check - the company ADMIN is limited to the package.
   */
  can(featureId: string, action: AccessAction): boolean {
    const user = this.user();
    if (!user) return false;
    if (user.fullAccess || user.role === 'SUPER_ADMIN') return true;
    return !!user.permissions?.[featureId]?.[action];
  }

  /**
   * Is the LEFT MENU entry of this category (e.g. MENU.COURSE) switched on for the user?
   * Only the category switch counts here - the create / read / update / delete flags are checked
   * separately with can() for the buttons inside the page.
   */
  hasMenu(categoryId: string): boolean {
    const user = this.user();
    if (!user) return false;
    if (user.fullAccess || user.role === 'SUPER_ADMIN') return true;
    return !!user.menus?.includes(categoryId);
  }

  /** True when the user satisfies AT LEAST ONE of the requirements. */
  canAny(requirements: readonly AccessRequirement[]): boolean {
    return requirements.some(([featureId, action]) => this.can(featureId, action));
  }

  /** GET /api/profile/permissions - re-reads the role's permissions without logging in again. */
  refreshPermissions(): Observable<AuthUser | null> {
    return this.http
      .get<ApiResponse<PermissionsApiData>>(`${environment.apiBaseUrl}/api/profile/permissions`)
      .pipe(
        map(({ data }) => {
          const current = this.user();
          if (!current) return null;
          const next: AuthUser = {
            ...current,
            fullAccess: !!data.fullAccess,
            companyAdmin: !!data.companyAdmin,
            permissions: this.toPermissionMap(data.permissions),
            menus: data.menus ?? [],
          };
          this.tokenStorage.updateUser(next);
          this.user.set(next);
          return next;
        }),
      );
  }

  private toPermissionMap(rows: PermissionGrantApi[] | undefined): Record<string, PermissionFlags> {
    const map: Record<string, PermissionFlags> = {};
    for (const row of rows ?? []) {
      map[row.featureId] = {
        create: !!row.create,
        read: !!row.read,
        update: !!row.update,
        delete: !!row.delete,
      };
    }
    return map;
  }

  token(): string | null {
    return this.tokenStorage.getToken();
  }

  /** POST /api/auth/heartbeat - "this browser is still open" (dashboard Online Users). No-op when logged out. */
  sendHeartbeat(): Observable<unknown> {
    return this.tokenStorage.getToken() ? this.http.post(`${this.apiUrl}/heartbeat`, {}) : EMPTY;
  }

  logout(): void {
    // Best effort: tells the backend the user is offline (dashboard "Online Users"). The token is
    // passed explicitly because it is cleared right below; a failure must never block the logout.
    const token = this.tokenStorage.getToken();
    if (token) {
      this.http
        .post(`${this.apiUrl}/logout`, {}, { headers: { Authorization: `Bearer ${token}` } })
        .subscribe({ error: () => undefined });
    }
    this.tokenStorage.clear();
    this.user.set(null);
  }

  register(account: {
    firstName: string;
    lastName: string;
    email: string;
    countryCode: string;
    phoneNumber: string;
    password: string;
    confirmPassword: string;
    acceptTerms: boolean;
  }): Observable<unknown> {
    return this.http.post(`${this.apiUrl}/signup`, account);
  }

  sendForgotPassword(email: string): Observable<unknown> {
    return this.http.post(`${this.apiUrl}/forgot-password/send-reset-link`, { email });
  }

  resetPassword(token: string, newPassword: string, confirmPassword: string): Observable<unknown> {
    return this.http.post(`${this.apiUrl}/forgot-password/reset-password`, {
      token,
      newPassword,
      confirmPassword,
    });
  }

  /** NEW - POST /api/auth/change-password (any logged-in user). */
  changePassword(
    currentPassword: string,
    newPassword: string,
    confirmPassword: string,
  ): Observable<unknown> {
    return this.http.post(`${this.apiUrl}/change-password`, {
      currentPassword,
      newPassword,
      confirmPassword,
    });
  }

  /** GET /api/auth/signup/admins — User-table fields only (see PackageService for package fields). */
  listAdmins(query: AdminListQuery = {}): Observable<AdminPage> {
    let params = new HttpParams();
    if (query.search) params = params.set('search', query.search);
    if (query.status && query.status !== 'All') params = params.set('status', query.status);
    if (query.page !== undefined) params = params.set('page', query.page);
    if (query.size !== undefined) params = params.set('size', query.size);

    return this.http
      .get<ApiResponse<AdminPage>>(`${this.apiUrl}/signup/admins`, { params })
      .pipe(map(({ data }) => data));
  }

  private normalizeUser(user: AuthUser | null): AuthUser | null {
    if (!user) return null;
    return {
      ...user,
      roles: user.roles?.length ? user.roles : [this.toAuthority(user.role)],
      instructorId: user.instructorId ?? null,
      // sessions saved before permissions existed have none of these fields
      fullAccess: user.fullAccess ?? false,
      companyAdmin: user.companyAdmin ?? user.role?.trim().toUpperCase() === 'ADMIN',
      permissions: user.permissions ?? {},
      menus: user.menus ?? [],
    };
  }

  private toAuthority(role: string): string {
    const normalized = role.trim().toUpperCase();
    return normalized.startsWith('ROLE_') ? normalized : `ROLE_${normalized}`;
  }
}


export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const tokenStorage = inject(TokenStorageService);
  const router = inject(Router);
  const token = tokenStorage.getToken();
  const req = token ? request.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : request;

  return next(req).pipe(
    catchError((error) => {
      // Login/signup request-ku 401 normal (wrong password), so skip pannrom.
      const isAuthCall = request.url.includes('/api/auth/login') ||
        request.url.includes('/api/auth/signup') ||
        request.url.includes('/api/auth/2fa/login');
      if (error?.status === 401 && token && !isAuthCall) {
        tokenStorage.clear();
        void router.navigate(['/auth'], { queryParams: { view: 'login' } });
      }
      return throwError(() => error);
    }),
  );
};