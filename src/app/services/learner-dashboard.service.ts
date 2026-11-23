import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { environment } from '../../environments/environment';

/** Shapes of LearnerDashboardDto.Response on the backend. */
export interface CourseStatus {
  completed: number;
  inProgress: number;
  notStarted: number;
}

export interface QuizScore {
  courseId: number;
  courseName: string;
  quizName: string;
  score: number;
  maxScore: number;
  /** 0-100, whole percent */
  percentage: number;
  passed: boolean;
}

export interface TrainingRecord {
  courseId: number;
  courseName: string;
  totalMinutes: number;
}

export interface LearnerDashboardData {
  passedQuizzes: number;
  /** Pass mark used for "Passed Quizzes" (the LMS has no per-quiz pass mark). */
  passPercent: number;
  enrolledCourses: number;
  completedCourses: number;
  inProgressCourses: number;
  notStartedCourses: number;
  courseStatus: CourseStatus;
  quizCourses: { id: number; name: string }[];
  quizScores: QuizScore[];
  trainingTime: TrainingRecord[];
}

interface ApiResponse<T> {
  success: boolean;
  message: string;
  data: T;
}

/**
 * GET /api/dashboard/learner - ONE request, every number is computed by the server for the logged-in learner.
 * Errors stay HttpErrorResponse so the dashboard can switch on error.status (0 / 401 / 5xx).
 */
@Injectable({ providedIn: 'root' })
export class LearnerDashboardService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.apiBaseUrl}/api/dashboard/learner`;

  getDashboard(): Observable<LearnerDashboardData> {
    return this.http.get<ApiResponse<LearnerDashboardData>>(this.url).pipe(map((res) => res.data));
  }
}