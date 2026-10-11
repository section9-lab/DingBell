import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { HTTPException } from 'hono/http-exception';
import { dispatch, init } from '@flue/runtime';
import * as adapter from '@flue/runtime/adapter';
import { createAgentRouter } from '@flue/runtime/routing';
import { HistoricalProbe } from './agents/historical-probe.ts';
type FixtureEnvironment = { Bindings: { PROBE_TOKEN?: string } };
const app = new Hono<FixtureEnvironment>();
app.use('/fixture/*',async(c,next)=>c.env.PROBE_TOKEN?bearerAuth<FixtureEnvironment>({token:c.env.PROBE_TOKEN})(c,next):c.json({error:'unconfigured'},503));
app.use('/agents/history/*',async(c,next)=>c.env.PROBE_TOKEN?bearerAuth<FixtureEnvironment>({token:c.env.PROBE_TOKEN})(c,next):c.json({error:'unconfigured'},503));
// This historical public export was renamed in the current runtime.
const schemaVersion = Reflect.get(adapter, 'FLUE_SCHEMA_VERSION');
app.get('/api/health',c=>c.json({service:'dingbell-flue-schema8-probe',variant:'legacy',runtimeVersion:'2.0.0-nightly.202607240825',storageFormat:{kind:'schema',version:schemaVersion}}));
app.route('/agents/history',createAgentRouter(HistoricalProbe));
app.post('/fixture/:id',async c=>c.json(await dispatch(HistoricalProbe,{id:c.req.param('id'),message:'synthetic schema8 cloud message'}),202));
app.get('/fixture/:id/:submissionId',async c=>c.json(await init(HistoricalProbe,{id:c.req.param('id')}).read(c.req.param('submissionId'))));
app.onError(error=>error instanceof HTTPException ? error.getResponse() : Response.json({error:'fixture_failed'},{status:500}));
export default app;
