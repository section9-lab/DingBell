import { useRouteError } from 'react-router';
import { workspaceRoutes } from '../lib/routes';
import { Button } from './ui/button';

export function ApplicationError(){
  const error=useRouteError();
  const asset=error instanceof Error&&/Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Unable to preload CSS|Loading (?:CSS )?chunk .* failed/i.test(error.message);
  return <main className="flex min-h-svh items-center justify-center bg-background p-6"><section className="flex w-full max-w-lg flex-col gap-4 rounded-xl border bg-card p-6">
    <h1 className="text-xl font-semibold">{asset?'页面资源需要重新加载':'页面暂时无法显示'}</h1>
    <p className="text-sm leading-6 text-muted-foreground">{asset?'当前标签页引用的页面资源已更新，或网络读取未完成。请重新加载当前页面。':'页面遇到了异常。请重新加载；如果仍有问题，请联系部署管理员。'}</p>
    <p className="text-xs text-muted-foreground">不会自动重新提交发送、保存或其他业务操作。尚未保存的输入可能丢失，请先保留。</p>
    <div className="flex flex-wrap gap-2"><Button onClick={()=>window.location.reload()}>重新加载页面</Button><Button variant="outline" render={<a href={workspaceRoutes.home}/>}>返回工作区</Button></div>
  </section></main>;
}
