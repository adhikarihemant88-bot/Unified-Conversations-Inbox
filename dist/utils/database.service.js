"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatabaseService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
const agent_assignment_lock_entity_1 = require("../entities/agent-assignment-lock.entity");
const agent_entity_1 = require("../entities/agent.entity");
const contact_entity_1 = require("../entities/contact.entity");
const contact_identity_entity_1 = require("../entities/contact-identity.entity");
const conversation_entity_1 = require("../entities/conversation.entity");
const inbox_event_entity_1 = require("../entities/inbox-event.entity");
const location_entity_1 = require("../entities/location.entity");
const message_entity_1 = require("../entities/message.entity");
const pagination_snapshot_entity_1 = require("../entities/pagination-snapshot.entity");
const provider_state_entity_1 = require("../entities/provider-state.entity");
const send_job_entity_1 = require("../entities/send-job.entity");
const database_url_1 = require("./database-url");
let DatabaseService = class DatabaseService {
    source;
    constructor() {
        this.source = new typeorm_1.DataSource({
            type: 'postgres',
            url: (0, database_url_1.databaseUrl)(process.env.DATABASE_URL),
            entities: [
                agent_entity_1.Agent,
                agent_assignment_lock_entity_1.AgentAssignmentLock,
                contact_entity_1.Contact,
                contact_identity_entity_1.ContactIdentity,
                conversation_entity_1.Conversation,
                inbox_event_entity_1.InboxEvent,
                location_entity_1.Location,
                message_entity_1.Message,
                pagination_snapshot_entity_1.PaginationSnapshot,
                provider_state_entity_1.ProviderState,
                send_job_entity_1.SendJob,
            ],
            synchronize: false,
            installExtensions: false,
        });
    }
    async onModuleInit() {
        await this.source.initialize();
    }
    ormTransaction(work, isolationLevel) {
        return isolationLevel
            ? this.source.transaction(isolationLevel, work)
            : this.source.transaction(work);
    }
    getRepository(target) {
        return this.source.getRepository(target);
    }
    async onModuleDestroy() {
        if (this.source.isInitialized)
            await this.source.destroy();
    }
};
exports.DatabaseService = DatabaseService;
exports.DatabaseService = DatabaseService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [])
], DatabaseService);
//# sourceMappingURL=database.service.js.map