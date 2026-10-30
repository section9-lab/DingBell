import { ArrowRight, BookOpen, History, Inbox, PackageSearch, ShoppingBag, SlidersHorizontal, Store } from 'lucide-react';
import { Link } from 'react-router';
import type { Company } from '../lib/api';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader } from './ui/card';
import { ContentReveal } from './motion';
import { roleLabel } from './identity-shared';

const preparation = [
  { title: '连接店铺', description: '连接平台，确认消息、商品和订单权限。', action: '管理店铺', to: '/workspace/stores', icon: Store },
  { title: '准备客服知识', description: '整理商品说明、店铺政策和常见问题。', action: '管理知识', to: '/workspace/knowledge', icon: BookOpen },
  { title: '配置回复策略', description: '检查回复范围与转人工条件，再测试效果。', action: '查看回复策略', to: '/workspace/reply-policies', icon: SlidersHorizontal },
];
const shortcuts = [
  { title: '消息中心', description: '查看咨询与跟进进度', to: '/workspace/messages', icon: Inbox },
  { title: '商品资料', description: '查询已导入的商品', to: '/workspace/products', icon: PackageSearch },
  { title: 'FBS 订单', description: '核对订单与包裹', to: '/workspace/orders', icon: ShoppingBag },
  { title: '会话日志', description: '查看操作与送达记录', to: '/workspace/activity', icon: History },
];

export function WorkspaceHome({ company }: { company: Company }) {
  return <ContentReveal className="flex flex-col gap-8">
    <section className="flex flex-col gap-6 border-b pb-8 sm:flex-row sm:items-end sm:justify-between" aria-labelledby="workspace-title">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><span>工作区总览</span><span aria-hidden="true">/</span><Badge variant="outline">{roleLabel(company.role)}</Badge></div>
        <h1 id="workspace-title" className="text-3xl font-semibold tracking-tight">公司工作区</h1>
        <p className="text-sm leading-6 break-words text-muted-foreground [overflow-wrap:anywhere]">欢迎回到 <span className="font-medium text-foreground">{company.name}</span>。从会话开始，让每一次服务有序进行。</p>
      </div>
      <Button render={<Link to="/workspace/messages" />} className="w-fit shrink-0">进入消息中心<ArrowRight data-icon="inline-end" /></Button>
    </section>

    <section aria-labelledby="next-steps" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="next-steps" className="text-base font-semibold">准备好你的客服工作区</h2>
        <p className="text-xs text-muted-foreground">连接、整理，再开始接待</p>
      </div>
      <ol className="grid gap-4 lg:grid-cols-3">
        {preparation.map(({ title, description, action, to, icon: Icon }, index) => <li key={to} className="flex min-w-0">
          <Card className="w-full gap-5 bg-background ring-border">
            <CardHeader className="flex flex-row items-center justify-between">
              <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-foreground"><Icon className="size-4" aria-hidden="true" /></span>
              <span className="text-xs text-muted-foreground tabular-nums">0{index + 1}</span>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-2">
              <h3 className="text-sm font-semibold">{title}</h3>
              <p className="flex-1 text-sm leading-6 text-muted-foreground">{description}</p>
              <Button variant="ghost" className="-ml-2 mt-2 w-fit justify-start" size="sm" render={<Link to={to} />}>{action}<ArrowRight data-icon="inline-end" className="text-muted-foreground" /></Button>
            </CardContent>
          </Card>
        </li>)}
      </ol>
      <p className="text-xs leading-5 text-muted-foreground">知识需完成索引和检索测试后再发布；自动接待与发送需另行配置并启用。</p>
    </section>

    <section aria-labelledby="workspace-shortcuts" className="flex flex-col gap-4">
      <h2 id="workspace-shortcuts" className="text-base font-semibold">常用入口</h2>
      <div className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2">
        {shortcuts.map(({ title, description, to, icon: Icon }) => <Link key={to} to={to} className="flex min-w-0 items-center gap-3 bg-background p-4 outline-none hover:bg-muted/60 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="flex min-w-0 flex-1 flex-col gap-1"><span className="text-sm font-medium">{title}</span><span className="text-xs text-muted-foreground">{description}</span></span>
          <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Link>)}
      </div>
    </section>
  </ContentReveal>;
}
