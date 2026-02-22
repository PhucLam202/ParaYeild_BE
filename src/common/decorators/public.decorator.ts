import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
/**
 * Đánh dấu endpoint là public, bỏ qua ApiKeyGuard
 * @example @Public()
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
