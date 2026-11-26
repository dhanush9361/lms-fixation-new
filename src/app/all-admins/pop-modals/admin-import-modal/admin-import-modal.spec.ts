import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AdminImportModal } from './admin-import-modal';

describe('AdminImportModal', () => {
  let component: AdminImportModal;
  let fixture: ComponentFixture<AdminImportModal>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AdminImportModal],
    }).compileComponents();

    fixture = TestBed.createComponent(AdminImportModal);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
