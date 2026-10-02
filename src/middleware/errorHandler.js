import { isProduction } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

export const notFound = (req, _res, next) => {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};

// Express identifies error handlers by their 4-argument signature.
// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, _req, res, _next) => {
  const statusCode = err.statusCode ?? err.status ?? 500;

  if (statusCode >= 500) console.error(err);

  res.status(statusCode).json({
    success: false,
    message: statusCode >= 500 && isProduction ? 'Internal server error' : err.message,
    ...(err.details && { details: err.details }),
    ...(!isProduction && statusCode >= 500 && { stack: err.stack }),
  });
};
