import pg from 'pg';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
const safeNumber=v=>{const n=Number(v);if(!Number.isFinite(n)||!Number.isSafeInteger(n))throw new Error('Ledger totals exceeded the safe integer range.');return n;};
pg.types.setTypeParser(20,safeNumber);pg.types.setTypeParser(1700,v=>{const n=Number(v);if(!Number.isFinite(n)||Math.abs(n)>Number.MAX_SAFE_INTEGER)throw Error('Numeric range exceeded.');return n;});
export function postgresSql(sql){
 let s=sql.replace(/INSERT OR IGNORE INTO/gi,'INSERT INTO');const ignore=/INSERT OR IGNORE INTO/i.test(sql);
 s=s.replace(/date\(\?,\s*'-90 days'\)/gi,"(CAST(? AS date) - INTERVAL '90 days')::text");
 if(ignore)s+=' ON CONFLICT DO NOTHING';
 // Translate SQLite placeholders only outside SQL string literals.
 let i=0,quoted=false,out='';for(let j=0;j<s.length;j++){const ch=s[j];if(ch==="'"){out+=ch;if(quoted&&s[j+1]==="'"){out+=s[++j];continue;}quoted=!quoted;}else out+=ch==='?'&&!quoted?'$'+(++i):ch;}return out;
}
export class Database{
 constructor(pool){this.pool=pool;this.storage=new AsyncLocalStorage();}
 withRequest(fn){return this.storage.run({client:null,user:null},fn);}
 setUser(user){const ctx=this.storage.getStore();if(ctx)ctx.user=user;}
 async query(sql,args=[]){const c=this.storage.getStore()?.client||this.pool;return c.query(postgresSql(sql),args);}
 async all(sql,args=[]){return (await this.query(sql,args)).rows;}
 async get(sql,args=[]){return (await this.query(sql,args)).rows[0];}
 async run(sql,args=[]){const r=await this.query(sql,args);return {changes:r.rowCount};}
 async columns(table){return (await this.all('SELECT column_name AS name FROM information_schema.columns WHERE table_schema=\'public\' AND table_name=? ORDER BY ordinal_position',[table])).map(r=>r.name);}
 async lockUser(user){const ctx=this.storage.getStore();if(ctx?.client&&!ctx.readonly){await this.get('SELECT id FROM users WHERE id=? FOR UPDATE',[user]);ctx.user=user;}}
 async readonly(fn){const outer=this.storage.getStore();if(outer?.client)return fn();const c=await this.pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const r=await this.storage.run({...outer,client:c,readonly:true},fn);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 async atomic(fn){const outer=this.storage.getStore();if(outer?.client)return fn();const c=await this.pool.connect();try{await c.query('BEGIN');const r=await this.storage.run({...outer,client:c},async()=>{if(outer?.user)await this.lockUser(outer.user);return fn();});await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 async rateLimit(ip,key,max){const id=createHash('sha256').update(ip+':'+key).digest('hex'),window=Math.floor(Date.now()/60000);const r=await this.pool.query(`INSERT INTO rate_limits(key,window_start,requests) VALUES($1,$2,1) ON CONFLICT(key) DO UPDATE SET requests=CASE WHEN rate_limits.window_start=EXCLUDED.window_start THEN rate_limits.requests+1 ELSE 1 END,window_start=EXCLUDED.window_start RETURNING requests`,[id,window]);if(r.rows[0].requests>max)throw Object.assign(new Error('Too many requests. Try again in a minute.'),{status:429});}
 async close(){await this.pool.end();}
}
let instance;
export function getDatabase(){if(!instance){if(!process.env.DATABASE_URL)throw Object.assign(new Error('DATABASE_URL is not configured. Add it in Netlify environment variables and redeploy.'),{status:503});const u=new URL(process.env.DATABASE_URL);if(!['postgres:','postgresql:'].includes(u.protocol))throw Error('DATABASE_URL must be a PostgreSQL connection string.');const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2,idleTimeoutMillis:15000,connectionTimeoutMillis:10000,statement_timeout:20000,allowExitOnIdle:true});instance=new Database(pool);}return instance;}
export function setTestDatabase(database){instance=database;}
