import { ComponentFixture, TestBed } from '@angular/core/testing';

import { CourseReport } from './course-report';

describe('CourseReport', () => {
  let component: CourseReport;
  let fixture: ComponentFixture<CourseReport>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CourseReport],
    }).compileComponents();

    fixture = TestBed.createComponent(CourseReport);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
