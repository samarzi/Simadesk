/**
 * Automation Report DB — сохранение результатов выполнения автоматизации.
 */

import { supaFetch } from './supabaseClient';
import { companyService } from './companyService';

export interface AutomationReport {
  id: string;
  company_id: string;
  script_type: 'yandex-warehouses' | 'yandex-tariffs' | 'ozon-warehouses';
  warehouse_name: string | null;
  mode: string | null;
  started_at: string;
  finished_at: string;
  total_cities: number;
  filled: number;
  already_set: number;
  not_found: number;
  errors: number;
  details: any[];
  created_at: string;
}

export const automationReportDb = {
  /** Получить отчёты для текущей компании */
  getReports: async (scriptType?: string): Promise<AutomationReport[]> => {
    const cid = companyService.getActiveId();
    if (!cid) return [];
    let url = `automation_reports?company_id=eq.${cid}&select=*&order=created_at.desc&limit=50`;
    if (scriptType) url += `&script_type=eq.${scriptType}`;
    return supaFetch<AutomationReport[]>(url);
  },

  /** Сохранить отчёт */
  saveReport: async (data: {
    script_type: string;
    warehouse_name?: string;
    mode?: string;
    started_at: string;
    total_cities: number;
    filled: number;
    already_set: number;
    not_found: number;
    errors: number;
    details: any[];
  }): Promise<AutomationReport> => {
    const cid = companyService.getActiveId();
    if (!cid) throw new Error('Не выбрана компания');
    const r = await supaFetch<AutomationReport[]>('automation_reports', {
      method: 'POST',
      body: JSON.stringify({
        company_id: cid,
        ...data,
      }),
    });
    return Array.isArray(r) ? r[0] : r;
  },
};
