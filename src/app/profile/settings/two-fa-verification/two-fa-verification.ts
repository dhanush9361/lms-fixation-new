import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  OnDestroy,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { toDataURL } from 'qrcode';
import { finalize } from 'rxjs';
import {
  TwoFactorAction,
  TwoFactorMethod,
  TwoFactorService,
} from '../../../services/two-factor.service';

export type TwoFaMethod = 'email' | 'google';
type Step = 'method' | 'qr' | 'otp';

interface MethodOption {
  id: TwoFaMethod;
  label: string;
  /** false = shown but not selectable yet ("Coming soon"). */
  available: boolean;
}

/** Only a short plain backend message is shown (Angular escapes it, so it is XSS-safe). */
const toMessage = (error: unknown, fallback: string): string => {
  const e = error as HttpErrorResponse;
  if (e?.status === 0 || e?.status >= 500) return fallback;
  const message: unknown = e?.error?.message;
  return typeof message === 'string' && message.trim() && message.length <= 200
    ? message.trim()
    : fallback;
};

/** Must match the tfa-*-out animation duration in styles.css. */
const CLOSE_MS = 220;
/** Must match the slide duration (duration-500) in the template. */
const SLIDE_MS = 500;
const OTP_LENGTH = 6;
const RESEND_SECONDS = 30;

@Component({
  selector: 'app-two-fa-verification',
  imports: [],
  templateUrl: './two-fa-verification.html',
  styleUrl: './two-fa-verification.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TwoFaVerification implements OnDestroy {
  private readonly api = inject(TwoFactorService);
  private readonly destroyRef = inject(DestroyRef);

  readonly methods: MethodOption[] = [
    { id: 'email', label: 'Email Verification', available: true },
    { id: 'google', label: 'Google Authenticator', available: true },
  ];

  /** Real state from GET /api/profile/2fa. */
  readonly enabled = signal(false);
  /** false until the first status response arrives - the main button stays disabled meanwhile. */
  readonly statusLoaded = signal(false);
  /** Where the OTP goes, e.g. j***@gmail.com. */
  readonly maskedEmail = signal('');
  /** Method that is active right now (null while 2FA is off). */
  readonly currentMethod = signal<TwoFactorMethod | null>(null);

  /** Google Authenticator setup: QR code image (data URL) + the key for "enter manually". */
  readonly qrDataUrl = signal('');
  readonly manualKey = signal('');

  readonly dialogOpen = signal(false);
  /** true while the close animation plays, then the dialog is removed from the DOM. */
  readonly closing = signal(false);

  /** 'enable' = Turn On flow (pick method -> OTP). 'disable' = Turn Off flow (OTP only). */
  readonly mode = signal<'enable' | 'disable'>('enable');

  /** Which slide is showing: 1) pick a method  2) scan the QR code (authenticator only)  3) enter the code. */
  readonly step = signal<Step>('method');
  /** No method is preselected; the user must choose one before continuing. */
  readonly selected = signal<TwoFaMethod | null>(null);

  readonly otp = signal('');
  readonly verified = signal(false);
  /** Seconds left before "Resend OTP" can be used again (0 = can resend). */
  readonly cooldown = signal(0);

  /** Request in flight (send / verify) - buttons are disabled meanwhile. */
  readonly busy = signal(false);
  readonly error = signal('');

  /** The code comes from the Google Authenticator app (nothing is e-mailed, so nothing to resend). */
  readonly usesAuthenticator = computed(() =>
    this.mode() === 'disable' ? this.currentMethod() === 'AUTHENTICATOR' : this.selected() === 'google',
  );
  /** translate-x class for the sliding steps. */
  readonly slideClass = computed(() =>
    this.step() === 'method' ? 'translate-x-0' : this.step() === 'qr' ? '-translate-x-full' : '-translate-x-[200%]',
  );

  readonly canVerify = computed(
    () => this.otp().length === OTP_LENGTH && !this.verified() && !this.busy(),
  );
  readonly otpLength = OTP_LENGTH;

  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  private readonly otpInput = viewChild<ElementRef<HTMLInputElement>>('otpInput');
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private cooldownTimer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    this.api
      .getStatus()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (status) => {
          this.enabled.set(status.enabled);
          this.currentMethod.set(status.method);
          this.maskedEmail.set(status.maskedEmail);
          this.statusLoaded.set(true);
        },
        // Leave the button disabled: showing a wrong "Turn On" for an account that has 2FA on would mislead.
        error: () => this.error.set('Unable to load your 2FA settings. Please refresh the page.'),
      });
  }

  private get action(): TwoFactorAction {
    return this.mode() === 'disable' ? 'DISABLE' : 'ENABLE';
  }

  /** "Turn On" opens the method popup; "Turn Off" opens the popup straight at the OTP step. */
  onMainButton(): void {
    if (!this.statusLoaded()) return;

    clearTimeout(this.closeTimer);
    this.resetDialog();
    this.mode.set(this.enabled() ? 'disable' : 'enable');
    this.closing.set(false);
    this.dialogOpen.set(true);
    // Move focus into the dialog once it has rendered (keyboard / screen reader users).
    setTimeout(() => {
      const panel = this.panel()?.nativeElement;
      panel?.focus();
      // The existing template uses a fixed title; set its text for the enable flow
      // without changing the popup markup or its styling.
      const title = panel?.querySelector<HTMLElement>('[aria-labelledby="tfa-title"] h3, #tfa-title');
      if (title) title.textContent = this.mode() === 'enable' ? 'Email Verification' : 'Verification';
    }, 0);

    if (this.mode() === 'disable') {
      this.step.set('otp');
      this.sendOtp(() => setTimeout(() => this.otpInput()?.nativeElement.focus(), 0));
    }
  }

  select(id: TwoFaMethod): void {
    const option = this.methods.find((m) => m.id === id);
    if (option?.available) this.selected.set(id);
  }

  /**
   * Step 1 -> next. E-mail: send the OTP, then show the code step.
   * Google Authenticator: fetch a new secret, draw the QR code, show the QR step.
   */
  next(): void {
    if (this.busy()) return;

    const method = this.selected();
    if (!method) {
      this.error.set('Please select a verification method to continue.');
      return;
    }

    if (method === 'google') {
      this.startAuthenticatorSetup();
      return;
    }
    this.sendOtp(() => this.showOtpStep());
  }

  /** QR step -> code step ("I've scanned it"). */
  qrScanned(): void {
    this.showOtpStep();
  }

  private showOtpStep(): void {
    this.step.set('otp');
    setTimeout(() => this.otpInput()?.nativeElement.focus(), SLIDE_MS);
  }

  private startAuthenticatorSetup(): void {
    this.busy.set(true);
    this.error.set('');
    this.api
      .setupAuthenticator()
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: async (setup) => {
          try {
            this.qrDataUrl.set(await toDataURL(setup.otpauthUri, { width: 192, margin: 1 }));
          } catch {
            this.qrDataUrl.set(''); // the manual key below still works
          }
          this.manualKey.set(setup.secret.replace(/(.{4})/g, '$1 ').trim());
          this.step.set('qr');
        },
        error: (error: unknown) =>
          this.error.set(toMessage(error, 'Unable to start Google Authenticator setup. Please try again later.')),
      });
  }

  onOtpInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const digits = input.value.replace(/\D/g, '').slice(0, OTP_LENGTH);
    input.value = digits; // keep the field numeric only
    this.otp.set(digits);
    this.error.set('');
  }

  /** Verifies the OTP and turns 2FA on / off in the same request. */
  verify(): void {
    if (!this.canVerify()) return;

    this.busy.set(true);
    this.error.set('');

    const request$ = this.mode() === 'disable' ? this.api.disable(this.otp()) : this.api.enable(this.otp());
    request$
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (status) => {
          this.verified.set(true);
          this.enabled.set(status.enabled);
          this.currentMethod.set(status.method);
          this.stopCooldown();
        },
        error: (error: unknown) => {
          this.error.set(toMessage(error, 'Unable to verify the code. Please try again.'));
          // Expired / too many attempts: the code is gone, so let the user ask for a new one right away.
          if ((error as HttpErrorResponse)?.status === 410 || (error as HttpErrorResponse)?.status === 429) {
            this.otp.set('');
            const el = this.otpInput()?.nativeElement;
            if (el) el.value = '';
          }
        },
      });
  }

  resend(): void {
    if (this.cooldown() > 0 || this.verified() || this.busy()) return;
    this.sendOtp(() => {
      this.otp.set('');
      const el = this.otpInput()?.nativeElement;
      if (el) {
        el.value = '';
        el.focus();
      }
    });
  }

  /** The server already switched 2FA on / off when the OTP was verified - "Done" just closes the popup. */
  save(): void {
    if (!this.verified()) return;
    this.close();
  }

  @HostListener('document:keydown.escape')
  close(): void {
    if (!this.dialogOpen() || this.closing()) return;
    this.closing.set(true);
    this.closeTimer = setTimeout(() => {
      this.dialogOpen.set(false);
      this.closing.set(false);
      this.stopCooldown();
    }, CLOSE_MS);
  }

  ngOnDestroy(): void {
    clearTimeout(this.closeTimer);
    this.stopCooldown();
  }

  /** POST /api/profile/2fa/send-otp, then start the resend cooldown. */
  private sendOtp(onSuccess?: () => void): void {
    this.busy.set(true);
    this.error.set('');
    this.api
      .sendOtp(this.action)
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          if (!this.usesAuthenticator()) this.startCooldown();
          onSuccess?.();
        },
        error: (error: unknown) =>
          this.error.set(toMessage(error, 'Unable to send the verification code. Please try again later.')),
      });
  }

  private resetDialog(): void {
    this.step.set('method');
    this.selected.set(null);
    this.qrDataUrl.set('');
    this.manualKey.set('');
    this.otp.set('');
    this.verified.set(false);
    this.busy.set(false);
    this.error.set('');
    this.stopCooldown();
  }

  private startCooldown(): void {
    this.stopCooldown();
    this.cooldown.set(RESEND_SECONDS);
    this.cooldownTimer = setInterval(() => {
      const left = this.cooldown() - 1;
      this.cooldown.set(Math.max(0, left));
      if (left <= 0) this.stopCooldown();
    }, 1000);
  }

  private stopCooldown(): void {
    clearInterval(this.cooldownTimer);
    this.cooldownTimer = undefined;
    this.cooldown.set(0);
  }
}
