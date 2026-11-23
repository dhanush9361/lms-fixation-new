import { Component, ElementRef, HostListener, OnInit, AfterViewInit, OnDestroy, ViewChild, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { finalize } from 'rxjs';
import { AuthService } from '../../services/auth';
import {
  LearnerDashboardData,
  LearnerDashboardService,
  CourseStatus,
} from '../../services/learner-dashboard.service';

interface TrainingAxis {
  unit: 'Hrs' | 'min';
  /** Labels from top to bottom. 7 labels = the 7 grid lines of the chart. */
  ticks: number[];
  /** Value of the top line, in minutes. */
  topMinutes: number;
}

interface TrainingPoint {
  name: string;
  minutes: number;
  /** e.g. "1h 05m" */
  label: string;
  /** 0-100 position inside the plot */
  x: number;
  y: number;
}

interface TrainingChart {
  points: TrainingPoint[];
  line: string;
  area: string;
  cols: number;
}

@Component({
  selector: 'app-learner-dashboard-home',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './learner-dashboard-home.html',
  styles: [`
    :host { display: block; }

    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(16px); }
      to   { opacity: 1; transform: none; }
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    @keyframes growUp {
      from { transform: scaleY(0); }
      to   { transform: scaleY(1); }
    }
    @keyframes popIn {
      0%   { transform: scale(0); opacity: 0; }
      70%  { transform: scale(1.4); opacity: 1; }
      100% { transform: scale(1); opacity: 1; }
    }
    @keyframes reveal {
      from { clip-path: inset(-8px 100% -8px -8px); }
      to   { clip-path: inset(-8px -8px -8px -8px); }
    }

    /* 'backwards' = only the start state is held during the delay, so hover transforms still work afterwards */
    .stat-card, .card-in { animation: fadeUp .7s cubic-bezier(.22, 1, .36, 1) backwards; }
    .legend-in           { animation: fadeUp .6s cubic-bezier(.22, 1, .36, 1) backwards; }
    .bar-grow            { transform-origin: bottom; animation: growUp .9s cubic-bezier(.22, 1, .36, 1) backwards; }
    .dot-pop             { animation: popIn .55s cubic-bezier(.34, 1.56, .64, 1) backwards; }
    .chart-reveal        { animation: reveal 1.3s cubic-bezier(.65, 0, .35, 1) .15s backwards; }
    .tip                 { animation: fadeIn .15s ease-out; }

    @keyframes shimmer  { from { background-position: 100% 0; } to { background-position: 0% 0; } }
    @keyframes barIn    { from { clip-path: inset(50% 0 50% 0); } to { clip-path: inset(0 0 0 0); } }
    @keyframes drawX    { from { transform: scaleX(0); opacity: 0; } to { transform: scaleX(1); opacity: 1; } }
    @keyframes donutIn  { from { opacity: 0; transform: rotate(-120deg) scale(.7); } to { opacity: 1; transform: none; } }
    @keyframes dotPulse { 0% { box-shadow: 0 0 0 0 rgba(92, 115, 232, .55); } 70%, 100% { box-shadow: 0 0 0 11px rgba(92, 115, 232, 0); } }
    @keyframes stemGrow { from { clip-path: inset(0 0 100% 0); } to { clip-path: inset(0 0 0 0); } }
    @keyframes slideIn  { from { opacity: 0; transform: translateX(18px); } to { opacity: 1; transform: none; } }

    .stat-bar        { animation: barIn .7s cubic-bezier(.22, 1, .36, 1) backwards; }
    .grid-draw       { transform-origin: left; animation: drawX .9s cubic-bezier(.22, 1, .36, 1) backwards; }
    .legend-in       { animation: slideIn .6s cubic-bezier(.22, 1, .36, 1) backwards; }
    .donut-in        { animation: donutIn 1s cubic-bezier(.22, 1, .36, 1) .5s backwards; }
    .center-pop      { animation: popIn .6s cubic-bezier(.34, 1.56, .64, 1) 1.1s backwards; }
    .dot-pulse       { animation: popIn .55s cubic-bezier(.34, 1.56, .64, 1) backwards, dotPulse 2.4s ease-out 1.4s infinite; }
    .stem-grow       { animation: stemGrow .6s ease-out .9s backwards; }
    .welcome-shimmer {
      background: linear-gradient(100deg, #62bdca 0%, #62bdca 38%, #bdeff5 50%, #62bdca 62%, #62bdca 100%);
      background-size: 300% 100%;
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
      color: transparent;
      animation: shimmer 2.6s ease-in-out 1s 2;
    }

    @media (prefers-reduced-motion: reduce) {
      * { animation: none !important; transition: none !important; }
    }
  `],
})
export class LearnerDashboardHome implements OnInit, AfterViewInit, OnDestroy {

  private authService = inject(AuthService);
  private dashboardService = inject(LearnerDashboardService);

  @ViewChild('root', { static: true }) private rootRef!: ElementRef<HTMLElement>;

  displayName = this.authService.displayName;

  dashboard = signal<LearnerDashboardData | null>(null);

  loading = signal(false);
  error = signal('');

  isVisible = signal(false);

  /** 0 -> 1 intro animation (count-up numbers + doughnut sweep). */
  progress = signal(0);
  private rafId = 0;
  private fitRaf = 0;
  private resizeObserver?: ResizeObserver;

  /** Set to false if the blue centre circle of the doughnut should stay empty (exactly like the Figma). */
  readonly showDonutTotal = true;

  /** Training Analytics shows this many courses per page (‹ › buttons). */
  readonly trainingPageSize = 5;
  trainingPage = signal(0);
  hoveredTraining = signal<number | null>(null);

  /** Quiz Scores chart shows this many quizzes per page (‹ › buttons). */
  readonly quizPageSize = 4;
  quizPage = signal(0);
  readonly quizTicks = [100, 75, 50, 25, 0];

  ngOnInit(): void {
    this.loadDashboard();
  }

  ngAfterViewInit(): void {
    requestAnimationFrame(() => {
      this.isVisible.set(true);
      this.fitToViewport();
      setTimeout(() => this.fitToViewport(), 300); // header / sidebar may finish layout a moment later

      // Re-fit whenever the shell (header, sidebar, fonts) changes the page size.
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => {
          cancelAnimationFrame(this.fitRaf);
          this.fitRaf = requestAnimationFrame(() => this.fitToViewport());
        });
        this.resizeObserver.observe(document.body);
      }
      document.fonts?.ready.then(() => this.fitToViewport());
    });
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.rafId);
    cancelAnimationFrame(this.fitRaf);
    this.resizeObserver?.disconnect();
    this.setPageScrollLocked(false);
  }

  /**
   * No page scroll on desktop: the dashboard gets exactly the free space under the header.
   * Works whatever the shell looks like (window scroll or an inner scroll container).
   */
  @HostListener('window:resize')
  fitToViewport(): void {
    const root = this.rootRef?.nativeElement;
    if (!root || typeof window === 'undefined') return;

    root.style.height = '';
    if (window.innerWidth < 1280) { // small screens scroll normally
      this.setPageScrollLocked(false);
      return;
    }

    const minHeight = 560;
    const scroller = this.findScroller();
    const rect = root.getBoundingClientRect();
    const isDoc = scroller === document.documentElement;

    const available = isDoc
      ? window.innerHeight - (rect.top + window.scrollY)
      : scroller.clientHeight - (rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop);

    let height = Math.max(minHeight, Math.floor(available));
    root.style.height = `${height}px`;

    // Safety passes: remove whatever the shell still adds below the dashboard (padding, footer ...).
    for (let i = 0; i < 4; i++) {
      const over = this.pageOverflow(scroller);
      if (over <= 0 || height <= minHeight) break;
      height = Math.max(minHeight, height - over);
      root.style.height = `${height}px`;
    }

    // Whatever the shell still adds, never show a page scrollbar on this screen.
    this.setPageScrollLocked(true, scroller);
  }

  private lockedEls: { el: HTMLElement; value: string; priority: string }[] = [];

  /** Hides the page scrollbar while the dashboard is on screen (restored when it leaves). */
  private setPageScrollLocked(locked: boolean, scroller?: HTMLElement): void {
    if (!locked) {
      this.lockedEls.forEach(({ el, value, priority }) => {
        if (value) el.style.setProperty('overflow-y', value, priority);
        else el.style.removeProperty('overflow-y');
      });
      this.lockedEls = [];
      return;
    }

    [document.documentElement, document.body, scroller].forEach(el => {
      if (!el || this.lockedEls.some(item => item.el === el)) return;

      this.lockedEls.push({
        el,
        value: el.style.getPropertyValue('overflow-y'),
        priority: el.style.getPropertyPriority('overflow-y'),
      });
      el.style.setProperty('overflow-y', 'hidden', 'important');
    });
  }

  /** Largest vertical overflow among every element that could own the page scrollbar. */
  private pageOverflow(scroller: HTMLElement): number {
    const candidates = new Set<Element | null>([
      document.scrollingElement,
      document.documentElement,
      document.body,
      scroller,
    ]);

    let over = 0;
    candidates.forEach(el => {
      if (el) over = Math.max(over, el.scrollHeight - el.clientHeight);
    });
    return over;
  }

  private findScroller(): HTMLElement {
    let el: HTMLElement | null = this.rootRef.nativeElement.parentElement;

    while (el && el !== document.documentElement) {
      const overflowY = getComputedStyle(el).overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
        return el;
      }
      el = el.parentElement;
    }

    return document.documentElement;
  }

  loadDashboard(): void {
    this.loading.set(true);
    this.error.set('');

    // ONE request - the server counts courses, quiz scores and study time of the logged-in learner.
    this.dashboardService.getDashboard()
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (data) => {
          this.dashboard.set(data);
          this.trainingPage.set(0);
          // Open on the newest quizzes (the list is oldest first).
          this.quizPage.set(Math.max(0, Math.ceil(data.quizScores.length / this.quizPageSize) - 1));
          this.startProgress();
          requestAnimationFrame(() => this.fitToViewport());
        },

        error: (err) => {
          console.error('Learner dashboard API error:', err);

          this.dashboard.set(null);
          this.progress.set(0);

          this.error.set(
            err.status === 0
              ? 'Network error. Please check your internet connection.'
              : err.status === 401
                ? 'Your session has expired. Please log in again.'
                : 'Unable to load dashboard data. Please try again.'
          );
        }
      });
  }

  /** Eased 0 -> 1 tween that drives the number count-up and the doughnut sweep. */
  private startProgress(): void {
    cancelAnimationFrame(this.rafId);

    const reduce = typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (reduce) {
      this.progress.set(1);
      return;
    }

    const duration = 1100;
    const start = performance.now();
    this.progress.set(0);

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      this.progress.set(1 - Math.pow(1 - t, 3)); // easeOutCubic
      if (t < 1) this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------- stat cards

  get passPercent(): number {
    return this.dashboard()?.passPercent ?? 50;
  }

  readonly stats = computed(() => {
    const d = this.dashboard();
    const p = this.progress();

    const fmt = (n: number | undefined) =>
      d && n != null ? String(Math.round(n * p)).padStart(2, '0') : '—';

    return [
      {
        lines: ['Passed', 'Quizzes'],
        color: '#a064f5',
        display: fmt(d?.passedQuizzes),
        title: `Quizzes submitted with a score of ${this.passPercent}% or more`,
      },
      { lines: ['My Enrolled', 'Courses'], color: '#7185ed', display: fmt(d?.enrolledCourses), title: null },
      { lines: ['Completed', 'Courses'], color: '#65c98b', display: fmt(d?.completedCourses), title: null },
      { lines: ['In Progress', 'Courses'], color: '#ffc44f', display: fmt(d?.inProgressCourses), title: null },
      { lines: ['Not Started', 'Courses'], color: '#ff6868', display: fmt(d?.notStartedCourses), title: null },
    ];
  });

  // ---------------------------------------------------------------- course status (doughnut)

  get courseStatus(): CourseStatus | null {
    return this.dashboard()?.courseStatus ?? null;
  }

  get totalCourses(): number {
    const status = this.courseStatus;

    if (!status) return 0;

    return status.completed +
      status.inProgress +
      status.notStarted;
  }

  get hasCourseStatus(): boolean {
    return this.totalCourses > 0;
  }

  /** The blue "Not Started" circle is drawn only when at least one course is not started. */
  get hasNotStarted(): boolean {
    return (this.courseStatus?.notStarted ?? 0) > 0;
  }

  get hasQuizScores(): boolean {
    return (this.dashboard()?.quizScores.length ?? 0) > 0;
  }

  get hasTrainingTime(): boolean {
    return (this.dashboard()?.trainingTime.length ?? 0) > 0;
  }

  get completedPercentage(): number {
    if (!this.totalCourses || !this.courseStatus) return 0;

    return (this.courseStatus.completed / this.totalCourses) * 100;
  }

  get inProgressPercentage(): number {
    if (!this.totalCourses || !this.courseStatus) return 0;

    return (this.courseStatus.inProgress / this.totalCourses) * 100;
  }

  get notStartedPercentage(): number {
    if (!this.totalCourses || !this.courseStatus) return 0;

    return (this.courseStatus.notStarted / this.totalCourses) * 100;
  }

  /** The ring is "drawn" clockwise while progress goes 0 -> 1. */
  get doughnutGradient(): string {
    if (!this.hasCourseStatus || !this.courseStatus) {
      return 'conic-gradient(#e5e7eb 0deg 360deg)';
    }

    const p = this.progress();

    // Only statuses that really have courses become part of the ring.
    const parts = [
      { color: '#60bdca', deg: this.completedPercentage * 3.6 },
      { color: '#a064f5', deg: this.inProgressPercentage * 3.6 },
      { color: '#5c73e8', deg: this.notStartedPercentage * 3.6 },
    ].filter(part => part.deg > 0);

    let from = 0;
    const stops = parts.map(part => {
      const to = from + part.deg * p;
      const stop = `${part.color} ${from}deg ${to}deg`;
      from = to;
      return stop;
    });
    stops.push(`#eef0f3 ${from}deg 360deg`);

    return `conic-gradient(${stops.join(', ')})`;
  }

  readonly legend = computed(() => {
    const s = this.dashboard()?.courseStatus;
    if (!s) return [];

    // Legend only lists statuses that have data.
    return [
      { name: 'Completed', color: '#60bdca', value: s.completed, title: `Completed: ${s.completed}` },
      { name: 'In-Progress', color: '#a064f5', value: s.inProgress, title: `In-Progress: ${s.inProgress}` },
      { name: 'Not Started', color: '#5c73e8', value: s.notStarted, title: `Not Started: ${s.notStarted}` },
    ].filter(item => item.value > 0);
  });

  // ---------------------------------------------------------------- training analytics (study time)

  /** Y-axis: minutes for short times, hours once a course passes 1 hour. Based on ALL courses so it stays stable while paging. */
  readonly trainingAxis = computed<TrainingAxis>(() => {
    const records = this.dashboard()?.trainingTime ?? [];
    const maxMinutes = records.reduce((max, record) => Math.max(max, record.totalMinutes), 0);

    if (maxMinutes <= 0) {
      return { unit: 'Hrs', ticks: [12, 10, 8, 6, 4, 2, 0], topMinutes: 720 };
    }

    // 6 equal steps between 0 and the top line.
    if (maxMinutes < 60) {
      const step = Math.max(1, Math.ceil(maxMinutes / 6));
      return { unit: 'min', ticks: this.buildTicks(step), topMinutes: step * 6 };
    }

    const step = Math.max(1, Math.ceil(maxMinutes / 60 / 6));
    return { unit: 'Hrs', ticks: this.buildTicks(step), topMinutes: step * 6 * 60 };
  });

  readonly trainingPageItems = computed(() => {
    const all = this.dashboard()?.trainingTime ?? [];
    const start = this.trainingPage() * this.trainingPageSize;
    return all.slice(start, start + this.trainingPageSize);
  });

  readonly trainingPageCount = computed(() => {
    const total = this.dashboard()?.trainingTime.length ?? 0;
    return Math.max(1, Math.ceil(total / this.trainingPageSize));
  });

  /** Area/line chart model. x and y are 0-100 (y = 0 is the top grid line). */
  readonly trainingChart = computed<TrainingChart>(() => {
    const items = this.trainingPageItems();
    const top = this.trainingAxis().topMinutes;
    const cols = Math.max(1, items.length);

    const points: TrainingPoint[] = items.map((record, i) => ({
      name: record.courseName,
      minutes: record.totalMinutes,
      label: this.formatTrainingTime(record.totalMinutes),
      x: ((i + 0.5) / cols) * 100,
      y: 100 - Math.min(100, Math.max(0, (record.totalMinutes / top) * 100)),
    }));

    const line = this.smoothPath(points);
    const area = points.length > 1
      ? `${line} L${points[points.length - 1].x},100 L${points[0].x},100 Z`
      : '';

    return { points, line, area, cols };
  });

  /** Changing value re-creates the chart layer so the draw-in animation plays again on every page. */
  get trainingKey(): number[] {
    return [this.trainingPage()];
  }

  get canPrevTrainingPage(): boolean {
    return this.trainingPage() > 0;
  }

  get canNextTrainingPage(): boolean {
    return this.trainingPage() < this.trainingPageCount() - 1;
  }

  prevTrainingPage(): void {
    if (!this.canPrevTrainingPage) return;
    this.hoveredTraining.set(null);
    this.trainingPage.update(page => page - 1);
  }

  nextTrainingPage(): void {
    if (!this.canNextTrainingPage) return;
    this.hoveredTraining.set(null);
    this.trainingPage.update(page => page + 1);
  }

  private buildTicks(step: number): number[] {
    return [6, 5, 4, 3, 2, 1, 0].map(i => i * step);
  }

  /** Smooth curve through the points (Catmull-Rom -> Bezier), never dipping below/above its neighbours. */
  private smoothPath(pts: { x: number; y: number }[]): string {
    if (pts.length === 0) return '';
    if (pts.length === 1) return `M${pts[0].x},${pts[0].y}`;

    const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
    const k = 1 / 6;
    let d = `M${pts[0].x},${pts[0].y}`;

    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] ?? p2;

      const lo = Math.min(p1.y, p2.y);
      const hi = Math.max(p1.y, p2.y);

      const c1x = p1.x + (p2.x - p0.x) * k;
      const c1y = clamp(p1.y + (p2.y - p0.y) * k, lo, hi);
      const c2x = p2.x - (p3.x - p1.x) * k;
      const c2y = clamp(p2.y - (p3.y - p1.y) * k, lo, hi);

      d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`;
    }

    return d;
  }

  formatTrainingTime(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;

    return hours > 0
      ? `${hours}h ${String(remainingMinutes).padStart(2, '0')}m`
      : `${remainingMinutes}m`;
  }

  // ---------------------------------------------------------------- quiz scores

  get quizPageCount(): number {
    const total = this.dashboard()?.quizScores.length ?? 0;
    return Math.max(1, Math.ceil(total / this.quizPageSize));
  }

  readonly quizPageItems = computed(() => {
    const start = this.quizPage() * this.quizPageSize;
    return (this.dashboard()?.quizScores ?? []).slice(start, start + this.quizPageSize);
  });

  get canPrevQuizPage(): boolean {
    return this.quizPage() > 0;
  }

  get canNextQuizPage(): boolean {
    return this.quizPage() < this.quizPageCount - 1;
  }

  prevQuizPage(): void {
    if (this.canPrevQuizPage) this.quizPage.update(page => page - 1);
  }

  nextQuizPage(): void {
    if (this.canNextQuizPage) this.quizPage.update(page => page + 1);
  }

  getQuizPercentage(score: number, maxScore: number): number {
    if (!maxScore || maxScore <= 0) return 0;

    return Math.min(100, Math.max(0, (score / maxScore) * 100));
  }

  retry(): void {
    this.loadDashboard();
  }
}