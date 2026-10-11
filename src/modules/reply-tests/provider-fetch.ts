// Replaced only by the isolated native test build; production always uses the fixed provider endpoint.
export const sendReplyTestRequest:typeof fetch=(input,init)=>fetch(input,init);
