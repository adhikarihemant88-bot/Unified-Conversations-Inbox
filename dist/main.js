"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_process_1 = require("node:process");
const core_1 = require("@nestjs/core");
const app_module_1 = require("./app.module");
async function bootstrap() {
    if ((0, node_fs_1.existsSync)('.env.local'))
        (0, node_process_1.loadEnvFile)('.env.local');
    if ((0, node_fs_1.existsSync)('.env'))
        (0, node_process_1.loadEnvFile)('.env');
    const app = await core_1.NestFactory.create(app_module_1.AppModule);
    if (!process.env.WEBHOOK_TOKEN)
        throw new Error('WEBHOOK_TOKEN is required');
    app.enableShutdownHooks();
    await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
//# sourceMappingURL=main.js.map