"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SuccessInterceptor = void 0;
const common_1 = require("@nestjs/common");
const rxjs_1 = require("rxjs");
let SuccessInterceptor = class SuccessInterceptor {
    intercept(context, next) {
        if (context.getType() !== 'http')
            return next.handle();
        const response = context.switchToHttp().getResponse();
        return next.handle().pipe((0, rxjs_1.map)((data) => {
            if (response.headersSent ||
                response.statusCode === 204 ||
                response.statusCode === 304 ||
                data instanceof common_1.StreamableFile)
                return data;
            const result = typeof data === 'object' &&
                data !== null &&
                'message' in data &&
                typeof data.message === 'string' &&
                'data' in data
                ? data
                : undefined;
            return {
                status: response.statusCode,
                message: result?.message ?? 'Success',
                data: result ? result.data : (data ?? null),
            };
        }));
    }
};
exports.SuccessInterceptor = SuccessInterceptor;
exports.SuccessInterceptor = SuccessInterceptor = __decorate([
    (0, common_1.Injectable)()
], SuccessInterceptor);
//# sourceMappingURL=success.interceptor.js.map