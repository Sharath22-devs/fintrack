// Test-only ephemeral PostgreSQL engine. Production always uses DATABASE_URL.
import {databaseFixture} from './harness.mjs';import {setTestDatabase} from '../api/database.mjs';
process.env.NODE_ENV='development';process.env.ENABLE_DEMO='true';process.env.PORT=process.env.PORT||'3002';const {db}=await databaseFixture();setTestDatabase(db);await import('../scripts/dev-server.mjs');
