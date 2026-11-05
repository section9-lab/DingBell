import { useState } from 'react';
import { ImageOff } from 'lucide-react';

/** Stable thumbnail dimensions, no referrer leakage and a local failure placeholder. */
export function ProductImage({src,alt,className}:{src:string|null;alt:string;className:string}){
  const [failedSource,setFailedSource]=useState<string|null>(null);
  return src&&failedSource!==src?<img src={src} alt={alt} className={`${className} object-contain`} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={()=>setFailedSource(src)}/>
    :<span className={`${className} flex items-center justify-center bg-muted text-muted-foreground`} role="img" aria-label={`${alt}，暂无图片`}><ImageOff className="size-5"/></span>;
}
