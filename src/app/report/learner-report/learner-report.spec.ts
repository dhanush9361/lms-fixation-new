import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LearnerReport } from './learner-report';

describe('LearnerReport', () => {
  let component: LearnerReport;
  let fixture: ComponentFixture<LearnerReport>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LearnerReport],
    }).compileComponents();

    fixture = TestBed.createComponent(LearnerReport);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
