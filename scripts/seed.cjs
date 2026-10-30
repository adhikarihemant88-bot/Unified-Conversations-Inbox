const { existsSync } = require('node:fs');
require('reflect-metadata');
const { DataSource } = require('typeorm');
const { Agent } = require('../dist/entities/agent.entity');
const { Contact } = require('../dist/entities/contact.entity');
const { ContactIdentity } = require('../dist/entities/contact-identity.entity');
const { Location } = require('../dist/entities/location.entity');
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
if (existsSync('.env')) process.loadEnvFile('.env');

const source = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: [Agent, Contact, ContactIdentity, Location],
  synchronize: false,
});

(async () => {
  await source.initialize();
  const agents = new Map();
  await source.transaction(async (manager) => {
    const locations = manager.getRepository(Location);
    const agentRepository = manager.getRepository(Agent);
    for (const n of [1, 2]) {
      const locationName = `loc_${n}`;
      if (!(await locations.existsBy({ name: locationName })))
        await locations.save(locations.create({ name: locationName }));

      const name = `Agent ${n}`;
      const existingAgent = await agentRepository
        .createQueryBuilder('agent')
        .where('LOWER(BTRIM(agent.name)) = LOWER(BTRIM(:name))', { name })
        .getOne();
      const agent =
        existingAgent ??
        (await agentRepository.save(agentRepository.create({ name })));
      agents.set(`agent_${n}`, agent.id);
    }

    const location = await locations.findOneByOrFail({ name: 'loc_1' });
    const identities = manager.getRepository(ContactIdentity);
    const contacts = manager.getRepository(Contact);
    for (const [name, contactIdentities] of [
      [
        'Demo participant A',
        [
          ['phone', '+919876543210'],
          ['email', 'customer@example.com'],
        ],
      ],
      [
        'Demo participant B',
        [
          ['phone', '+918000000000'],
          ['email', 'inbox@example.com'],
        ],
      ],
    ]) {
      const [primaryKind, primaryValue] = contactIdentities[0];
      const existingIdentity = await identities.findOneBy({
        locationId: location.id,
        kind: primaryKind,
        value: primaryValue,
      });
      const contact =
        existingIdentity === null
          ? await contacts.save(
              contacts.create({ locationId: location.id, name }),
            )
          : await contacts.findOneByOrFail({ id: existingIdentity.contactId });

      for (const [kind, value] of contactIdentities) {
        if (
          !(await identities.existsBy({
            locationId: location.id,
            kind,
            value,
          }))
        )
          await identities.save(
            identities.create({
              locationId: location.id,
              contactId: contact.id,
              kind,
              value,
            }),
          );
      }
    }
  });
  console.log(
    `Demo seed complete. Agent IDs: agent_1=${agents.get('agent_1')}, agent_2=${agents.get('agent_2')}.`,
  );
})()
  .catch(() => {
    console.error('Seed failed. Run migrations first and check connectivity.');
    process.exitCode = 1;
  })
  .finally(async () => {
    if (source.isInitialized) await source.destroy();
  });
