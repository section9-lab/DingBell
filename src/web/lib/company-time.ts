export function createTimeFormatter(timeZone: string) {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'shortOffset',
  });
  return (value: string | null, empty = '尚无记录') => {
    if (value === null) return empty;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? formatter.format(date) : '时间不可用';
  };
}
