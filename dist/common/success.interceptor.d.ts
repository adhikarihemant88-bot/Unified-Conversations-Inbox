import { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { type Observable } from 'rxjs';
export declare class SuccessInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown>;
}
