import {
    Injectable,
    NestInterceptor,
    ExecutionContext,
    CallHandler,
    Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Observable, tap } from 'rxjs';
import { ActivityLog } from '../../entities';

/**
 * Logging interceptor — log method, path, status, và response time cho mọi request
 * Also saves structured ActivityLogs to MongoDB using TypeORM
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
    private readonly logger = new Logger('HTTP');

    constructor(
        @InjectRepository(ActivityLog)
        private readonly activityLogRepo: Repository<ActivityLog>,
    ) { }

    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        const request = context.switchToHttp().getRequest();
        const { method, url, ip } = request;
        const userAgent = request.get('user-agent') || '';
        const requestBody = request.body || {};
        const start = Date.now();

        return next.handle().pipe(
            tap({
                next: (responseData) => {
                    const response = context.switchToHttp().getResponse();
                    const statusCode = response.statusCode;
                    const executionTimeMs = Date.now() - start;

                    this.logger.log(`${method} ${url} ${statusCode} ${executionTimeMs}ms — ${ip} ${userAgent}`);

                    // Save success log asynchronously
                    this.saveLog({
                        method,
                        url,
                        status: statusCode,
                        requestBody,
                        responseBody: responseData || {},
                        ip,
                        userAgent,
                        executionTimeMs,
                    });
                },
                error: (error) => {
                    const executionTimeMs = Date.now() - start;
                    const statusCode = error?.status || error?.response?.statusCode || 500;

                    this.logger.warn(`${method} ${url} ERROR ${executionTimeMs}ms — ${ip}`);

                    // Save error log asynchronously
                    this.saveLog({
                        method,
                        url,
                        status: statusCode,
                        requestBody,
                        responseBody: { message: error?.message || 'Internal Server Error' },
                        ip,
                        userAgent,
                        executionTimeMs,
                    });
                },
            }),
        );
    }

    private saveLog(logData: Partial<ActivityLog>) {
        // Fire-and-forget save to not block the request
        this.activityLogRepo.save(this.activityLogRepo.create(logData))
            .catch(err => this.logger.error(`Failed to specify activity log: ${err.message}`, err.stack));
    }
}
