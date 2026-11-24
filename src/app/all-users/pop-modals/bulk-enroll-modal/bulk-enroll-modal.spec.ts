import { ComponentFixture, TestBed } from '@angular/core/testing';

import { BulkEnrollModal } from './bulk-enroll-modal';

describe('BulkEnrollModal', () => {
  let component: BulkEnrollModal;
  let fixture: ComponentFixture<BulkEnrollModal>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [BulkEnrollModal],
    }).compileComponents();

    fixture = TestBed.createComponent(BulkEnrollModal);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
