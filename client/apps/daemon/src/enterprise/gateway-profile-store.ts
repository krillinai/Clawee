import type { ConfigureModelServiceRequest, EnterpriseLoginRequest } from '@clawee/protocol';
import { z } from 'zod';
import type { PrivateCredentialFileStore } from '../security/private-credential-file.js';

const loginSchema = z.union([
  z.object({ email: z.string().email(), password: z.string().min(8).max(1024) }).strict(),
  z.object({ phone: z.string().regex(/^1[3-9]\d{9}$/), password: z.string().min(8).max(1024) }).strict()
]);
const modelSchema = z.object({
  baseUrl: z.string().url(), model: z.string().min(1), apiKey: z.string().min(1)
}).strict();
const profilesSchema = z.record(z.object({
  login: loginSchema.optional(), model: modelSchema.optional()
}).strict());

export type GatewayProfileStore = {
  readLogin(origin: string): Promise<EnterpriseLoginRequest | undefined>;
  writeLogin(origin: string, login: EnterpriseLoginRequest): Promise<void>;
  readModel(origin: string): Promise<ConfigureModelServiceRequest | undefined>;
  writeModel(origin: string, model: ConfigureModelServiceRequest | undefined): Promise<void>;
};

export function createGatewayProfileStore(input: { file: PrivateCredentialFileStore }): GatewayProfileStore {
  let pending = Promise.resolve();
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation).catch(() => {
      throw new Error('GATEWAY_PROFILE_STORAGE_UNAVAILABLE');
    });
    pending = result.then(() => undefined, () => undefined);
    return result;
  }
  async function readProfiles() {
    return profilesSchema.parse(await input.file.read('gatewayProfiles') ?? {});
  }
  async function write(origin: string, update: Partial<z.infer<typeof profilesSchema>[string]>) {
    const profiles = await readProfiles();
    profiles[origin] = { ...profiles[origin], ...update };
    await input.file.write('gatewayProfiles', profilesSchema.parse(profiles));
  }
  return {
    readLogin: origin => enqueue(async () => (await readProfiles())[origin]?.login),
    writeLogin: (origin, login) => enqueue(() => write(origin, { login })),
    readModel: origin => enqueue(async () => (await readProfiles())[origin]?.model),
    writeModel: (origin, model) => enqueue(() => write(origin, { model }))
  };
}
