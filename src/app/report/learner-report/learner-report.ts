import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { ReportService } from '../../services/report.service';
import { LearnerReportDto } from '../report.model';

/* -------------------------------------------------------
   Learner Report Types
------------------------------------------------------- */
type LearnerFilter = 'completed' | 'incompleted' | 'enrolled';
type ExportFormat = 'excel' | 'csv';

interface LearnerReportRow {
  userId: number;
  learner: string;
  role: string;
  department: string;
  registrationDate: string;
  lastActivity: string;
  lastLogin: string;

  completedCourses: number;
  incompleteCourses: number;
  enrolledCourses: number;
  assignedCourses: string;

  averageScore: string;
  studyTime: string;
  totalTimeOnPlatform: string;
}

/* -------------------------------------------------------
   Component
------------------------------------------------------- */
@Component({
  selector: 'app-learner-report',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, RouterLink],
  templateUrl: './learner-report.html',
})
export class LearnerReport implements OnInit {
  private readonly reportService = inject(ReportService);

  /* -------------------------------------------------------
     State
  ------------------------------------------------------- */
  readonly rows = signal<LearnerReportRow[]>([]);
  readonly loading = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly searchText = signal('');
  readonly filterDropdownOpen = signal(false);
  readonly exportDropdownOpen = signal(false);
  readonly selectedFilter = signal<LearnerFilter | ''>('');
  readonly selectedLearner = signal<LearnerReportRow | null>(null);

  /* -------------------------------------------------------
     Filter Options
  ------------------------------------------------------- */
  readonly filterOptions: { label: string; value: LearnerFilter }[] = [
    { label: 'Completed Courses', value: 'completed' },
    { label: 'Incompleted Courses', value: 'incompleted' },
    { label: 'Enrolled Courses', value: 'enrolled' },
  ];

  /* -------------------------------------------------------
     Computed Values
  ------------------------------------------------------- */
  readonly selectedFilterLabel = computed(() => {
    const filter = this.selectedFilter();
    return this.filterOptions.find(option => option.value === filter)?.label ?? '';
  });

  readonly filteredRows = computed(() => {
    const search = this.searchText().trim().toLowerCase();
    const filter = this.selectedFilter();

    return this.rows().filter(row => {
      // Search learner information.
      const matchesSearch =
        !search ||
        row.learner.toLowerCase().includes(search) ||
        row.role.toLowerCase().includes(search) ||
        row.department.toLowerCase().includes(search);

      if (!matchesSearch) {
        return false;
      }
      // No filter selected.
      if (!filter) {
        return true;
      }
      if (filter === 'completed') {
        return row.completedCourses > 0;
      }
      if (filter === 'incompleted') {
        return row.incompleteCourses > 0;
      }
      if (filter === 'enrolled') {
        return row.enrolledCourses > 0;
      }
      return true;
    });
  });

  /* -------------------------------------------------------
     Lifecycle
  ------------------------------------------------------- */
  ngOnInit(): void {
    this.loadLearnerReports();
  }

  /* -------------------------------------------------------
     Load Learner Reports
  ------------------------------------------------------- */
  loadLearnerReports(): void {
    if (this.loading()) {
      return;
    }
    this.loading.set(true);
    this.errorMessage.set(null);

    // ONE request - the server lists every learner of the organization (even with 0 enrollments)
    // and counts their courses, scores, study time, last login and last activity.
    this.reportService.getLearnerReport().subscribe({
      next: (reports: LearnerReportDto[]) => {
        this.rows.set(reports.map(report => this.toRow(report)));
        this.loading.set(false);
      },
      error: (error: unknown) => this.handleLoadError(error),
    });
  }

  private toRow(report: LearnerReportDto): LearnerReportRow {
    return {
      userId: report.userId,
      learner: report.learner || '—',
      role: report.role || '—',
      department: report.department || '—',
      registrationDate: this.formatDate(report.registrationDate),
      lastActivity: this.formatDateTime(report.lastActivity),
      lastLogin: this.formatDateTime(report.lastLogin),
      completedCourses: report.completedCourses,
      incompleteCourses: report.incompleteCourses,
      enrolledCourses: report.enrolledCourses,
      // Not recorded by the backend (no course-assignment feature) -> dash, not a guess.
      assignedCourses: '—',
      averageScore: report.averageScore === null ? '—' : `${report.averageScore.toFixed(2)}%`,
      studyTime: report.studyTime,
      totalTimeOnPlatform: report.totalTimeOnPlatform,
    };
  }

  private formatDate(iso: string | null): string {
    if (!iso) {
      return '—';
    }
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? '—'
      : date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  private formatDateTime(iso: string | null): string {
    if (!iso) {
      return '—';
    }
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? '—'
      : date.toLocaleString('en-GB', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        });
  }

  /* -------------------------------------------------------
     Error Handling
  ------------------------------------------------------- */
  private handleLoadError(error: unknown): void {
    this.loading.set(false);
    const httpError = error as HttpErrorResponse;

    if (httpError?.status === 0) {
      this.errorMessage.set(
        'Unable to load the Learner Report. Please check your internet connection and try again.',
      );
      return;
    }
    if (httpError?.status === 401) {
      this.errorMessage.set('Your session has expired. Please log in again.');
      // Existing auth interceptor handles session cleanup
      // and redirects to the login page.
      return;
    }
    if (httpError?.status === 403) {
      this.errorMessage.set('You do not have permission to view this report.');
      return;
    }
    if (httpError?.status >= 500) {
      this.errorMessage.set('Something went wrong. Please try again later.');
      return;
    }
    this.errorMessage.set('Unable to load the Learner Report. Please try again.');
  }

  /* -------------------------------------------------------
     Search
  ------------------------------------------------------- */
  onSearchChange(value: string): void {
    this.searchText.set(value.slice(0, 100));
  }

  /* -------------------------------------------------------
     Filter Dropdown
  ------------------------------------------------------- */
  toggleFilterDropdown(): void {
    this.filterDropdownOpen.update(value => !value);
    this.exportDropdownOpen.set(false);
  }

  onFilterChange(value: string): void {
    const validFilters: LearnerFilter[] = ['completed', 'incompleted', 'enrolled'];
    if (value === '' || validFilters.includes(value as LearnerFilter)) {
      this.selectedFilter.set(value as LearnerFilter | '');
    }
  }

  applyFilter(): void {
    this.filterDropdownOpen.set(false);
  }

  clearFilter(): void {
    this.selectedFilter.set('');
    this.filterDropdownOpen.set(false);
  }

  /* -------------------------------------------------------
     Export Dropdown
  ------------------------------------------------------- */
  toggleExportDropdown(): void {
    this.exportDropdownOpen.update(value => !value);
    this.filterDropdownOpen.set(false);
  }

  /* -------------------------------------------------------
     Export Report
  ------------------------------------------------------- */
  exportReport(format: ExportFormat): void {
    if (this.loading() || this.filteredRows().length === 0) {
      return;
    }
    try {
      const reportRows = this.filteredRows();
      if (format === 'csv') {
        this.exportCsv(reportRows);
      } else {
        this.exportExcel(reportRows);
      }
      this.exportDropdownOpen.set(false);
      this.errorMessage.set(null);
    } catch {
      this.errorMessage.set('Unable to export the Learner Report. Please try again.');
    }
  }

  /* -------------------------------------------------------
     Export Headers
  ------------------------------------------------------- */
  private readonly exportHeaders = [
    'Learner',
    'Role',
    'Department',
    'Registration Date',
    'Last Activity',
    'Last Login',
    'Completed Courses',
    'Incomplete Courses',
    'Enrolled Courses',
    'Assigned Courses',
    'Average Score',
    'Study Time',
    'Total Time on Platform',
  ];

  private getExportValues(row: LearnerReportRow): (string | number)[] {
    return [
      row.learner,
      row.role,
      row.department,
      row.registrationDate,
      row.lastActivity,
      row.lastLogin,
      row.completedCourses,
      row.incompleteCourses,
      row.enrolledCourses,
      row.assignedCourses,
      row.averageScore,
      row.studyTime,
      row.totalTimeOnPlatform,
    ];
  }

  /* -------------------------------------------------------
     CSV Export
  ------------------------------------------------------- */
  private exportCsv(data: LearnerReportRow[]): void {
    const csvRows = [this.exportHeaders, ...data.map(row => this.getExportValues(row))];

    const csvContent = csvRows
      .map(row => row.map(value => this.escapeCsv(value)).join(','))
      .join('\r\n');

    const blob = new Blob(['\uFEFF', csvContent], { type: 'text/csv;charset=utf-8;' });
    this.downloadFile(blob, 'learner-report.csv');
  }

  private escapeCsv(value: string | number): string {
    const text = String(value);
    return `"${text.replace(/"/g, '""')}"`;
  }

  /* -------------------------------------------------------
     Excel Export
     Excel-compatible Spreadsheet XML
  ------------------------------------------------------- */
  private exportExcel(data: LearnerReportRow[]): void {
    const escapeXml = (value: string | number): string =>
      String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    const tableRows = [this.exportHeaders, ...data.map(row => this.getExportValues(row))];

    const xmlRows = tableRows
      .map((row, index) => {
        const cells = row
          .map(value => {
            const numeric = typeof value === 'number';
            return `
          <Cell>
            <Data ss:Type="${numeric ? 'Number' : 'String'}">
              ${escapeXml(value)}
            </Data>
          </Cell>
        `;
          })
          .join('');

        return `
        <Row ss:StyleID="${index === 0 ? 'Header' : 'Normal'}">
          ${cells}
        </Row>
      `;
      })
      .join('');

    const excelXml = `<?xml version="1.0"?>
      <?mso-application progid="Excel.Sheet"?>
      <Workbook
        xmlns="urn:schemas-microsoft-com:office:spreadsheet"
        xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
        <Styles>
          <Style ss:ID="Header">
            <Font ss:Bold="1"/>
            <Interior ss:Color="#DDEFF2" ss:Pattern="Solid"/>
          </Style>
          <Style ss:ID="Normal"/>
        </Styles>
        <Worksheet ss:Name="Learner Report">
          <Table>
            ${xmlRows}
          </Table>
        </Worksheet>
      </Workbook>
    `;

    const blob = new Blob([excelXml], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    this.downloadFile(blob, 'learner-report.xls');
  }

  /* -------------------------------------------------------
     Download Helper
  ------------------------------------------------------- */
  private downloadFile(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  /* -------------------------------------------------------
     Learner Preview
  ------------------------------------------------------- */
  previewLearner(row: LearnerReportRow): void {
    this.selectedLearner.set(row);
  }

  closePreview(): void {
    this.selectedLearner.set(null);
  }
}