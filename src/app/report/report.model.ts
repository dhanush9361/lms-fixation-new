// src/app/services/report.model.ts
// Shapes returned by ReportController (ReportDto.java).

export interface CourseReportDto {
  id: number;
  courseTitle: string;
  courseCode: string;
  category: string;
  enrollments: number;
  completionRate: number; // whole %
  learners: number;
  completedLearners: number;
  learnersInProgress: number;
  learnersNotStarted: number;
  avgUserProgress: number; // whole %
  totalTimeSpent: string; // e.g. "2h 05m"
  certificatesIssued: number;
}

export interface LearnerReportDto {
  userId: number;
  learner: string;
  role: string;
  department: string | null;
  registrationDate: string | null; // ISO date-time
  lastActivity: string | null; // ISO date-time, null = no learning activity yet
  lastLogin: string | null; // ISO date-time, null = never logged in
  completedCourses: number;
  incompleteCourses: number;
  enrolledCourses: number;
  averageScore: number | null; // 0-100, null = no score yet
  studyTime: string;           // e.g. "3h 20m"
  totalTimeOnPlatform: string; // e.g. "12h 45m"
}