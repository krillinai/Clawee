import type {
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
