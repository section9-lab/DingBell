import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Brain, ChevronDown, ChevronRight, Inbox, MessageSquare, Wrench } from 'lucide-react';
import { readAiActivity } from '../lib/ai-activity-api';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';
import { cn } from '../lib/utils';
import type { AiLoopStep } from '../../shared/ai-activity';

const meta = {
  input: { label: '输入', Icon: Inbox, tone: 'text-violet-600' },
  thinking: { label: '思考', Icon: Brain, tone: 'text-sky-600' },
  tool: { label: '工具', Icon: Wrench, tone: 'text-amber-600' },
  answer: { label: '回复文本', Icon: MessageSquare, tone: 'text-emerald-600' },
} as const;

function stepTitle(step: AiLoopStep) {
  return step.kind === 'tool' ? `${meta.tool.label} · ${step.name}` : meta[step.kind].label;
}

export function AiLoopActivity({ companyId, conversationId, memberId }: { companyId: string; conversationId: string; memberId: string }) {
  const [open, setOpen] = useState(false), panelId = useId();
  const query = useQuery({
    queryKey: ['ai-activity', companyId, conversationId, memberId],
    queryFn: ({ signal }) => readAiActivity(companyId, conversationId, memberId, signal),
    gcTime: 0, refetchOnWindowFocus: false,
    refetchInterval: result => result.state.data?.status === 'pending' ? 1500 : 10_000,
  });
  const data = query.data, steps = data?.steps ?? [], latest = steps.at(-1);
  const replied = steps.some(step => step.kind === 'tool' && step.name === 'send_message' && step.output);
  const summary = !data
    ? query.isError ? 'Agent 执行状态暂不可用' : '正在读取 Agent 执行状态…'
    : data.status === 'pending'
      ? latest ? `Agent 正在${meta[latest.kind].label}${latest.kind === 'tool' ? ` · ${latest.name}` : ''}…` : 'Agent 正在启动…'
      : data.status === 'completed' ? `Agent 已完成${replied ? '并提交回复' : latest?.kind === 'answer' ? '并生成回复' : ''}（${steps.length} 步）`
        : data.status === 'failed' ? 'Agent 本次执行失败'
          : '当前没有可展示的 Agent 执行记录';
  return <div className="mt-1.5 flex flex-col gap-1.5">
    <div className="flex min-w-0 items-center gap-2">
      {data?.status === 'pending'
        ? <Spinner aria-hidden="true" />
        : <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', data?.status === 'completed' ? 'bg-emerald-500' : data?.status === 'failed' ? 'bg-destructive' : 'bg-muted-foreground/40')} />}
      <p role="status" className="min-w-0 truncate text-xs text-muted-foreground">{summary}</p>
      {steps.length > 0 && <Button type="button" variant="ghost" size="sm" className="h-6 shrink-0 px-1.5 text-xs" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
        {open ? <ChevronDown data-icon="inline-start" /> : <ChevronRight data-icon="inline-start" />}{open ? '收起 Loop' : '展开 Loop'}
      </Button>}
    </div>
    {open && steps.length > 0 && <ol id={panelId} aria-label="Agent 执行 Loop" className="max-h-56 overflow-auto rounded-md border bg-muted/20 p-2 text-xs">
      {data?.truncated && <li className="pb-1 text-muted-foreground">仅显示最近 {steps.length} 步。</li>}
      {steps.map(step => {
        const { Icon, tone } = meta[step.kind];
        return <li key={step.id} className="flex gap-2 border-b border-border/50 py-1.5 last:border-0">
          <Icon aria-hidden="true" className={cn('mt-0.5 size-3.5 shrink-0', tone)} />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{stepTitle(step)}</p>
            {step.kind === 'tool'
              ? <dl className="mt-1 flex flex-col gap-1 font-mono text-[11px]">
                  <div className="flex gap-1"><dt className="shrink-0 font-sans font-medium not-italic">输入</dt><dd className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-muted-foreground">{step.input || '{}'}</dd></div>
                  <div className="flex gap-1"><dt className="shrink-0 font-sans font-medium not-italic">输出</dt><dd className={cn('min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]', step.failed ? 'text-destructive' : 'text-muted-foreground')}>{step.output ?? '等待结果…'}</dd></div>
                </dl>
              : <p className="mt-0.5 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-muted-foreground">{step.text || '（空）'}</p>}
          </div>
        </li>;
      })}
    </ol>}
  </div>;
}
