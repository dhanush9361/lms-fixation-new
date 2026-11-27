import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { environment } from '../../environments/environment';
import { ApiResponse } from '../course-module/course.model';
import {
  DEFAULT_INVOICE_SETTING,
  InvoiceSetting,
} from '../profile/settings/invoice-setup.model';

/** What the API returns: the setup plus when it was last saved. */
type InvoiceSettingApi = Partial<InvoiceSetting> & { updatedAt?: string };

/**
 * Profile > Settings > Invoice Setup of the admin's organization, stored in the database
 * (GET / PUT /api/invoice-settings, company admin only). One setup per organization.
 */
@Injectable({ providedIn: 'root' })
export class InvoiceSetupService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.apiBaseUrl}/api/invoice-settings`;

  /** The saved setup, or the blank default when nothing has been saved yet. */
  load(): Observable<InvoiceSetting> {
    return this.http
      .get<ApiResponse<InvoiceSettingApi | null>>(this.url)
      .pipe(map((res) => this.fromApi(res.data)));
  }

  /** Creates the setup the first time and replaces it afterwards. Emits the setup as saved. */
  save(setting: InvoiceSetting): Observable<InvoiceSetting> {
    return this.http
      .put<ApiResponse<InvoiceSettingApi>>(this.url, setting)
      .pipe(map((res) => this.fromApi(res.data)));
  }

  /** Picks the setup fields (drops updatedAt) and fills anything the server left out with the defaults. */
  private fromApi(data: InvoiceSettingApi | null): InvoiceSetting {
    const d = DEFAULT_INVOICE_SETTING;
    if (!data) return { ...d, texts: {} };
    return {
      builtInEnabled: data.builtInEnabled ?? d.builtInEnabled,
      invoicePrefix: data.invoicePrefix ?? d.invoicePrefix,
      nextInvoiceNumber: data.nextInvoiceNumber ?? d.nextInvoiceNumber,
      creditNotePrefix: data.creditNotePrefix ?? d.creditNotePrefix,
      nextCreditNoteNumber: data.nextCreditNoteNumber ?? d.nextCreditNoteNumber,
      vatNumber: data.vatNumber ?? d.vatNumber,
      taxRate: data.taxRate ?? d.taxRate,
      pricesIncludeTax: data.pricesIncludeTax ?? d.pricesIncludeTax,
      invoiceForFullDiscount: data.invoiceForFullDiscount ?? d.invoiceForFullDiscount,
      showLogo: data.showLogo ?? d.showLogo,
      logo: data.logo ?? null,
      logoName: data.logoName ?? null,
      thankYouMessage: data.thankYouMessage ?? d.thankYouMessage,
      taxMessage: data.taxMessage ?? d.taxMessage,
      texts: data.texts ?? {},
    };
  }
}