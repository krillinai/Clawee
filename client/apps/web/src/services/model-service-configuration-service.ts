import type {
  CodexAvailabilityProbe,
  ConfigureModelServiceRequest,
  ConfigureModelServiceResponse,
  ModelAccessState
} from '@clawee/protocol';
import type { RuntimeClient } from '../runtime/client.js';

type ClientLike = Pick<RuntimeClient, 'get' | 'post'>;

export function createModelServiceConfigurationService(
  client: ClientLike
) {
  return {
    readApiKey(): Promise<{ apiKey: string | null }> {
      return client.get('/runtime/model-service/api-key');
    },
    check(input?: ConfigureModelServiceRequest): Promise<CodexAvailabilityProbe> {
      return client.post('/runtime/model-service/check', input);
    },
    read(): Promise<ModelAccessState> {
      return client.get('/runtime/model-service');
    },
    retry(): Promise<ModelAccessState> {
      return client.post('/runtime/model-service/retry');
    },
    configure(
      input: ConfigureModelServiceRequest
    ): Promise<ConfigureModelServiceResponse> {
      return client.post('/runtime/model-service/configure', input);
    }
  };
}
