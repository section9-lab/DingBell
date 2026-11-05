import { useState } from 'react';
import { ImageOff, ZoomIn } from 'lucide-react';
import { messageImagePath, messageImageReference } from '../../shared/message-images';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog';

function PreviewImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  return failed ? <div role="status" className="flex flex-col items-center gap-3 p-6 text-muted-foreground">
    <ImageOff /><p>图片加载失败，可能已失效或暂无读取权限。</p>
    <Button variant="outline" onClick={() => { setFailed(false); setAttempt(value => value + 1); }}>重新加载图片</Button>
  </div> : <img key={attempt} src={src} alt={alt} referrerPolicy="no-referrer" decoding="async" onError={() => setFailed(true)}
    className="mx-auto max-h-[70dvh] max-w-full rounded-md object-contain" />;
}

function MessageImage({ src, number }: { src: string; number: number }) {
  const [failed, setFailed] = useState(false), [loaded, setLoaded] = useState(false), [attempt, setAttempt] = useState(0);
  const alt = `消息图片 ${number}`;
  if (failed) return <div role="status" className="flex w-60 max-w-full flex-col items-start gap-2 rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
    <span className="flex items-center gap-2"><ImageOff className="size-4" />图片加载失败或已失效</span>
    <Button size="sm" variant="outline" onClick={() => { setFailed(false); setLoaded(false); setAttempt(value => value + 1); }}>重新加载图片 {number}</Button>
  </div>;
  return <Dialog>
    <DialogTrigger disabled={!loaded} aria-label={`查看图片 ${number}`} render={<button type="button" className="group relative block aspect-4/3 w-60 max-w-full overflow-hidden rounded-md border bg-muted/30 outline-none focus-visible:ring-2 focus-visible:ring-ring" />}>
      {!loaded && <span role="status" className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">正在加载图片…</span>}
      <img key={attempt} src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer"
        className="size-full object-contain" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
      {loaded && <span className="absolute right-2 bottom-2 rounded bg-background/90 p-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"><ZoomIn className="size-4" /></span>}
    </DialogTrigger>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-4xl">
      <DialogHeader><DialogTitle>图片预览</DialogTitle><DialogDescription>{alt} · 平台原图</DialogDescription></DialogHeader>
      <PreviewImage src={src} alt={alt} />
    </DialogContent>
  </Dialog>;
}

export function MessageImages({ companyId, conversationId, messageId, content }: { companyId: string; conversationId: string; messageId: string; content: string[] }) {
  const images = content.flatMap((part, index) => index <= 999 && messageImageReference(part) ? [{ index }] : []);
  if (!images.length) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><ImageOff className="size-4" />图片地址不可用或不受支持</p>;
  const captions = content.filter(part => !messageImageReference(part));
  return <div className="flex min-w-0 flex-col gap-2">
    {images.map(({ index }, number) => <MessageImage key={`${messageId}:${index}:${content[index]}`} src={messageImagePath(companyId, conversationId, messageId, index)} number={number + 1} />)}
    {!!captions.length && <p dir="auto" className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{captions.join('\n')}</p>}
  </div>;
}
