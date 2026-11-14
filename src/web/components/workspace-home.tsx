import { workspaceRoutes } from '../lib/routes';
import { ArrowRight, BookOpen, Check, SlidersHorizontal, Store, Users } from 'lucide-react';
import { Link } from 'react-router';
import type { Company } from '../lib/api';
import { ContentReveal } from './motion';

function QuickIllustration() {
  return (
    <svg viewBox="0 0 132 64" className="h-16 w-36" aria-hidden="true">
      <rect x="2" y="8" width="128" height="48" rx="14" fill="#faf9f6" stroke="#eeece7" />
      <path d="M14 46c17 0 22-22 42-20s22-9 36-8" fill="none" stroke="#e7b45f" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M14 51c16 0 26-13 39-14s26 4 38-7" fill="none" stroke="#9dc0dc" strokeWidth="1.6" strokeLinecap="round" />
      <path d="m95 24 7 10 16-20" fill="none" stroke="#e58c63" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function WorkspaceHome({ company }: { company: Company }) {
  return <ContentReveal className="flex min-h-full flex-col items-center justify-center px-2 pt-10 pb-28 text-center sm:px-6">
    <h1 id="workspace-title" aria-label="公司工作区" className="ghost-title max-w-[720px]">
      从这里开始使用 <span className="serif">DingBell</span>
    </h1>
    <p className="mt-4 max-w-md text-[13.5px] leading-6 text-[var(--text-2)]">
      欢迎回到 <span className="font-medium text-foreground">{company.name}</span>。从一次会话开始，让咨询、订单与售后在同一个工作区有序进行。
    </p>

    <div className="mt-10 grid w-full max-w-[660px] gap-5 sm:grid-cols-2">
      <Link
        to={workspaceRoutes.messages}
        aria-label="进入消息中心"
        className="home-card group flex min-h-[230px] flex-col justify-between p-7 text-left outline-none transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_10px_28px_rgb(0_0_0/0.07)] focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-start justify-between">
          <QuickIllustration />
          <span className="flex size-8 items-center justify-center rounded-full border border-border bg-background text-[var(--text-2)] transition-colors group-hover:text-foreground">
            <ArrowRight className="size-4" aria-hidden="true" />
          </span>
        </div>
        <div className="mt-8 flex flex-col gap-1.5">
          <h2 className="text-[17px] font-semibold tracking-tight">处理咨询</h2>
          <p className="text-[13px] leading-5 text-[var(--text-2)]">打开消息中心，跟进消费者对话</p>
        </div>
      </Link>

      <Link
        to={workspaceRoutes.team}
        aria-label="邀请成员"
        className="home-card group flex min-h-[230px] flex-col justify-between p-7 text-left outline-none transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_10px_28px_rgb(0_0_0/0.07)] focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-start justify-between">
          <span className="pill-action h-9 px-5 text-[13px]">
            <Users className="mr-1.5 size-3.5" aria-hidden="true" />
            邀请
          </span>
          <span className="flex size-8 items-center justify-center rounded-full border border-border bg-background text-[var(--text-2)] transition-colors group-hover:text-foreground">
            <ArrowRight className="size-4" aria-hidden="true" />
          </span>
        </div>
        <div className="mt-8 flex flex-col gap-1.5">
          <h2 className="text-[17px] font-semibold tracking-tight">邀请成员</h2>
          <p className="text-[13px] leading-5 text-[var(--text-2)]">在同一个工作区协作</p>
        </div>
      </Link>
    </div>

    <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-[var(--text-3)]">
      <Link to={workspaceRoutes.stores} aria-label="管理店铺" className="quiet-link flex items-center gap-1.5 hover:text-foreground">
        <Store className="size-3.5" aria-hidden="true" />
        连接店铺
      </Link>
      <Link to={workspaceRoutes.knowledge} aria-label="管理知识" className="quiet-link flex items-center gap-1.5 hover:text-foreground">
        <BookOpen className="size-3.5" aria-hidden="true" />
        准备知识
      </Link>
      <Link to={workspaceRoutes.policies} aria-label="查看回复策略" className="quiet-link flex items-center gap-1.5 hover:text-foreground">
        <SlidersHorizontal className="size-3.5" aria-hidden="true" />
        配置回复
      </Link>
      <Link to={workspaceRoutes.capabilities} aria-label="查看能力与数据" className="quiet-link flex items-center gap-1.5 hover:text-foreground">
        <Check className="size-3.5" aria-hidden="true" />
        检查能力
      </Link>
    </div>
  </ContentReveal>;
}
