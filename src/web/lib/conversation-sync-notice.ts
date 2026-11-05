export function conversationSyncNotice(storeStatus:string,sync:{enabled:boolean;lastError:string|null}):{message:string;stopped:boolean}|null {
  if(storeStatus==='disconnected')return {message:'店铺已断开，当前显示已导入历史。',stopped:true};
  if(storeStatus==='paused')return {message:'店铺同步已暂停，已导入消息仍可查看。',stopped:true};
  if(sync.lastError)return sync.enabled
    ?{message:'上次读取未完成，系统已安排自动重试。已导入消息仍可查看。',stopped:false}
    :{message:'会话同步因异常停止，进度已保留。请在店铺管理中查看原因并恢复。',stopped:true};
  return sync.enabled?null:{message:'会话同步尚未启用。',stopped:false};
}
