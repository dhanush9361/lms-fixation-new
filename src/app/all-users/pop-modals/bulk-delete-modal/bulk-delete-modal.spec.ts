import { ComponentFixture, TestBed } from '@angular/core/testing';

import { BulkDeleteModal } from './bulk-delete-modal';

describe('BulkDeleteModal', () => {
  let component: BulkDeleteModal;
  let fixture: ComponentFixture<BulkDeleteModal>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [BulkDeleteModal],
    }).compileComponents();

    fixture = TestBed.createComponent(BulkDeleteModal);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
