import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../lib/api';
import { readCompanySettings } from '../lib/company-settings-api';
import { createTimeFormatter } from '../lib/company-time';

function useSettings(companyId: string, userId: string) {
  const queryKey = ['company-settings', userId, companyId];
  const query = useQuery({ queryKey, queryFn: ({ signal }) => readCompanySettings(companyId, signal), refetchInterval: 60_000 });
  const timeZone = query.data?.timeZone ?? 'UTC';
  const date = useMemo(() => createTimeFormatter(timeZone), [timeZone]);
  return { query, queryKey, timeZone, date };
}
const SettingsContext = createContext<ReturnType<typeof useSettings> | null>(null);
export function CompanySettingsProvider({ companyId, userId, refresh, children }: {
  companyId: string; userId: string; refresh: (notice?: unknown) => Promise<void>; children: ReactNode;
}) {
  const settings = useSettings(companyId, userId);
  useEffect(() => {
    const error = settings.query.error;
    if (error instanceof ApiError && ['NOT_FOUND', 'UNAUTHENTICATED', 'FORBIDDEN'].includes(error.code)) void refresh(error);
  }, [settings.query.error, refresh]);
  return <SettingsContext value={settings}>{children}</SettingsContext>;
}
export function useCompanySettings() {
  const value = useContext(SettingsContext);
  if (!value) throw new Error('Company settings require an authorized workspace.');
  return value;
}
