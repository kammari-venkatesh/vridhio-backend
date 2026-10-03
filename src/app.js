import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env, isProduction, isTest } from './config/env.js';
import routes from './routes/index.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { ensureDB } from './config/db.js';
import { kickBackgroundWork } from './services/serverlessWork.js';

const app = express();

// Behind a hosting proxy (Render/Railway/Fly), needed so rate limiting sees the real client IP.
if (isProduction) app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin: env.corsOrigins,
    credentials: true,
    exposedHeaders: ['Content-Disposition', 'X-Export-Count', 'X-Export-Truncated'],
  }),
);
const defaultJson = express.json({ limit: '100kb' });
// Lead Workspace imports and table pastes parse their larger bodies after authentication
// (see leadWorkspace.routes.js and salesLead.routes.js).
const LARGE_BODY_PATHS = ['/api/admin/lead-workspace/import', '/api/admin/leads/batch'];
app.use((req, res, next) =>
  LARGE_BODY_PATHS.some((path) => req.path.startsWith(path)) ? next() : defaultJson(req, res, next),
);
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
if (!isTest) app.use(morgan(isProduction ? 'combined' : 'dev'));

app.get('/', (_req, res) => {
  res.json({ success: true, message: 'Vridhio API is running' });
});

// Vercel imports this app directly, so server.js (and its connectDB call) never runs there.
if (process.env.VERCEL) {
  app.use('/api', ensureDB);
  app.use('/api/admin', kickBackgroundWork);
}
app.use('/api', routes);

app.use(notFound);
app.use(errorHandler);

export default app;
