import * as v from 'valibot';
import { defaultModelGenerations, modelExecutionSchema, type ModelExecution } from '../../shared/company-model.ts';
import { usdToMicros } from './budget-api.ts';

export const modelExecutionFields = [
  { name: 'maxInputTokens', label: '输入 token 上限', price: false },
  { name: 'maxOutputTokens', label: '输出 token 上限', price: false },
  { name: 'maxGenerations', label: '每次接待最多生成轮数', price: false },
  { name: 'inputMicrosPerMillion', label: '输入价格（USD / 百万 token）', price: true },
  { name: 'outputMicrosPerMillion', label: '输出价格（USD / 百万 token）', price: true },
  { name: 'cacheReadMicrosPerMillion', label: '缓存读取价格（USD / 百万 token）', price: true },
  { name: 'cacheWriteMicrosPerMillion', label: '缓存写入价格（USD / 百万 token）', price: true },
] as const;
type Field = typeof modelExecutionFields[number]['name'];
export type ModelExecutionDraft = Record<Field, string>;

function decimalMicros(value: number): string {
  const amount = BigInt(value);
  const fraction = (amount % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${amount / 1_000_000n}${fraction ? '.' + fraction : ''}`;
}

export function createModelExecutionDraft(execution: ModelExecution | null): ModelExecutionDraft {
  return Object.fromEntries(modelExecutionFields.map(field => {
    if (!execution) return [field.name, ''];
    const value = field.name === 'maxGenerations' ? execution.maxGenerations ?? defaultModelGenerations : execution[field.name];
    return [field.name, field.price ? decimalMicros(value) : String(value)];
  })) as ModelExecutionDraft;
}

type Parsed = { success: true; execution: ModelExecution | null } | { success: false; message: string };
export function parseModelExecutionDraft(draft: ModelExecutionDraft): Parsed {
  if (modelExecutionFields.every(field => !draft[field.name].trim())) return { success: true, execution: null };
  const values = Object.fromEntries(modelExecutionFields.map(field => {
    const raw = draft[field.name].trim();
    return [field.name, field.price ? usdToMicros(raw) : /^\d+$/.test(raw) ? Number(raw) : null];
  }));
  const parsed = v.safeParse(modelExecutionSchema, values);
  return parsed.success ? { success: true, execution: parsed.output } : {
    success: false,
    message: '执行限制与价格可全部留空；如需填写，请完整填写 token 上限、生成轮数和四项供应商价格，并确保在有效范围内。',
  };
}
