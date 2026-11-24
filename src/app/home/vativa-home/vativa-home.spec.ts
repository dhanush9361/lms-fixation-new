import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { VativaHome } from './vativa-home';

describe('VativaHome', () => {
  let component: VativaHome;
  let fixture: ComponentFixture<VativaHome>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [VativaHome],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(VativaHome);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should render the landing page and initial video service', () => {
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector('h1')?.textContent).toContain('Pick & Pay');
    expect(element.querySelector('#services-heading')?.textContent).toContain('Our Services');
    expect(element.querySelector('h3')?.textContent).toContain('Video & Simulations');
  });

  it('should switch services and close the selected service panel', () => {
    const element = fixture.nativeElement as HTMLElement;
    const lmsButton = Array.from(element.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('LMS Integration/Development'),
    );

    lmsButton?.click();
    fixture.detectChanges();

    expect(element.querySelector('h3')?.textContent).toContain('LMS Integration/Development');

    element.querySelector<HTMLButtonElement>('[aria-label="Close selected service"]')?.click();
    fixture.detectChanges();

    expect(element.querySelector('[aria-hidden="true"][inert]')).not.toBeNull();
    expect(
      Array.from(element.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Show LMS Integration/Development'),
      ),
    ).toBe(true);
  });
});
