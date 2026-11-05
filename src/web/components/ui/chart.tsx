import {createContext,useContext,useId,type ComponentProps,type CSSProperties,type ReactNode} from 'react';
import * as RechartsPrimitive from 'recharts';
import {cn} from 'cn';

// shadcn/ui chart composition: Recharts primitives inside a token-aware container.
export type ChartConfig=Record<string,{label:ReactNode;color:string}>;
const ChartContext=createContext<ChartConfig>({});
export function ChartContainer({config,children,className,...props}:ComponentProps<'div'>&{config:ChartConfig;children:ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>['children']}){
  const id=useId();
  const colors=Object.fromEntries(Object.entries(config).map(([key,value])=>[`--color-${key}`,value.color])) as CSSProperties;
  return <ChartContext.Provider value={config}><div data-slot="chart" data-chart={id} className={cn('flex h-72 min-w-0 justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line]:stroke-border [&_.recharts-reference-line_line]:stroke-border [&_.recharts-surface]:outline-none',className)} style={colors} {...props}><RechartsPrimitive.ResponsiveContainer width="100%" height="100%">{children}</RechartsPrimitive.ResponsiveContainer></div></ChartContext.Provider>;
}
export const ChartTooltip=RechartsPrimitive.Tooltip;
export function ChartTooltipContent({active,payload,label,formatter}: {active?:boolean;payload?:ReadonlyArray<{dataKey?:string|number;value?:string|number|ReadonlyArray<string|number>;color?:string}>;label?:ReactNode;formatter?:(value:number)=>string}){
  const config=useContext(ChartContext);
  if(!active||!payload?.length)return null;
  return <div className="grid min-w-40 gap-2 rounded-lg border bg-background p-3 text-xs shadow-sm"><p className="font-medium">{label}</p>{payload.map((item,index)=><div key={`${item.dataKey}:${index}`} className="flex items-center gap-2"><span aria-hidden="true" className="size-2 rounded-sm" style={{backgroundColor:item.color}}/><span className="text-muted-foreground">{config[String(item.dataKey)]?.label??String(item.dataKey)}</span><span className="ml-auto font-medium tabular-nums">{typeof item.value==='number'?formatter?.(item.value)??item.value:String(item.value??'—')}</span></div>)}</div>;
}
