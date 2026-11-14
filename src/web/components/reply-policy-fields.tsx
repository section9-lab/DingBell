import type { ReplyPolicyConfig } from '../../shared/reply-policy';
import type { StoreRecord } from '../lib/stores-api';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from './ui/field';
import { Input } from './ui/input';
import { NativeSelect, NativeSelectOption } from './ui/native-select';
import { Textarea } from './ui/textarea';

export const stages = { presale: '售前咨询', order: '售中订单查询', aftersale: '售后维护' };
export const languages = {
  customer: '跟随消费者语言',
  ru: '俄语',
  'zh-CN': '简体中文',
  en: '英语',
};
export const tones = { concise: '简洁清晰', friendly: '亲切友好', formal: '正式礼貌' };
export type StoreScope = 'all' | 'stores';
export function defaultPolicy(kind: ReplyPolicyConfig['kind']): ReplyPolicyConfig {
  const common = { name: '', storeIds: [], priority: 50 };
  return kind === 'automatic'
    ? {
        ...common,
        kind,
        stage: 'presale',
        mode: 'automatic',
        language: 'customer',
        tone: 'concise',
        instructions: '',
      }
    : {
        ...common,
        kind,
        event: 'dispatched',
        delayMinutes: 0,
        expiresAfterMinutes: 1440,
        maxPerDay: 1,
        quietHours: { start: '22:00', end: '08:00' },
        content: '您的订单 {{order_number}} 已发货，请耐心等待。',
      };
}
export function PolicyFields({
  config,
  onChange,
  storeScope,
  onStoreScopeChange,
  stores,
  storesPending,
  storesError,
  hasMoreStores,
  loadingMoreStores,
  onLoadMoreStores,
  onRetryStores,
}: {
  config: ReplyPolicyConfig;
  onChange: (config: ReplyPolicyConfig) => void;
  storeScope: StoreScope;
  onStoreScopeChange: (scope: StoreScope) => void;
  stores: StoreRecord[];
  storesPending: boolean;
  storesError: unknown;
  hasMoreStores: boolean;
  loadingMoreStores: boolean;
  onLoadMoreStores: () => void;
  onRetryStores: () => void;
}) {
  if (config.kind !== 'automatic') return null;
  return (
    <FieldGroup className="gap-6">
      <Field className="pr-10">
        <FieldLabel htmlFor="policy-name">策略名称</FieldLabel>
        <Input
          id="policy-name"
          placeholder="例如：商品咨询接待"
          value={config.name}
          maxLength={80}
          required
          onChange={(event) => onChange({ ...config, name: event.target.value })}
        />
      </Field>
      <FieldSet>
        <FieldLegend variant="label">业务阶段</FieldLegend>
        <FieldDescription>每条策略只服务一个阶段；三个阶段各建一条才能全覆盖。</FieldDescription>
        <FieldGroup className="gap-3 sm:flex-row sm:flex-wrap">
          {(Object.keys(stages) as (keyof typeof stages)[]).map((stage) => (
            <Field orientation="horizontal" key={stage} className="sm:w-auto">
              <input
                id={`policy-stage-${stage}`}
                type="radio"
                name="policy-stage"
                className="size-4 accent-primary"
                checked={config.stage === stage}
                onChange={() => onChange({ ...config, stage })}
              />
              <FieldLabel htmlFor={`policy-stage-${stage}`}>{stages[stage]}</FieldLabel>
            </Field>
          ))}
        </FieldGroup>
      </FieldSet>
      <FieldSet>
        <FieldLegend variant="label">适用店铺</FieldLegend>
        <FieldDescription>选择全部店铺，或只对指定店铺生效。</FieldDescription>
        <FieldGroup className="gap-3 sm:flex-row sm:flex-wrap">
          <Field orientation="horizontal" className="sm:w-auto">
            <input
              id="policy-store-scope-all"
              type="radio"
              name="policy-store-scope"
              className="size-4 accent-primary"
              checked={storeScope === 'all'}
              onChange={() => onStoreScopeChange('all')}
            />
            <FieldLabel htmlFor="policy-store-scope-all">全部店铺</FieldLabel>
          </Field>
          <Field orientation="horizontal" className="sm:w-auto">
            <input
              id="policy-store-scope-stores"
              type="radio"
              name="policy-store-scope"
              className="size-4 accent-primary"
              checked={storeScope === 'stores'}
              onChange={() => onStoreScopeChange('stores')}
            />
            <FieldLabel htmlFor="policy-store-scope-stores">
              指定店铺
              {storeScope === 'stores' && (
                <span className="font-normal text-muted-foreground">
                  已选 {config.storeIds.length} 家
                </span>
              )}
            </FieldLabel>
          </Field>
        </FieldGroup>
        {storeScope === 'stores' && (
          <div className="max-h-48 space-y-3 overflow-y-auto rounded-lg border p-3">
            {storesPending ? (
              <p className="text-sm text-muted-foreground">正在读取店铺…</p>
            ) : storesError ? (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">店铺读取失败。</p>
                <Button type="button" variant="outline" size="sm" onClick={onRetryStores}>
                  重新读取店铺
                </Button>
              </div>
            ) : (
              <>
                {stores.map((store) => (
                  <Field key={store.id} orientation="horizontal">
                    <Checkbox
                      id={`policy-store-${store.id}`}
                      checked={config.storeIds.includes(store.id)}
                      disabled={config.storeIds.length >= 20 && !config.storeIds.includes(store.id)}
                      onCheckedChange={(checked) =>
                        onChange({
                          ...config,
                          storeIds: checked
                            ? [...config.storeIds, store.id]
                            : config.storeIds.filter((id) => id !== store.id),
                        })
                      }
                    />
                    <FieldLabel htmlFor={`policy-store-${store.id}`}>{store.name}</FieldLabel>
                  </Field>
                ))}
                {stores.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    暂无可选店铺，请先在店铺管理中连接店铺。
                  </p>
                )}
                {hasMoreStores && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={loadingMoreStores}
                    onClick={onLoadMoreStores}
                  >
                    载入更多店铺
                  </Button>
                )}
              </>
            )}
          </div>
        )}
        {storeScope === 'stores' && config.storeIds.length === 0 && (
          <FieldDescription>请至少选择一家店铺。</FieldDescription>
        )}
      </FieldSet>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="policy-language">回复语言</FieldLabel>
          <NativeSelect
            id="policy-language"
            className="w-full"
            value={config.language}
            onChange={(event) =>
              onChange({ ...config, language: event.target.value as typeof config.language })
            }
          >
            {Object.entries(languages).map(([value, label]) => (
              <NativeSelectOption key={value} value={value}>
                {label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="policy-tone">回复语气</FieldLabel>
          <NativeSelect
            id="policy-tone"
            className="w-full"
            value={config.tone}
            onChange={(event) =>
              onChange({ ...config, tone: event.target.value as typeof config.tone })
            }
          >
            {Object.entries(tones).map(([value, label]) => (
              <NativeSelectOption key={value} value={value}>
                {label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="policy-instructions">提示词内容</FieldLabel>
        <Textarea
          id="policy-instructions"
          rows={6}
          maxLength={2000}
          placeholder="例如：先简短回答问题，再补充必要的使用建议。"
          value={config.instructions}
          onChange={(event) => onChange({ ...config, instructions: event.target.value })}
        />
        <FieldDescription>
          商品事实与店铺政策请在知识库维护，提示词只补充表达要求。
        </FieldDescription>
      </Field>
    </FieldGroup>
  );
}
