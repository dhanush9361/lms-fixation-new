// src/app/services/report.service.ts
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { environment } from '../../environments/environment';
import { ApiResponse } from '../course-module/course.model';
import { CourseReportDto, LearnerReportDto } from '../report/report.model';

/**
 * Talks to ReportController:
 *   GET /api/reports/courses   -> Course Report  (one request, numbers computed by the server)
 *   GET /api/reports/learners  -> Learner Report (one request, numbers computed by the server)
 *
 * Errors are left as HttpErrorResponse so the components' handleLoadError()
 * can keep switching on error.status (0 / 401 / 403 / 5xx).
 */
@Injectable({ providedIn: 'root' })
export class ReportService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiBaseUrl}/api/reports`;

  getCourseReport(): Observable<CourseReportDto[]> {
    return this.http
      .get<ApiResponse<CourseReportDto[]>>(`${this.baseUrl}/courses`)
      .pipe(map(res => res.data ?? []));
  }

  getLearnerReport(): Observable<LearnerReportDto[]> {
    return this.http
      .get<ApiResponse<LearnerReportDto[]>>(`${this.baseUrl}/learners`)
      .pipe(map(res => res.data ?? []));
  }
}