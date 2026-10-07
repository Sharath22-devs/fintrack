export async function mapAsync(items,fn){const out=[];let i=0;for(const item of items)out.push(await fn(item,i++,items));return out;}
export async function filterAsync(items,fn){const out=[];let i=0;for(const item of items)if(await fn(item,i++,items))out.push(item);return out;}
export async function reduceAsync(items,fn,initial){let acc=initial,i=0;for(const item of items)acc=await fn(acc,item,i++,items);return acc;}
