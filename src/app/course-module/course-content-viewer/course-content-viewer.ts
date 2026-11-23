import { Location } from '@angular/common';
import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { EMPTY, forkJoin, of, timer } from 'rxjs';
import { catchError, filter, switchMap } from 'rxjs/operators';

import { Section, SectionManagementService } from '../../services/Section management.service';
import { MultimediaManagementService } from '../../services/multimedia-management.service';
import { EbookManagementService } from '../../services/ebook-management.service';
import { CourseProgress, SectionProgressService } from '../../services/section-progress.service';
import { StudyTimeService } from '../../services/study-time.service';
import { QuestionBankService } from '../../services/question-bank.service';
import { QuizAttemptService } from '../../services/quiz-attempt.service';
import { CourseManagementService } from '../../services/course-management.service'; // adjust the path/file name to your project
import { AuthService, FEATURE } from '../../services/auth';
import { environment } from '../../../environments/environment'; // adjust the path to your project
import { ApiBankResponse } from '../question-bank.model';
import { MultimediaResource, extensionOf, trustedMediaUrl } from '../multimedia.model';
import { QuizAttemptPage } from '../quiz-attempt/quiz-attempt'; // adjust the path to your project
import { EbookSummary } from '../ebook/ebook-api.model';
import { Section as EbookPage } from '../ebook/models';
import { EbookReader } from '../ebook/ebook-reader/ebook-reader';
import { activityOrderKey, applyActivityOrder, readActivityOrder } from '../activity-order';

type ViewMode = 'desktop' | 'tablet' | 'mobile';
type TabKind = 'Ebook' | 'Multimedia' | 'Question Bank';
type MediaKind = 'image' | 'video' | 'audio' | 'pdf' | 'docx' | 'office' | 'other';

interface ContentTab {
  key: string;
  label: string;
  kind: TabKind;
  /** createdAt timestamp (ms) - used to show the tabs in the order they were added. */
  addedAt: number;
  resource?: MultimediaResource;
  bankId?: number;
  ebookId?: number;
}

interface ActiveMedia {
  kind: MediaKind;
  /** Plain https URL (image / video / audio / download link). */
  url: string | null;
  /** Sanitized URL for the <iframe> (PDF directly, Office files through Microsoft's embed viewer). */
  frameUrl: SafeResourceUrl | null;
}

const MIN_HEIGHT = 520;
const BOTTOM_GAP = 0;
const DESKTOP_MIN_WIDTH = 1024;

const OFFICE_EXTENSIONS: ReadonlySet<string> = new Set(['docx', 'pptx', 'xlsx']);

@Component({
  selector: 'app-course-content-viewer',
  imports: [QuizAttemptPage, EbookReader],
  host: { class: 'block' },
  templateUrl: './course-content-viewer.html',
  styleUrl: './course-content-viewer.css',
})
export class CourseContentViewer implements OnInit, AfterViewInit {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly destroyRef = inject(DestroyRef);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly sectionService = inject(SectionManagementService);
  private readonly progressService = inject(SectionProgressService);
  private readonly multimediaService = inject(MultimediaManagementService);
  private readonly ebookService = inject(EbookManagementService);
  private readonly questionBankService = inject(QuestionBankService);
  private readonly quizService = inject(QuizAttemptService);
  private readonly courseService = inject(CourseManagementService);
  private readonly auth = inject(AuthService);
  private readonly studyTime = inject(StudyTimeService);

  /** Admins / instructors who may organize modules manage the quiz; everyone else (learners) attempts it. */
  private isLearnerView(): boolean {
    return !this.auth.can(FEATURE.COURSE_ORGANIZE, 'update');
  }

  /** Used by the template: learners see the quiz inline, admins / instructors get the Question Bank button. */
  readonly learnerView = computed(() => this.isLearnerView());

  /** Public: the template passes it to <app-quiz-attempt>. */
  courseId = 0;

  /** Course thumbnail, shown on the "Ready to take the quiz?" page. */
  readonly courseThumbnail = signal<string | null>(null);

  // ---------- data ----------
  readonly sections = signal<Section[]>([]);
  /** Learner progress (tracked = false for admins / instructors: no completion marks and no quiz lock). */
  readonly progress = signal<CourseProgress | null>(null);
  readonly canTrackProgress = computed(() => this.progress()?.tracked === true);
  readonly selectedSectionId = signal<number | null>(null);
  readonly tabs = signal<ContentTab[]>([]);
  readonly activeTabKey = signal<string>('');
  readonly loading = signal(false);
  readonly error = signal('');

  /** Which online viewer renders DOCX / PPTX / XLSX. Switchable if one of them can't open the file. */
  readonly officeViewer = signal<'microsoft' | 'google'>('microsoft');

  toggleOfficeViewer(): void {
    this.officeViewer.update(v => (v === 'microsoft' ? 'google' : 'microsoft'));
  }

  /** True while the Office embed iframe is still loading (Microsoft/Google fetch the file server-side). */
  readonly frameLoading = signal(false);

  /** DOCX is rendered locally in the browser with docx-preview (no Microsoft/Google server involved). */
  private readonly docxHost = viewChild<ElementRef<HTMLDivElement>>('docxHost');
  readonly docxLoading = signal(false);
  /** Tab key whose local DOCX render failed (e.g. CORS) - that tab falls back to the online viewer. */
  private readonly docxFailedKey = signal('');
  private docxToken = 0;
  /** Downloaded DOCX files (by URL), so a tab opens instantly if it was prefetched or opened before. */
  private readonly docxCache = new Map<string, Promise<Blob>>();

  private fetchDocx(url: string): Promise<Blob> {
    let cached = this.docxCache.get(url);
    if (!cached) {
      cached = fetch(url).then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      });
      cached.catch(() => this.docxCache.delete(url)); // don't cache failures
      this.docxCache.set(url, cached);
    }
    return cached;
  }

  /** Background-download the section's DOCX files (and load docx-preview) while the user reads the first tab. */
  private prefetchDocx(tabs: ContentTab[]): void {
    this.docxCache.clear();
    const urls = tabs
      .map(t => t.resource)
      .filter((r): r is MultimediaResource => !!r)
      .filter(r => (extensionOf(r.originalFileName) || (r.fileExtension ?? '').toLowerCase()) === 'docx')
      .map(r => trustedMediaUrl(r.fileUrl))
      .filter((u): u is string => !!u)
      .slice(0, 5);
    if (!urls.length) return;
    void import('docx-preview');
    urls.forEach(u => this.fetchDocx(u).catch(() => undefined));
  }

  constructor() {
    // Whenever the active media changes (new tab or viewer switched), show the spinner again for Office files.
    effect(() => {
      this.frameLoading.set(this.activeMedia()?.kind === 'office');
    });

    // Re-check the tab arrows whenever the tabs or the preview size change.
    effect(() => {
      this.tabs();
      this.viewMode();
      this.tabStrip();
      setTimeout(() => this.updateTabScroll());
    });

    // Render DOCX locally once its host <div> exists in the template.
    effect(() => {
      const media = this.activeMedia();
      const host = this.docxHost()?.nativeElement;
      if (media?.kind !== 'docx' || !media.url || !host) return;
      const url = media.url;
      untracked(() => void this.renderDocx(url, host));
    });
  }

  private async renderDocx(url: string, host: HTMLElement): Promise<void> {
    const token = ++this.docxToken;
    const tabKey = this.activeTabKey();
    this.docxLoading.set(true);
    host.innerHTML = '';
    try {
      const blob = await this.fetchDocx(url);
      if (token !== this.docxToken) return;
      const { renderAsync } = await import('docx-preview');
      if (token !== this.docxToken) return;
      await renderAsync(blob, host, undefined, {
        className: 'docx',
        inWrapper: true,
        breakPages: true,
      });
    } catch {
      // Could not fetch/render locally (CORS, corrupt file...) -> fall back to the online viewer for this tab.
      if (token === this.docxToken) this.docxFailedKey.set(tabKey);
    } finally {
      if (token === this.docxToken) {
        this.docxLoading.set(false);
        // a short document that fits on screen counts as fully read; a long one counts what is visible
        setTimeout(() => this.updateDocxProgress(host), 300);
      }
    }
  }

  onFrameLoaded(): void {
    this.frameLoading.set(false);
  }

  // ---------- tab strip scrolling (the arrows scroll the tabs; they do not change the selected tab) ----------
  private readonly tabStrip = viewChild<ElementRef<HTMLDivElement>>('tabStrip');
  readonly canScrollLeft = signal(false);
  readonly canScrollRight = signal(false);

  scrollTabs(direction: -1 | 1): void {
    const el = this.tabStrip()?.nativeElement;
    if (!el) return;
    el.scrollBy({ left: direction * Math.max(120, el.clientWidth * 0.7), behavior: 'smooth' });
  }

  updateTabScroll(): void {
    const el = this.tabStrip()?.nativeElement;
    if (!el) {
      this.canScrollLeft.set(false);
      this.canScrollRight.set(false);
      return;
    }
    this.canScrollLeft.set(el.scrollLeft > 1);
    this.canScrollRight.set(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }

  @HostListener('window:resize')
  onTabStripResize(): void {
    this.updateTabScroll();
  }

  readonly activeTab = computed(() => this.tabs().find(t => t.key === this.activeTabKey()) ?? null);
  readonly activeIndex = computed(() => this.tabs().findIndex(t => t.key === this.activeTabKey()));
  readonly canPrev = computed(() => this.activeIndex() > 0);
  readonly canNext = computed(() => this.activeIndex() >= 0 && this.activeIndex() < this.tabs().length - 1);

  /**
   * Computed once per active tab (NOT in a template method) so the iframe gets the same
   * SafeResourceUrl object on every change detection run and doesn't reload.
   */
  readonly activeMedia = computed<ActiveMedia | null>(() => {
    const resource = this.activeTab()?.resource;
    if (!resource) return null;

    const url = trustedMediaUrl(resource.fileUrl);
    if (!url) return { kind: 'other', url: null, frameUrl: null };

    const ext = extensionOf(resource.originalFileName) || (resource.fileExtension ?? '').toLowerCase();
    if (['jpg', 'jpeg', 'png'].includes(ext)) return { kind: 'image', url, frameUrl: null };
    if (ext === 'mp4') return { kind: 'video', url, frameUrl: null };
    if (ext === 'mp3') return { kind: 'audio', url, frameUrl: null };
    if (ext === 'pdf') {
      return { kind: 'pdf', url, frameUrl: this.sanitizer.bypassSecurityTrustResourceUrl(url) };
    }
    if (ext === 'docx' && this.docxFailedKey() !== this.activeTabKey()) {
      return { kind: 'docx', url, frameUrl: null };
    }
    if (OFFICE_EXTENSIONS.has(ext)) {
      const embed =
        this.officeViewer() === 'microsoft'
          ? `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}`
          : `https://docs.google.com/gview?embedded=true&url=${encodeURIComponent(url)}`;
      return { kind: 'office', url, frameUrl: this.sanitizer.bypassSecurityTrustResourceUrl(embed) };
    }
    return { kind: 'other', url, frameUrl: null }; // e.g. ZIP: cannot be displayed, download only
  });

  // ---------- toolbar ----------
  readonly readingMode = signal(false);
  readonly viewMode = signal<ViewMode>('desktop');
  readonly isFullscreen = signal(false);
  readonly fitHeight = signal<number | null>(null);
  readonly pageBg = signal('#f6f6f6');

  readonly stacked = computed(() => this.viewMode() !== 'desktop');
  /**
   * The inline quiz (Start Quiz / questions / Score) must fit the content area without scrolling, so the
   * content area does not scroll for it. Everything else (and small / stacked screens) keeps scrolling.
   */
  readonly contentClass = computed(() => {
    if (this.stacked()) return 'overflow-y-auto max-h-[70vh]';
    const quizFits = this.activeTab()?.kind === 'Question Bank' && this.learnerView() && this.fitHeight() !== null;
    return quizFits ? 'overflow-hidden' : 'overflow-y-auto';
  });

  readonly frameWidthClass = computed(() => {
    switch (this.viewMode()) {
      case 'tablet':
        return 'max-w-[820px]';
      case 'mobile':
        return 'max-w-[400px]';
      default:
        return 'h-full max-w-none';
    }
  });

  ngOnInit(): void {
    this.courseId = Number(this.route.snapshot.paramMap.get('courseId'));
    this.selectedSectionId.set(Number(this.route.snapshot.paramMap.get('sectionId')) || null);
    this.loadCourseThumbnail();
    this.loadSections();
    this.loadProgress();
    // save the last bit of progress when the learner leaves the page
    this.destroyRef.onDestroy(() => this.flushAllProgress());
    this.trackStudyTime();
  }

  /**
   * Study time (Course Report / Learner Report): ping the backend every 30 s, but only for an enrolled
   * learner (canTrackProgress) and only while this browser tab is visible. The backend measures the
   * seconds itself, so a hidden or closed tab simply stops adding time.
   */
  private trackStudyTime(): void {
    timer(5_000, 30_000)
      .pipe(
        filter(() => this.canTrackProgress() && document.visibilityState === 'visible'),
        switchMap(() => this.studyTime.ping(this.courseId).pipe(catchError(() => EMPTY))),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  ngAfterViewInit(): void {
    this.pageBg.set(this.detectPageBg());
    setTimeout(() => this.updateFit());
    setTimeout(() => this.updateFit(), 200);
  }

  /** The course thumbnail is the image of the quiz "Ready to take the quiz?" page. */
  private loadCourseThumbnail(): void {
    if (!this.courseId) return;
    this.courseService
      .getCourseById(this.courseId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: course => this.courseThumbnail.set(this.resolveThumbnailUrl(course.thumbnailUrl)),
        error: () => this.courseThumbnail.set(null),
      });
  }

  /** Same rule as CourseManagement.resolveThumbnailUrl: the backend sends a relative path like "/uploads/thumbnails/x.png". */
  private resolveThumbnailUrl(thumbnailUrl: string | null | undefined): string | null {
    if (!thumbnailUrl) return null;
    if (thumbnailUrl.startsWith('blob:') || /^https?:\/\//i.test(thumbnailUrl)) return thumbnailUrl;
    return `${environment.apiBaseUrl}${thumbnailUrl}`;
  }

  // ---------- layout fit (same approach as the course preview page) ----------
  private detectPageBg(): string {
    let el: HTMLElement | null = this.host.nativeElement.parentElement;
    while (el) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') return bg;
      el = el.parentElement;
    }
    return '#f6f6f6';
  }

  private ancestorsBottomSpace(): number {
    let total = 0;
    let el: HTMLElement | null = this.host.nativeElement.parentElement;
    while (el) {
      const cs = getComputedStyle(el);
      total +=
        (parseFloat(cs.paddingBottom) || 0) +
        (parseFloat(cs.marginBottom) || 0) +
        (parseFloat(cs.borderBottomWidth) || 0);
      el = el.parentElement;
    }
    return total;
  }

  @HostListener('window:resize')
  updateFit(): void {
    if (this.stacked() || window.innerWidth < DESKTOP_MIN_WIDTH) {
      this.fitHeight.set(null);
      return;
    }
    const top = this.host.nativeElement.getBoundingClientRect().top + window.scrollY;
    const available = window.innerHeight - top - this.ancestorsBottomSpace() - BOTTOM_GAP - 1;
    this.fitHeight.set(Math.max(MIN_HEIGHT, Math.floor(available)));
  }

  // ---------- loading ----------
  loadSections(): void {
    if (!this.courseId) {
      this.error.set('Course not found.');
      return;
    }
    this.loading.set(true);
    this.error.set('');
    this.sectionService
      .getSections(this.courseId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: list => {
          const sorted = [...list].sort((a, b) => a.sectionOrder - b.sectionOrder);
          this.sections.set(sorted);
          const current = this.selectedSectionId();
          this.selectedSectionId.set(sorted.some(s => s.id === current) ? current : (sorted[0]?.id ?? null));
          this.loadTabs();
        },
        error: (err: unknown) => {
          this.loading.set(false);
          this.error.set(err instanceof Error && err.message ? err.message : 'Unable to load the course content.');
        },
      });
  }

  /** Tabs = only what was added to this section, in the same order as the Organize screen list. */
  private loadTabs(): void {
    const sectionId = this.selectedSectionId();
    if (sectionId === null) {
      this.tabs.set([]);
      this.activeTabKey.set('');
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    forkJoin({
      ebooks: this.ebookService
        .list(this.courseId, sectionId)
        .pipe(catchError(() => of([] as EbookSummary[]))),
      resources: this.multimediaService
        .getResources(this.courseId, sectionId)
        .pipe(catchError(() => of([] as MultimediaResource[]))),
      banks: (this.isLearnerView()
        ? this.quizService.listForSection(this.courseId, sectionId)
        : this.questionBankService.listBanks(this.courseId, sectionId)
      ).pipe(catchError(() => of([] as ApiBankResponse[]))),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ ebooks, resources, banks }) => {
        // Ebook + Multimedia: default order (ebooks first), or the order dragged on the Organize screen.
        const content: ContentTab[] = applyActivityOrder<ContentTab>(
          [
            ...ebooks.map(e => ({
              key: `eb-${e.id}`,
              label: e.name,
              kind: 'Ebook' as const,
              addedAt: this.timeOf(e.createdAt),
              ebookId: e.id,
            })),
            ...resources.map(r => ({
              key: `mm-${r.id}`,
              label: r.name,
              kind: 'Multimedia' as const,
              addedAt: this.timeOf(r.createdAt),
              resource: r,
            })),
          ],
          tab => activityOrderKey(tab.kind, tab.kind === 'Ebook' ? (tab.ebookId ?? 0) : (tab.resource?.id ?? 0)),
          readActivityOrder(sectionId),
        );
        const items: ContentTab[] = [
          ...content,
          ...[...banks].sort((x, y) => x.bankOrder - y.bankOrder).map(b => ({
            key: `qb-${b.id}`,
            label: b.name,
            kind: 'Question Bank' as const,
            addedAt: this.timeOf(b.createdAt),
            bankId: b.id,
          })),
        ];
        // Same order as the Organize screen: Ebook / Multimedia rows (default ebooks first, or the dragged order), then question banks last.
        this.tabs.set(items);
        this.activeTabKey.set(items[0]?.key ?? '');
        this.loading.set(false);
        this.prefetchDocx(items);
      });
  }

  private timeOf(iso: string | undefined): number {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
  }

  // ---------- section / tab navigation ----------
  sectionLabel(section: Section): string {
    return `${section.sectionOrder.toString().padStart(2, '0')} - ${section.name}`;
  }

  onSectionChange(event: Event): void {
    const id = Number((event.target as HTMLSelectElement).value);
    if (!id) return;
    this.openSection(id);
  }

  /** A module is locked until the previous one is completed (learners only). */
  isSectionLocked(section: Section): boolean {
    return this.progress()?.sections.find(i => i.sectionId === section.id)?.locked === true;
  }

  sectionOptionLabel(section: Section): string {
    return this.isSectionLocked(section) ? `${this.sectionLabel(section)} (locked)` : this.sectionLabel(section);
  }

  /** Opened a locked module (old link / typed URL)? Move to the first module the learner may open. */
  private guardLockedSection(p: CourseProgress): void {
    const current = this.selectedSectionId();
    if (!p.tracked || !p.sections.find(s => s.sectionId === current)?.locked) return;
    const target = p.sections.find(s => !s.locked && s.status !== 'COMPLETED') ?? p.sections.find(s => !s.locked);
    if (target && target.sectionId !== current) this.openSection(target.sectionId);
  }

  /** Switches to another course section (dropdown, or "Go to next unit" from the embedded quiz). */
  private openSection(id: number): void {
    if (this.progress()?.sections.find(s => s.sectionId === id)?.locked) return;
    this.flushAllProgress();
    this.selectedSectionId.set(id);
    // keep the URL in sync so a refresh stays on the same section (no extra history entry)
    void this.router.navigate(
      ['/admin-dashboard', 'courses', this.courseId, 'sections', id, 'content'],
      { replaceUrl: true },
    );
    this.loadTabs();
  }

  /** Event of the embedded quiz: 'course' = back to the course preview, a number = next course section. */
  onQuizLeave(target: 'course' | number): void {
    if (typeof target === 'number') {
      this.openSection(target);
    } else {
      void this.router.navigate(['/admin-dashboard', 'courses', this.courseId, 'preview']);
    }
  }

  // ---------- learner progress & quiz lock ----------
  //
  // Rule: every content item of a section (ebooks and multimedia files) must be COMPLETED before the quiz
  // of that section opens. An item is completed only when the learner really went through it:
  //   ebook ................. scrolled down to the end of the ebook
  //   video / audio ......... played to the end (skipping ahead does not count)
  //   Word (.docx) .......... scrolled down to the end
  //   image ................. shown
  //   PDF / PowerPoint / Excel / other ... these open in another site's viewer (iframe): the browser cannot tell how
  //                           far the learner got, so the learner confirms with "I've finished reading".
  // The quiz counts only after it is SUBMITTED (the server records that); opening it and leaving does nothing.

  private static readonly SAVE_INTERVAL_MS = 3000;

  /** Best percent seen in this visit per item ("EBOOK:3", "MULTIMEDIA:12"): shows at once, before the server has answered. */
  private readonly localPercent = signal<ReadonlyMap<string, number>>(new Map());
  private readonly pendingPercent = new Map<string, { sectionId: number; type: 'EBOOK' | 'MULTIMEDIA'; id: number; percent: number }>();
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastSaveAt = new Map<string, number>();
  /** video / audio: seconds really played per multimedia id, and the last playback position seen. */
  private readonly watchedSeconds = new Map<number, number>();
  private readonly lastPosition = new Map<number, number>();

  private static itemKey(type: 'EBOOK' | 'MULTIMEDIA', id: number): string {
    return `${type}:${id}`;
  }

  /** Loads the learner's progress (rings, completed items). Admins / instructors get tracked = false. */
  loadProgress(): void {
    if (!this.courseId) return;
    this.progressService
      .getProgress(this.courseId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: p => {
          this.progress.set(p);
          this.guardLockedSection(p);
        },
        error: () => this.progress.set(null), // without progress the content still opens, just without locks
      });
  }

  /** What the server has stored for one item. */
  private serverPercent(type: 'EBOOK' | 'MULTIMEDIA' | 'QUIZ', itemId: number): number {
    return this.progress()?.items.find(i => i.itemType === type && i.itemId === itemId)?.percent ?? 0;
  }

  /** Server value or what was reached in this visit, whichever is higher. */
  private percentOf(type: 'EBOOK' | 'MULTIMEDIA', id: number): number {
    return Math.max(this.serverPercent(type, id), this.localPercent().get(CourseContentViewer.itemKey(type, id)) ?? 0);
  }

  /** 0-100 of a tab: its ebook / multimedia file, or the quiz (100 only after it was submitted). */
  tabPercent(tab: ContentTab): number {
    if (tab.kind === 'Question Bank') return tab.bankId ? this.serverPercent('QUIZ', tab.bankId) : 0;
    if (tab.kind === 'Ebook') return tab.ebookId ? this.percentOf('EBOOK', tab.ebookId) : 0;
    return tab.resource?.id ? this.percentOf('MULTIMEDIA', tab.resource.id) : 0;
  }

  isDone(tab: ContentTab | null | undefined): boolean {
    return !!tab && this.tabPercent(tab) >= 100;
  }

  /** Content tabs (not quizzes) of the current section that the learner has not completed yet. */
  readonly remainingTabs = computed(() =>
    this.canTrackProgress() ? this.tabs().filter(t => t.kind !== 'Question Bank' && this.tabPercent(t) < 100) : [],
  );

  /** The quiz stays locked until every content tab of the section is completed (learners only). */
  readonly quizLocked = computed(() => this.canTrackProgress() && this.remainingTabs().length > 0);

  /** PDF / PowerPoint / Excel / other files: the learner confirms with a button (see the rule above). */
  readonly needsManualCompletion = computed(() => {
    const kind = this.activeMedia()?.kind;
    return this.canTrackProgress() && (kind === 'pdf' || kind === 'office' || kind === 'other');
  });

  /** "I've finished reading" button. */
  markItemDone(): void {
    const id = this.activeTab()?.resource?.id;
    if (id) this.setPercent('MULTIMEDIA', id, 100);
  }

  /** Image: shown = completed. */
  onImageLoaded(): void {
    const id = this.activeTab()?.resource?.id;
    if (id) this.setPercent('MULTIMEDIA', id, 100);
  }

  /** Video / audio, on every timeupdate: only natural playback counts as watched. */
  onMediaTime(event: Event): void {
    const id = this.activeTab()?.resource?.id;
    const el = event.target as HTMLMediaElement;
    if (!id || !this.canTrackProgress() || !el.duration || !Number.isFinite(el.duration)) return;
    const duration = el.duration;
    // first time in this visit: continue from what the server already knows
    let watched = this.watchedSeconds.get(id) ?? (this.percentOf('MULTIMEDIA', id) / 100) * duration;
    const delta = el.currentTime - (this.lastPosition.get(id) ?? el.currentTime);
    this.lastPosition.set(id, el.currentTime);
    // normal playback moves forward a little each tick; a jump (seeking ahead) is ignored
    if (!el.seeking && delta >= 0 && delta <= 2.5 && el.currentTime <= watched + 2.5) {
      watched = Math.max(watched, el.currentTime);
    }
    this.watchedSeconds.set(id, watched);
    this.setPercent('MULTIMEDIA', id, watched >= duration - 1.5 ? 100 : Math.min(99, (watched / duration) * 100));
  }

  /** Video / audio reached its end: completed only if it was really played (not skipped to the end). */
  onMediaEnded(event: Event): void {
    const id = this.activeTab()?.resource?.id;
    const el = event.target as HTMLMediaElement;
    if (!id || !this.canTrackProgress() || !el.duration || !Number.isFinite(el.duration)) return;
    if ((this.watchedSeconds.get(id) ?? 0) >= el.duration - 3) this.setPercent('MULTIMEDIA', id, 100);
  }

  /** Word document: completed when the learner has scrolled to the end. */
  onDocxScroll(event: Event): void {
    this.updateDocxProgress(event.target as HTMLElement);
  }

  private updateDocxProgress(el: HTMLElement): void {
    const id = this.activeTab()?.resource?.id;
    if (!id || !this.canTrackProgress() || this.docxLoading() || !el.scrollHeight) return;
    this.setScrollProgress('MULTIMEDIA', id, el, true);
  }

  // ---------- ebook (Add Activity -> Ebook) ----------

  /** The ebook pages of the active ebook tab (parsed from the saved content). */
  readonly activeEbookPages = signal<EbookPage[] | null>(null);
  readonly ebookLoading = signal(false);
  readonly ebookError = signal('');
  private readonly ebookCache = new Map<number, EbookPage[]>();
  private readonly ebookHost = viewChild<ElementRef<HTMLDivElement>>('ebookHost');

  /** Opens the ebook of the active tab (cached once loaded). */
  private readonly loadActiveEbook = effect(() => {
    const tab = this.activeTab();
    if (tab?.kind !== 'Ebook' || !tab.ebookId) {
      return;
    }
    const ebookId = tab.ebookId;
    untracked(() => this.fetchEbook(ebookId));
  });

  fetchEbook(ebookId: number): void {
    const sectionId = this.selectedSectionId();
    if (!this.courseId || sectionId === null) return;
    const cached = this.ebookCache.get(ebookId);
    if (cached) {
      this.activeEbookPages.set(cached);
      this.ebookError.set('');
      this.scheduleEbookCheck();
      return;
    }
    this.activeEbookPages.set(null);
    this.ebookError.set('');
    this.ebookLoading.set(true);
    this.ebookService
      .get(this.courseId, sectionId, ebookId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ebook => {
          try {
            const pages = JSON.parse(ebook.content) as EbookPage[];
            if (!Array.isArray(pages)) throw new Error('not an array');
            this.ebookCache.set(ebookId, pages);
            // the user may have switched tab while it loaded
            if (this.activeTab()?.ebookId === ebookId) this.activeEbookPages.set(pages);
            this.ebookLoading.set(false);
            this.scheduleEbookCheck();
          } catch {
            this.ebookLoading.set(false);
            this.ebookError.set('This ebook could not be opened.');
          }
        },
        error: () => {
          this.ebookLoading.set(false);
          this.ebookError.set('The ebook could not be loaded.');
        },
      });
  }

  /** An ebook that fits the screen without scrolling counts as read; the images need a moment to get their height. */
  private scheduleEbookCheck(): void {
    for (const delay of [400, 1500, 4000]) {
      setTimeout(() => {
        const el = this.ebookHost()?.nativeElement;
        if (el) this.updateEbookProgress(el);
      }, delay);
    }
  }

  /** Ebook: completed when the learner has scrolled to the end. */
  onEbookScroll(event: Event): void {
    this.updateEbookProgress(event.target as HTMLElement);
  }

  private updateEbookProgress(el: HTMLElement): void {
    const id = this.activeTab()?.ebookId;
    if (!id || !this.canTrackProgress() || !el.scrollHeight) return;
    // a short ebook (no scrolling) only counts as read once its images are in place
    const imagesReady = Array.from(el.querySelectorAll('img')).every(img => img.complete);
    this.setScrollProgress('EBOOK', id, el, imagesReady);
  }

  /** Scrolled to the end = 100 %; before that the scrolled share, at most 99 %. */
  private setScrollProgress(type: 'EBOOK' | 'MULTIMEDIA', id: number, el: HTMLElement, allowFitsOnScreen: boolean): void {
    const fitsOnScreen = el.scrollHeight - el.clientHeight <= 4; // short content: all of it is visible
    const atEnd = el.scrollHeight - el.clientHeight - el.scrollTop <= 8;
    if ((fitsOnScreen && allowFitsOnScreen) || (!fitsOnScreen && atEnd)) {
      this.setPercent(type, id, 100);
    } else {
      this.setPercent(type, id, Math.min(99, ((el.scrollTop + el.clientHeight) / el.scrollHeight) * 100));
    }
  }

  /** Raises one item's percent. It shows at once; it is sent to the server at most every few seconds (at once at 100). */
  private setPercent(type: 'EBOOK' | 'MULTIMEDIA', id: number, percent: number): void {
    const sectionId = this.selectedSectionId();
    if (!this.courseId || sectionId === null || !this.canTrackProgress()) return;
    const value = Math.max(0, Math.min(100, Math.floor(percent)));
    if (value <= this.percentOf(type, id)) return; // only ever goes up
    const key = CourseContentViewer.itemKey(type, id);
    this.localPercent.update(m => new Map(m).set(key, value));
    this.pendingPercent.set(key, { sectionId, type, id, percent: value });
    const wait = CourseContentViewer.SAVE_INTERVAL_MS - (Date.now() - (this.lastSaveAt.get(key) ?? 0));
    if (value >= 100 || wait <= 0) {
      this.flushItem(key);
    } else if (!this.saveTimers.has(key)) {
      this.saveTimers.set(key, setTimeout(() => this.flushItem(key), wait));
    }
  }

  private flushItem(key: string): void {
    const timer = this.saveTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.saveTimers.delete(key);
    }
    const job = this.pendingPercent.get(key);
    if (!job) return;
    this.pendingPercent.delete(key);
    this.lastSaveAt.set(key, Date.now());
    this.progressService
      .updateItem(this.courseId, job.sectionId, job.id, job.percent, job.type === 'EBOOK' ? 'ebook' : 'multimedia')
      .subscribe({
        next: p => this.progress.set(p),
        error: () => {
          // not saved: take the local mark back so the quiz does not look unlocked when the server would refuse it
          this.localPercent.update(m => {
            const next = new Map(m);
            next.delete(key);
            return next;
          });
          this.lastSaveAt.delete(key);
        },
      });
  }

  /** Sends everything still waiting (section change, page close). */
  private flushAllProgress(): void {
    [...this.pendingPercent.keys()].forEach(key => this.flushItem(key));
  }

  /** The embedded quiz was submitted: the section / course progress changed. */
  onQuizFinished(): void {
    this.loadProgress();
  }

  selectTab(key: string): void {
    this.activeTabKey.set(key);
  }

  step(direction: -1 | 1): void {
    const next = this.tabs()[this.activeIndex() + direction];
    if (next) this.activeTabKey.set(next.key);
  }

  /** Admins / instructors only: opens the Question Bank editor. Learners attempt the quiz inline (<app-quiz-attempt>). */
  openQuiz(bankId: number | undefined): void {
    const sectionId = this.selectedSectionId();
    if (!bankId || sectionId === null) return;
    void this.router.navigate([
      '/admin-dashboard',
      'courses',
      this.courseId,
      'sections',
      sectionId,
      'question-banks',
      bankId,
    ]);
  }

  // ---------- toolbar ----------
  toggleReadingMode(): void {
    this.readingMode.update(v => !v);
  }

  setViewMode(event: Event): void {
    this.viewMode.set((event.target as HTMLSelectElement).value as ViewMode);
    this.updateFit();
  }

  toggleFullscreen(): void {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen().catch(() => undefined);
    }
  }

  @HostListener('document:fullscreenchange')
  onFullscreenChange(): void {
    this.isFullscreen.set(!!document.fullscreenElement);
    setTimeout(() => this.updateFit());
  }

  back(): void {
    this.location.back();
  }
}