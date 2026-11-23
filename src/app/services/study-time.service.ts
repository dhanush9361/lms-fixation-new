import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../environments/environment';

/**
 * POST /api/courses/{id}/study-time/ping  (StudyTimeController)
 *
 * Sent every 30 s while the course content page is open and visible. The BACKEND measures the
 * seconds from the time between two pings, so nothing about duration is sent from here.
 * Feeds Course Report "Total Time Spent" and Learner Report "Study Time".
 */
@Injectable({ providedIn: 'root' })
export class StudyTimeService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiBaseUrl}/api/courses`;

  ping(courseId: number): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/${courseId}/study-time/ping`, {});
  }
}