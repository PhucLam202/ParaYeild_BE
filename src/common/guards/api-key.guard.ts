import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * API Key Guard — bảo vệ admin endpoints
 * Header: X-API-Key: <value>
 * Dùng @Public() decorator để bỏ qua guard
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
    constructor(
        private readonly configService: ConfigService,
        private readonly reflector: Reflector,
    ) { }

    canActivate(context: ExecutionContext): boolean {
        // Kiểm tra xem endpoint có được đánh dấu là public không
        const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (isPublic) return true;

        const request = context.switchToHttp().getRequest();
        const apiKey = request.headers['x-api-key'];
        const adminKey = this.configService.get<string>('security.adminApiKey');

        if (!apiKey || apiKey !== adminKey) {
            throw new UnauthorizedException(
                'Invalid or missing API key. Provide X-API-Key header.',
            );
        }

        return true;
    }
}
