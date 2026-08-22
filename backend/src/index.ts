import Fastify from 'fastify';
import { config } from './config/index.js';
import { closePool, healthCheck, query } from './db/pool.js';
import { cerbos } from './authz/cerbos.js';
import { isPrivileged } from './lib/access.js';
import { authenticate } from './authz/middleware.js';
import { runAllJobs } from './lib/jobs.js';
import { authRoutes } from './modules/auth/routes.js';
import { personRoutes } from './modules/persons/routes.js';
import { leaveRoutes } from './modules/leave/routes.js';
import { attendanceRoutes } from './modules/attendance/routes.js';
import { messageRoutes } from './modules/messages/routes.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { payrollRoutes } from './modules/payroll/routes.js';
import { growthRoutes } from './modules/growth/routes.js';
import { careRoutes } from './modules/care/routes.js';
import { motivationRoutes } from './modules/motivation/routes.js';
import { workloadIntelligenceRoutes } from './modules/workloadIntelligence/routes.js';
import { conciergeRoutes } from './modules/concierge/routes.js';
import { departmentRoutes } from './modules/departments/routes.js';
import { organizationRoutes } from './modules/organization/routes.js';
import { projectRoutes } from './modules/projects/routes.js';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';

const loggerOptions = config.NODE_ENV !== 'production'
  ? { level: config.LOG_LEVEL, transport: { target: 'pino-pretty', options: { colorize: true } } }
  : { level: config.LOG_LEVEL };

const app = (Fastify)({ logger: loggerOptions });

// Plugins
await app.register(fastifyCors, {
  origin: config.CORS_ORIGIN,
  credentials: true,
});

await app.register(fastifyHelmet, {
  contentSecurityPolicy: false,
});

await app.register(fastifyRateLimit, {
  max: config.RATE_LIMIT_MAX_REQUESTS,
  timeWindow: config.RATE_LIMIT_WINDOW_MS,
});

// API docs (swagger) — development surface only. Production must not
// expose route schemas that aid enumeration or debug endpoints.
if (config.NODE_ENV !== 'production') {
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'EduRankAI HRMS API',
        description: 'EduRankAI Human Resource Management System API',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });
}

// Health check
app.get('/health', async () => {
  const dbHealthy = await healthCheck();
  const cerbosHealthy = await checkCerbosHealth();

  return {
    status: dbHealthy && cerbosHealthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    services: {
      database: dbHealthy ? 'healthy' : 'unhealthy',
      cerbos: cerbosHealthy ? 'healthy' : 'unhealthy',
    },
  };
});

// Auth routes (login issues signed JWTs; /auth/me requires authentication)
await app.register(authRoutes);

// Register routes
app.register(async (app) => {
  app.register(personRoutes);
  app.register(leaveRoutes);
  app.register(attendanceRoutes);
  app.register(messageRoutes);
  app.register(departmentRoutes);
  app.register(organizationRoutes);
  app.register(projectRoutes);
  app.register(notificationRoutes);
  app.register(payrollRoutes);
  app.register(growthRoutes);
  app.register(careRoutes);
  app.register(motivationRoutes);
  app.register(workloadIntelligenceRoutes);
  app.register(conciergeRoutes);

  // Audit query endpoint (fn_audit_log_query) — self or privileged role only
  app.post('/api/audit/query', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
    const { person_id, action, limit } = (request.body || {}) as { person_id?: string; action?: string; limit?: number };
    if (!person_id) {
      return reply.code(400).send({ error: 'person_id is required' });
    }
    if (person_id !== request.user?.personId && !isPrivileged(request.user?.roles ?? [])) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'You may only query your own audit trail',
      });
    }
    const result = await query(
      `SELECT log_id, action, target_type, target_id, person_id, details, created_at
       FROM health.fn_audit_log_query($1, NULL, NULL, $2, NULL, $3, 0)`,
      [person_id, action || null, limit || 100]
    );
    return result.rows;
    },
  });

  // System observability: event fabric, scheduler, audit coverage.
  // Operational telemetry is internal: authenticated privileged roles only.
  app.get('/api/system/observability', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      if (!isPrivileged(request.user?.roles ?? [])) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Observability requires a privileged role' });
      }
      const result = await query(`SELECT * FROM health.observability_state`);
    const jobs = await query(
      `SELECT job_name, schedule_cron, last_status, last_run_at, last_error,
              runs_count, success_count, failure_count, enabled
       FROM health.scheduler_jobs ORDER BY job_name`
    );
    const recentEvents = await query(
      `SELECT event_type, count(*) AS count, max(occurred_at) AS last_occurred
       FROM health.events GROUP BY event_type ORDER BY count DESC LIMIT 20`
    );
    return {
      ...result.rows[0],
      scheduler_jobs: jobs.rows,
      recent_events: recentEvents.rows,
      heartbeat: new Date().toISOString(),
    };
  },
});
});

// Error handler
app.setErrorHandler((error: any, _request, reply) => {
  console.error('Error:', error);
  
  if (error.validation) {
    return reply.code(400).send({
      error: 'Validation Error',
      message: error.message,
      details: error.validation,
    });
  }
  
  return reply.code(500).send({
    error: 'Internal Server Error',
    message: config.NODE_ENV === 'development' ? error.message : 'Internal server error',
  });
});

// Graceful shutdown
const shutdown = async () => {
  console.log('Shutting down...');
  await closePool();
  await cerbos.close();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
async function start() {
  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    console.log(`EduRankAI HRMS API running at http://${config.HOST}:${config.PORT}`);
    console.log(`API Documentation: http://${config.HOST}:${config.PORT}/docs`);

    // Operational scheduler: runs enabled jobs on an interval.
    // NEVER_RUN is recorded until a job first executes.
    const schedulerMs = 60_000;
    setInterval(() => {
      runAllJobs().catch((err) => console.error('[SCHEDULER] run failed:', err));
    }, schedulerMs);
    console.log(`Scheduler started (interval ${schedulerMs}ms)`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

async function checkCerbosHealth(): Promise<boolean> {
  try {
    // Simple health check - could ping Cerbos
    return true;
  } catch {
    return false;
  }
}

start();