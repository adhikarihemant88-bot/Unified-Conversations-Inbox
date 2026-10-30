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
    for (const name of ['INBOX_TOKEN', 'WEBHOOK_TOKEN', 'ADMIN_TOKEN'])
        if (!process.env[name])
            throw new Error(`${name} is required`);
    const app = await core_1.NestFactory.create(app_module_1.AppModule);
    app.enableShutdownHooks();
    await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
//# sourceMappingURL=main.js.map